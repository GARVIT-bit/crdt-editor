/**
 * DocClient: the browser side of sync, independent of any UI.
 *
 *   start:     load snapshot + outbox from storage -> editor usable immediately (even offline)
 *   connect:   hello{lastSeq} -> catchup (or init -> rebase) -> send whole outbox
 *   local op:  outbox (memory + storage) -> sent when online -> removed on ack
 *   remote op: RGA.apply -> effects -> onRemote
 *
 * Rebase (on init): replica = server snapshot + our outbox. Complete, because
 * every acked op is in the server snapshot and every unacked op is in the outbox.
 * Each rebase uses a fresh replica id, so we can never reuse an ID the server
 * has seen (e.g. from an op it rejected).
 */
import { RGA, type Effect, type Op } from "@crdt-editor/crdt";
import { MAX_OPS_PER_MESSAGE, opId, type ClientMessage, type PresenceState, type ServerMessage } from "./index.js";
import { MemoryDocStorage, type DocStorage } from "./storage.js";

export type Status = "connecting" | "online" | "offline";

/** The subset of the WebSocket API we use: browsers, Node 22+ and `ws` all fit. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface DocClientOptions {
  /** Full WebSocket URL, e.g. ws://localhost:5173/ws?doc=resume */
  url: string;
  /** Local persistence (IndexedDB in the browser). Default: in memory only. */
  storage?: DocStorage;
  /** A new replica was built (startup or rebase). Replace the whole editor text. */
  onInit?: (rga: RGA) => void;
  /** Screen updates caused by other people's edits. */
  onRemote?: (effects: Effect[]) => void;
  onStatus?: (status: Status) => void;
  /** Number of local ops not yet acked by the server. */
  onPending?: (count: number) => void;
  onError?: (message: string) => void;
  /** Called for every server message after the client handled it (presence, history...). */
  onMessage?: (msg: ServerMessage) => void;
  /** Reconnect automatically (default true). */
  reconnect?: boolean;
  /** First reconnect delay; doubles up to 10 s. Default 500 ms. */
  retryBaseMs?: number;
  /** Debounce for saving the snapshot locally. Default 300 ms. */
  saveDelayMs?: number;
  /** Minimum gap between presence messages. Default 100 ms. */
  presenceThrottleMs?: number;
  /** Give up on a connection attempt not synced within this time. Default 10 s. */
  connectTimeoutMs?: number;
  /** Send an app-level ping this often while online. Default 15 s. */
  pingIntervalMs?: number;
  /** Treat the connection as dead after this long without any message. Default 2 x ping + 5 s. */
  deadAfterMs?: number;
  createSocket?: (url: string) => SocketLike;
  newReplicaId?: () => string;
}

const OPEN = 1;

export class DocClient {
  /** The local replica. null only until storage has loaded. */
  rga: RGA | null = null;
  status: Status = "offline";
  /** Every server op with seq <= lastSeq is in our replica. null = never synced. */
  lastSeq: number | null = null;
  /** Resolves once local storage has loaded and the editor can be shown. */
  readonly ready: Promise<void>;

  private readonly storage: DocStorage;
  private outbox: Op[] = [];
  private live: Op[] = [];
  private flushScheduled = false;
  private socket: SocketLike | null = null;
  private closed = false;
  private wantOnline = true;
  private fullResync = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: PresenceState | null = null;
  private presenceDirty = false;
  private presenceSentAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;

  constructor(private readonly opts: DocClientOptions) {
    this.storage = opts.storage ?? new MemoryDocStorage();
    this.ready = this.start();
  }

  get pendingCount(): number {
    return this.outbox.length;
  }

  get online(): boolean {
    return this.wantOnline;
  }

  /** Record ops the editor just applied locally; send them when possible. */
  send(ops: Op[]): void {
    if (ops.length === 0) return;
    this.outbox.push(...ops);
    this.persist(this.storage.appendOutbox(ops));
    this.opts.onPending?.(this.outbox.length);
    this.scheduleSave();
    if (this.status !== "online") return; // sent with the whole outbox after the next sync
    this.live.push(...ops);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushLive());
    }
  }

  /** Send a non-op message if connected. Returns false if not sent. */
  sendMessage(msg: ClientMessage): boolean {
    if (this.status !== "online" || !this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Share my name/colour/cursor. Throttled: at most one message per
   * presenceThrottleMs, always carrying the LATEST state. Re-sent after reconnect.
   */
  setPresence(state: PresenceState): void {
    this.presence = state;
    this.presenceDirty = true;
    if (this.presenceTimer) return;
    const wait = Math.max(0, this.presenceSentAt + (this.opts.presenceThrottleMs ?? 100) - Date.now());
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, wait);
  }

  private flushPresence(): void {
    if (!this.presenceDirty || !this.presence) return;
    if (this.sendMessage({ type: "presence", ...this.presence })) {
      this.presenceDirty = false;
      this.presenceSentAt = Date.now();
    }
  }

  /** Go offline on purpose (keep editing locally) or come back online. */
  setOnline(on: boolean): void {
    this.wantOnline = on;
    if (this.closed) return;
    if (!on) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      const s = this.socket;
      this.socket = null;
      s?.close(1000, "going offline");
      this.setStatus("offline");
    } else if (!this.socket && this.rga) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retries = 0;
      this.connect();
    }
  }

  /** Save the snapshot now (e.g. on page hide). */
  saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.rga) return Promise.resolve();
    return this.persist(this.storage.saveSnapshot(this.rga.snapshot(), this.lastSeq));
  }

  /** Stop for good (component unmount / tab close). */
  close(): void {
    if (this.closed) return;
    void this.saveNow();
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const s = this.socket;
    this.socket = null;
    s?.close(1000, "client closed");
    this.setStatus("offline");
  }

  // ---------------------------------------------------------------- startup

  private async start(): Promise<void> {
    let stored = null;
    try {
      stored = await this.storage.load();
    } catch (err) {
      this.opts.onError?.(`could not read local copy: ${String(err)}`);
    }
    const rga = stored?.snapshot ? RGA.fromSnapshot(stored.snapshot, this.newId()) : new RGA(this.newId());
    if (stored) {
      for (const op of stored.outbox) rga.apply(op);
      this.outbox = [...stored.outbox];
      this.lastSeq = stored.lastSeq;
    }
    this.rga = rga;
    this.opts.onInit?.(rga);
    this.opts.onPending?.(this.outbox.length);
    if (!this.closed && this.wantOnline) this.connect();
  }

  // ---------------------------------------------------------------- network

  private connect(): void {
    this.setStatus("connecting");
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = create(this.opts.url);
    this.socket = socket;
    this.watch(socket);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      const hello: ClientMessage = { type: "hello", lastSeq: this.fullResync ? null : this.lastSeq };
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastHeard = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
      this.opts.onMessage?.(msg);
    };
    socket.onclose = () => this.lost(socket);
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(msg: ServerMessage): void {
    const rga = this.rga!;
    switch (msg.type) {
      case "init": {
        // Rebase: server state + our unacked ops, under a fresh replica id.
        const next = RGA.fromSnapshot(msg.snapshot, this.newId());
        for (const op of this.outbox) next.apply(op);
        this.rga = next;
        this.lastSeq = msg.seq;
        this.fullResync = false;
        this.opts.onInit?.(next);
        this.synced();
        return;
      }
      case "catchup": {
        const effects: Effect[] = [];
        for (const { op } of msg.ops) effects.push(...rga.apply(op));
        this.lastSeq = msg.seq;
        if (effects.length) this.opts.onRemote?.(effects);
        this.synced();
        return;
      }
      case "ops": {
        const effects: Effect[] = [];
        for (const { op } of msg.ops) effects.push(...rga.apply(op));
        // Only the server's watermark, never an op's own seq: with several
        // servers, seq 11 can arrive before seq 10.
        this.advance(msg.seq);
        if (effects.length) this.opts.onRemote?.(effects);
        this.scheduleSave();
        return;
      }
      case "ack": {
        this.dropFromOutbox(msg.opIds);
        this.advance(msg.seq);
        this.scheduleSave();
        return;
      }
      case "reject": {
        // These can never be accepted. Forget them and rebuild from the server,
        // so our replica doesn't keep text nobody else has.
        this.dropFromOutbox(msg.opIds);
        this.opts.onError?.(msg.message);
        this.fullResync = true;
        this.socket?.close(4000, "resync after reject");
        return;
      }
      case "error": {
        this.opts.onError?.(msg.message);
        return;
      }
      default:
        return; // presence / history: handled via onMessage
    }
  }

  /**
   * Watchdog for one socket. Sockets can hang without ever closing: a load
   * balancer stuck connecting to a dead server, or a server that died without
   * closing TCP (half-open). Browsers can't see WebSocket ping frames, so:
   *   - not synced within connectTimeoutMs  -> give up on this socket and retry
   *   - once online, send "ping" every pingIntervalMs; nothing heard for
   *     deadAfterMs (any message counts) -> give up and retry
   */
  private watch(socket: SocketLike): void {
    if (this.watchdog) clearInterval(this.watchdog);
    const connectTimeout = this.opts.connectTimeoutMs ?? 10_000;
    const pingEvery = this.opts.pingIntervalMs ?? 15_000;
    const deadAfter = this.opts.deadAfterMs ?? pingEvery * 2 + 5_000;
    const started = Date.now();
    let pingedAt = Date.now();
    this.lastHeard = Date.now();
    this.watchdog = setInterval(
      () => {
        if (this.socket !== socket) return;
        const now = Date.now();
        if (this.status !== "online") {
          if (now - started > connectTimeout) this.lost(socket, true);
          return;
        }
        if (now - this.lastHeard > deadAfter) return this.lost(socket, true);
        if (now - pingedAt >= pingEvery) {
          pingedAt = now;
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
        }
      },
      Math.max(10, Math.min(connectTimeout, pingEvery) / 5),
    );
  }

  /** This socket is gone (closed, or abandoned by the watchdog): go offline and retry. */
  private lost(socket: SocketLike, abandon = false): void {
    if (this.socket !== socket) return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.socket = null;
    this.live = [];
    if (abandon) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(4001, "unresponsive");
      } catch {
        /* closing a CONNECTING socket can throw in some runtimes */
      }
    }
    this.setStatus("offline");
    if (!this.closed && this.wantOnline && this.opts.reconnect !== false) this.scheduleReconnect();
  }

  /** Catch-up done: send everything not yet acked, then go live. */
  private synced(): void {
    this.retries = 0;
    this.live = [];
    for (let i = 0; i < this.outbox.length; i += MAX_OPS_PER_MESSAGE) {
      this.sendOps(this.outbox.slice(i, i + MAX_OPS_PER_MESSAGE));
    }
    this.setStatus("online");
    this.scheduleSave();
    // The server forgot us when we disconnected: tell it who/where we are again.
    if (this.presence) {
      this.presenceDirty = true;
      this.flushPresence();
    }
  }

  private flushLive(): void {
    this.flushScheduled = false;
    if (this.live.length === 0 || this.status !== "online") return;
    for (let i = 0; i < this.live.length; i += MAX_OPS_PER_MESSAGE) {
      this.sendOps(this.live.slice(i, i + MAX_OPS_PER_MESSAGE));
    }
    this.live = [];
  }

  private sendOps(ops: Op[]): void {
    if (ops.length === 0 || !this.socket || this.socket.readyState !== OPEN) return;
    const msg: ClientMessage = { type: "ops", ops };
    this.socket.send(JSON.stringify(msg));
  }

  private dropFromOutbox(opIds: string[]): void {
    const gone = new Set(opIds);
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((op) => !gone.has(opId(op)));
    this.persist(this.storage.removeOutbox(opIds));
    if (this.outbox.length !== before) this.opts.onPending?.(this.outbox.length);
  }

  private advance(seq: number): void {
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
  }

  private scheduleReconnect(): void {
    const base = Math.min(10_000, (this.opts.retryBaseMs ?? 500) * 2 ** this.retries);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed && this.wantOnline && !this.socket) this.connect();
    }, delay);
  }

  // ---------------------------------------------------------------- local persistence

  private scheduleSave(): void {
    if (this.closed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.saveNow(), this.opts.saveDelayMs ?? 300);
  }

  private persist(p: Promise<void>): Promise<void> {
    return p.catch((err) => this.opts.onError?.(`could not save locally: ${String(err)}`));
  }

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private newId(): string {
    return (this.opts.newReplicaId ?? randomReplicaId)();
  }
}

function randomReplicaId(): string {
  return globalThis.crypto.randomUUID().slice(0, 13);
}

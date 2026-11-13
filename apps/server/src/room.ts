/**
 * A Room is everything one server knows about one open document: the sockets
 * in it, its own RGA replica (to hand joiners a snapshot), presence, and the
 * seq WATERMARK: every op with seq <= `seq` has been applied here (and relayed
 * to this room's clients). Clients only ever adopt this watermark as their
 * lastSeq, so a reconnect can never skip an op, even when ops from other
 * servers arrive out of order.
 *
 * All work for a room runs one task at a time through `enqueue`, so "answer
 * hello, then join" is atomic with respect to incoming ops.
 *
 * The server does NOT decide where text goes. It only checks, stores and
 * forwards; the RGA rule gives every replica the same order.
 */
import { idKey, RGA, type Op } from "@crdt-editor/crdt";
import { opId, type PresenceState, type SeqOp, type ServerMessage } from "@crdt-editor/protocol";
import type { WebSocket } from "ws";
import type { Bus, BusMessage } from "./bus.js";
import type { OpStore } from "./store.js";

/** Drop a client whose unsent buffer grows past this (it will reconnect + resync). */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface RoomOptions {
  snapshotEvery: number;
  /** Behind by more than this many seqs? Send a snapshot instead of a long catch-up. */
  catchupLimit?: number;
  /** Fan-out to other servers (scale-out). Absent = single server. */
  bus?: Bus;
  serverId?: string;
  /** How long to wait for a missing seq before reading it from the store. */
  gapFillMs?: number;
  /** Remote presence not refreshed within this time is dropped (its server died). */
  presenceTtlMs?: number;
}

export class Room {
  readonly clients = new Set<WebSocket>();
  /** Local clients: who is here and where their cursor is. Never persisted. */
  readonly presence = new Map<WebSocket, { clientId: string; state: PresenceState }>();
  /** Clients connected to OTHER servers. */
  readonly remotePresence = new Map<string, { state: PresenceState; expires: number }>();
  rga = new RGA("server");
  /** Watermark: every op with seq <= this has been applied. */
  seq = 0;
  /** Applied ops above the watermark (waiting for a missing seq below them). */
  private readonly above = new Set<number>();
  private opsSinceSnapshot = 0;
  private chain: Promise<unknown>;
  private readonly ready: Promise<void>;
  private unsubscribe: (() => Promise<void>) | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly catchupLimit: number;
  private readonly serverId: string;

  constructor(
    readonly docId: string,
    private readonly store: OpStore,
    private readonly opts: RoomOptions,
  ) {
    this.catchupLimit = opts.catchupLimit ?? 5000;
    this.serverId = opts.serverId ?? "local";
    this.ready = this.start();
    this.chain = this.ready.catch(() => {});
  }

  /** Run `task` after every earlier task for this room has finished. */
  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.ready).then(task);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Resolves once the room has loaded and every queued task has run. */
  idle(): Promise<unknown> {
    return this.chain;
  }

  /** Subscribe FIRST, then load: anything published after the load query is not missed. */
  private async start(): Promise<void> {
    if (this.opts.bus) {
      this.unsubscribe = await this.opts.bus.subscribe(this.docId, (msg) => this.fromBus(msg));
      // Ask other servers who is already editing, instead of waiting for their heartbeat.
      this.publish({ from: this.serverId, kind: "who" });
    }
    const { snapshot, snapshotSeq, ops } = await this.store.load(this.docId);
    this.rga = snapshot ? RGA.fromSnapshot(snapshot, "server") : new RGA("server");
    this.seq = snapshotSeq;
    for (const { seq, op } of ops) {
      this.rga.apply(op);
      if (seq > this.seq) this.seq = seq; // the store's answer is complete up to its max
    }
    this.opsSinceSnapshot = ops.length;
  }

  /** Room is being unloaded. */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    await this.unsubscribe?.();
  }

  // ---------------------------------------------------------------- watermark

  private markApplied(seq: number): void {
    if (seq <= this.seq) return;
    this.above.add(seq);
    while (this.above.delete(this.seq + 1)) this.seq++;
    if (this.above.size > 0) this.scheduleGapFill();
  }

  private scheduleGapFill(): void {
    if (this.gapTimer || this.closed) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.enqueue(() => this.syncFromStore()).catch((err) => console.error(`[${this.docId}] gap fill failed`, err));
    }, this.opts.gapFillMs ?? 500);
  }

  /**
   * Must run inside enqueue(). Read everything after the watermark from the
   * store. Seqs are committed in order, so any seq below the highest one the
   * store returns that it does NOT have will never exist: skip past it.
   */
  async syncFromStore(): Promise<void> {
    const ops = await this.store.opsSince(this.docId, this.seq);
    this.applyFromElsewhere(ops);
    const max = ops.length ? ops[ops.length - 1]!.seq : this.seq;
    if (max > this.seq) {
      for (const s of [...this.above]) if (s <= max) this.above.delete(s);
      this.seq = max;
      while (this.above.delete(this.seq + 1)) this.seq++;
    }
  }

  /**
   * Must run inside enqueue(). Anti-entropy: a lost bus message followed by
   * silence would never show up as a gap, so periodically compare with the
   * store's head and catch up if we're behind.
   */
  async checkHead(): Promise<void> {
    if ((await this.store.headSeq(this.docId)) > this.seq) await this.syncFromStore();
  }

  /** Apply ops stored by another server; relay the new ones to our clients. */
  private applyFromElsewhere(ops: SeqOp[]): void {
    const fresh = ops.filter((o) => o.seq > this.seq && !this.above.has(o.seq));
    if (fresh.length === 0) return;
    for (const { seq, op } of fresh) {
      this.rga.apply(op);
      this.markApplied(seq);
    }
    this.broadcast({ type: "ops", ops: fresh, seq: this.seq });
  }

  // ---------------------------------------------------------------- clients

  /**
   * Must run inside enqueue(). Answer a client's hello, then add it to the room.
   *   - catchup: just the ops it missed (cheap, keeps its cursor in place)
   *   - init:    full snapshot when it has nothing (null), is too far behind,
   *              or claims a seq that doesn't exist (e.g. the database was reset)
   */
  async hello(ws: WebSocket, lastSeq: number | null): Promise<void> {
    if (ws.readyState !== ws.OPEN) return;
    // Maybe it was on another server that is ahead of us: catch up ourselves first.
    if (lastSeq !== null && lastSeq > this.seq) await this.syncFromStore();
    if (lastSeq === null || lastSeq > this.seq || this.seq - lastSeq > this.catchupLimit) {
      send(ws, { type: "init", snapshot: this.rga.snapshot(), seq: this.seq });
    } else {
      // From the store, not memory: it also has ops applied here above the watermark.
      const ops = await this.store.opsSince(this.docId, lastSeq);
      send(ws, { type: "catchup", ops, seq: this.seq });
    }
    // It may have disconnected while we were reading the store: don't keep a dead socket.
    if (ws.readyState !== ws.OPEN) return;
    this.clients.add(ws);
    // Show the newcomer who is already here (on this server and on others).
    for (const { clientId, state } of this.presence.values()) send(ws, { type: "presence", clientId, ...state });
    for (const [clientId, { state }] of this.remotePresence) send(ws, { type: "presence", clientId, ...state });
  }

  /** Must run inside enqueue(). Check, persist, apply, ack, relay, publish. */
  async receive(from: WebSocket, ops: Op[]): Promise<void> {
    // 1. Causal check: every op must refer to a character we already have
    //    (or one earlier in this same batch). Otherwise it would sit in the
    //    RGA's pending buffer forever and could never be shown to anyone.
    const accepted: Op[] = [];
    const inBatch = new Set<string>();
    for (const op of ops) {
      const ref = op.type === "ins" ? op.after : op.id;
      if (ref !== null && !this.rga.has(ref) && !inBatch.has(idKey(ref))) {
        // Reject this op and everything after it (later ops may depend on it).
        // The client drops exactly these from its outbox, so it can't retry forever.
        const rejected = ops.slice(accepted.length);
        send(from, {
          type: "reject",
          opIds: rejected.map(opId),
          message: `op ${opId(op)} refers to unknown character ${idKey(ref)}; rejected it and ${
            rejected.length - 1
          } later op(s)`,
        });
        break;
      }
      if (op.type === "ins") inBatch.add(idKey(op.id));
      accepted.push(op);
    }
    if (accepted.length === 0) return;

    // 2. Persist BEFORE anyone sees it: nothing a client has seen can be lost.
    const stored: SeqOp[] = await this.store.append(this.docId, accepted);

    // 3. Apply to the server replica (duplicates are no-ops) and advance the watermark.
    for (const op of accepted) this.rga.apply(op);
    for (const { seq } of stored) this.markApplied(seq);

    // 4. Ack EVERY accepted op, duplicates included: a client re-sending an op
    //    whose first ack got lost must still be told it's safe to forget it.
    send(from, { type: "ack", opIds: accepted.map(opId), seq: this.seq });

    if (stored.length > 0) {
      // 5. Relay only what was new: to our other clients, and to other servers.
      this.broadcast({ type: "ops", ops: stored, seq: this.seq }, from);
      this.publish({ from: this.serverId, kind: "ops", ops: stored });
    }

    // 6. Occasionally snapshot so joins and restarts don't replay the whole log.
    this.opsSinceSnapshot += stored.length;
    if (this.opsSinceSnapshot >= this.opts.snapshotEvery && this.rga.pendingCount === 0) {
      this.opsSinceSnapshot = 0;
      await this.snapshotNow();
    }
  }

  /**
   * Must run inside enqueue(). Save the current state as a version (auto or
   * named). Labelled with the watermark; the replica may also hold ops above
   * it, which is harmless: loading re-applies them and duplicates are no-ops.
   */
  async snapshotNow(label?: string): Promise<void> {
    try {
      await this.store.saveSnapshot(this.docId, this.seq, this.rga.snapshot(), label);
    } catch (err) {
      console.error(`[${this.docId}] snapshot failed (ops are still safe in the log)`, err);
      if (label) throw err; // a user asked for this one: tell them
    }
  }

  // ---------------------------------------------------------------- presence (memory only)

  /** Must run inside enqueue() so a cursor is never relayed before the text it points at. */
  setPresence(ws: WebSocket, clientId: string, state: PresenceState): void {
    if (!this.clients.has(ws)) return;
    this.presence.set(ws, { clientId, state });
    this.broadcast({ type: "presence", clientId, ...state }, ws);
    this.publish({ from: this.serverId, kind: "presence", clientId, state });
  }

  /** Must run inside enqueue(). */
  leave(ws: WebSocket): void {
    this.clients.delete(ws);
    const p = this.presence.get(ws);
    if (!p) return;
    this.presence.delete(ws);
    this.broadcast({ type: "presence-leave", clientId: p.clientId }, ws);
    this.publish({ from: this.serverId, kind: "leave", clientId: p.clientId });
  }

  /**
   * Called periodically: re-announce our clients to other servers (keeps their
   * entries alive) and drop remote clients whose server stopped announcing them.
   */
  presenceTick(now = Date.now()): void {
    for (const { clientId, state } of this.presence.values()) {
      this.publish({ from: this.serverId, kind: "presence", clientId, state });
    }
    for (const [clientId, p] of this.remotePresence) {
      if (p.expires > now) continue;
      this.remotePresence.delete(clientId);
      this.broadcast({ type: "presence-leave", clientId });
    }
  }

  // ---------------------------------------------------------------- bus

  private fromBus(msg: BusMessage): void {
    if (msg.from === this.serverId || this.closed) return;
    this.enqueue(() => {
      if (msg.kind === "ops") return this.applyFromElsewhere(msg.ops);
      if (msg.kind === "who") {
        for (const { clientId, state } of this.presence.values()) {
          this.publish({ from: this.serverId, kind: "presence", clientId, state });
        }
        return;
      }
      if (msg.kind === "presence") {
        const known = this.remotePresence.get(msg.clientId);
        this.remotePresence.set(msg.clientId, { state: msg.state, expires: Date.now() + (this.opts.presenceTtlMs ?? 30_000) });
        // A heartbeat that changes nothing doesn't need to reach the browsers.
        if (known && JSON.stringify(known.state) === JSON.stringify(msg.state)) return;
        this.broadcast({ type: "presence", clientId: msg.clientId, ...msg.state });
        return;
      }
      if (this.remotePresence.delete(msg.clientId)) this.broadcast({ type: "presence-leave", clientId: msg.clientId });
    }).catch((err) => console.error(`[${this.docId}] bus message failed`, err));
  }

  private publish(msg: BusMessage): void {
    this.opts.bus?.publish(this.docId, msg).catch((err) => {
      // Others will refill the gap from the store when they notice it.
      console.error(`[${this.docId}] publish failed`, err);
    });
  }

  /** Send to every client in this room except `except`. */
  broadcast(msg: ServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client === except || client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.terminate(); // it will reconnect and catch up
        continue;
      }
      client.send(data);
    }
  }
}

export function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

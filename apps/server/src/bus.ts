/**
 * Server-to-server fan-out for scale-out. Every server that has a document
 * open subscribes to channel doc:<id>; after storing ops it publishes them so
 * the others can relay them to their own clients. Presence travels the same way.
 *
 * Pub/sub is at-most-once (a message can be lost when a connection drops), so
 * the bus is only a fast path: rooms detect seq gaps and refill from the store,
 * and resync every open room after the bus reconnects.
 */
import { createClient } from "redis";
import type { PresenceState, SeqOp } from "@crdt-editor/protocol";

export type BusMessage =
  | { from: string; kind: "ops"; ops: SeqOp[] }
  | { from: string; kind: "presence"; clientId: string; state: PresenceState }
  | { from: string; kind: "leave"; clientId: string }
  /** A room just opened on `from`: everyone please re-announce your clients. */
  | { from: string; kind: "who" };

export type BusHandler = (msg: BusMessage) => void;

export interface Bus {
  /** Resolves once the subscription is active. Returns an unsubscribe function for this handler. */
  subscribe(docId: string, handler: BusHandler): Promise<() => Promise<void>>;
  publish(docId: string, msg: BusMessage): Promise<void>;
  /** Called after the bus reconnected (messages may have been lost meanwhile). */
  onReconnect(cb: () => void): void;
  close(): Promise<void>;
}

export const channelFor = (docId: string) => `doc:${docId}`;

/** In-process bus: several servers in one test process. */
export class MemoryBus implements Bus {
  private handlers = new Map<string, Set<BusHandler>>();
  private reconnectCbs: (() => void)[] = [];
  /** Test hook: drop messages instead of delivering them (simulates pub/sub loss). */
  dropping = false;

  async subscribe(docId: string, handler: BusHandler) {
    const set = this.handlers.get(docId) ?? new Set();
    set.add(handler);
    this.handlers.set(docId, set);
    return async () => {
      set.delete(handler);
    };
  }

  async publish(docId: string, msg: BusMessage) {
    if (this.dropping) return;
    const copy = structuredClone(msg);
    // Asynchronous like a real network hop.
    setTimeout(() => {
      for (const h of this.handlers.get(docId) ?? []) h(copy);
    }, 0);
  }

  onReconnect(cb: () => void) {
    this.reconnectCbs.push(cb);
  }

  /** Test hook: pretend the connection dropped and came back. */
  simulateReconnect() {
    for (const cb of this.reconnectCbs) cb();
  }

  async close() {
    this.handlers.clear();
  }
}

const redisClient = (url: string) => createClient({ url });
type RedisClient = ReturnType<typeof redisClient>;

/** Redis pub/sub bus. Uses two connections: a subscribed connection can't publish. */
export class RedisBus implements Bus {
  private handlers = new Map<string, Set<BusHandler>>();
  private reconnectCbs: (() => void)[] = [];
  private constructor(
    private readonly pub: RedisClient,
    private readonly sub: RedisClient,
  ) {}

  static async connect(url: string): Promise<RedisBus> {
    const pub = redisClient(url);
    const sub = redisClient(url);
    pub.on("error", (err) => console.error("redis (pub) error:", err.message));
    sub.on("error", (err) => console.error("redis (sub) error:", err.message));
    await Promise.all([pub.connect(), sub.connect()]);
    const bus = new RedisBus(pub, sub);
    let first = true;
    sub.on("ready", () => {
      // 'ready' fires again after every reconnect; the client re-subscribes by itself.
      if (first) {
        first = false;
        return;
      }
      for (const cb of bus.reconnectCbs) cb();
    });
    return bus;
  }

  async subscribe(docId: string, handler: BusHandler) {
    let set = this.handlers.get(docId);
    if (!set) {
      set = new Set();
      this.handlers.set(docId, set);
      const handlers = set;
      await this.sub.subscribe(channelFor(docId), (raw) => {
        let msg: BusMessage;
        try {
          msg = JSON.parse(raw) as BusMessage;
        } catch {
          return;
        }
        for (const h of handlers) h(msg);
      });
    }
    set.add(handler);
    const handlers = set;
    return async () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.handlers.get(docId) === handlers) {
        this.handlers.delete(docId);
        await this.sub.unsubscribe(channelFor(docId));
      }
    };
  }

  async publish(docId: string, msg: BusMessage) {
    await this.pub.publish(channelFor(docId), JSON.stringify(msg));
  }

  onReconnect(cb: () => void) {
    this.reconnectCbs.push(cb);
  }

  async close() {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

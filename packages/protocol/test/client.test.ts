/**
 * DocClient's watchdog, with fake sockets: connections that hang without ever
 * closing must not leave the client stuck (found by the Docker failover E2E:
 * Nginx kept a reconnect hanging while it tried to reach a killed server).
 */
import { afterEach, describe, expect, it } from "vitest";
import { RGA } from "@crdt-editor/crdt";
import { DocClient, type SocketLike } from "../src/index.js";

type Behavior = { open: boolean; sync: boolean; pong: boolean };

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: { type: string }[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(private readonly b: Behavior) {
    if (b.open) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      }, 1);
    }
  }
  private reply(msg: object) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 1);
  }
  send(data: string) {
    const msg = JSON.parse(data) as { type: string };
    this.sent.push(msg);
    if (msg.type === "hello" && this.b.sync) this.reply({ type: "init", snapshot: new RGA("s").snapshot(), seq: 0 });
    if (msg.type === "ping" && this.b.pong) this.reply({ type: "pong" });
  }
  close() {
    this.closed = true;
    this.readyState = 3; // note: never fires onclose, like a socket stuck on a dead peer
  }
}

const clients: DocClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

function client(behaviors: Behavior[], opts: Partial<ConstructorParameters<typeof DocClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const c = new DocClient({
    url: "ws://fake",
    retryBaseMs: 10,
    createSocket: () => {
      const s = new FakeSocket(behaviors[Math.min(sockets.length, behaviors.length - 1)]!);
      sockets.push(s);
      return s;
    },
    ...opts,
  });
  clients.push(c);
  return { c, sockets };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(5);
  }
}

describe("DocClient watchdog", () => {
  it("abandons a connection attempt that never syncs, then retries", async () => {
    const hang = { open: false, sync: false, pong: false };
    const good = { open: true, sync: true, pong: true };
    const { c, sockets } = client([hang, hang, good], { connectTimeoutMs: 50 });
    await until(() => c.status === "online");
    expect(sockets).toHaveLength(3);
    expect(sockets[0]!.closed && sockets[1]!.closed).toBe(true);
  });

  it("detects a server that went silent after syncing (half-open) and reconnects", async () => {
    const silent = { open: true, sync: true, pong: false };
    const good = { open: true, sync: true, pong: true };
    const { c, sockets } = client([silent, good], { pingIntervalMs: 20, deadAfterMs: 80 });
    await until(() => sockets.length === 2 && c.status === "online");
    expect(sockets[0]!.sent.some((m) => m.type === "ping")).toBe(true);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("keeps a healthy connection: pings are answered, no reconnects", async () => {
    const good = { open: true, sync: true, pong: true };
    const { c, sockets } = client([good], { pingIntervalMs: 20, deadAfterMs: 80 });
    await until(() => c.status === "online");
    await wait(300);
    expect(c.status).toBe("online");
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.filter((m) => m.type === "ping").length).toBeGreaterThan(5);
  });

  it("going offline on purpose stops the watchdog (no reconnect behind your back)", async () => {
    const good = { open: true, sync: true, pong: true };
    const { c, sockets } = client([good], { pingIntervalMs: 20, deadAfterMs: 50, connectTimeoutMs: 50 });
    await until(() => c.status === "online");
    c.setOnline(false);
    await wait(200);
    expect(c.status).toBe("offline");
    expect(sockets).toHaveLength(1);
  });
});

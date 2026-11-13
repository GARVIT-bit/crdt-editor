/**
 * Same scale-out path as scaleout.test.ts, but through a REAL Redis.
 * Uses REDIS_URL (default redis://127.0.0.1:6380, this project's own container:
 * `docker compose up -d redis`). Skipped, loudly, if Redis isn't reachable.
 */
import { connect as tcpConnect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { RedisBus } from "../src/bus.js";
import { startServer, type RunningServer } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { connect, ofType, until } from "./helpers.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6380";

async function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const s = tcpConnect({ host: hostname, port: Number(port || 6379), timeout: 1000 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
}

const up = await reachable(REDIS_URL);
if (!up) console.warn(`\n  Redis not reachable at ${REDIS_URL}; skipping Redis tests (docker compose up -d redis)\n`);

const cleanup: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanup.reverse()) await c();
});

describe.skipIf(!up)("RedisBus (real Redis)", () => {
  it("two servers relay edits and presence through Redis pub/sub", async () => {
    const store = new MemoryStore();
    const servers: RunningServer[] = [];
    for (const id of ["r1", "r2"]) {
      const bus = await RedisBus.connect(REDIS_URL);
      const s = await startServer({ store, bus, serverId: id });
      servers.push(s);
      cleanup.push(async () => {
        await s.close();
        await bus.close();
      });
    }
    const doc = `redis${Date.now()}`;
    const alice = await connect(servers[0]!, doc, "alice");
    const bob = await connect(servers[1]!, doc, "bob");
    alice.type(0, "via redis ");
    bob.type(0, "😀 ");
    await until(() => alice.text() === bob.text() && alice.client.pendingCount + bob.client.pendingCount === 0, 5000);
    expect([...alice.text()].length).toBe(12);
    expect(alice.client.lastSeq).toBe(12);
    expect(bob.client.lastSeq).toBe(12);

    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: null });
    await until(() => ofType(bob.messages, "presence").some((m) => m.name === "Alice"));
    alice.client.close();
    bob.client.close();
  });
});

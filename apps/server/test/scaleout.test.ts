/**
 * Several servers, one store, one bus (in-process stand-ins for MongoDB and
 * Redis). The same Room code runs with RedisBus in production; see
 * redis.test.ts for the real Redis round trip and e2e for Docker + Nginx.
 */
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { MemoryBus } from "../src/bus.js";
import { startServer, type RunningServer } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { connect, ofType, until, type TestClient } from "./helpers.js";

let docN = 0;
const freshDoc = () => `so${++docN}`;
const running: RunningServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.client.close();
  for (const s of running.splice(0)) await s.close().catch(() => {});
});

async function cluster(n: number, opts: { gapFillMs?: number; presenceHeartbeatMs?: number; antiEntropyMs?: number } = {}) {
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const servers: RunningServer[] = [];
  for (let i = 0; i < n; i++) {
    const s = await startServer({ store, bus, serverId: `s${i}`, snapshotEvery: 7, ...opts });
    servers.push(s);
    running.push(s);
  }
  return { store, bus, servers };
}

async function client(...args: Parameters<typeof connect>) {
  const c = await connect(...args);
  clients.push(c);
  return c;
}

async function converged(cs: TestClient[], store: MemoryStore, doc: string, ms = 5000) {
  await until(
    () => {
      const expected = cs[0]!.text();
      for (const c of cs) {
        expect(c.client.status).toBe("online");
        expect(c.client.pendingCount).toBe(0);
        expect(c.text()).toBe(expected);
        expect(c.view()).toBe(expected);
        // Every client knows it has seen the whole log.
        expect(c.client.lastSeq).toBe(store.opCount(doc));
      }
    },
    ms,
    "convergence across servers",
  );
}

describe("two servers behind a bus", () => {
  it("relays edits and cursors between clients on different servers", async () => {
    const { store, servers } = await cluster(2);
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    const bob = await client(servers[1]!, doc, "bob");
    alice.type(0, "Garvit");
    await until(() => bob.view() === "Garvit");
    bob.type(6, " Mundra");
    await converged([alice, bob], store, doc);
    expect(alice.text()).toBe("Garvit Mundra");

    const at = alice.client.rga!.cursorAt(6);
    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: { anchor: at, head: at } });
    await until(() => ofType(bob.messages, "presence").at(-1)?.name === "Alice");
    alice.client.close();
    await until(() => ofType(bob.messages, "presence-leave").length === 1);
  });

  it("a newcomer on server B sees people connected to server A", async () => {
    const { servers } = await cluster(2);
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: null });
    const bob0 = await client(servers[1]!, doc, "bob0"); // opens the room on B
    await until(() => ofType(bob0.messages, "presence").length === 1);
    const bob = await client(servers[1]!, doc, "bob");
    await until(() => ofType(bob.messages, "presence").some((m) => m.name === "Alice"));
  });

  it("refills from the store when bus messages are lost, without ever over-claiming lastSeq", async () => {
    const { store, bus, servers } = await cluster(2, { gapFillMs: 300 });
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    const bob = await client(servers[1]!, doc, "bob");
    alice.type(0, "ab");
    await converged([alice, bob], store, doc);

    bus.dropping = true; // pub/sub loses these
    alice.type(2, "cd");
    await until(() => alice.client.pendingCount === 0);
    bus.dropping = false;
    alice.type(4, "e"); // seq 5 reaches B, but 3 and 4 never did
    await until(() => ofType(bob.messages, "ops").some((m) => m.ops.some((o) => o.seq === 5)));
    // B relayed "e" but must not tell bob he has everything up to 5...
    expect(bob.client.lastSeq).toBe(2);
    // ...and bob can't show "e" yet: it's anchored after "d", so it waits in the RGA's pending buffer.
    expect(bob.text()).toBe("ab");
    expect(bob.client.rga!.pendingCount).toBe(1);
    // ...until B notices the gap and reads seqs 3-4 from the store.
    await converged([alice, bob], store, doc);
    expect(bob.text()).toBe("abcde");
  });

  it("resyncs every open room after the bus reconnects, even if nothing else happens", async () => {
    const { store, bus, servers } = await cluster(2, { gapFillMs: 60_000, antiEntropyMs: 60_000 });
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    const bob = await client(servers[1]!, doc, "bob");
    bus.dropping = true;
    alice.type(0, "lost in transit");
    await until(() => alice.client.pendingCount === 0);
    bus.dropping = false;
    expect(bob.text()).toBe("");
    bus.simulateReconnect();
    await converged([alice, bob], store, doc);
  });

  it("anti-entropy: a lost message followed by silence still arrives (regression)", async () => {
    const { store, bus, servers } = await cluster(2, { gapFillMs: 60_000, antiEntropyMs: 50 });
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    const bob = await client(servers[1]!, doc, "bob");
    alice.type(0, "a");
    await converged([alice, bob], store, doc);
    bus.dropping = true;
    alice.del(0, 1); // the last edit, and it is lost: no later seq will reveal the gap
    await until(() => alice.client.pendingCount === 0);
    bus.dropping = false;
    await converged([alice, bob], store, doc);
    expect(bob.text()).toBe("");
  });

  it("drops cursors of clients whose server died without saying goodbye", async () => {
    const { bus, servers } = await cluster(2, { presenceHeartbeatMs: 40 });
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice");
    const bob = await client(servers[1]!, doc, "bob");
    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: null });
    await until(() => ofType(bob.messages, "presence").length >= 1);

    // Crash A: its "leave" messages never make it out.
    bus.dropping = true;
    alice.client.setOnline(false);
    await servers[0]!.close();
    bus.dropping = false;
    await until(() => ofType(bob.messages, "presence-leave").length === 1, 3000, "ghost cursor to expire");
  });

  it("failover: server A dies mid-session; its clients move to B with no lost edits", async () => {
    const { store, servers } = await cluster(2);
    const live = () => servers.filter((s) => running.includes(s)).map((s) => s.port);
    const doc = freshDoc();
    const alice = await client(servers[0]!, doc, "alice", { balance: { ports: live, startAt: 0 } });
    const bob = await client(servers[1]!, doc, "bob", { balance: { ports: live, startAt: 1 } });
    alice.type(0, "before. ");
    await converged([alice, bob], store, doc);

    running.splice(running.indexOf(servers[0]!), 1);
    await servers[0]!.close(); // "docker kill"
    alice.type(8, "during. "); // typed while alice has no server
    bob.type(0, "B: ");
    await converged([alice, bob], store, doc, 10_000);
    expect(alice.text()).toBe("B: before. during. ");
  });
});

describe("convergence across 3 servers (property-based)", () => {
  it("random clients on random servers, going offline, with a lossy bus", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            who: fc.nat(3),
            at: fc.double({ min: 0, max: 1, noNaN: true }),
            ins: fc.boolean(),
            text: fc.constantFrom("a", "bc", "😀", " x"),
            toggle: fc.integer({ min: 0, max: 7 }).map((x) => x === 0),
            drop: fc.integer({ min: 0, max: 9 }).map((x) => x === 0),
            pause: fc.boolean(),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (actions) => {
          const { store, bus, servers } = await cluster(3, { gapFillMs: 30, antiEntropyMs: 50 });
          const doc = freshDoc();
          const cs = await Promise.all([0, 1, 2, 3].map((i) => client(servers[i % 3]!, doc, `r${i}`)));
          try {
            for (const act of actions) {
              const c = cs[act.who]!;
              bus.dropping = act.drop;
              if (act.toggle) c.client.setOnline(!c.client.online);
              const len = [...c.text()].length;
              if (act.ins || len === 0) c.type(Math.min(len, Math.floor(act.at * (len + 1))), act.text);
              else c.del(Math.min(len - 1, Math.floor(act.at * len)), 1);
              if (act.pause) await new Promise((r) => setTimeout(r, 1));
            }
            bus.dropping = false;
            for (const c of cs) c.client.setOnline(true);
            await converged(cs, store, doc, 10_000);
            for (const c of cs) expect(c.errors).toEqual([]);
          } finally {
            for (const c of cs) c.client.close();
            for (const s of servers) {
              running.splice(running.indexOf(s), 1);
              await s.close();
            }
          }
        },
      ),
      { numRuns: Number(process.env.NET_RUNS ?? 25) },
    );
  }, 300_000);
});

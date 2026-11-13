import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { startServer, type RunningServer } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { connect, ofType, rawSocket, until } from "./helpers.js";

let store: MemoryStore;
let server: RunningServer;
let docN = 0;
const freshDoc = () => `doc${++docN}`;

beforeAll(async () => {
  store = new MemoryStore();
  server = await startServer({ store, snapshotEvery: 5 });
});
afterAll(async () => {
  await server.close();
});

describe("rooms", () => {
  it("a new document starts empty at seq 0", async () => {
    const { ws, inbox } = await rawSocket(server, freshDoc());
    expect(inbox[0]).toMatchObject({ type: "init", seq: 0, snapshot: { nodes: [] } });
    ws.close();
  });

  it("relays edits to the other client but never echoes them back", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.type(0, "hello");
    await until(() => bob.view() === "hello", 3000, "bob to see hello");
    bob.type(5, " world");
    await until(() => alice.view() === "hello world");
    expect(alice.text()).toBe("hello world");
    expect(store.opCount(doc)).toBe(11);
    alice.client.close();
    bob.client.close();
  });

  it("a late joiner gets the whole document in init", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    alice.type(0, "résumé 😀");
    alice.del(0, 1);
    await until(() => store.opCount(doc) === 9); // 8 characters (emoji = 1) + 1 delete
    const carol = await connect(server, doc, "carol");
    expect(carol.view()).toBe("ésumé 😀");
    alice.client.close();
    carol.client.close();
  });

  it("keeps documents isolated", async () => {
    const [d1, d2] = [freshDoc(), freshDoc()];
    const a = await connect(server, d1, "a");
    const b = await connect(server, d2, "b");
    const a2 = await connect(server, d1, "a2");
    a.type(0, "only in d1");
    await until(() => a2.view() === "only in d1");
    expect(b.view()).toBe("");
    expect(store.opCount(d2)).toBe(0);
    for (const c of [a, b, a2]) c.client.close();
  });

  it("unloads a room from memory when its last client leaves", async () => {
    const doc = freshDoc();
    const a = await connect(server, doc, "a");
    expect(server.rooms.has(doc)).toBe(true);
    a.client.close();
    await until(() => !server.rooms.has(doc), 3000, "room unload");
  });
});

describe("rejecting bad input", () => {
  it("rejects bad document ids at the HTTP upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?doc=..%2Fetc`);
    let failed = false;
    ws.onerror = () => (failed = true);
    await until(() => failed, 3000, "upgrade rejection");
  });

  it("answers malformed messages with an error and stores nothing", async () => {
    const doc = freshDoc();
    const { ws, inbox } = await rawSocket(server, doc);
    ws.send("{not json");
    ws.send(JSON.stringify({ type: "ops", ops: [{ type: "ins", id: [1, "x"], after: null, value: "too long" }] }));
    await until(() => inbox.length === 3);
    expect(inbox.slice(1).every((m) => m.type === "error")).toBe(true);
    expect(store.opCount(doc)).toBe(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects ops that refer to characters the server has never seen", async () => {
    const doc = freshDoc();
    const { ws, inbox } = await rawSocket(server, doc);
    const ok = { type: "ins", id: [1, "x"], after: null, value: "a" };
    const orphan = { type: "ins", id: [2, "x"], after: [99, "ghost"], value: "b" };
    const after = { type: "ins", id: [3, "x"], after: [2, "x"], value: "c" };
    ws.send(JSON.stringify({ type: "ops", ops: [ok, orphan, after] }));
    await until(() => inbox.length === 3);
    expect(inbox[1]).toMatchObject({ type: "reject", opIds: ["ins:2@x", "ins:3@x"] });
    expect((inbox[1] as { message: string }).message).toContain("99@ghost");
    expect(inbox[2]).toMatchObject({ type: "ack", opIds: ["ins:1@x"], seq: 1 });
    expect(store.opCount(doc)).toBe(1); // only "a" survived
    expect(server.rooms.get(doc)!.rga.pendingCount).toBe(0);
    ws.close();
  });

  it("stores a resent op once and does not relay it twice", async () => {
    const doc = freshDoc();
    const a = await rawSocket(server, doc);
    const b = await rawSocket(server, doc);
    const op = { type: "ins", id: [1, "x"], after: null, value: "a" };
    a.ws.send(JSON.stringify({ type: "ops", ops: [op] }));
    a.ws.send(JSON.stringify({ type: "ops", ops: [op] }));
    await until(() => b.inbox.length === 2);
    await server.rooms.get(doc)!.idle();
    expect(store.opCount(doc)).toBe(1);
    expect(b.inbox.length).toBe(2); // init + one relay
    // ...but the duplicate IS acked, so a client that lost the first ack can forget it.
    expect(ofType(a.inbox, "ack").map((m) => m.opIds)).toEqual([["ins:1@x"], ["ins:1@x"]]);
    a.ws.close();
    b.ws.close();
  });
});

describe("snapshots", () => {
  it("are taken every N ops and a restarted server rebuilds the same text", async () => {
    const doc = freshDoc();
    const a = await connect(server, doc, "a");
    a.type(0, "abcdefghijkl"); // 12 ops, snapshotEvery = 5
    await until(() => store.opCount(doc) === 12);
    await server.rooms.get(doc)!.idle();
    expect(store.snapshotSeq(doc)).toBe(12); // one batch of 12 crossed the threshold
    a.type(12, "mn");
    a.del(0, 1);
    await until(() => store.opCount(doc) === 15);
    a.client.close();

    // Same store, brand new server process: load = snapshot + ops after it.
    const server2 = await startServer({ store, snapshotEvery: 5 });
    try {
      const b = await connect(server2, doc, "b");
      expect(b.view()).toBe("bcdefghijklmn");
      b.client.close();
    } finally {
      await server2.close();
    }
  });
});

describe("convergence over real sockets (property-based)", () => {
  type Action = { who: number; ins: boolean; at: number; text: string; len: number; pause: boolean; toggle: boolean };
  const action = (n: number) =>
    fc.record({
      who: fc.nat(n - 1),
      ins: fc.boolean(),
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      text: fc.constantFrom("a", "b", "xy", "😀", "é", "hello "),
      len: fc.integer({ min: 1, max: 3 }),
      pause: fc.boolean(),
      // ~1 in 6 actions flips this client between online and offline
      toggle: fc.integer({ min: 0, max: 5 }).map((x) => x === 0),
    });

  it("all clients and the server end with identical text, even with clients going offline", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }).chain((n) =>
          fc.tuple(fc.constant(n), fc.array(action(n), { minLength: 1, maxLength: 40 })),
        ),
        async ([n, actions]: [number, Action[]]) => {
          const doc = freshDoc();
          const clients = await Promise.all(Array.from({ length: n }, (_, i) => connect(server, doc, `r${i}`)));
          try {
            for (const act of actions) {
              const c = clients[act.who]!;
              if (act.toggle) c.client.setOnline(!c.client.online);
              const len = [...c.text()].length;
              if (act.ins || len === 0) c.type(Math.min(len, Math.floor(act.at * (len + 1))), act.text);
              else {
                const at = Math.min(len - 1, Math.floor(act.at * len));
                c.del(at, Math.min(act.len, len - at));
              }
              // Sometimes let the network deliver, sometimes keep typing concurrently.
              if (act.pause) await new Promise((r) => setTimeout(r, 0));
            }
            for (const c of clients) c.client.setOnline(true);
            await until(() => {
              // The room may have been unloaded and reloaded while everyone was offline.
              const expected = server.rooms.get(doc)!.rga.toString();
              for (const c of clients) {
                expect(c.client.status).toBe("online");
                expect(c.client.pendingCount).toBe(0);
                expect(c.text()).toBe(expected);
                expect(c.view()).toBe(expected);
              }
            }, 8000, "convergence");
            for (const c of clients) expect(c.errors).toEqual([]);
            const room = server.rooms.get(doc)!;

            // And a newcomer built from the snapshot agrees too.
            const late = await connect(server, doc, "late");
            expect(late.view()).toBe(room.rga.toString());
            late.client.close();
          } finally {
            for (const c of clients) c.client.close();
          }
        },
      ),
      { numRuns: Number(process.env.NET_RUNS ?? 40), endOnFailure: process.env.NO_SHRINK === "1" },
    );
  }, 120_000);
});

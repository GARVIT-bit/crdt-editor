import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RGA, type Op } from "@crdt-editor/crdt";
import { MemoryDocStorage } from "@crdt-editor/protocol";
import { startServer, type RunningServer } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { connect, ofType, rawSocket, until, type TestClient } from "./helpers.js";

let store: MemoryStore;
let server: RunningServer;
let docN = 0;
const freshDoc = () => `off${++docN}`;

beforeAll(async () => {
  store = new MemoryStore();
  server = await startServer({ store, snapshotEvery: 5 });
});
afterAll(async () => {
  await server.close();
});

/** Wait until every client shows the same text as `expected()`, with nothing left in any outbox. */
async function converged(clients: TestClient[], expected: () => string, ms = 5000) {
  await until(
    () => {
      for (const c of clients) {
        expect(c.client.status).toBe("online");
        expect(c.client.pendingCount).toBe(0);
        expect(c.text()).toBe(expected());
        expect(c.view()).toBe(expected());
      }
    },
    ms,
    "convergence",
  );
}

describe("hello / catchup", () => {
  it("rejects ops sent before hello", async () => {
    const doc = freshDoc();
    const { inbox, sendOps } = await rawSocket(server, doc, "skip");
    sendOps([{ type: "ins", id: [1, "x"], after: null, value: "a" }]);
    await until(() => inbox.length === 1);
    expect(inbox[0]).toMatchObject({ type: "error", message: "send hello first" });
    expect(store.opCount(doc)).toBe(0);
  });

  it("sends only the missed ops, or a snapshot when the client knows nothing or too much", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    alice.type(0, "abcdef");
    await until(() => alice.client.pendingCount === 0);

    const behind = await rawSocket(server, doc, 4);
    expect(behind.inbox[0]).toMatchObject({ type: "catchup", seq: 6 });
    const missed = ofType(behind.inbox, "catchup")[0]!.ops;
    expect(missed.map((o) => o.seq)).toEqual([5, 6]);
    expect(missed.map((o) => (o.op.type === "ins" ? o.op.value : ""))).toEqual(["e", "f"]);

    const upToDate = await rawSocket(server, doc, 6);
    expect(upToDate.inbox[0]).toEqual({ type: "catchup", ops: [], seq: 6 });

    const fromTheFuture = await rawSocket(server, doc, 99); // e.g. the server database was reset
    expect(fromTheFuture.inbox[0]).toMatchObject({ type: "init", seq: 6 });

    for (const s of [behind, upToDate, fromTheFuture]) s.ws.close();
    alice.client.close();
  });

  it("knows its seq after reloading a room whose snapshot covers every op (regression)", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    alice.type(0, "abcdef"); // 6 ops >= snapshotEvery (5): snapshot at seq 6, no ops after it
    await until(() => alice.client.pendingCount === 0);
    alice.client.close();
    await until(() => !server.rooms.has(doc), 3000, "room unload");

    const late = await rawSocket(server, doc, 0); // reloads the room from the snapshot
    expect(late.inbox[0]).toMatchObject({ type: "catchup", seq: 6 });
    expect(ofType(late.inbox, "catchup")[0]!.ops).toHaveLength(6);
    late.ws.close();
  });

  it("sends a snapshot instead of a catch-up that would be too long", async () => {
    const small = await startServer({ store: new MemoryStore(), catchupLimit: 2 });
    try {
      const doc = freshDoc();
      const alice = await connect(small, doc, "alice");
      alice.type(0, "abcd");
      await until(() => alice.client.pendingCount === 0);
      expect((await rawSocket(small, doc, 1)).inbox[0]).toMatchObject({ type: "init", seq: 4 });
      expect((await rawSocket(small, doc, 2)).inbox[0]).toMatchObject({ type: "catchup", seq: 4 });
      alice.client.close();
    } finally {
      await small.close();
    }
  });
});

describe("offline editing", () => {
  it("both users edit while offline and everything merges on reconnect", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.type(0, "Skills: TS");
    await converged([alice, bob], () => alice.text());

    alice.client.setOnline(false);
    bob.client.setOnline(false);
    alice.type(10, ", React");
    bob.type(0, "## ");
    bob.del(3, 1); // the "S"
    expect(alice.client.pendingCount).toBe(7);
    expect(bob.client.pendingCount).toBe(4);

    alice.client.setOnline(true);
    bob.client.setOnline(true);
    await converged([alice, bob], () => server.rooms.get(doc)!.rga.toString());
    expect(alice.text()).toBe("## kills: TS, React");
    alice.client.close();
    bob.client.close();
  });

  it("offline edits survive a reload (same storage, new client) and reach the server", async () => {
    const doc = freshDoc();
    const storage = new MemoryDocStorage();
    // A tab that never manages to connect (nothing listens on this port).
    const tab1 = await connect(server, doc, "tab", { storage, port: 1, waitOnline: false });
    tab1.type(0, "drafted on a plane");
    tab1.client.close(); // tab closed: snapshot + outbox are in storage
    await until(() => storage.outbox.length === 18 && storage.snapshot !== null);

    const tab2 = await connect(server, doc, "tab", { storage });
    expect(tab2.view()).toBe("drafted on a plane");
    await converged([tab2], () => "drafted on a plane");
    expect(store.opCount(doc)).toBe(18);
    await until(() => storage.outbox.length === 0, 3000, "storage outbox to empty");
    tab2.client.close();
  });

  it("re-sending ops whose ack was lost stores them once and empties the outbox", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const author = new RGA("lost-ack");
    const ops = author.localInsertText(0, "once");
    const firstTry = await rawSocket(server, doc);
    firstTry.sendOps(ops); // stored and acked once...
    await until(() => ofType(firstTry.inbox, "ack").length === 1);
    firstTry.ws.close();
    expect(store.opCount(doc)).toBe(4);

    // ...but pretend the ack never arrived: the ops are still in this storage's outbox.
    const storage = new MemoryDocStorage();
    await storage.appendOutbox(ops);
    const retry = await connect(server, doc, "retry", { storage });
    await converged([alice, retry], () => "once");
    expect(store.opCount(doc)).toBe(4);
    expect(storage.outbox).toEqual([]);
    alice.client.close();
    retry.client.close();
  });

  it("drops ops the server rejects, resyncs, and keeps the good ones", async () => {
    const doc = freshDoc();
    const good: Op = { type: "ins", id: [1, "bad-client"], after: null, value: "k" };
    const orphan: Op = { type: "ins", id: [2, "bad-client"], after: [42, "ghost"], value: "?" };
    const child: Op = { type: "ins", id: [3, "bad-client"], after: [2, "bad-client"], value: "!" };
    const storage = new MemoryDocStorage();
    await storage.appendOutbox([good, orphan, child]);

    const c = await connect(server, doc, "c", { storage, waitOnline: false });
    await until(() => c.errors.length > 0, 3000, "reject");
    expect(c.errors[0]).toContain("42@ghost");
    await converged([c], () => "k");
    expect(storage.outbox).toEqual([]);
    expect(store.opCount(doc)).toBe(1);
    c.client.close();
  });

  it("two tabs sharing one browser storage both edit offline; nothing is lost", async () => {
    const doc = freshDoc();
    const seed = await connect(server, doc, "seed");
    seed.type(0, "base");
    await until(() => seed.client.pendingCount === 0);

    const storage = new MemoryDocStorage();
    const tab1 = await connect(server, doc, "t1", { storage });
    tab1.client.setOnline(false);
    tab1.type(4, " one");
    await tab1.client.saveNow();
    const tab2 = await connect(server, doc, "t2", { storage, waitOnline: false });
    tab2.client.setOnline(false);
    expect(tab2.text()).toBe("base one"); // loaded tab1's offline edit from storage
    tab2.type(0, "two ");

    tab1.client.setOnline(true);
    tab2.client.setOnline(true);
    await converged([seed, tab1, tab2], () => "two base one");
    await until(() => storage.outbox.length === 0);
    for (const c of [seed, tab1, tab2]) c.client.close();
  });

  it("survives a full server restart mid-session with edits made during the outage", async () => {
    const own = new MemoryStore();
    const first = await startServer({ store: own });
    const port = first.port;
    const doc = freshDoc();
    const alice = await connect(first, doc, "alice");
    const bob = await connect(first, doc, "bob");
    alice.type(0, "v1");
    await converged([alice, bob], () => "v1");

    await first.close(); // server dies
    await until(() => alice.client.status !== "online" && bob.client.status !== "online");
    alice.type(2, " alice");
    bob.type(0, "bob ");

    const second = await startServer({ store: own, port }); // comes back on the same port
    try {
      await converged([alice, bob], () => second.rooms.get(doc)?.rga.toString() ?? "<no room>", 10_000);
      expect(alice.text()).toBe("bob v1 alice");
    } finally {
      alice.client.close();
      bob.client.close();
      await second.close();
    }
  });
});

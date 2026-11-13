/**
 * One contract, two stores. If MemoryStore passes the same tests as
 * MongoStore, the server tests (which use MemoryStore) mean something.
 *
 * Mongo tests use MONGO_URL (default mongodb://127.0.0.1:27017) and a
 * throwaway database that is dropped afterwards. They are skipped, loudly,
 * if MongoDB isn't reachable.
 */
import { afterAll, describe, expect, it } from "vitest";
import { RGA, type Op } from "@crdt-editor/crdt";
import { startServer } from "../src/app.js";
import { MongoStore } from "../src/mongoStore.js";
import { MemoryStore, type OpStore } from "../src/store.js";
import { connect, until } from "./helpers.js";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017";
const TEST_DB = `crdt_editor_test_${process.pid}_${Date.now()}`;

let mongo: MongoStore | null = null;
try {
  mongo = await MongoStore.connect(MONGO_URL, TEST_DB, 2000);
} catch (err) {
  console.warn(`\n  MongoDB not reachable at ${MONGO_URL}; skipping Mongo tests (${String(err)})\n`);
}

afterAll(async () => {
  if (!mongo) return;
  await mongo.db.dropDatabase();
  await mongo.close();
});

const ins = (c: number, r: string, after: Op["id"] | null, value: string): Op => ({
  type: "ins",
  id: [c, r],
  after,
  value,
});

let n = 0;
const fresh = () => `contract${++n}`;

function storeContract(name: string, getStore: () => OpStore) {
  describe(`${name} store contract`, () => {
    it("assigns increasing seqs and returns ops in input order", async () => {
      const s = getStore();
      const doc = fresh();
      const a = await s.append(doc, [ins(1, "a", null, "x"), ins(2, "a", [1, "a"], "y")]);
      const b = await s.append(doc, [{ type: "del", id: [1, "a"] }]);
      expect(a.map((o) => o.op)).toEqual([ins(1, "a", null, "x"), ins(2, "a", [1, "a"], "y")]);
      const seqs = [...a, ...b].map((o) => o.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(3);
    });

    it("skips duplicates, across batches and inside one batch", async () => {
      const s = getStore();
      const doc = fresh();
      const op = ins(1, "a", null, "x");
      expect(await s.append(doc, [op])).toHaveLength(1);
      const again = await s.append(doc, [op, ins(2, "a", [1, "a"], "y"), op]);
      expect(again.map((o) => o.op.id)).toEqual([[2, "a"]]);
      expect((await s.load(doc)).ops).toHaveLength(2);
    });

    it("loads the latest snapshot plus only the ops after it", async () => {
      const s = getStore();
      const doc = fresh();
      const rga = new RGA("w");
      await s.append(doc, rga.localInsertText(0, "abc"));
      await s.saveSnapshot(doc, 1, { replica: "old", clock: 1, nodes: [] });
      const [last] = (await s.append(doc, rga.localInsertText(3, "d"))).slice(-1);
      const snap = rga.snapshot();
      const seq = last!.seq;
      await s.saveSnapshot(doc, seq, snap);
      await s.append(doc, rga.localInsertText(4, "ef"));

      const loaded = await s.load(doc);
      expect(loaded.snapshot).toEqual(snap);
      expect(loaded.snapshotSeq).toBe(seq);
      expect(loaded.ops).toHaveLength(2); // only "e" and "f"
      expect(loaded.ops.every((o) => o.seq > seq)).toBe(true);
      // snapshot + tail rebuilds the full document
      const rebuilt = RGA.fromSnapshot(loaded.snapshot!, "reader");
      for (const { op } of loaded.ops) rebuilt.apply(op);
      expect(rebuilt.toString()).toBe("abcdef");
    });

    it("opsSince returns exactly the ops after a seq, in order", async () => {
      const s = getStore();
      const doc = fresh();
      const rga = new RGA("w");
      const all = await s.append(doc, rga.localInsertText(0, "hello"));
      const cut = all[1]!.seq;
      const since = await s.opsSince(doc, cut);
      expect(since.map((o) => o.seq)).toEqual(all.slice(2).map((o) => o.seq));
      expect(since.map((o) => o.op)).toEqual(all.slice(2).map((o) => o.op));
      expect(await s.opsSince(doc, all[4]!.seq)).toEqual([]);
      expect(await s.opsSince(doc, 0)).toHaveLength(5);
      expect(await s.headSeq(doc)).toBe(all[4]!.seq);
      expect(await s.headSeq(fresh())).toBe(0);
    });

    it("keeps every snapshot as a version: newest first, with labels and sizes", async () => {
      const s = getStore();
      const doc = fresh();
      const rga = new RGA("w");
      await s.append(doc, rga.localInsertText(0, "v1"));
      await s.saveSnapshot(doc, 2, rga.snapshot());
      await s.append(doc, rga.localInsertText(2, " and v2"));
      await s.saveSnapshot(doc, 9, rga.snapshot(), "Before interview");

      const versions = await s.listVersions(doc);
      expect(versions.map((v) => [v.seq, v.label, v.chars])).toEqual([
        [9, "Before interview", 9],
        [2, null, 2],
      ]);
      expect(Date.parse(versions[0]!.createdAt)).not.toBeNaN();
      expect(await s.listVersions(doc, 1)).toHaveLength(1);

      expect(RGA.fromSnapshot((await s.getVersion(doc, 2))!).toString()).toBe("v1");
      expect(await s.getVersion(doc, 5)).toBeNull();
      expect((await s.load(doc)).snapshotSeq).toBe(9); // latest still used for loading
    });

    it("keeps documents separate", async () => {
      const s = getStore();
      const [d1, d2] = [fresh(), fresh()];
      await s.append(d1, [ins(1, "a", null, "x")]);
      expect((await s.load(d2)).ops).toEqual([]);
      // the same op in another document is NOT a duplicate
      expect(await s.append(d2, [ins(1, "a", null, "x")])).toHaveLength(1);
    });

    it("never hands out the same seq to concurrent appends", async () => {
      const s = getStore();
      const doc = fresh();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => s.append(doc, [ins(i + 1, "c", null, "z"), ins(i + 1, "d", null, "z")])),
      );
      const seqs = results.flat().map((o) => o.seq);
      expect(seqs).toHaveLength(40);
      expect(new Set(seqs).size).toBe(40);
    });
  });
}

storeContract("memory", () => new MemoryStore());

describe.skipIf(!mongo)("MongoDB", () => {
  storeContract("mongo", () => mongo!);

  it.skipIf(!mongo?.transactional)(
    "replica set: two servers appending concurrently get gap-free seqs (transactional appends)",
    async () => {
      const other = await MongoStore.connect(MONGO_URL, TEST_DB); // a second "server"
      try {
        expect(other.transactional).toBe(true);
        const doc = fresh();
        const batches = Array.from({ length: 30 }, (_, i) => [ins(i + 1, i % 2 ? "x" : "y", null, "z")]);
        // Both stores hammer the same document; one batch is sent by both (a resend).
        const results = await Promise.all([
          ...batches.map((ops, i) => (i % 2 ? mongo! : other).append(doc, ops)),
          mongo!.append(doc, batches[0]!),
          other.append(doc, batches[0]!),
        ]);
        const seqs = results.flat().map((o) => o.seq).sort((a, b) => a - b);
        expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1)); // no gaps, no duplicates
        expect(await mongo!.headSeq(doc)).toBe(30);
      } finally {
        await other.close();
      }
    },
  );

  it("has the unique (docId, opId) and (docId, seq) indexes", async () => {
    const names = (await mongo!.ops.indexes()).map((i) => [i.name, i.unique ?? false]);
    expect(names).toContainEqual(["docId_opId_unique", true]);
    expect(names).toContainEqual(["docId_seq", false]);
  });

  it("a document survives a full server restart (new process, new connection)", async () => {
    const doc = fresh();
    const server1 = await startServer({ store: mongo!, snapshotEvery: 4 });
    const alice = await connect(server1, doc, "alice");
    alice.type(0, "Garvit, CSE 😀");
    alice.del(0, 1);
    const expected = alice.text();
    await until(() => server1.rooms.get(doc)?.rga.toString() === expected);
    alice.client.close();
    await server1.close();

    // Fresh connection pool + fresh server: nothing shared in memory.
    const store2 = await MongoStore.connect(MONGO_URL, TEST_DB);
    const server2 = await startServer({ store: store2, snapshotEvery: 4 });
    try {
      expect(await store2.snapshots.countDocuments({ docId: doc })).toBeGreaterThan(0);
      const bob = await connect(server2, doc, "bob");
      expect(bob.view()).toBe("arvit, CSE 😀");
      bob.client.close();
    } finally {
      await server2.close();
      await store2.close();
    }
  });
});

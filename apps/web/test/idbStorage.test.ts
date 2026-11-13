import "fake-indexeddb/auto"; // real IndexedDB semantics in Node (globals: indexedDB, IDBKeyRange)
import { describe, expect, it } from "vitest";
import { RGA } from "@crdt-editor/crdt";
import { DocClient, opId, type SocketLike } from "@crdt-editor/protocol";
import { IdbDocStorage } from "../src/idbStorage.js";

let n = 0;
const freshDb = () => `test-db-${++n}`;

describe("IdbDocStorage", () => {
  it("returns null for a document never stored", async () => {
    expect(await new IdbDocStorage("doc", freshDb()).load()).toBeNull();
  });

  it("keeps the outbox in insertion order (12+ ops, so string-sorting would break it)", async () => {
    const db = freshDb();
    const s = new IdbDocStorage("doc", db);
    await s.load();
    const rga = new RGA("a");
    const ops = rga.localInsertText(0, "hello world!!");
    await s.appendOutbox(ops.slice(0, 5));
    await s.appendOutbox(ops.slice(5));
    const loaded = await new IdbDocStorage("doc", db).load();
    expect(loaded!.outbox).toEqual(ops);
    expect(loaded!.snapshot).toBeNull();

    await s.removeOutbox(ops.slice(0, 3).map(opId));
    expect((await new IdbDocStorage("doc", db).load())!.outbox).toEqual(ops.slice(3));
  });

  it("keeps documents apart", async () => {
    const db = freshDb();
    const a = new IdbDocStorage("a", db);
    await a.load();
    await a.appendOutbox(new RGA("x").localInsertText(0, "a"));
    expect(await new IdbDocStorage("b", db).load()).toBeNull();
  });

  it("never replaces a snapshot with one covering an older lastSeq", async () => {
    const db = freshDb();
    const s = new IdbDocStorage("doc", db);
    await s.load();
    const snap = (text: string) => {
      const r = new RGA("w");
      r.localInsertText(0, text);
      return r.snapshot();
    };
    await s.saveSnapshot(snap("never synced"), null);
    await s.saveSnapshot(snap("seq 5"), 5);
    await s.saveSnapshot(snap("stale tab"), 3); // ignored
    await s.saveSnapshot(snap("stale null"), null); // ignored
    let loaded = await new IdbDocStorage("doc", db).load();
    expect(loaded!.lastSeq).toBe(5);
    expect(RGA.fromSnapshot(loaded!.snapshot!).toString()).toBe("seq 5");
    await s.saveSnapshot(snap("same seq, newer local edits"), 5); // equal is allowed
    loaded = await new IdbDocStorage("doc", db).load();
    expect(RGA.fromSnapshot(loaded!.snapshot!).toString()).toBe("same seq, newer local edits");
  });

  it("two tabs append without overwriting each other; an ack removes every copy", async () => {
    const db = freshDb();
    const tab1 = new IdbDocStorage("doc", db);
    const tab2 = new IdbDocStorage("doc", db);
    await Promise.all([tab1.load(), tab2.load()]);
    const ops1 = new RGA("t1").localInsertText(0, "one");
    const ops2 = new RGA("t2").localInsertText(0, "two");
    await Promise.all([tab1.appendOutbox(ops1), tab2.appendOutbox(ops2)]);
    await tab2.appendOutbox([ops1[0]!]); // tab2 also holds a copy of tab1's first op
    expect((await tab1.load())!.outbox).toHaveLength(7);
    await tab1.removeOutbox(ops1.map(opId));
    expect((await tab2.load())!.outbox).toEqual(ops2);
  });
});

/** A socket that never connects: the client stays offline. */
function deadSocket(): SocketLike {
  return { readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
}

describe("DocClient + IndexedDB", () => {
  it("offline edits survive closing and reopening the tab", async () => {
    const db = freshDb();
    const open = () =>
      new DocClient({ url: "ws://offline", storage: new IdbDocStorage("resume", db), createSocket: deadSocket });

    const tab1 = open();
    await tab1.ready;
    expect(tab1.rga!.toString()).toBe("");
    tab1.send(tab1.rga!.localInsertText(0, "Garvit Mundra"));
    tab1.send(tab1.rga!.localDeleteRange(0, 7));
    tab1.close();
    await tab1.saveNow();

    const tab2 = open();
    await tab2.ready;
    expect(tab2.rga!.toString()).toBe("Mundra");
    expect(tab2.pendingCount).toBe(20); // 13 inserts + 7 deletes, all still unacked
    expect(tab2.rga!.replica).not.toBe(tab1.rga!.replica); // new tab, new replica id
    tab2.close();
  });
});

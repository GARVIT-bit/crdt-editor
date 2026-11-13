/**
 * IndexedDB persistence for one document (DocStorage implementation).
 *
 *   docs    { docId, snapshot, lastSeq }               keyPath docId
 *   outbox  { key (auto), docId, opId, op }            index byDoc, byDocOp [docId, opId]
 *
 * Every write method creates its transaction synchronously, before any
 * await, so IndexedDB runs them in call order. saveSnapshot's transaction
 * also covers the outbox store, which forces it to run after any outbox
 * write created earlier: the saved snapshot can never contain an op whose
 * outbox record isn't written yet.
 */
import type { Op, Snapshot } from "@crdt-editor/crdt";
import { opId, seqRank, type DocStorage, type StoredDoc } from "@crdt-editor/protocol";

const DB_VERSION = 1;

interface DocRecord {
  docId: string;
  snapshot: Snapshot;
  lastSeq: number | null;
}

interface OutboxRecord {
  key?: number;
  docId: string;
  opId: string;
  op: Op;
}

export function openDocDb(name = "crdt-editor", factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("docs", { keyPath: "docId" });
      const outbox = db.createObjectStore("outbox", { keyPath: "key", autoIncrement: true });
      outbox.createIndex("byDoc", "docId");
      outbox.createIndex("byDocOp", ["docId", "opId"]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export class IdbDocStorage implements DocStorage {
  private db: IDBDatabase | null = null;

  constructor(
    private readonly docId: string,
    private readonly dbName = "crdt-editor",
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private requireDb(): IDBDatabase {
    if (!this.db) throw new Error("IdbDocStorage: call load() first");
    return this.db;
  }

  async load(): Promise<StoredDoc | null> {
    this.db ??= await openDocDb(this.dbName, this.factory);
    const tx = this.db.transaction(["docs", "outbox"], "readonly");
    const docReq = tx.objectStore("docs").get(this.docId);
    // Index order = [docId, primary key]: insertion order within this doc.
    const outReq = tx.objectStore("outbox").index("byDoc").getAll(this.docId);
    await done(tx);
    const doc = docReq.result as DocRecord | undefined;
    const outbox = (outReq.result as OutboxRecord[]).map((r) => r.op);
    if (!doc && outbox.length === 0) return null;
    return { snapshot: doc?.snapshot ?? null, lastSeq: doc?.lastSeq ?? null, outbox };
  }

  appendOutbox(ops: Op[]): Promise<void> {
    const tx = this.requireDb().transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    for (const op of ops) store.add({ docId: this.docId, opId: opId(op), op } satisfies OutboxRecord);
    return done(tx);
  }

  removeOutbox(opIds: string[]): Promise<void> {
    const tx = this.requireDb().transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    const index = store.index("byDocOp");
    for (const id of opIds) {
      // Several tabs may hold the same op: remove every copy.
      const req = index.getAllKeys(IDBKeyRange.only([this.docId, id]));
      req.onsuccess = () => {
        for (const key of req.result) store.delete(key);
      };
    }
    return done(tx);
  }

  saveSnapshot(snapshot: Snapshot, lastSeq: number | null): Promise<void> {
    // "outbox" is in scope only for ordering (see header comment).
    const tx = this.requireDb().transaction(["docs", "outbox"], "readwrite");
    const docs = tx.objectStore("docs");
    const req = docs.get(this.docId);
    req.onsuccess = () => {
      const existing = req.result as DocRecord | undefined;
      // Another tab already saved newer server state: keep it (our outbox ops are safe in "outbox").
      if (existing && seqRank(existing.lastSeq) > seqRank(lastSeq)) return;
      docs.put({ docId: this.docId, snapshot, lastSeq } satisfies DocRecord);
    };
    return done(tx);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

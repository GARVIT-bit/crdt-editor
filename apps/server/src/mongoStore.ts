/**
 * MongoDB op log.
 *
 *   ops        { docId, seq, opId, op }   unique (docId, opId), index (docId, seq)
 *   snapshots  { docId, seq, snapshot, createdAt, label, chars }   index (docId, seq desc)
 *   counters   { _id: docId, seq }        next seq per document
 *
 * - seq comes from an atomic $inc on the doc's counter, so two server
 *   processes appending to the same document (Phase 6) never get the same seq.
 * - Re-sent ops are filtered out before seqs are reserved, so seqs have no gaps.
 * - On a replica set, each append is a transaction: seq order == commit order
 *   across servers (Phase 6). The unique (docId, opId) index is the backstop:
 *   a duplicate that slips through fails with error 11000 and is skipped.
 * - Snapshots are never overwritten; old ones become version history (Phase 5).
 */
import { MongoBulkWriteError, MongoClient, type ClientSession, type Collection, type Db } from "mongodb";
import type { Op, Snapshot } from "@crdt-editor/crdt";
import { opId, type SeqOp } from "@crdt-editor/protocol";
import { visibleChars, type LoadedDoc, type OpStore, type VersionInfo } from "./store.js";

interface OpDoc {
  docId: string;
  seq: number;
  opId: string;
  op: Op;
}

interface SnapshotDoc {
  docId: string;
  seq: number;
  snapshot: Snapshot;
  createdAt: Date;
  label: string | null;
  /** Stored so the history list doesn't have to load every snapshot. */
  chars: number;
}

interface CounterDoc {
  _id: string;
  seq: number;
}

const DUPLICATE_KEY = 11000;

export class MongoStore implements OpStore {
  readonly ops: Collection<OpDoc>;
  readonly snapshots: Collection<SnapshotDoc>;
  readonly counters: Collection<CounterDoc>;

  private constructor(
    private readonly client: MongoClient,
    readonly db: Db,
  ) {
    this.ops = db.collection<OpDoc>("ops");
    this.snapshots = db.collection<SnapshotDoc>("snapshots");
    this.counters = db.collection<CounterDoc>("counters");
  }

  /** True when connected to a replica set: appends then run in transactions. */
  transactional = false;

  static async connect(url: string, dbName: string, timeoutMs = 5000): Promise<MongoStore> {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: timeoutMs });
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    const hello = await client.db("admin").command({ hello: 1 });
    store.transactional = typeof hello.setName === "string";
    await store.ensureIndexes();
    return store;
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.ops.createIndex({ docId: 1, opId: 1 }, { unique: true, name: "docId_opId_unique" }),
      this.ops.createIndex({ docId: 1, seq: 1 }, { name: "docId_seq" }),
      this.snapshots.createIndex({ docId: 1, seq: -1 }, { name: "docId_seq_desc" }),
    ]);
  }

  async load(docId: string): Promise<LoadedDoc> {
    const snap = await this.snapshots.findOne({ docId }, { sort: { seq: -1 } });
    const snapshotSeq = snap?.seq ?? 0;
    return { snapshot: snap?.snapshot ?? null, snapshotSeq, ops: await this.opsSince(docId, snapshotSeq) };
  }

  async opsSince(docId: string, afterSeq: number): Promise<SeqOp[]> {
    // Served by the (docId, seq) index.
    const rows = await this.ops
      .find({ docId, seq: { $gt: afterSeq } }, { projection: { _id: 0, seq: 1, op: 1 } })
      .sort({ seq: 1 })
      .toArray();
    return rows.map((r) => ({ seq: r.seq, op: r.op }));
  }

  async headSeq(docId: string): Promise<number> {
    // Highest COMMITTED op (served by the (docId, seq) index). Not the counter:
    // without transactions the counter can run ahead of what is visible.
    const top = await this.ops.findOne({ docId }, { sort: { seq: -1 }, projection: { _id: 0, seq: 1 } });
    return top?.seq ?? 0;
  }

  async append(docId: string, ops: Op[]): Promise<SeqOp[]> {
    if (ops.length === 0) return [];
    if (!this.transactional) return this.appendOnce(docId, ops);
    // Replica set: counter $inc + inserts in ONE transaction. Two servers appending
    // to the same doc conflict on the counter document, so the driver retries one of
    // them after the other commits: seq order == commit order, with no gaps.
    const session = this.client.startSession();
    try {
      let stored: SeqOp[] = [];
      await session.withTransaction(async () => {
        stored = await this.appendOnce(docId, ops, session);
      });
      return stored;
    } finally {
      await session.endSession();
    }
  }

  /** Dedupe, reserve exactly as many seqs as there are new ops, insert. */
  private async appendOnce(docId: string, ops: Op[], session?: ClientSession): Promise<SeqOp[]> {
    // Drop duplicates (within the batch and already stored) BEFORE reserving seqs,
    // so a re-sent op doesn't burn a seq number and leave a gap.
    const fresh = new Map<string, Op>();
    for (const op of ops) if (!fresh.has(opId(op))) fresh.set(opId(op), op);
    const existing = await this.ops
      .find({ docId, opId: { $in: [...fresh.keys()] } }, { projection: { _id: 0, opId: 1 }, session })
      .toArray();
    for (const { opId: id } of existing) fresh.delete(id);
    if (fresh.size === 0) return [];

    const counter = await this.counters.findOneAndUpdate(
      { _id: docId },
      { $inc: { seq: fresh.size } },
      { upsert: true, returnDocument: "after", session },
    );
    const first = counter!.seq - fresh.size + 1;
    const rows: OpDoc[] = [...fresh].map(([id, op], i) => ({ docId, seq: first + i, opId: id, op }));

    let duplicates = new Set<number>();
    try {
      // ordered: false = keep inserting after a duplicate instead of stopping.
      await this.ops.insertMany(rows, { ordered: false, session });
    } catch (err) {
      // Only reachable without transactions: another server inserted the same op
      // between our check and our insert. Leaves a seq gap that rooms skip over.
      if (session || !(err instanceof MongoBulkWriteError)) throw err;
      const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
      if (writeErrors.some((e) => e.code !== DUPLICATE_KEY)) throw err;
      duplicates = new Set(writeErrors.map((e) => e.index));
    }
    return rows.filter((_, i) => !duplicates.has(i)).map((r) => ({ seq: r.seq, op: r.op }));
  }

  async saveSnapshot(docId: string, seq: number, snapshot: Snapshot, label?: string): Promise<void> {
    await this.snapshots.insertOne({
      docId,
      seq,
      snapshot,
      createdAt: new Date(),
      label: label ?? null,
      chars: visibleChars(snapshot),
    });
  }

  async listVersions(docId: string, limit = 100): Promise<VersionInfo[]> {
    const rows = await this.snapshots
      .find({ docId }, { projection: { _id: 0, seq: 1, createdAt: 1, label: 1, chars: 1 } })
      .sort({ seq: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
    return rows.map((r) => ({ seq: r.seq, createdAt: r.createdAt.toISOString(), label: r.label ?? null, chars: r.chars ?? 0 }));
  }

  async getVersion(docId: string, seq: number): Promise<Snapshot | null> {
    const row = await this.snapshots.findOne({ docId, seq }, { projection: { _id: 0, snapshot: 1 } });
    return row?.snapshot ?? null;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

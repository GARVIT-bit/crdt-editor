/**
 * Where ops are persisted. The server only talks to this interface, so the
 * in-memory store (tests, quick dev) and MongoStore are interchangeable.
 *
 * Snapshots are never overwritten: every one (automatic every N ops, or
 * named by a user) is a version in the document's history.
 */
import type { Op, Snapshot } from "@crdt-editor/crdt";
import { opId, type SeqOp } from "@crdt-editor/protocol";

export interface LoadedDoc {
  /** Latest snapshot, or null if none was ever taken. */
  snapshot: Snapshot | null;
  /** The seq the snapshot covers (0 if none). The doc's seq is max(this, last op's seq). */
  snapshotSeq: number;
  /** Every op with seq > the snapshot's seq, in seq order. */
  ops: SeqOp[];
}

export interface VersionInfo {
  seq: number;
  createdAt: string; // ISO date
  /** Set for versions a user saved by name; null for automatic ones. */
  label: string | null;
  /** Visible characters in that version. */
  chars: number;
}

export interface OpStore {
  /** Latest snapshot + all ops after it. */
  load(docId: string): Promise<LoadedDoc>;
  /**
   * Append ops to the doc's log. Ops already stored (same opId) are skipped.
   * Returns only the newly stored ops, with their assigned seq, in input order.
   */
  append(docId: string, ops: Op[]): Promise<SeqOp[]>;
  /** Every op with seq > afterSeq, in seq order (reconnect catch-up). */
  opsSince(docId: string, afterSeq: number): Promise<SeqOp[]>;
  /** Highest seq stored for the doc (0 if none). Cheap: used for anti-entropy checks. */
  headSeq(docId: string): Promise<number>;
  /** Remember that `snapshot` contains every op with seq <= `seq`. */
  saveSnapshot(docId: string, seq: number, snapshot: Snapshot, label?: string): Promise<void>;
  /** Saved versions, newest first. */
  listVersions(docId: string, limit?: number): Promise<VersionInfo[]>;
  /** The snapshot saved at `seq`, or null. */
  getVersion(docId: string, seq: number): Promise<Snapshot | null>;
  close(): Promise<void>;
}

/** Visible characters in a snapshot, without building an RGA. */
export function visibleChars(snapshot: Snapshot): number {
  let n = 0;
  for (const node of snapshot.nodes) if (!node.deleted) n++;
  return n;
}

interface MemSnapshot {
  seq: number;
  snapshot: Snapshot;
  label: string | null;
  createdAt: Date;
}

interface MemDoc {
  seq: number;
  ops: SeqOp[];
  opIds: Set<string>;
  snapshots: MemSnapshot[];
}

export class MemoryStore implements OpStore {
  private docs = new Map<string, MemDoc>();

  private doc(docId: string): MemDoc {
    let d = this.docs.get(docId);
    if (!d) {
      d = { seq: 0, ops: [], opIds: new Set(), snapshots: [] };
      this.docs.set(docId, d);
    }
    return d;
  }

  private latest(d: MemDoc): MemSnapshot | null {
    let best: MemSnapshot | null = null;
    for (const s of d.snapshots) if (!best || s.seq >= best.seq) best = s;
    return best;
  }

  async load(docId: string): Promise<LoadedDoc> {
    const d = this.doc(docId);
    const snap = this.latest(d);
    const after = snap?.seq ?? 0;
    return {
      snapshot: snap ? structuredClone(snap.snapshot) : null,
      snapshotSeq: after,
      ops: structuredClone(d.ops.filter((o) => o.seq > after)),
    };
  }

  async append(docId: string, ops: Op[]): Promise<SeqOp[]> {
    const d = this.doc(docId);
    const stored: SeqOp[] = [];
    for (const op of ops) {
      const key = opId(op);
      if (d.opIds.has(key)) continue;
      d.opIds.add(key);
      const entry = { seq: ++d.seq, op: structuredClone(op) };
      d.ops.push(entry);
      stored.push(entry);
    }
    return stored;
  }

  async opsSince(docId: string, afterSeq: number): Promise<SeqOp[]> {
    return structuredClone(this.doc(docId).ops.filter((o) => o.seq > afterSeq));
  }

  async headSeq(docId: string): Promise<number> {
    return this.doc(docId).seq;
  }

  async saveSnapshot(docId: string, seq: number, snapshot: Snapshot, label?: string): Promise<void> {
    this.doc(docId).snapshots.push({ seq, snapshot: structuredClone(snapshot), label: label ?? null, createdAt: new Date() });
  }

  async listVersions(docId: string, limit = 100): Promise<VersionInfo[]> {
    return [...this.doc(docId).snapshots]
      .reverse()
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((s) => ({ seq: s.seq, createdAt: s.createdAt.toISOString(), label: s.label, chars: visibleChars(s.snapshot) }));
  }

  async getVersion(docId: string, seq: number): Promise<Snapshot | null> {
    const s = this.doc(docId).snapshots.find((x) => x.seq === seq);
    return s ? structuredClone(s.snapshot) : null;
  }

  async close(): Promise<void> {}

  /** Test helper: total ops in the log. */
  opCount(docId: string): number {
    return this.docs.get(docId)?.ops.length ?? 0;
  }

  /** Test helper: seq of the latest snapshot. */
  snapshotSeq(docId: string): number | null {
    const d = this.docs.get(docId);
    return d ? (this.latest(d)?.seq ?? null) : null;
  }
}

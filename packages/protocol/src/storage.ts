/**
 * Local persistence for one document on one device.
 *
 * Stored state = a snapshot (+ the lastSeq it covers) and an outbox of local
 * ops the server hasn't acked yet. Loading = snapshot, then apply the outbox
 * (duplicates are no-ops). The outbox is a list of individual records, so
 * several tabs can add to it without overwriting each other.
 *
 * Implementations must perform writes in call order (IndexedDB does this
 * when each call creates its transaction synchronously).
 */
import type { Op, Snapshot } from "@crdt-editor/crdt";
import { opId } from "./index.js";

export interface StoredDoc {
  snapshot: Snapshot | null;
  /** Every server op with seq <= lastSeq is in the snapshot. null = never synced. */
  lastSeq: number | null;
  /** Unacked local ops, in the order they were made. */
  outbox: Op[];
}

export interface DocStorage {
  /** null if nothing was ever stored for this document. */
  load(): Promise<StoredDoc | null>;
  appendOutbox(ops: Op[]): Promise<void>;
  removeOutbox(opIds: string[]): Promise<void>;
  /** Ignored if the stored snapshot already covers a higher lastSeq (another tab saved newer state). */
  saveSnapshot(snapshot: Snapshot, lastSeq: number | null): Promise<void>;
}

/** Rank for comparing lastSeq values: null (never synced) is older than any seq. */
export function seqRank(seq: number | null): number {
  return seq ?? -1;
}

export class MemoryDocStorage implements DocStorage {
  snapshot: Snapshot | null = null;
  lastSeq: number | null = null;
  outbox: Op[] = [];

  async load(): Promise<StoredDoc | null> {
    if (this.snapshot === null && this.outbox.length === 0) return null;
    return structuredClone({ snapshot: this.snapshot, lastSeq: this.lastSeq, outbox: this.outbox });
  }

  async appendOutbox(ops: Op[]): Promise<void> {
    this.outbox.push(...structuredClone(ops));
  }

  async removeOutbox(opIds: string[]): Promise<void> {
    const gone = new Set(opIds);
    this.outbox = this.outbox.filter((op) => !gone.has(opId(op)));
  }

  async saveSnapshot(snapshot: Snapshot, lastSeq: number | null): Promise<void> {
    if (this.snapshot !== null && seqRank(this.lastSeq) > seqRank(lastSeq)) return;
    this.snapshot = structuredClone(snapshot);
    this.lastSeq = lastSeq;
  }
}

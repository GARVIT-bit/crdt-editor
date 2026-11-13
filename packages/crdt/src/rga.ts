/**
 * RGA (Replicated Growable Array): a sequence CRDT for collaborative text.
 *
 * The document is a list of nodes, one per character ever typed. Each node
 * remembers the character it was typed AFTER (its anchor). Deleted characters
 * stay as invisible "tombstones" because a concurrent insert may still use
 * them as an anchor.
 *
 * The one rule that makes every replica agree:
 *   to insert X after anchor A, start right after A and skip every node whose
 *   ID is greater than X's ID; insert X before the first node with a smaller ID.
 * Nodes with larger IDs were typed at the same anchor with higher priority
 * (or typed after them), so they belong before X. Because the final position
 * depends only on IDs, the order in which ops arrive doesn't matter.
 */
import { compareId, idKey, LamportClock, sameId, type Id } from "./id.js";

export type InsertOp = { type: "ins"; id: Id; after: Id | null; value: string };
export type DeleteOp = { type: "del"; id: Id };
export type Op = InsertOp | DeleteOp;

/** What changed in the visible text, so an editor (CodeMirror) can update. */
export type Effect =
  | { type: "insert"; index: number; value: string }
  | { type: "delete"; index: number };

interface Node {
  id: Id;
  value: string;
  deleted: boolean;
}

export interface Snapshot {
  replica: string;
  clock: number;
  nodes: { id: Id; value: string; deleted: boolean }[];
}

export class RGA {
  readonly replica: string;
  private readonly clock = new LamportClock();
  private nodes: Node[] = [];
  private byKey = new Map<string, Node>();
  /** Ops that arrived before the character they refer to (network reordering). */
  private pending: Op[] = [];

  constructor(replica: string) {
    if (!replica) throw new Error("replica id required");
    this.replica = replica;
  }

  // ------------------------------------------------------------ local edits

  /** Insert one character at a visible index. Returns the op to broadcast. */
  localInsert(index: number, value: string): InsertOp {
    if ([...value].length !== 1) throw new Error("insert one character at a time");
    const after = index === 0 ? null : this.idAtVisible(index - 1);
    const op: InsertOp = { type: "ins", id: [this.clock.tick(), this.replica], after, value };
    this.integrateInsert(op);
    return op;
  }

  /** Insert a string; each character anchors to the previous one. */
  localInsertText(index: number, text: string): InsertOp[] {
    return [...text].map((ch, i) => this.localInsert(index + i, ch));
  }

  /** Delete the visible character at index. Returns the op to broadcast. */
  localDelete(index: number): DeleteOp {
    const op: DeleteOp = { type: "del", id: this.idAtVisible(index) };
    this.integrateDelete(op);
    return op;
  }

  localDeleteRange(index: number, length: number): DeleteOp[] {
    const ids = Array.from({ length }, (_, i) => this.idAtVisible(index + i));
    return ids.map((id) => {
      const op: DeleteOp = { type: "del", id };
      this.integrateDelete(op);
      return op;
    });
  }

  // ------------------------------------------------------------ remote ops

  /**
   * Apply an op from another replica. Safe to call twice with the same op
   * (idempotent) and in any order: an op whose anchor hasn't arrived yet is
   * buffered until it can be placed.
   */
  apply(op: Op): Effect[] {
    const effects: Effect[] = [];
    this.pending.push(op);
    // Keep draining: applying one op may unblock others waiting on it.
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const next = this.pending[i]!;
        if (!this.isReady(next)) continue;
        this.pending.splice(i, 1);
        i--;
        progress = true;
        const effect = next.type === "ins" ? this.integrateInsert(next) : this.integrateDelete(next);
        if (effect) effects.push(effect);
      }
    }
    return effects;
  }

  /** True if this replica has integrated the character with this ID (deleted or not). */
  has(id: Id): boolean {
    return this.byKey.has(idKey(id));
  }

  private isReady(op: Op): boolean {
    if (op.type === "ins") return op.after === null || this.byKey.has(idKey(op.after));
    return this.byKey.has(idKey(op.id));
  }

  // ------------------------------------------------------------ core logic

  private integrateInsert(op: InsertOp): Effect | null {
    if (this.byKey.has(idKey(op.id))) return null;      // duplicate delivery: no-op
    this.clock.observe(op.id[0]);

    let i = 0;
    if (op.after !== null) {
      i = this.indexOfNode(op.after) + 1;
    }
    // THE RGA RULE: skip nodes with a larger ID (they win the tie at this anchor).
    while (i < this.nodes.length && compareId(this.nodes[i]!.id, op.id) > 0) i++;

    const node: Node = { id: op.id, value: op.value, deleted: false };
    this.nodes.splice(i, 0, node);
    this.byKey.set(idKey(op.id), node);
    return { type: "insert", index: this.visibleIndexBefore(i), value: op.value };
  }

  private integrateDelete(op: DeleteOp): Effect | null {
    const node = this.byKey.get(idKey(op.id));
    if (!node || node.deleted) return null;             // already deleted: no-op
    const index = this.visibleIndexBefore(this.indexOfNode(node.id));
    node.deleted = true;                                // tombstone: keep it as an anchor
    return { type: "delete", index };
  }

  // ------------------------------------------------------------ index <-> id

  /** ID of the visible character at index. O(n); a tree makes this O(log n). */
  idAtVisible(index: number): Id {
    let seen = 0;
    for (const n of this.nodes) {
      if (n.deleted) continue;
      if (seen === index) return n.id;
      seen++;
    }
    throw new RangeError(`index ${index} out of range (length ${seen})`);
  }

  private indexOfNode(id: Id): number {
    const i = this.nodes.findIndex((n) => sameId(n.id, id));
    if (i < 0) throw new Error(`unknown id ${idKey(id)}`);
    return i;
  }

  /** Number of visible characters before nodes[i]. */
  private visibleIndexBefore(i: number): number {
    let count = 0;
    for (let k = 0; k < i; k++) if (!this.nodes[k]!.deleted) count++;
    return count;
  }

  // ------------------------------------------------------------ cursors

  /**
   * A cursor stored as "after this character" instead of a number, so it
   * stays next to the same character when others type earlier in the text.
   * null = start of document.
   */
  cursorAt(index: number): Id | null {
    return index === 0 ? null : this.idAtVisible(index - 1);
  }

  /** Visible index of a cursor anchor. Works even if that character was deleted. */
  cursorIndex(anchor: Id | null): number {
    if (anchor === null) return 0;
    const node = this.byKey.get(idKey(anchor));
    if (!node) return 0;
    const i = this.indexOfNode(anchor);
    return this.visibleIndexBefore(i) + (node.deleted ? 0 : 1);
  }

  // ------------------------------------------------------------ inspection

  toString(): string {
    let out = "";
    for (const n of this.nodes) if (!n.deleted) out += n.value;
    return out;
  }

  get length(): number {
    let count = 0;
    for (const n of this.nodes) if (!n.deleted) count++;
    return count;
  }

  /** Total nodes including tombstones: the memory cost of history. */
  get size(): number {
    return this.nodes.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get clockValue(): number {
    return this.clock.value;
  }

  /** Node IDs in document order: two converged replicas have identical lists. */
  order(): string[] {
    return this.nodes.map((n) => idKey(n.id));
  }

  // ------------------------------------------------------------ persistence

  snapshot(): Snapshot {
    return {
      replica: this.replica,
      clock: this.clock.value,
      nodes: this.nodes.map((n) => ({ id: n.id, value: n.value, deleted: n.deleted })),
    };
  }

  /** Load a snapshot under a (possibly new) replica ID, e.g. a fresh browser tab. */
  static fromSnapshot(snap: Snapshot, replica: string = snap.replica): RGA {
    const doc = new RGA(replica);
    for (const n of snap.nodes) {
      const node: Node = { id: [n.id[0], n.id[1]], value: n.value, deleted: n.deleted };
      doc.nodes.push(node);
      doc.byKey.set(idKey(node.id), node);
    }
    doc.clock.observe(snap.clock);
    return doc;
  }
}

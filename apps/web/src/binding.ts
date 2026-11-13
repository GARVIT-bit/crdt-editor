/**
 * CodeMirror 6 <-> RGA binding.
 *
 *   local:  CodeMirror transaction -> rga.localDelete/localInsert -> ops to send
 *   remote: ops -> rga.apply() -> effects -> one CodeMirror transaction
 *
 * Remote transactions are tagged with the `remote` annotation so the update
 * listener doesn't turn them back into ops (that would echo forever), and
 * they're kept out of undo history so Ctrl+Z only undoes YOUR typing.
 *
 * Units trap: CodeMirror positions count UTF-16 code units ("😀".length === 2),
 * but the RGA has one node per code point ([..."😀"].length === 1). Every
 * position crossing the boundary goes through cpLength / cpToPos.
 */
import { Annotation, ChangeSet, Text, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Effect, Op, RGA } from "@crdt-editor/crdt";
import type { Edit } from "@crdt-editor/protocol";

/** Marks transactions that came from the network. */
export const remote = Annotation.define<boolean>();

// ------------------------------------------------------------ UTF-16 <-> code points

function isPairAt(s: string, i: number): boolean {
  const hi = s.charCodeAt(i);
  if (hi < 0xd800 || hi > 0xdbff || i + 1 >= s.length) return false;
  const lo = s.charCodeAt(i + 1);
  return lo >= 0xdc00 && lo <= 0xdfff;
}

/** Number of code points in s (same as [...s].length, without allocating). */
export function cpLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += isPairAt(s, i) ? 2 : 1) n++;
  return n;
}

/** CodeMirror position of the cp-th code point. O(cp), not O(document). */
export function cpToPos(doc: Text, cp: number): number {
  const s = doc.sliceString(0, Math.min(doc.length, cp * 2));
  let i = 0;
  for (let n = 0; n < cp; n++) {
    if (i >= s.length) throw new RangeError(`code point ${cp} is past the end of the document`);
    i += isPairAt(s, i) ? 2 : 1;
  }
  return i;
}

// ------------------------------------------------------------ local -> ops

/**
 * Apply a local CodeMirror transaction to the RGA and return the ops to send.
 *
 * iterChanges reports each changed range with fromA (old doc) and fromB (new
 * doc). We apply them in order, so when we reach a change, everything before
 * it already looks like the NEW doc: its RGA index is the code-point length
 * of newDoc[0 .. fromB).
 *
 * Remote transactions return no ops: they are already in the RGA.
 */
export function opsFromTransaction(rga: RGA, tr: Transaction): Op[] {
  if (!tr.docChanged || tr.annotation(remote)) return [];
  const ops: Op[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    const index = cpLength(tr.newDoc.sliceString(0, fromB));
    const deleted = cpLength(tr.startState.doc.sliceString(fromA, toA));
    if (deleted > 0) ops.push(...rga.localDeleteRange(index, deleted));
    const text = inserted.toString();
    if (text.length > 0) ops.push(...rga.localInsertText(index, text));
  });
  return ops;
}

// ------------------------------------------------------------ remote -> changes

/**
 * Turn RGA effects into one CodeMirror ChangeSet. Each effect's index is
 * relative to the text AFTER the previous effects, so we build the set step
 * by step and compose, instead of dispatching hundreds of transactions.
 */
export function changesFromEffects(doc: Text, effects: Effect[]): ChangeSet {
  let changes = ChangeSet.empty(doc.length);
  let text = doc;
  for (const e of effects) {
    const from = cpToPos(text, e.index);
    const spec: ChangeSpec =
      e.type === "insert" ? { from, insert: e.value } : { from, to: from + (isPairAt(text.sliceString(from, from + 2), 0) ? 2 : 1) };
    const step = ChangeSet.of(spec, text.length);
    changes = changes.compose(step);
    text = step.apply(text);
  }
  return changes;
}

/**
 * A diff (see protocol/diff.ts) as CodeMirror changes in the CURRENT document's
 * coordinates. Dispatched as a normal local transaction, so the binding turns
 * it into ops like any typing: that's how "restore version" works.
 */
export function changesFromEdits(edits: Edit[]): ChangeSpec[] {
  const specs: ChangeSpec[] = [];
  let pos = 0;
  for (const e of edits) {
    if (e.op === "eq") pos += e.text.length;
    else if (e.op === "del") {
      specs.push({ from: pos, to: pos + e.text.length });
      pos += e.text.length;
    } else specs.push({ from: pos, insert: e.text });
  }
  return specs;
}

/** Transaction annotations for anything that came from the network. */
export const remoteAnnotations = [remote.of(true), Transaction.addToHistory.of(false)];

export function applyRemoteEffects(view: EditorView, effects: Effect[]): void {
  view.dispatch({ changes: changesFromEffects(view.state.doc, effects), annotations: remoteAnnotations });
}

/** Replace the whole document (first join or resync), keeping the cursor roughly in place. */
export function replaceDocument(view: EditorView, text: string): void {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: head },
    annotations: remoteAnnotations,
  });
}

/** Editor extension: forward every local change to the RGA and out to the network. */
export function crdtBinding(getRga: () => RGA | null, send: (ops: Op[]) => void): Extension {
  return EditorView.updateListener.of((update) => {
    const rga = getRga();
    if (!rga) return; // editor is read-only until the first init, so this shouldn't happen
    for (const tr of update.transactions) send(opsFromTransaction(rga, tr));
  });
}

/**
 * Minimal character diff (Myers, O((N+M)·D)) over code points, and helpers
 * to turn it into RGA ops. Used to restore old versions and by the AI bot:
 * "make the text look like X" becomes the smallest set of inserts/deletes,
 * so concurrent edits by other people elsewhere in the text survive.
 */
import type { Op, RGA } from "@crdt-editor/crdt";

export type Edit = { op: "eq" | "del" | "ins"; text: string };

/**
 * Edit script turning `a` into `b`. If the texts differ in more than `maxD`
 * places, falls back to one replace of the differing middle (still correct,
 * just not minimal) to bound time and memory.
 */
export function diffText(a: string, b: string, maxD = 2000): Edit[] {
  const A = [...a];
  const B = [...b];
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);

  const out: Edit[] = [];
  const push = (op: Edit["op"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };

  push("eq", A.slice(0, pre).join(""));
  const mid = myers(midA, midB, maxD);
  if (mid) for (const [op, ch] of mid) push(op, ch);
  else {
    push("del", midA.join(""));
    push("ins", midB.join(""));
  }
  push("eq", A.slice(A.length - suf).join(""));
  return out;
}

/** Myers' greedy algorithm with a trace for backtracking. null if D > maxD. */
function myers(a: string[], b: string[], maxD: number): [Edit["op"], string][] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = the part of v that iteration d reads (indices -d-1 .. d+1).
  const trace: Int32Array[] = [];
  let found = -1;

  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const edits: [Edit["op"], string][] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push(["eq", a[x - 1]!]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push(["ins", b[y - 1]!]);
      else edits.push(["del", a[x - 1]!]);
      x = prevX;
      y = prevY;
    }
  }
  return edits.reverse();
}

/** Apply an edit script to a replica as LOCAL edits; returns the ops to send. */
export function applyEdits(rga: RGA, edits: Edit[]): Op[] {
  const ops: Op[] = [];
  let i = 0;
  for (const e of edits) {
    const n = [...e.text].length;
    if (e.op === "eq") i += n;
    else if (e.op === "del") ops.push(...rga.localDeleteRange(i, n));
    else {
      ops.push(...rga.localInsertText(i, e.text));
      i += n;
    }
  }
  return ops;
}

/** Make `rga` read `target` with the fewest character ops. */
export function opsToMatch(rga: RGA, target: string): Op[] {
  return applyEdits(rga, diffText(rga.toString(), target));
}

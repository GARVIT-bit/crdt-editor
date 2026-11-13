import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareId, RGA, type Effect, type Op } from "../src/index.js";

/** Apply editor effects to a plain string, the way CodeMirror would. */
function applyEffects(text: string, effects: Effect[]): string {
  for (const e of effects) {
    text = e.type === "insert"
      ? text.slice(0, e.index) + e.value + text.slice(e.index)
      : text.slice(0, e.index) + text.slice(e.index + 1);
  }
  return text;
}

/** Deterministic shuffle so a failing property run can be replayed from its seed. */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ------------------------------------------------------------------ unit tests

describe("ids", () => {
  it("orders by counter, then replica", () => {
    expect(compareId([1, "b"], [2, "a"])).toBeLessThan(0);
    expect(compareId([2, "a"], [2, "b"])).toBeLessThan(0);
    expect(compareId([2, "a"], [2, "a"])).toBe(0);
  });
});

describe("single replica", () => {
  it("inserts at start, middle and end, and deletes", () => {
    const doc = new RGA("a");
    doc.localInsertText(0, "hlo");
    doc.localInsert(1, "e");
    doc.localInsert(3, "l");
    expect(doc.toString()).toBe("hello");
    doc.localDelete(0);
    doc.localDeleteRange(3, 1);
    expect(doc.toString()).toBe("ell");
    expect(doc.size).toBe(5);              // tombstones stay
    expect(doc.length).toBe(3);
  });

  it("rejects out-of-range indexes", () => {
    const doc = new RGA("a");
    expect(() => doc.localDelete(0)).toThrow(RangeError);
  });
});

describe("two replicas", () => {
  it("sync typed text", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    for (const op of a.localInsertText(0, "hello")) b.apply(op);
    expect(b.toString()).toBe("hello");
  });

  it("converge on concurrent inserts at the same position", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    const base = a.localInsertText(0, "ac");
    base.forEach((op) => b.apply(op));
    const fromA = a.localInsert(1, "X");   // both type at index 1 at the same time
    const fromB = b.localInsert(1, "Y");
    a.apply(fromB);
    b.apply(fromA);
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toHaveLength(4);
  });

  it("does not interleave two concurrently typed words", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    const opsA = a.localInsertText(0, "Alice");
    const opsB = b.localInsertText(0, "Charlie");
    opsB.forEach((op) => a.apply(op));
    opsA.forEach((op) => b.apply(op));
    expect(a.toString()).toBe(b.toString());
    expect(["AliceCharlie", "CharlieAlice"]).toContain(a.toString());
  });

  it("keeps a concurrent insert next to a character the other user deleted", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    a.localInsertText(0, "abc").forEach((op) => b.apply(op));
    const del = a.localDelete(1);          // alice deletes "b"
    const ins = b.localInsert(2, "X");     // bob types after "b" at the same time
    a.apply(ins);
    b.apply(del);
    expect(a.toString()).toBe("aXc");
    expect(b.toString()).toBe("aXc");
  });

  it("ignores duplicate delivery", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    const ops = [...a.localInsertText(0, "hi"), a.localDelete(0)];
    for (const op of [...ops, ...ops]) b.apply(op);
    expect(b.toString()).toBe("i");
    expect(b.size).toBe(2);
  });

  it("buffers ops that arrive before their anchor", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    const ops: Op[] = [...a.localInsertText(0, "abc"), a.localDelete(0)];
    b.apply(ops[3]!);                      // delete of "a" before "a" exists
    b.apply(ops[2]!);                      // "c" before its anchor "b"
    expect(b.toString()).toBe("");
    expect(b.pendingCount).toBe(2);
    b.apply(ops[0]!);
    b.apply(ops[1]!);
    expect(b.toString()).toBe("bc");
    expect(b.pendingCount).toBe(0);
  });

  it("has() reports integrated characters, including tombstones, but not pending ones", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    const [x, y] = a.localInsertText(0, "xy");
    b.apply(y!);                           // pending: anchor x missing
    expect(b.has(y!.id)).toBe(false);
    b.apply(x!);
    expect(b.has(x!.id) && b.has(y!.id)).toBe(true);
    b.apply(a.localDelete(0));
    expect(b.has(x!.id)).toBe(true);       // tombstone still known
    expect(b.has([99, "nobody"])).toBe(false);
  });
});

describe("cursors", () => {
  it("stay next to the same character when someone types before them", () => {
    const a = new RGA("alice");
    const b = new RGA("bob");
    a.localInsertText(0, "world").forEach((op) => b.apply(op));
    const cursor = b.cursorAt(5);          // bob's cursor at the end, after "d"
    a.localInsertText(0, "hello ").forEach((op) => b.apply(op));
    expect(b.cursorIndex(cursor)).toBe(11);
  });

  it("survive deletion of their anchor character", () => {
    const doc = new RGA("a");
    doc.localInsertText(0, "abc");
    const cursor = doc.cursorAt(2);        // after "b"
    doc.localDelete(1);                    // delete "b"
    expect(doc.cursorIndex(cursor)).toBe(1);
  });
});

describe("snapshots", () => {
  it("round-trip and keep collaborating", () => {
    const a = new RGA("alice");
    a.localInsertText(0, "hey");
    a.localDelete(1);
    const json = JSON.parse(JSON.stringify(a.snapshot()));
    const restored = RGA.fromSnapshot(json, "alice-tab2");
    expect(restored.toString()).toBe("hy");
    const op = restored.localInsert(2, "!");
    expect(op.id[0]).toBeGreaterThan(a.clockValue);  // clock restored: no ID reuse
    a.apply(op);
    expect(a.toString()).toBe("hy!");
  });
});

// ------------------------------------------------------- property-based test

type Action =
  | { kind: "insert"; who: number; pos: number; ch: string }
  | { kind: "delete"; who: number; pos: number }
  | { kind: "deliver"; who: number; count: number; seed: number };

const actionArb = (replicas: number): fc.Arbitrary<Action> =>
  fc.oneof(
    fc.record({ kind: fc.constant("insert" as const), who: fc.nat(replicas - 1), pos: fc.double({ min: 0, max: 1, noNaN: true }), ch: fc.constantFrom("a", "b", "c", "x", "y", " ") }),
    fc.record({ kind: fc.constant("delete" as const), who: fc.nat(replicas - 1), pos: fc.double({ min: 0, max: 1, noNaN: true }) }),
    fc.record({ kind: fc.constant("deliver" as const), who: fc.nat(replicas - 1), count: fc.integer({ min: 1, max: 6 }), seed: fc.nat() }),
  );

describe("convergence (property-based)", () => {
  it("all replicas converge for any concurrent history, delivery order and duplicates", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }).chain((n) =>
          fc.tuple(fc.constant(n), fc.array(actionArb(n), { maxLength: 60 }), fc.nat())),
        ([n, actions, finalSeed]) => {
          const docs = Array.from({ length: n }, (_, i) => new RGA(`r${i}`));
          const mirrors = docs.map(() => "");          // what each replica's editor shows
          const log: Op[] = [];                         // every op ever made
          const delivered = docs.map(() => new Set<number>());

          const receive = (r: number, idx: number) => {
            mirrors[r] = applyEffects(mirrors[r]!, docs[r]!.apply(log[idx]!));
            delivered[r]!.add(idx);
          };

          for (const act of actions) {
            const doc = docs[act.who]!;
            if (act.kind === "insert") {
              const index = Math.floor(act.pos * (doc.length + 1)) % (doc.length + 1);
              const op = doc.localInsert(index, act.ch);
              mirrors[act.who] = applyEffects(mirrors[act.who]!, [{ type: "insert", index, value: act.ch }]);
              delivered[act.who]!.add(log.push(op) - 1);
            } else if (act.kind === "delete") {
              if (doc.length === 0) continue;
              const index = Math.floor(act.pos * doc.length) % doc.length;
              const op = doc.localDelete(index);
              mirrors[act.who] = applyEffects(mirrors[act.who]!, [{ type: "delete", index }]);
              delivered[act.who]!.add(log.push(op) - 1);
            } else {
              // partial, out-of-order delivery (may include duplicates)
              const all = log.map((_, i) => i);
              for (const idx of shuffle(all, act.seed).slice(0, act.count)) receive(act.who, idx);
            }
            // the editor view must always match the CRDT
            expect(mirrors[act.who]).toBe(doc.toString());
          }

          // finally everyone receives everything, shuffled, twice over
          docs.forEach((_, r) => {
            const all = log.map((_, i) => i);
            for (const idx of shuffle([...all, ...all], finalSeed + r)) receive(r, idx);
          });

          const texts = docs.map((d) => d.toString());
          const orders = docs.map((d) => d.order().join(","));
          for (let r = 0; r < n; r++) {
            expect(docs[r]!.pendingCount).toBe(0);
            expect(texts[r]).toBe(texts[0]);
            expect(orders[r]).toBe(orders[0]);
            expect(mirrors[r]).toBe(texts[r]);
          }
        },
      ),
      { numRuns: Number(process.env.RUNS ?? 2000) },
    );
  });
});

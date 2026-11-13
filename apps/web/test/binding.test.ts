import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { EditorState, Text, type ChangeSpec, type Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { RGA, type Op } from "@crdt-editor/crdt";
import { changesFromEffects, cpLength, cpToPos, opsFromTransaction, remoteAnnotations } from "../src/binding.js";

/** One simulated browser tab: a CodeMirror state plus its RGA replica. */
class Tab {
  state = EditorState.create({ doc: "" });
  constructor(readonly rga: RGA) {}

  /** A local edit, exactly like typing/pasting would produce. Returns ops to send. */
  edit(changes: ChangeSpec): Op[] {
    const tr = this.state.update({ changes });
    this.state = tr.state;
    return opsFromTransaction(this.rga, tr);
  }

  receive(op: Op): void {
    const effects = this.rga.apply(op);
    if (effects.length === 0) return;
    const tr = this.state.update({
      changes: changesFromEffects(this.state.doc, effects),
      annotations: remoteAnnotations,
    });
    this.state = tr.state;
    // The real update listener sees remote transactions too: they must not become ops.
    expect(opsFromTransaction(this.rga, tr)).toEqual([]);
  }

  get text(): string {
    return this.state.doc.toString();
  }
}

describe("code point helpers", () => {
  it("count emoji as one character, like the RGA does", () => {
    expect(cpLength("a😀b")).toBe(3);
    expect("a😀b".length).toBe(4);
    const doc = Text.of(["a😀b"]);
    expect([0, 1, 2, 3].map((cp) => cpToPos(doc, cp))).toEqual([0, 1, 3, 4]);
    expect(() => cpToPos(doc, 4)).toThrow(RangeError);
  });
});

describe("local edits -> ops", () => {
  it("typing, pasting and deleting produce matching RGA text", () => {
    const tab = new Tab(new RGA("a"));
    expect(tab.edit({ from: 0, insert: "Hello" })).toHaveLength(5);
    tab.edit({ from: 5, insert: " 😀 world" });
    tab.edit({ from: 0, to: 1, insert: "J" }); // replace = delete + insert
    expect(tab.text).toBe("Jello 😀 world");
    expect(tab.rga.toString()).toBe(tab.text);
  });

  it("handles one transaction with several changes (e.g. multi-cursor typing)", () => {
    const tab = new Tab(new RGA("a"));
    tab.edit({ from: 0, insert: "abc def ghi" });
    // positions refer to the document BEFORE this transaction
    tab.edit([
      { from: 0, to: 3, insert: "XY" },
      { from: 4, to: 7, insert: "😀" },
      { from: 11, insert: "!" },
    ]);
    expect(tab.text).toBe("XY 😀 ghi!");
    expect(tab.rga.toString()).toBe(tab.text);
  });
});

describe("remote ops -> editor", () => {
  it("places remote text correctly after an emoji", () => {
    const a = new Tab(new RGA("a"));
    const b = new Tab(new RGA("b"));
    for (const op of a.edit({ from: 0, insert: "😀😀" })) b.receive(op);
    for (const op of a.edit({ from: 2, insert: "x" })) b.receive(op); // between the emoji
    expect(b.text).toBe("😀x😀");
    for (const op of a.edit({ from: 3, to: 5 })) b.receive(op); // delete 2nd emoji (2 code units)
    expect(b.text).toBe("😀x");
  });

  it("keeps the other user's cursor next to the same text", () => {
    const a = new Tab(new RGA("a"));
    const b = new Tab(new RGA("b"));
    for (const op of a.edit({ from: 0, insert: "world" })) b.receive(op);
    b.state = b.state.update({ selection: { anchor: 5 } }).state; // b's cursor after "world"
    for (const op of a.edit({ from: 0, insert: "hello " })) b.receive(op);
    expect(b.text).toBe("hello world");
    expect(b.state.selection.main.head).toBe(11); // CodeMirror mapped it through the remote change
  });
});

describe("undo", () => {
  it("only undoes my own typing, never someone else's, and undo itself becomes ops", () => {
    const a = new Tab(new RGA("a"));
    const b = new Tab(new RGA("b"));
    a.state = EditorState.create({ doc: "", extensions: [history()] });
    const send = (ops: Op[]) => ops.forEach((op) => b.receive(op));

    send(a.edit({ from: 0, insert: "mine " }));
    for (const op of b.edit({ from: 5, insert: "theirs" })) a.receive(op);
    expect(a.text).toBe("mine theirs");

    let undoTr: Transaction | null = null;
    undo({ state: a.state, dispatch: (tr) => (undoTr = tr) });
    a.state = undoTr!.state;
    send(opsFromTransaction(a.rga, undoTr!));
    expect(a.text).toBe("theirs");
    expect(b.text).toBe("theirs");
    expect(a.rga.toString()).toBe("theirs");
  });
});

describe("binding convergence (property-based)", () => {
  const pieces = ["a", "B", "xyz", "😀", "é", " ", "\n", "👍🏽"];

  it("every editor always equals its RGA, and all editors converge", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3 }),
        fc.array(
          fc.record({
            who: fc.nat(2),
            kind: fc.constantFrom("insert", "delete", "replace", "multi", "deliver"),
            p: fc.double({ min: 0, max: 1, noNaN: true }),
            q: fc.double({ min: 0, max: 1, noNaN: true }),
            text: fc.constantFrom(...pieces),
            seed: fc.nat(),
          }),
          { maxLength: 30 },
        ),
        fc.nat(),
        (n, actions, finalSeed) => {
          const tabs = Array.from({ length: n }, (_, i) => new Tab(new RGA(`r${i}`)));
          const log: Op[] = [];

          for (const act of actions) {
            const tab = tabs[act.who % n]!;
            const len = cpLength(tab.text);
            const pos = (f: number) => cpToPos(tab.state.doc, Math.min(len, Math.floor(f * (len + 1))));
            const [x, y] = [pos(act.p), pos(act.q)].sort((m, k) => m - k) as [number, number];
            let ops: Op[] = [];
            if (act.kind === "insert") ops = tab.edit({ from: x, insert: act.text });
            else if (act.kind === "delete") ops = tab.edit({ from: x, to: y });
            else if (act.kind === "replace") ops = tab.edit({ from: x, to: y, insert: act.text });
            else if (act.kind === "multi") ops = tab.edit([{ from: x, insert: act.text }, { from: y, insert: "|" }]);
            else {
              // deliver a random, shuffled, possibly duplicated subset of everything so far
              for (const op of shuffle([...log, ...log], act.seed).slice(0, act.seed % (log.length + 1))) tab.receive(op);
            }
            log.push(...ops);
            for (const t of tabs) expect(t.text).toBe(t.rga.toString());
          }

          tabs.forEach((tab, i) => {
            for (const op of shuffle([...log, ...log], finalSeed + i)) tab.receive(op);
          });
          for (const t of tabs) {
            expect(t.rga.pendingCount).toBe(0);
            expect(t.text).toBe(tabs[0]!.text);
          }
        },
      ),
      { numRuns: Number(process.env.RUNS ?? 1000) },
    );
  }, 120_000); // RUNS=10000 takes ~4-8 s, over vitest's 5 s default
});

function shuffle<T>(arr: T[], seed: number): T[] {
  let s = seed || 1;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

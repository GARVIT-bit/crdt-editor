import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RGA } from "@crdt-editor/crdt";
import { applyEdits, diffText, opsToMatch, type Edit } from "../src/diff.js";

const rebuild = (edits: Edit[]) => ({
  a: edits.filter((e) => e.op !== "ins").map((e) => e.text).join(""),
  b: edits.filter((e) => e.op !== "del").map((e) => e.text).join(""),
});

/** Classic O(n·m) LCS length, the reference for "minimal". */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

const changed = (edits: Edit[]) => edits.filter((e) => e.op !== "eq").reduce((s, e) => s + [...e.text].length, 0);
const text = fc.array(fc.constantFrom("a", "b", "c", " ", "😀", "é"), { maxLength: 40 }).map((x) => x.join(""));

describe("diffText", () => {
  it("handles the obvious cases", () => {
    expect(diffText("", "")).toEqual([]);
    expect(diffText("abc", "abc")).toEqual([{ op: "eq", text: "abc" }]);
    expect(diffText("", "hi")).toEqual([{ op: "ins", text: "hi" }]);
    expect(diffText("Garvit, CSE", "Garvit M., CSE")).toEqual([
      { op: "eq", text: "Garvit" },
      { op: "ins", text: " M." },
      { op: "eq", text: ", CSE" },
    ]);
  });

  it("treats an emoji as one character", () => {
    expect(diffText("a😀b", "a😁b")).toEqual([
      { op: "eq", text: "a" },
      { op: "del", text: "😀" },
      { op: "ins", text: "😁" },
      { op: "eq", text: "b" },
    ]);
  });

  it("is a correct and minimal edit script for any pair of strings", () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const edits = diffText(a, b);
        expect(rebuild(edits)).toEqual({ a, b });
        const [A, B] = [[...a], [...b]];
        expect(changed(edits)).toBe(A.length + B.length - 2 * lcs(A, B));
      }),
      { numRuns: 2000 },
    );
  });

  it("falls back to a correct (non-minimal) replace when the texts differ too much", () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        expect(rebuild(diffText(a, b, 1))).toEqual({ a, b });
      }),
      { numRuns: 500 },
    );
  });
});

describe("opsToMatch", () => {
  it("turns a replica into the target text with one op per changed character", () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        const rga = new RGA("me");
        rga.localInsertText(0, a);
        const ops = opsToMatch(rga, b);
        expect(rga.toString()).toBe(b);
        expect(ops.length).toBe(changed(diffText(a, b)));
      }),
      { numRuns: 1000 },
    );
  });

  it("keeps a concurrent edit made elsewhere in the text", () => {
    const alice = new RGA("alice");
    const bob = new RGA("bob");
    for (const op of alice.localInsertText(0, "Skills: TS. Projects: CRDT.")) bob.apply(op);
    // Bob restores an old wording of the first sentence while Alice edits the second.
    const bobOps = opsToMatch(bob, "Skills: TypeScript. Projects: CRDT.");
    const aliceOps = applyEdits(alice, diffText(alice.toString(), "Skills: TS. Projects: CRDT editor."));
    for (const op of aliceOps) bob.apply(op);
    for (const op of bobOps) alice.apply(op);
    expect(alice.toString()).toBe("Skills: TypeScript. Projects: CRDT editor.");
    expect(bob.toString()).toBe(alice.toString());
  });
});

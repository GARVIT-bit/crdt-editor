import { describe, expect, it } from "vitest";
import { RGA } from "@crdt-editor/crdt";
import { DOC_ID_PATTERN, opId, parseClientMessage, ProtocolError } from "../src/index.js";

const raw = (x: unknown) => JSON.stringify(x);

describe("parseClientMessage", () => {
  it("accepts real ops produced by the RGA", () => {
    const doc = new RGA("alice");
    const ops = [...doc.localInsertText(0, "hé😀"), doc.localDelete(0)];
    expect(parseClientMessage(raw({ type: "ops", ops }))).toEqual({ type: "ops", ops });
  });

  it("accepts hello with null or a seq, and nothing else", () => {
    expect(parseClientMessage(raw({ type: "hello", lastSeq: null }))).toEqual({ type: "hello", lastSeq: null });
    expect(parseClientMessage(raw({ type: "hello", lastSeq: 41, x: 1 }))).toEqual({ type: "hello", lastSeq: 41 });
  });

  it("accepts presence with a cursor made of CRDT ids, or no cursor", () => {
    const cursor = { anchor: null, head: [3, "bob"] };
    expect(parseClientMessage(raw({ type: "presence", name: "Bob", color: "#aa00ff", cursor, extra: 1 }))).toEqual({
      type: "presence",
      name: "Bob",
      color: "#aa00ff",
      cursor,
    });
    expect(parseClientMessage(raw({ type: "presence", name: "Bob", color: "#aa00ff", cursor: null }))).toMatchObject({
      cursor: null,
    });
  });

  it("strips unknown fields", () => {
    const msg = parseClientMessage(
      raw({ type: "ops", evil: 1, ops: [{ type: "del", id: [1, "a"], extra: "x" }] }),
    );
    expect(msg).toEqual({ type: "ops", ops: [{ type: "del", id: [1, "a"] }] });
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", raw(42)],
    ["unknown type", raw({ type: "hack" })],
    ["empty ops", raw({ type: "ops", ops: [] })],
    ["multi-char insert", raw({ type: "ops", ops: [{ type: "ins", id: [1, "a"], after: null, value: "ab" }] })],
    ["empty insert", raw({ type: "ops", ops: [{ type: "ins", id: [1, "a"], after: null, value: "" }] })],
    ["counter 0", raw({ type: "ops", ops: [{ type: "del", id: [0, "a"] }] })],
    ["fractional counter", raw({ type: "ops", ops: [{ type: "del", id: [1.5, "a"] }] })],
    ["empty replica", raw({ type: "ops", ops: [{ type: "del", id: [1, ""] }] })],
    ["huge replica", raw({ type: "ops", ops: [{ type: "del", id: [1, "x".repeat(65)] }] })],
    ["bad anchor", raw({ type: "ops", ops: [{ type: "ins", id: [1, "a"], after: "1@a", value: "x" }] })],
    ["hello without lastSeq", raw({ type: "hello" })],
    ["hello with negative lastSeq", raw({ type: "hello", lastSeq: -1 })],
    ["hello with string lastSeq", raw({ type: "hello", lastSeq: "5" })],
    ["presence without name", raw({ type: "presence", color: "#112233", cursor: null })],
    ["presence with long name", raw({ type: "presence", name: "x".repeat(41), color: "#112233", cursor: null })],
    ["presence with css injection color", raw({ type: "presence", name: "a", color: "red;x:y", cursor: null })],
    ["presence with bad cursor", raw({ type: "presence", name: "a", color: "#112233", cursor: { anchor: 5, head: null } })],
  ])("rejects %s", (_name, input) => {
    expect(() => parseClientMessage(input)).toThrow(ProtocolError);
  });
});

describe("opId", () => {
  it("is unique per character and op type", () => {
    expect(opId({ type: "ins", id: [3, "bob"], after: null, value: "x" })).toBe("ins:3@bob");
    expect(opId({ type: "del", id: [3, "bob"] })).toBe("del:3@bob");
  });
});

describe("doc ids", () => {
  it("allow simple names only", () => {
    expect(DOC_ID_PATTERN.test("resume-2026_v2")).toBe(true);
    for (const bad of ["", "../etc", "a b", "doc:1", "x".repeat(65)]) expect(DOC_ID_PATTERN.test(bad)).toBe(false);
  });
});

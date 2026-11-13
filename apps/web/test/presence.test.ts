import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { RGA, type Op } from "@crdt-editor/crdt";
import { diffText } from "@crdt-editor/protocol";
import {
  changesFromEdits,
  changesFromEffects,
  cpLength,
  opsFromTransaction,
  remoteAnnotations,
} from "../src/binding.js";
import { colorFor, idsToPositions, peersField, selectionToIds, setPeers } from "../src/presence.js";

/** A tab: CodeMirror state + replica + the peers field. */
class Tab {
  readonly rga: RGA;
  readonly field;
  state: EditorState;
  constructor(name: string) {
    this.rga = new RGA(name);
    this.field = peersField(() => this.rga);
    this.state = EditorState.create({ doc: "", extensions: [this.field] });
  }
  edit(changes: ChangeSpec, selection?: { anchor: number; head?: number }): Op[] {
    const tr = this.state.update({ changes, selection });
    this.state = tr.state;
    return opsFromTransaction(this.rga, tr);
  }
  select(anchor: number, head = anchor) {
    this.state = this.state.update({ selection: { anchor, head } }).state;
  }
  receive(ops: Op[]) {
    const effects = ops.flatMap((op) => this.rga.apply(op));
    if (!effects.length) return;
    this.state = this.state.update({
      changes: changesFromEffects(this.state.doc, effects),
      annotations: remoteAnnotations,
    }).state;
  }
  peers() {
    return this.state.field(this.field);
  }
}

describe("presence positions", () => {
  it("a cursor sent as ids lands at the same text on another tab, and follows edits", () => {
    const alice = new Tab("alice");
    const bob = new Tab("bob");
    bob.receive(alice.edit({ from: 0, insert: "Hello 😀 world" }));
    alice.select(6, 8); // selects the emoji (2 UTF-16 units)
    const ids = selectionToIds(alice.rga, alice.state);

    bob.state = bob.state.update({ effects: setPeers.of([{ clientId: "a", name: "Alice", color: "#e11d48", cursor: ids }]) }).state;
    expect(bob.peers()[0]).toMatchObject({ anchor: 6, head: 8 });

    bob.edit({ from: 0, insert: ">> " }); // bob types before it: mapped
    expect(bob.peers()[0]).toMatchObject({ anchor: 9, head: 11 });
    bob.receive(alice.edit({ from: 0, insert: "¡" })); // alice types before it: mapped too
    expect(bob.peers()[0]).toMatchObject({ anchor: 10, head: 12 });
    // ...and mapping agrees with recomputing from the ids
    expect(idsToPositions(bob.rga, bob.state.doc, ids)).toEqual({ anchor: 10, head: 12 });
  });

  it("a cursor whose anchor character was deleted stays where the character was", () => {
    const alice = new Tab("alice");
    const bob = new Tab("bob");
    bob.receive(alice.edit({ from: 0, insert: "abcdef" }));
    alice.select(3);
    const ids = selectionToIds(alice.rga, alice.state);
    bob.receive(alice.edit({ from: 1, to: 4 })); // deletes "bcd", including the anchor "c"
    expect(idsToPositions(bob.rga, bob.state.doc, ids)).toEqual({ anchor: 1, head: 1 });
  });

  it("peers with no cursor are not drawn; ids we don't know yet go to the start", () => {
    const tab = new Tab("t");
    tab.edit({ from: 0, insert: "abc" });
    tab.state = tab.state.update({
      effects: setPeers.of([
        { clientId: "x", name: "X", color: "#000000", cursor: null },
        { clientId: "y", name: "Y", color: "#000000", cursor: { anchor: [99, "ghost"], head: [99, "ghost"] } },
      ]),
    }).state;
    expect(tab.peers().map((p) => [p.clientId, p.head])).toEqual([["y", 0]]);
  });

  it("colours are stable per name", () => {
    expect(colorFor("Garvit")).toBe(colorFor("Garvit"));
    expect(colorFor("Garvit")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("restore via diff", () => {
  const text = fc.array(fc.constantFrom("a", "b", " ", "😀", "é", "\n"), { maxLength: 30 }).map((x) => x.join(""));

  it("dispatching changesFromEdits makes editor, replica and a peer match the target", () => {
    fc.assert(
      fc.property(text, text, (current, target) => {
        const me = new Tab("me");
        const peer = new Tab("peer");
        peer.receive(me.edit({ from: 0, insert: current }));
        const edits = diffText(me.state.doc.toString(), target);
        const ops = me.edit(changesFromEdits(edits));
        peer.receive(ops);
        expect(me.state.doc.toString()).toBe(target);
        expect(me.rga.toString()).toBe(target);
        expect(peer.state.doc.toString()).toBe(target);
        const changed = edits.filter((e) => e.op !== "eq").reduce((n, e) => n + cpLength(e.text), 0);
        expect(ops).toHaveLength(changed);
      }),
      { numRuns: 1000 },
    );
  });
});

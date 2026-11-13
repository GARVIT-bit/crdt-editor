/**
 * Other people's cursors in CodeMirror.
 *
 * Presence arrives as CRDT ids ("after character X"). When it arrives we turn
 * the ids into positions using our replica; between updates CodeMirror maps
 * those positions through every change, local or remote.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { RGA } from "@crdt-editor/crdt";
import type { CursorIds } from "@crdt-editor/protocol";
import { cpLength, cpToPos } from "./binding.js";

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  cursor: CursorIds | null;
}

interface PlacedPeer extends Peer {
  anchor: number;
  head: number;
}

/** My main selection as CRDT ids, to send as presence. */
export function selectionToIds(rga: RGA, state: EditorState): CursorIds {
  const sel = state.selection.main;
  const toId = (pos: number) => rga.cursorAt(cpLength(state.doc.sliceString(0, pos)));
  return { anchor: toId(sel.anchor), head: toId(sel.head) };
}

/** Where cursor ids are in this document now. Unknown ids (not arrived yet) go to the start. */
export function idsToPositions(rga: RGA, doc: Text, cursor: CursorIds): { anchor: number; head: number } {
  const total = cpLength(doc.toString());
  const pos = (id: CursorIds["head"]) => cpToPos(doc, Math.min(total, rga.cursorIndex(id)));
  return { anchor: pos(cursor.anchor), head: pos(cursor.head) };
}

/** Replace the full list of peers (positions computed from ids against the current replica). */
export const setPeers = StateEffect.define<Peer[]>();

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  override eq(other: CaretWidget) {
    return other.name === this.name && other.color === this.color;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-peer-caret";
    caret.style.borderLeftColor = this.color;
    const label = document.createElement("span");
    label.className = "cm-peer-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }
  override ignoreEvent() {
    return true;
  }
}

export function peersField(getRga: () => RGA | null) {
  return StateField.define<PlacedPeer[]>({
    create: () => [],
    update(peers, tr) {
      let next = peers;
      if (tr.docChanged) {
        next = next.map((p) => ({ ...p, anchor: tr.changes.mapPos(p.anchor, 1), head: tr.changes.mapPos(p.head, 1) }));
      }
      for (const e of tr.effects) {
        if (!e.is(setPeers)) continue;
        const rga = getRga();
        next = e.value
          .filter((p) => p.cursor !== null && rga !== null)
          .map((p) => ({ ...p, ...idsToPositions(rga!, tr.state.doc, p.cursor!) }));
      }
      return next;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (peers): DecorationSet => {
        const ranges = [];
        for (const p of peers) {
          const from = Math.min(p.anchor, p.head);
          const to = Math.max(p.anchor, p.head);
          if (from < to) {
            ranges.push(
              Decoration.mark({ attributes: { style: `background-color: ${p.color}33` } }).range(from, to),
            );
          }
          ranges.push(Decoration.widget({ widget: new CaretWidget(p.name, p.color), side: 1 }).range(p.head));
        }
        return Decoration.set(ranges, true);
      }),
  });
}

/** Extension: peers' carets and selections, plus their styles. */
export function presenceExtension(getRga: () => RGA | null): { field: StateField<PlacedPeer[]>; extension: Extension } {
  const field = peersField(getRga);
  return {
    field,
    extension: [
      field,
      EditorView.baseTheme({
        ".cm-peer-caret": {
          position: "relative",
          borderLeft: "2px solid",
          marginLeft: "-1px",
          marginRight: "-1px",
          pointerEvents: "none",
        },
        ".cm-peer-label": {
          position: "absolute",
          top: "-1.35em",
          left: "-2px",
          fontSize: "0.7em",
          lineHeight: "1.3",
          padding: "0 4px",
          borderRadius: "3px 3px 3px 0",
          color: "#fff",
          whiteSpace: "nowrap",
          fontFamily: "system-ui, sans-serif",
        },
      }),
    ],
  };
}

const PALETTE = ["#e11d48", "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#c026d3", "#65a30d"];

/** Stable colour for a name. */
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

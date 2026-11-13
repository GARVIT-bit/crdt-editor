/**
 * Mounts CodeMirror and wires it to a DocClient. React only owns the <div>;
 * CodeMirror owns the text, the DocClient owns the replica, socket and storage.
 */
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DocClient, MemoryDocStorage, diffText, type DocStorage, type Status } from "@crdt-editor/protocol";
import { applyRemoteEffects, changesFromEdits, crdtBinding, replaceDocument } from "./binding.js";
import { IdbDocStorage } from "./idbStorage.js";
import { colorFor, presenceExtension, selectionToIds, setPeers, type Peer } from "./presence.js";

export interface EditorInfo {
  status: Status;
  replica: string | null;
  chars: number;
  pending: number;
  error: string | null;
  peers: Peer[];
}

export const initialInfo: EditorInfo = {
  status: "connecting",
  replica: null,
  chars: 0,
  pending: 0,
  error: null,
  peers: [],
};

export interface EditorHandle {
  setOnline(on: boolean): void;
  /** Make the document read `text` using the smallest set of edits (version restore). */
  restore(text: string): void;
  /** Re-announce presence (e.g. after a name change). */
  announce(): void;
}

function makeStorage(docId: string): DocStorage {
  // Private windows / old browsers may not have IndexedDB: fall back to memory.
  return typeof indexedDB === "undefined" ? new MemoryDocStorage() : new IdbDocStorage(docId);
}

export function Editor({
  docId,
  name,
  onInfo,
  handle,
}: {
  docId: string;
  name: string;
  onInfo: (info: EditorInfo) => void;
  handle: React.RefObject<EditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    const editable = new Compartment();
    let info: EditorInfo = initialInfo;
    const report = (patch: Partial<EditorInfo>) => {
      info = { ...info, ...patch };
      onInfoRef.current(info);
    };

    const peers = new Map<string, Peer>();
    const presence = presenceExtension(() => client.rga);
    const showPeers = () => {
      const list = [...peers.values()];
      view.dispatch({ effects: setPeers.of(list) });
      report({ peers: list });
    };
    const announce = () => {
      const rga = client.rga;
      if (!rga) return;
      const me = nameRef.current;
      client.setPresence({ name: me, color: colorFor(me), cursor: selectionToIds(rga, view.state) });
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          editable.of(readOnly(true)), // until the local copy has loaded
          presence.extension,
          crdtBinding(
            () => client.rga,
            (ops) => {
              client.send(ops);
              report({ chars: client.rga?.length ?? 0 });
            },
          ),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) announce();
          }),
        ],
      }),
    });

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const client: DocClient = new DocClient({
      url: `${scheme}://${location.host}/ws?doc=${encodeURIComponent(docId)}`,
      storage: makeStorage(docId),
      onInit: (rga) => {
        replaceDocument(view, rga.toString());
        view.dispatch({ effects: editable.reconfigure(readOnly(false)) }); // editable, online or not
        showPeers(); // new replica: recompute peer positions from their ids
        report({ replica: rga.replica, chars: rga.length });
        announce();
      },
      onRemote: (effects) => {
        applyRemoteEffects(view, effects);
        report({ chars: client.rga?.length ?? 0 });
      },
      onStatus: (status) => {
        if (status !== "online" && peers.size > 0) {
          peers.clear(); // stale: the server re-sends everyone after we reconnect
          showPeers();
        }
        report({ status });
      },
      onPending: (pending) => report({ pending }),
      onError: (error) => report({ error }),
      onMessage: (msg) => {
        if (msg.type === "presence") {
          peers.set(msg.clientId, { clientId: msg.clientId, name: msg.name, color: msg.color, cursor: msg.cursor });
          showPeers();
        } else if (msg.type === "presence-leave") {
          peers.delete(msg.clientId);
          showPeers();
        }
      },
    });

    handle.current = {
      setOnline: (on) => client.setOnline(on),
      announce,
      restore(text) {
        // A normal local transaction: the binding turns it into ops and sends them.
        view.dispatch({ changes: changesFromEdits(diffText(view.state.doc.toString(), text)), userEvent: "restore" });
      },
    };
    // Persist the latest snapshot when the tab is hidden or closed.
    const onHide = () => void client.saveNow();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);

    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      handle.current = null;
      client.close();
      view.destroy();
    };
  }, [docId, handle]);

  return <div className="editor" ref={host} />;
}

function readOnly(on: boolean) {
  return [EditorState.readOnly.of(on), EditorView.editable.of(!on)];
}

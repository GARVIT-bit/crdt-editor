import { useEffect, useRef, useState } from "react";
import { Editor, initialInfo, type EditorHandle, type EditorInfo } from "./Editor.js";
import { History } from "./History.js";
import { colorFor } from "./presence.js";

const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_KEY = "crdt-editor:name";

function docIdFromUrl(): string {
  const id = new URLSearchParams(location.search).get("doc") ?? "resume";
  return DOC_ID_PATTERN.test(id) ? id : "resume";
}

function initialName(): string {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
  } catch {
    /* storage blocked: fall through */
  }
  return `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
}

function statusLabel(info: EditorInfo, wantOnline: boolean): string {
  const unsynced = info.pending > 0 ? ` · ${info.pending} unsynced` : "";
  if (info.status === "online") return `Live${unsynced}`;
  if (!wantOnline) return `Offline (by choice): editing locally${unsynced}`;
  if (info.status === "connecting") return `Connecting…${unsynced}`;
  return `Offline: editing locally, reconnecting…${unsynced}`;
}

export function App() {
  const [docId] = useState(docIdFromUrl);
  const [info, setInfo] = useState<EditorInfo>(initialInfo);
  const [wantOnline, setWantOnline] = useState(true);
  const [name, setName] = useState(initialName);
  const [showHistory, setShowHistory] = useState(false);
  const handle = useRef<EditorHandle | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* ignore */
    }
    handle.current?.announce();
  }, [name]);

  const toggle = () => {
    const next = !wantOnline;
    setWantOnline(next);
    handle.current?.setOnline(next);
  };

  return (
    <div className={`app ${showHistory ? "with-history" : ""}`}>
      <header>
        <h1>{docId}</h1>
        <span className={`status status-${info.status}`}>{statusLabel(info, wantOnline)}</span>
        <button type="button" onClick={toggle}>
          {wantOnline ? "Go offline" : "Go online"}
        </button>
        <button type="button" onClick={() => setShowHistory((s) => !s)}>
          History
        </button>
        <span className="meta">
          {info.replica && <>replica <code>{info.replica}</code> · </>}
          {info.chars} chars
        </span>
      </header>
      <div className="people">
        <label className="me">
          <span className="dot" style={{ background: colorFor(name) }} />
          <input
            value={name}
            maxLength={40}
            aria-label="Your name"
            onChange={(e) => setName(e.target.value.trimStart() || "Guest")}
          />
        </label>
        {info.peers.map((p) => (
          <span key={p.clientId} className="peer" title={p.name}>
            <span className="dot" style={{ background: p.color }} />
            {p.name}
          </span>
        ))}
      </div>
      {info.error && <div className="error">{info.error}</div>}
      <main>
        <Editor docId={docId} name={name} onInfo={setInfo} handle={handle} />
        {showHistory && (
          <History docId={docId} onRestore={(text) => handle.current?.restore(text)} onClose={() => setShowHistory(false)} />
        )}
      </main>
      <footer>Open this page in a second tab to edit together. Edits made offline sync when you reconnect.</footer>
    </div>
  );
}

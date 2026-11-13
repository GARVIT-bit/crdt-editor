/**
 * Version history panel: list saved versions, preview one, restore it, or
 * save the current state under a name. Restoring is a diff applied as normal
 * edits, so it never fights with people typing at the same time.
 */
import { useCallback, useEffect, useState } from "react";

interface Version {
  seq: number;
  createdAt: string;
  label: string | null;
  chars: number;
}

export function History({ docId, onRestore, onClose }: { docId: string; onRestore: (text: string) => void; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [preview, setPreview] = useState<{ seq: number; text: string } | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const api = `/api/docs/${encodeURIComponent(docId)}/versions`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(api);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setVersions(((await res.json()) as { versions: Version[] }).versions);
      setError(null);
    } catch (err) {
      setError(`Could not load history (${String(err)}). History needs the server.`);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (seq: number) => {
    try {
      const res = await fetch(`${api}/${seq}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreview((await res.json()) as { seq: number; text: string });
    } catch (err) {
      setError(String(err));
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: label.trim() }),
    });
    if (!res.ok) return setError(`Save failed: HTTP ${res.status}`);
    setLabel("");
    await refresh();
  };

  return (
    <aside className="history">
      <div className="history-head">
        <h2>Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close history">
          ×
        </button>
      </div>
      <form onSubmit={save} className="history-save">
        <input value={label} maxLength={80} placeholder="Name this version…" onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" disabled={!label.trim()}>
          Save
        </button>
      </form>
      {error && <p className="history-error">{error}</p>}
      {versions?.length === 0 && <p className="history-empty">No versions yet. One is saved automatically every 200 edits.</p>}
      <ul>
        {versions?.map((v) => (
          <li key={`${v.seq}-${v.createdAt}`}>
            <button type="button" className={preview?.seq === v.seq ? "active" : ""} onClick={() => void open(v.seq)}>
              <strong>{v.label ?? "Auto-save"}</strong>
              <span>
                {new Date(v.createdAt).toLocaleString()} · {v.chars} chars
              </span>
            </button>
          </li>
        ))}
      </ul>
      {preview && (
        <div className="history-preview">
          <pre>{preview.text}</pre>
          <button type="button" onClick={() => onRestore(preview.text)}>
            Restore this version
          </button>
        </div>
      )}
    </aside>
  );
}

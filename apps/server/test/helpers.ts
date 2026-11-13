import { DocClient, type DocStorage, type ServerMessage } from "@crdt-editor/protocol";
import type { RunningServer } from "../src/app.js";

/** Poll until `check` stops throwing / returns true, or fail after `ms`. */
export async function until(check: () => boolean | void, ms = 3000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (check() !== false) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

export interface TestClient {
  client: DocClient;
  errors: string[];
  /** Every message the server sent this client (latest connection included). */
  messages: ServerMessage[];
  /** Mirror of what an editor would show, built only from onInit + onRemote effects. */
  view(): string;
  type(index: number, text: string): void;
  del(index: number, length: number): void;
  text(): string;
}

let replicaN = 0;

export interface ConnectOptions {
  /** Shared storage simulates the same browser profile (reload / second tab). */
  storage?: DocStorage;
  /** Wait until online (default true). */
  waitOnline?: boolean;
  /** Override the port (e.g. a server that isn't running yet). */
  port?: number;
  /**
   * Stand-in for a load balancer: each (re)connect goes to the next port that
   * `ports()` returns, starting at index `startAt`.
   */
  balance?: { ports: () => number[]; startAt?: number };
}

/** A real DocClient (same code as the browser) with a string standing in for CodeMirror. */
export async function connect(
  server: RunningServer,
  doc: string,
  name = "c",
  opts: ConnectOptions = {},
): Promise<TestClient> {
  let view = "";
  const errors: string[] = [];
  const messages: ServerMessage[] = [];
  let turn = opts.balance?.startAt ?? 0;
  const balance = opts.balance;
  const client = new DocClient({
    url: `ws://127.0.0.1:${opts.port ?? server.port}/ws?doc=${doc}`,
    createSocket: balance
      ? () => {
          const ports = balance.ports();
          const port = ports[turn++ % ports.length]!;
          return new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${doc}`) as never;
        }
      : undefined,
    storage: opts.storage,
    retryBaseMs: 20,
    saveDelayMs: 5,
    // Globally unique, readable replica ids: "alice.3"
    newReplicaId: () => `${name}.${++replicaN}`,
    onInit: (rga) => {
      view = rga.toString();
    },
    onRemote: (effects) => {
      for (const e of effects) {
        const chars = [...view];
        if (e.type === "insert") chars.splice(e.index, 0, e.value);
        else chars.splice(e.index, 1);
        view = chars.join("");
      }
    },
    onError: (m) => errors.push(m),
    onMessage: (m) => messages.push(m),
  });
  await client.ready;
  if (opts.waitOnline !== false) await until(() => client.status === "online", 3000, `${name} to join`);
  const rga = () => client.rga!;
  return {
    client,
    errors,
    messages,
    view: () => view,
    text: () => rga().toString(),
    type(index, text) {
      client.send(rga().localInsertText(index, text));
      view = rga().toString();
    },
    del(index, length) {
      client.send(rga().localDeleteRange(index, length));
      view = rga().toString();
    },
  };
}

/** A bare WebSocket for sending hand-crafted (possibly malicious) messages. Sends hello unless told not to. */
export async function rawSocket(server: RunningServer, doc: string, lastSeq: number | null | "skip" = null) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?doc=${doc}`);
  const inbox: ServerMessage[] = [];
  ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)) as ServerMessage);
  await until(() => ws.readyState === WebSocket.OPEN, 3000, "socket open");
  if (lastSeq !== "skip") {
    ws.send(JSON.stringify({ type: "hello", lastSeq }));
    await until(() => inbox.length > 0, 3000, "init/catchup");
  }
  const sendOps = (ops: unknown[]) => ws.send(JSON.stringify({ type: "ops", ops }));
  return { ws, inbox, sendOps };
}

/** Messages of one type from an inbox. */
export function ofType<T extends ServerMessage["type"]>(inbox: ServerMessage[], type: T) {
  return inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

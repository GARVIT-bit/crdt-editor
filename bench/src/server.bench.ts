/**
 * Server benchmarks, everything on THIS machine (clients and server share it,
 * so numbers are a lower bound for a real network deployment).
 *   npm run server -w @crdt-editor/bench                  in-memory op log
 *   $env:STORE="mongo"; npm run server -w @crdt-editor/bench   MongoDB op log
 *       (MONGO_URL, default mongodb://127.0.0.1:27017; uses a throwaway
 *        crdt_editor_bench_* database that is dropped afterwards)
 *
 *   latency     one writer, one reader: type a char, wait until the reader has it (p50/p99)
 *   ingest      how many ops/sec one document accepts (stored + acked), batches of 50
 *   fan-out     K readers on one document, a writer typing 20 chars/sec:
 *               delivery latency per reader per op, for growing K
 */
import { RGA, type Op } from "@crdt-editor/crdt";
import { opId, type ServerMessage } from "@crdt-editor/protocol";
import { startServer } from "../../apps/server/src/app.js";
import { MemoryStore, type OpStore } from "../../apps/server/src/store.js";
import { fmt, saveResults, summarize } from "./stats.js";

const STORE = process.env.STORE ?? "memory";
const FANOUT = (process.env.FANOUT ?? "10,50,100,250,500").split(",").map(Number);
const P99_BUDGET_MS = 100;

let store: OpStore;
let dropDb: (() => Promise<void>) | null = null;
if (STORE === "mongo") {
  const { MongoStore } = await import("../../apps/server/src/mongoStore.js");
  const db = `crdt_editor_bench_${Date.now()}`;
  const mongo = await MongoStore.connect(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017", db);
  store = mongo;
  dropDb = async () => {
    await mongo.db.dropDatabase();
    await mongo.close();
  };
} else store = new MemoryStore();

const server = await startServer({ store });
const url = (doc: string) => `ws://127.0.0.1:${server.port}/ws?doc=${doc}`;

/** A minimal raw client: hello, then hand every server message to onMessage. */
async function rawClient(doc: string, onMessage: (m: ServerMessage) => void = () => {}) {
  const ws = new WebSocket(url(doc));
  let ready = false;
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as ServerMessage;
    if (m.type === "init" || m.type === "catchup") ready = true;
    onMessage(m);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("connect failed"));
  });
  ws.send(JSON.stringify({ type: "hello", lastSeq: null }));
  while (!ready) await new Promise((r) => setTimeout(r, 2));
  return ws;
}
const sendOps = (ws: WebSocket, ops: Op[]) => ws.send(JSON.stringify({ type: "ops", ops }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ latency

async function latency(n = 1000) {
  const doc = `lat${Date.now()}`;
  const writerRga = new RGA("writer");
  let waiting: { id: string; resolve: () => void } | null = null;
  const reader = await rawClient(doc, (m) => {
    if (m.type === "ops" && waiting && m.ops.some((o) => opId(o.op) === waiting!.id)) waiting.resolve();
  });
  const writer = await rawClient(doc);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const op = writerRga.localInsert(writerRga.length, "x");
    const t = performance.now();
    await new Promise<void>((resolve) => {
      waiting = { id: opId(op), resolve };
      sendOps(writer, [op]);
    });
    samples.push(performance.now() - t);
  }
  reader.close();
  writer.close();
  return summarize(samples);
}

// ------------------------------------------------------------------ ingest

async function ingest(total = 20_000, batch = 50) {
  const doc = `ing${Date.now()}`;
  const rga = new RGA("writer");
  let acked = 0;
  const writer = await rawClient(doc, (m) => {
    if (m.type === "ack") acked += m.opIds.length;
  });
  const t = performance.now();
  for (let sent = 0; sent < total; sent += batch) {
    sendOps(writer, rga.localInsertText(rga.length, "y".repeat(batch)));
    // Keep at most 20 batches in flight, like a client with an outbox.
    while (sent + batch - acked > batch * 20) await sleep(0);
  }
  while (acked < total) await sleep(1);
  const ms = performance.now() - t;
  writer.close();
  return { ops: total, batch, opsPerSec: Math.round((total / ms) * 1000) };
}

// ------------------------------------------------------------------ fan-out

async function fanout(k: number, chars = 100, perSec = 20) {
  const doc = `fan${k}-${Date.now()}`;
  const sentAt = new Map<string, number>();
  const samples: number[] = [];
  const readers: WebSocket[] = [];
  for (let i = 0; i < k; i++) {
    readers.push(
      await rawClient(doc, (m) => {
        if (m.type !== "ops") return;
        const now = performance.now();
        for (const { op } of m.ops) {
          const t = sentAt.get(opId(op));
          if (t !== undefined) samples.push(now - t);
        }
      }),
    );
  }
  const writer = await rawClient(doc);
  const rga = new RGA("writer");
  for (let i = 0; i < chars; i++) {
    const op = rga.localInsert(rga.length, "z");
    sentAt.set(opId(op), performance.now());
    sendOps(writer, [op]);
    await sleep(1000 / perSec);
  }
  const deadline = Date.now() + 10_000;
  while (samples.length < chars * k && Date.now() < deadline) await sleep(10);
  const delivered = samples.length / (chars * k);
  for (const ws of [...readers, writer]) ws.close();
  await sleep(200);
  return { readers: k, delivered, ...summarize(samples) };
}

// ------------------------------------------------------------------ run

console.log(`server benchmarks (op log: ${STORE}), clients and server on one machine\n`);
const lat = await latency();
console.log(`edit latency writer -> server -> reader, n=${lat.n}: p50 ${fmt(lat.p50, 2)} ms, p99 ${fmt(lat.p99, 2)} ms`);
const ing = await ingest();
console.log(`ingest into one document: ${fmt(ing.opsPerSec, 0)} ops/sec (batches of ${ing.batch}, stored + acked)`);

console.log(`\nfan-out: one writer typing 20 chars/sec, K readers on the same document`);
console.log("      K   delivered   p50 ms   p99 ms   max ms");
const fan = [];
for (const k of FANOUT) {
  const r = await fanout(k);
  fan.push(r);
  console.log(
    `  ${String(k).padStart(5)}   ${fmt(r.delivered * 100, 1).padStart(8)}%  ${fmt(r.p50, 1).padStart(7)}  ${fmt(r.p99, 1).padStart(7)}  ${fmt(r.max, 1).padStart(7)}`,
  );
}
const ok = fan.filter((r) => r.delivered === 1 && r.p99 <= P99_BUDGET_MS).map((r) => r.readers);
const maxOk = ok.length ? Math.max(...ok) : 0;
console.log(`\nlargest K tested with 100% delivery and p99 <= ${P99_BUDGET_MS} ms: ${maxOk || "none"}`);

await server.close();
await dropDb?.();
console.log(`saved ${saveResults(`server-${STORE}`, { store: STORE, latency: lat, ingest: ing, fanout: fan, p99BudgetMs: P99_BUDGET_MS, maxClientsWithinBudget: maxOk })}`);
process.exit(0);

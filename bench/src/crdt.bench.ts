/**
 * CRDT micro-benchmarks: this project's RGA vs Yjs on the same workloads.
 *   npm run crdt -w @crdt-editor/bench          (N=10000 chars, 5 runs, median reported)
 *   $env:N=50000; npm run crdt -w @crdt-editor/bench
 *
 * Workloads
 *   typing-append   one char at a time at the end (how people mostly type)
 *   typing-random   one char at a time at random positions
 *   remote-apply    replay another replica's ops one by one
 *   merge           two replicas edit concurrently; per-op latency of merging B's ops into A
 *   memory          heap per document of N chars (and with half of them deleted)
 */
import * as Y from "yjs";
import { RGA, type Op } from "@crdt-editor/crdt";
import { fmt, gc, median, rng, saveResults, summarize } from "./stats.js";

const N = Number(process.env.N ?? 10_000);
const RUNS = Number(process.env.RUNS ?? 5);
const CHARS = "abcdefghijklmnopqrstuvwxyz ";

const now = () => performance.now();
const char = (r: () => number) => CHARS[Math.floor(r() * CHARS.length)]!;

/** Run fn RUNS times (after one warm-up), return the median ms. */
function time(fn: () => void): number {
  fn();
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    gc();
    const t = now();
    fn();
    runs.push(now() - t);
  }
  return median(runs);
}

const opsPerSec = (ms: number) => (N / ms) * 1000;

// ------------------------------------------------------------------ workloads

function rgaAppend() {
  const doc = new RGA("a");
  const r = rng(1);
  for (let i = 0; i < N; i++) doc.localInsert(i, char(r));
  return doc;
}
function yAppend() {
  const doc = new Y.Doc();
  const t = doc.getText("t");
  const r = rng(1);
  for (let i = 0; i < N; i++) t.insert(i, char(r));
  return doc;
}
function rgaRandom() {
  const doc = new RGA("a");
  const r = rng(2);
  for (let i = 0; i < N; i++) doc.localInsert(Math.floor(r() * (i + 1)), char(r));
}
function yRandom() {
  const doc = new Y.Doc();
  const t = doc.getText("t");
  const r = rng(2);
  for (let i = 0; i < N; i++) t.insert(Math.floor(r() * (i + 1)), char(r));
}

/** Ops / updates recorded once, replayed in the timed section. */
const rgaOps: Op[] = (() => {
  const a = new RGA("a");
  const r = rng(3);
  const ops: Op[] = [];
  for (let i = 0; i < N; i++) ops.push(a.localInsert(Math.floor(r() * (i + 1)), char(r)));
  return ops;
})();
const yUpdates: Uint8Array[] = (() => {
  const a = new Y.Doc();
  const t = a.getText("t");
  const updates: Uint8Array[] = [];
  a.on("update", (u: Uint8Array) => updates.push(u));
  const r = rng(3);
  for (let i = 0; i < N; i++) t.insert(Math.floor(r() * (i + 1)), char(r));
  return updates;
})();

function rgaRemote() {
  const b = new RGA("b");
  for (const op of rgaOps) b.apply(op);
}
function yRemote() {
  const b = new Y.Doc();
  for (const u of yUpdates) Y.applyUpdate(b, u);
}

/** Two replicas share a base of N/2 chars, then each makes N/4 concurrent random edits. */
function mergeLatency() {
  const base = Math.floor(N / 2);
  const each = Math.floor(N / 4);
  // RGA
  const seed = new RGA("seed");
  const baseOps = seed.localInsertText(0, Array.from({ length: base }, (_, i) => CHARS[i % 26]).join(""));
  const a = new RGA("a");
  const b = new RGA("b");
  for (const op of baseOps) (a.apply(op), b.apply(op));
  const r = rng(4);
  for (let i = 0; i < each; i++) a.localInsert(Math.floor(r() * (a.length + 1)), char(r));
  const bOps: Op[] = [];
  for (let i = 0; i < each; i++) {
    if (r() < 0.2 && b.length > 0) bOps.push(b.localDelete(Math.floor(r() * b.length)));
    else bOps.push(b.localInsert(Math.floor(r() * (b.length + 1)), char(r)));
  }
  gc();
  const rgaSamples = bOps.map((op) => {
    const t = now();
    a.apply(op);
    return (now() - t) * 1000; // µs
  });

  // Yjs, same shape
  const ya = new Y.Doc();
  const yb = new Y.Doc();
  ya.getText("t").insert(0, Array.from({ length: base }, (_, i) => CHARS[i % 26]).join(""));
  Y.applyUpdate(yb, Y.encodeStateAsUpdate(ya));
  const ta = ya.getText("t");
  const tb = yb.getText("t");
  const r2 = rng(4);
  for (let i = 0; i < each; i++) ta.insert(Math.floor(r2() * (ta.length + 1)), char(r2));
  const updates: Uint8Array[] = [];
  yb.on("update", (u: Uint8Array) => updates.push(u));
  for (let i = 0; i < each; i++) {
    if (r2() < 0.2 && tb.length > 0) tb.delete(Math.floor(r2() * tb.length), 1);
    else tb.insert(Math.floor(r2() * (tb.length + 1)), char(r2));
  }
  gc();
  const ySamples = updates.map((u) => {
    const t = now();
    Y.applyUpdate(ya, u);
    return (now() - t) * 1000;
  });
  return { rga: summarize(rgaSamples), yjs: summarize(ySamples), docChars: base + 2 * each };
}

/**
 * Heap bytes retained by `build()`'s result (median of 5). The result lives in a
 * module-level slot that is cleared before each baseline: with a local variable,
 * the PREVIOUS run's document can still be reachable when the baseline is taken,
 * which made every other sample read ~0 (found while validating this script).
 */
let retained: unknown = null;
function heapOf(build: () => unknown): number {
  const deltas: number[] = [];
  for (let i = 0; i < 5; i++) {
    retained = null;
    gc();
    const before = process.memoryUsage().heapUsed;
    retained = build();
    gc();
    deltas.push(process.memoryUsage().heapUsed - before);
  }
  retained = null;
  return median(deltas);
}

function withDeletes<T>(doc: T, del: (doc: T, at: number) => void, len: () => number) {
  const r = rng(5);
  for (let i = 0; i < N / 2; i++) del(doc, Math.floor(r() * len()));
  return doc;
}

// ------------------------------------------------------------------ run

console.log(`CRDT benchmarks: N=${fmt(N, 0)} chars, median of ${RUNS} runs\n`);

const results: Record<string, unknown> = { N, runs: RUNS };
const rows: [string, number, number][] = [];
for (const [name, ours, yjs] of [
  ["typing-append", rgaAppend, yAppend],
  ["typing-random", rgaRandom, yRandom],
  ["remote-apply", rgaRemote, yRemote],
] as const) {
  const a = opsPerSec(time(ours));
  const b = opsPerSec(time(yjs));
  rows.push([name, a, b]);
  results[name] = { rgaOpsPerSec: Math.round(a), yjsOpsPerSec: Math.round(b) };
}
console.log("throughput (ops/sec, higher is better)");
console.log("  workload         this RGA      Yjs");
for (const [name, a, b] of rows) console.log(`  ${name.padEnd(15)} ${fmt(a, 0).padStart(9)} ${fmt(b, 0).padStart(9)}`);

const merge = mergeLatency();
results.merge = merge;
console.log(`\nmerge latency per remote op (µs), doc of ~${fmt(merge.docChars, 0)} chars`);
console.log("            p50      p99      max");
for (const [name, s] of [["this RGA", merge.rga], ["Yjs", merge.yjs]] as const) {
  console.log(`  ${name.padEnd(9)} ${fmt(s.p50, 2).padStart(6)} ${fmt(s.p99, 2).padStart(8)} ${fmt(s.max, 2).padStart(8)}`);
}

const mem = {
  rga: heapOf(rgaAppend),
  yjs: heapOf(yAppend),
  rgaHalfDeleted: heapOf(() => {
    const d = rgaAppend();
    return withDeletes(d, (x, at) => x.localDelete(at), () => d.length);
  }),
  yjsHalfDeleted: heapOf(() => {
    const d = yAppend();
    const t = d.getText("t");
    return withDeletes(d, (_x, at) => t.delete(at, 1), () => t.length);
  }),
  rgaSnapshotBytes: Buffer.byteLength(JSON.stringify(rgaAppend().snapshot())),
  yjsUpdateBytes: Y.encodeStateAsUpdate(yAppend()).byteLength,
};
results.memory = mem;
const per10k = (bytes: number) => (bytes / N) * 10_000;
console.log(`\nmemory per 10k chars (heap, typed one char at a time)`);
console.log(`  this RGA            ${fmt(per10k(mem.rga) / 1024, 0)} KiB`);
console.log(`  Yjs                 ${fmt(per10k(mem.yjs) / 1024, 0)} KiB`);
console.log(`  this RGA, 50% deleted (tombstones kept) ${fmt(per10k(mem.rgaHalfDeleted) / 1024, 0)} KiB`);
console.log(`  Yjs, 50% deleted    ${fmt(per10k(mem.yjsHalfDeleted) / 1024, 0)} KiB`);
console.log(`  serialized: RGA snapshot JSON ${fmt(per10k(mem.rgaSnapshotBytes) / 1024, 0)} KiB, Yjs update ${fmt(per10k(mem.yjsUpdateBytes) / 1024, 0)} KiB`);

console.log(`\nsaved ${saveResults("crdt", results)}`);

/** Small helpers shared by the benchmarks: percentiles, machine info, result files. */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? NaN,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim() ?? "unknown",
    cores: cpus.length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  };
}

/** Deterministic PRNG so every run does the same work. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) throw new Error("run with node --expose-gc (use the npm scripts)");
  g();
  g();
}

/** Write bench/results/<name>-<timestamp>.json and return its path. */
export function saveResults(name: string, data: unknown): string {
  const dir = fileURLToPath(new URL("../results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}${name}-${stamp}.json`;
  writeFileSync(path, JSON.stringify({ name, date: new Date().toISOString(), machine: machine(), ...(data as object) }, null, 2));
  return path;
}

export const fmt = (x: number, digits = 1) =>
  Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: digits }) : "n/a";

/**
 * AI co-editor: an ordinary CRDT client (same DocClient as the browser).
 *
 * How an AI edit merges with people typing at the same time:
 *   1. Fork: snapshot the replica the moment the request starts (version T0).
 *   2. Ask the LLM for the revised text of T0 (takes seconds; people keep typing).
 *   3. Diff T0 -> revision on the FORK, producing ops anchored to characters of T0.
 *   4. Apply those ops to the live replica and send them like any other edit.
 * Because the ops refer to character ids, not positions, they land in the right
 * place even though the live text has moved on, and concurrent human edits
 * elsewhere survive. Nothing is overwritten wholesale.
 *
 * Two ways to use it: `revise(instruction)` (CLI), or watch mode, where anyone
 * types a line "@ai <instruction>" in the document.
 */
import { RGA, type Op } from "@crdt-editor/crdt";
import { DocClient, diffText, applyEdits, type DocStorage, type SocketLike } from "@crdt-editor/protocol";
import type { Reviser } from "./reviser.js";

export const COMMAND = /^@ai[ \t]+(.+)$/m;
export const BOT_NAME = "AI co-editor";
const BOT_COLOR = "#7c3aed";

export interface BotOptions {
  /** e.g. ws://localhost:3000/ws?doc=resume */
  url: string;
  reviser: Reviser;
  /** React to "@ai ..." lines typed into the document. */
  watch?: boolean;
  /** Quiet time after the last edit before acting on a command. Default 1500 ms. */
  debounceMs?: number;
  /** Refuse documents longer than this (characters). Default 50 000. */
  maxChars?: number;
  log?: (line: string) => void;
  createSocket?: (url: string) => SocketLike;
  storage?: DocStorage;
}

export interface EditResult {
  ops: number;
  summary: string;
}

let forkN = 0;

export class AiCoEditor {
  readonly client: DocClient;
  private busy = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BotOptions) {
    this.log = opts.log ?? ((l) => console.log(l));
    this.client = new DocClient({
      url: opts.url,
      storage: opts.storage,
      createSocket: opts.createSocket,
      onStatus: (s) => this.log(`status: ${s}`),
      onError: (m) => this.log(`error: ${m}`),
      onInit: () => this.onChange(),
      onRemote: () => this.onChange(),
    });
  }

  /** Resolves once connected and synced. */
  async ready(timeoutMs = 10_000): Promise<void> {
    await this.client.ready;
    const start = Date.now();
    while (this.client.status !== "online") {
      if (Date.now() - start > timeoutMs) throw new Error("could not connect to the server");
      await new Promise((r) => setTimeout(r, 20));
    }
    this.announce(null);
  }

  /** Apply an instruction to the whole document. */
  async revise(instruction: string): Promise<EditResult> {
    return this.run(instruction, null);
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.client.close();
  }

  // ---------------------------------------------------------------- core

  /**
   * Fork at T0, ask the reviser, merge as ops. `commandLine` (watch mode) is
   * hidden from the LLM and deleted by the same diff.
   */
  private async run(instruction: string, commandLine: string | null): Promise<EditResult> {
    if (this.busy) throw new Error("already working on an instruction");
    const live = this.client.rga;
    if (!live) throw new Error("not loaded yet");
    this.busy = true;
    this.announce("thinking…");
    try {
      // 1. Fork: a private replica at T0 with its own replica id (its ops can't clash with anyone's).
      const fork = RGA.fromSnapshot(live.snapshot(), `${live.replica}-ai${++forkN}`);
      const t0 = fork.toString();
      const maxChars = this.opts.maxChars ?? 50_000;
      if ([...t0].length > maxChars) throw new Error(`document is longer than ${maxChars} characters`);

      // 2. Ask (without the command line, if any).
      const shown = commandLine === null ? t0 : removeLine(t0, commandLine);
      const revision = await this.opts.reviser(shown, instruction);

      // 3. Diff T0 -> revision on the fork (this also deletes the command line).
      const ops: Op[] = applyEdits(fork, diffText(t0, revision.text));

      // 4. Merge into the live replica (people may have typed meanwhile) and send.
      for (const op of ops) live.apply(op);
      this.client.send(ops);
      this.log(`applied ${ops.length} op(s): ${revision.summary}`);
      return { ops: ops.length, summary: revision.summary };
    } finally {
      this.busy = false;
      this.announce(null);
    }
  }

  // ---------------------------------------------------------------- watch mode

  private onChange(): void {
    if (!this.opts.watch) return;
    if (this.debounce) clearTimeout(this.debounce);
    // Wait until people stop typing so we don't act on a half-written command.
    this.debounce = setTimeout(() => void this.checkForCommand(), this.opts.debounceMs ?? 1500);
  }

  private async checkForCommand(): Promise<void> {
    const text = this.client.rga?.toString() ?? "";
    const match = COMMAND.exec(text);
    if (!match || this.busy) return;
    const line = match[0];
    const instruction = match[1]!.trim();
    this.log(`command: ${instruction}`);
    try {
      await this.run(instruction, line);
    } catch (err) {
      this.log(`failed: ${String(err)}`);
      // Leave a visible note instead of silently doing nothing, and stop re-triggering.
      this.replaceLive(line, `@ai-failed ${instruction} (${String(err).slice(0, 120)})`);
    }
  }

  /** Small direct edit on the live replica (used for the failure note). */
  private replaceLive(oldLine: string, newLine: string): void {
    const live = this.client.rga;
    if (!live) return;
    const text = live.toString();
    if (!text.includes(oldLine)) return;
    this.client.send(applyEdits(live, diffText(text, text.replace(oldLine, newLine))));
  }

  private announce(status: string | null): void {
    this.client.setPresence({
      name: status ? `${BOT_NAME} (${status})` : BOT_NAME,
      color: BOT_COLOR,
      cursor: null,
    });
  }
}

/** Remove one line (and its line break) from a text. */
export function removeLine(text: string, line: string): string {
  const at = text.indexOf(line);
  if (at < 0) return text;
  const end = at + line.length;
  if (text[end] === "\n") return text.slice(0, at) + text.slice(end + 1);
  if (at > 0 && text[at - 1] === "\n") return text.slice(0, at - 1) + text.slice(end);
  return text.slice(0, at) + text.slice(end);
}

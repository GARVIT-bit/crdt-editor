import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/src/app.js";
import { MemoryStore } from "../../server/src/store.js";
import { connect, ofType, until, type TestClient } from "../../server/test/helpers.js";
import { AiCoEditor, BOT_NAME, removeLine } from "../src/bot.js";
import type { Reviser } from "../src/reviser.js";

let server: RunningServer;
let store: MemoryStore;
let n = 0;
const freshDoc = () => `bot${++n}`;
const bots: AiCoEditor[] = [];
const people: TestClient[] = [];

beforeAll(async () => {
  store = new MemoryStore();
  server = await startServer({ store });
});
afterAll(async () => {
  for (const b of bots) b.close();
  for (const p of people) p.client.close();
  await server.close();
});

async function setup(reviser: Reviser, watch = false) {
  const doc = freshDoc();
  const human = await connect(server, doc, "human");
  people.push(human);
  const logs: string[] = [];
  const bot = new AiCoEditor({
    url: `ws://127.0.0.1:${server.port}/ws?doc=${doc}`,
    reviser,
    watch,
    debounceMs: 50,
    log: (l) => logs.push(l),
  });
  bots.push(bot);
  await bot.ready();
  return { doc, human, bot, logs };
}

const settled = (human: TestClient, bot: AiCoEditor, text: string) =>
  until(
    () => {
      expect(human.text()).toBe(text);
      expect(bot.client.rga!.toString()).toBe(text);
      expect(bot.client.pendingCount + human.client.pendingCount).toBe(0);
    },
    5000,
    "bot edit to settle",
  );

/** A fake LLM: applies a pure function to the text. */
const fake =
  (fn: (s: string) => string, summary = "fake edit"): Reviser =>
  async (doc) => ({ text: fn(doc), summary });

describe("AI co-editor", () => {
  it("applies an instruction as a minimal set of character ops", async () => {
    const { human, bot } = await setup(fake((s) => s.replace("Teh", "The").replace("expereince", "experience")));
    human.type(0, "Teh resume has expereince.");
    await until(() => bot.client.rga!.toString() === "Teh resume has expereince.");
    const result = await bot.revise("fix spelling");
    expect(result.ops).toBe(4); // "eh"->"he" is a delete + insert; "ei"->"ie" likewise
    await settled(human, bot, "The resume has experience.");
  });

  it("merges with a person typing while the model is thinking", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reviser: Reviser = async (doc) => {
      await gate; // the model is "thinking"...
      return { text: doc.replace("Skills: ts", "Skills: TypeScript"), summary: "expanded abbreviation" };
    };
    const { human, bot } = await setup(reviser);
    human.type(0, "Skills: ts\nProjects: editor");
    await until(() => bot.client.rga!.toString() === "Skills: ts\nProjects: editor");

    const pending = bot.revise("expand abbreviations");
    human.type(27, " (CRDT)"); // ...while the human keeps editing elsewhere
    await until(() => bot.client.rga!.toString().endsWith("(CRDT)"));
    release();
    await pending;
    // Both edits survive: the bot's ops were computed on its fork but anchored by id.
    await settled(human, bot, "Skills: TypeScript\nProjects: editor (CRDT)");
  });

  it("even when the person edits the very sentence the model is rewriting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reviser: Reviser = async (doc) => {
      await gate;
      return { text: doc.replace("good team player", "collaborative engineer"), summary: "stronger wording" };
    };
    const { human, bot } = await setup(reviser);
    human.type(0, "I am a good team player.");
    await until(() => bot.client.rga!.toString() === "I am a good team player.");
    const pending = bot.revise("stronger wording");
    human.type(5, "very "); // inside the span the bot is replacing
    await until(() => bot.client.rga!.toString().includes("very"));
    release();
    await pending;
    // No crash, no lost keystrokes: the human's insert stays (next to the
    // characters it was typed after), the bot's replacement lands around it.
    await until(() => human.text() === bot.client.rga!.toString() && human.text().includes("very "));
    expect(human.text()).toContain("collaborative engineer");
  });

  it("watch mode: a typed '@ai ...' line triggers an edit and the line disappears", async () => {
    const seen: { doc: string; instruction: string }[] = [];
    const reviser: Reviser = async (doc, instruction) => {
      seen.push({ doc, instruction });
      return { text: doc.toUpperCase(), summary: "uppercased" };
    };
    const { human, bot } = await setup(reviser, true);
    human.type(0, "garvit mundra\n@ai make it uppercase");
    await settled(human, bot, "GARVIT MUNDRA");
    // The model never saw the command line itself.
    expect(seen).toEqual([{ doc: "garvit mundra", instruction: "make it uppercase" }]);
  });

  it("a failing model leaves the text alone and marks the command as failed", async () => {
    const { human, logs } = await setup(async () => {
      throw new Error("rate limited");
    }, true);
    human.type(0, "keep me\n@ai rewrite everything");
    await until(() => human.text().includes("@ai-failed"));
    expect(human.text()).toMatch(/^keep me\n@ai-failed rewrite everything \(Error: rate limited\)$/);
    expect(logs.some((l) => l.includes("failed"))).toBe(true);
  });

  it("shows up in presence like any other collaborator", async () => {
    const { human } = await setup(fake((s) => s));
    await until(() => ofType(human.messages, "presence").some((m) => m.name === BOT_NAME));
  });

  it("refuses documents above the size limit", async () => {
    const doc = freshDoc();
    const human = await connect(server, doc, "h");
    people.push(human);
    const bot = new AiCoEditor({
      url: `ws://127.0.0.1:${server.port}/ws?doc=${doc}`,
      reviser: fake((s) => s),
      maxChars: 5,
      log: () => {},
    });
    bots.push(bot);
    await bot.ready();
    human.type(0, "too long");
    await until(() => bot.client.rga!.length === 8);
    await expect(bot.revise("x")).rejects.toThrow("longer than 5");
  });
});

describe("removeLine", () => {
  it("removes a line and exactly one adjacent line break", () => {
    expect(removeLine("a\n@ai x\nb", "@ai x")).toBe("a\nb");
    expect(removeLine("a\n@ai x", "@ai x")).toBe("a");
    expect(removeLine("@ai x", "@ai x")).toBe("");
    expect(removeLine("abc", "zzz")).toBe("abc");
  });
});

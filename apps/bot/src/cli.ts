/**
 * Run the AI co-editor against a running server.
 *
 *   npm start -w @crdt-editor/bot -- --doc resume --instruction "Fix spelling and grammar"
 *   npm start -w @crdt-editor/bot -- --doc resume --watch      (then type "@ai <instruction>" in the doc)
 *
 * Options: --server ws://localhost:3000  --model claude-opus-5-5
 * Needs Claude API credentials: ANTHROPIC_API_KEY, or `ant auth login`.
 */
import { parseArgs } from "node:util";
import { AiCoEditor } from "./bot.js";
import { claudeReviser } from "./reviser.js";

const { values } = parseArgs({
  options: {
    doc: { type: "string", default: "resume" },
    server: { type: "string", default: "ws://localhost:3000" },
    instruction: { type: "string" },
    watch: { type: "boolean", default: false },
    model: { type: "string" },
  },
});

if (!values.instruction && !values.watch) {
  console.error('Give --instruction "..." or --watch');
  process.exit(2);
}

const bot = new AiCoEditor({
  url: `${values.server}/ws?doc=${encodeURIComponent(values.doc!)}`,
  reviser: claudeReviser({ model: values.model }),
  watch: values.watch,
});
await bot.ready();
console.log(`joined "${values.doc}" as the AI co-editor`);

if (values.instruction) {
  try {
    await bot.revise(values.instruction);
    // Give the outbox a moment to be acked before leaving.
    const start = Date.now();
    while (bot.client.pendingCount > 0 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 50));
  } finally {
    bot.close();
  }
} else {
  console.log('watching: type a line like "@ai make the summary shorter" in the document');
  process.on("SIGINT", () => {
    bot.close();
    process.exit(0);
  });
}

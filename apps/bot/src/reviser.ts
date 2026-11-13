/**
 * The bot's "brain": given the document and an instruction, return the full
 * revised document. Kept behind an interface so tests use a fake (no network,
 * no cost) and the CRDT side never depends on the LLM.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export interface Revision {
  /** The complete revised document. */
  text: string;
  /** One line for humans: what changed. */
  summary: string;
}

export type Reviser = (document: string, instruction: string) => Promise<Revision>;

const RevisionSchema = z.object({
  text: z.string().describe("The complete revised document"),
  summary: z.string().describe("One short sentence describing what you changed"),
});

const SYSTEM = `You are a careful co-editor of a resume that several people edit at the same time.
You receive the current document and an instruction. Return the complete revised document.
Change only what the instruction asks for and keep everything else exactly as it is,
including line breaks, spacing and characters you were not asked to touch:
your output is diffed character by character against the original, and every
unnecessary change can overwrite something a person is typing.
Never invent facts (employers, dates, numbers, skills) that are not in the document.`;

export interface ClaudeReviserOptions {
  /** Default: credentials from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile). */
  client?: Anthropic;
  model?: string;
}

export function claudeReviser(opts: ClaudeReviserOptions = {}): Reviser {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? "claude-opus-5-5";
  return async (document, instruction) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: betaZodOutputFormat(RevisionSchema) },
      // If the model declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `<document>\n${document}\n</document>\n\n<instruction>\n${instruction}\n</instruction>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`declined: ${response.stop_details?.explanation ?? "no explanation"}`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("the revised document was too long");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("model returned no parsable revision");
    return parsed;
  };
}

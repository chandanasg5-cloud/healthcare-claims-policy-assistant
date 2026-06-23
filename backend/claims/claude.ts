import Anthropic from "@anthropic-ai/sdk";
import { secret } from "encore.dev/config";

const anthropicKey = secret("AnthropicApiKey");

export const SYSTEM_PROMPT = `You are a healthcare claims policy assistant for claims analysts.
You answer strictly from the policy excerpts and claim data provided in the user
message. Ground every statement in that context.

Rules:
- Cite the specific policy rule id (for example COV-002.2) whenever you rely on it.
- If the provided context does not contain the answer, say so plainly rather than
  guessing.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note.`;

function client(): Anthropic {
  const key = anthropicKey();
  if (!key) {
    throw new Error("AnthropicApiKey secret is not set. Set it with `encore secret set`.");
  }
  return new Anthropic({ apiKey: key });
}

export async function* askStream(userContent: string): AsyncGenerator<string> {
  const stream = client().messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

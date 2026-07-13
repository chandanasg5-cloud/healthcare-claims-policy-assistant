import { GoogleGenAI } from "@google/genai";
import { secret } from "encore.dev/config";

const geminiKey = secret("GeminiApiKey");

const MODEL = "gemini-2.5-flash";

export const SYSTEM_PROMPT = `You are a healthcare claims policy assistant for claims analysts.
You answer strictly from the policy excerpts and claim data provided in the user
message. Ground every statement in that context.

Rules:
- Cite the specific policy rule id (for example COV-002.2) whenever you rely on it.
- If the provided context does not contain the answer, say so plainly rather than
  guessing.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note.`;

function client(): GoogleGenAI {
  const key = geminiKey();
  if (!key) {
    throw new Error("GeminiApiKey secret is not set. Set it with `encore secret set`.");
  }
  return new GoogleGenAI({ apiKey: key });
}

export async function* askStream(userContent: string): AsyncGenerator<string> {
  const stream = await client().models.generateContentStream({
    model: MODEL,
    contents: userContent,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 2048,
      // Thinking tokens count against maxOutputTokens on 2.5 models; disable
      // thinking so short answers are never starved by the budget.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield text;
  }
}

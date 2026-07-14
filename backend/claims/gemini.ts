import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { secret } from "encore.dev/config";
import type { GenContent, ModelClient, RoundChunk } from "./agent";
import { toolDeclarations } from "./toolspec";

const geminiKey = secret("GeminiApiKey");

const MODEL = "gemini-2.5-flash";

export const SYSTEM_PROMPT = `You are a healthcare claims policy assistant for claims analysts.
You answer using ONLY what your tools return: claim records and excerpts of real
CMS policy documents. Ground every statement in tool results.

Rules:
- Use tools rather than guessing. Look up claims before discussing them; run
  search_policies before citing any policy.
- Cite the governing policy by its real identifier as it appears in the excerpt
  (e.g. NCD 220.2, or the manual chapter/section) and name the source document.
- The claims data is synthetic demo data; the policy excerpts are real CMS text.
- If the retrieved policy text does not answer the question, say so plainly.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note.`;

function client(): GoogleGenAI {
  const key = geminiKey();
  if (!key) {
    throw new Error("GeminiApiKey secret is not set. Set it with `encore secret set`.");
  }
  return new GoogleGenAI({ apiKey: key });
}

// Adapts one Gemini streaming call to the agent loop's ModelClient interface.
export function geminiModelClient(): ModelClient {
  const ai = client();
  return {
    async *streamRound(contents: GenContent[]): AsyncGenerator<RoundChunk> {
      const stream = await ai.models.generateContentStream({
        model: MODEL,
        contents: contents as Content[],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
          tools: [{ functionDeclarations: toolDeclarations as unknown as FunctionDeclaration[] }],
        },
      });
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield { text };
        const calls = chunk.functionCalls;
        if (calls?.length) {
          yield {
            functionCalls: calls.map((c) => ({
              name: c.name ?? "",
              args: (c.args ?? {}) as Record<string, unknown>,
            })),
          };
        }
      }
    },
  };
}

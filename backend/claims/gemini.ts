import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponse } from "@google/genai";
import { secret } from "encore.dev/config";
import type { GenContent, ModelClient, RoundChunk } from "./agent";
import { toolDeclarations } from "./toolspec";

const geminiKey = secret("GeminiApiKey");

// Tried in order: free-tier quota bursts (429) and outages (503) on the
// primary fall back to the next model rather than erroring the chat.
// (gemini-2.5-flash-lite is NOT available to this account — 404s.)
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

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
      let stream: AsyncGenerator<GenerateContentResponse> | undefined;
      let lastErr: unknown;
      for (const model of MODELS) {
        try {
          stream = await ai.models.generateContentStream({
            model,
            contents: contents as Content[],
            config: {
              systemInstruction: SYSTEM_PROMPT,
              maxOutputTokens: 2048,
              // 2.0-era models reject thinkingConfig; 2.5 needs thinking off so
              // short answers aren't starved by the output-token budget.
              ...(model.startsWith("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
              tools: [{ functionDeclarations: toolDeclarations as unknown as FunctionDeclaration[] }],
            },
          });
          break;
        } catch (err) {
          lastErr = err;
          console.error(`model ${model} unavailable, trying next:`, err);
        }
      }
      if (!stream) throw lastErr;
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

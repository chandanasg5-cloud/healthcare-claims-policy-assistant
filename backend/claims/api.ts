import { api } from "encore.dev/api";
import { db } from "./db";
import { ensureSeeded } from "./seed";
import type { ClaimRow } from "./parse";
import { chatStream, type ChatMessage } from "./agent";
import { geminiModelClient } from "./gemini";
import { runTool } from "./tools";

async function allRows(): Promise<ClaimRow[]> {
  await ensureSeeded();
  const rows = db.query<ClaimRow>`SELECT * FROM claims ORDER BY claim_id`;
  const out: ClaimRow[] = [];
  for await (const r of rows) out.push(r);
  return out;
}

export const listClaims = api(
  { method: "GET", path: "/claims", expose: true },
  async (): Promise<{ claims: ClaimRow[] }> => {
    return { claims: await allRows() };
  },
);

// --- Chat: agent loop over SSE via api.raw (no generated client needed) ---
// The client POSTs {messages:[{role,text}...]} and receives typed events, one
// JSON object per `data:` line: step | sources | text | error | done.

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function sseInit(resp: any): void {
  resp.setHeader("Content-Type", "text/event-stream");
  resp.setHeader("Cache-Control", "no-cache");
}

function sseSend(resp: any, event: Record<string, unknown>): void {
  resp.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Runs an SSE handler so the response ALWAYS ends with a `done` event and
// `resp.end()` — even if the body is malformed or Gemini errors mid-stream.
async function sseEndpoint(
  req: any,
  resp: any,
  handler: (body: any) => Promise<void>,
): Promise<void> {
  sseInit(resp);
  try {
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      sseSend(resp, { type: "error", message: "Invalid request body." });
      return;
    }
    await handler(body);
  } catch (err) {
    console.error("chat stream failed:", err);
    sseSend(resp, { type: "error", message: "Sorry, an error occurred while generating the answer." });
  } finally {
    sseSend(resp, { type: "done" });
    resp.end();
  }
}

function parseMessages(body: any): ChatMessage[] | null {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const m of body.messages) {
    if ((m?.role !== "user" && m?.role !== "model") || typeof m?.text !== "string" || m.text.trim() === "") {
      return null;
    }
    messages.push({ role: m.role, text: m.text });
  }
  return messages.at(-1)?.role === "user" ? messages : null;
}

export const chat = api.raw(
  { expose: true, method: "POST", path: "/chat" },
  (req, resp) =>
    sseEndpoint(req, resp, async (body) => {
      const messages = parseMessages(body);
      if (!messages) {
        sseSend(resp, { type: "error", message: "Body must be {messages:[{role,text}...]} ending with a user message." });
        return;
      }
      await ensureSeeded();
      for await (const event of chatStream(messages, geminiModelClient(), runTool)) {
        sseSend(resp, event);
      }
    }),
);

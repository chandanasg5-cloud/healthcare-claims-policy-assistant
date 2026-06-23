import type { ClaimRow } from "./types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// --- JSON endpoints ---

export async function getClaims(): Promise<ClaimRow[]> {
  const res = await fetch(`${API}/claims`);
  if (!res.ok) throw new Error(`GET /claims failed: ${res.status}`);
  const data = (await res.json()) as { claims: ClaimRow[] };
  return data.claims;
}

export async function getSimilarDenied(claimId: string): Promise<ClaimRow[]> {
  const res = await fetch(`${API}/similar-denied?claimId=${encodeURIComponent(claimId)}`);
  if (!res.ok) throw new Error(`GET /similar-denied failed: ${res.status}`);
  const data = (await res.json()) as { claims: ClaimRow[] };
  return data.claims;
}

// --- Streaming (SSE) endpoints ---

// Parse complete `data: {"text":"..."}` frames out of an SSE buffer, returning
// the text deltas and the leftover partial frame.
function parseSseBuffer(buffer: string): { texts: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const texts: string[] = [];
  for (const evt of parts) {
    const line = evt.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const { text } = JSON.parse(line.slice(5).trim()) as { text?: string };
      if (typeof text === "string") texts.push(text);
    } catch {
      // ignore keep-alive / non-JSON frames
    }
  }
  return { texts, rest };
}

// POST a JSON body and read a `text/event-stream` of `data: {"text":"..."}\n\n`
// events, yielding each text delta as it arrives. `signal` lets the caller abort
// the request (e.g. on tab switch). The reader is always released.
async function* streamPost(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`POST ${path} failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { texts, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const t of texts) yield t;
    }
    // Flush any trailing multibyte bytes and a final frame with no closing "\n\n".
    buffer += decoder.decode();
    const { texts } = parseSseBuffer(`${buffer}\n\n`);
    for (const t of texts) yield t;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export const whyDenied = (claimId: string, signal?: AbortSignal) =>
  streamPost("/why-denied", { claimId }, signal);
export const whichPolicy = (question: string, signal?: AbortSignal) =>
  streamPost("/which-policy", { question }, signal);
export const patientHistory = (patientId: string, signal?: AbortSignal) =>
  streamPost("/patient-history", { patientId }, signal);
export const appealSummary = (claimId: string, signal?: AbortSignal) =>
  streamPost("/appeal-summary", { claimId }, signal);

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
// POST a JSON body and read a `text/event-stream` of `data: {"text":"..."}\n\n`
// events, yielding each text delta as it arrives.
async function* streamPost(path: string, body: unknown): AsyncGenerator<string> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`POST ${path} failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const { text } = JSON.parse(line.slice(5).trim()) as { text?: string };
        if (typeof text === "string") yield text;
      } catch {
        // ignore partial/keep-alive frames
      }
    }
  }
}

export const whyDenied = (claimId: string) => streamPost("/why-denied", { claimId });
export const whichPolicy = (question: string) => streamPost("/which-policy", { question });
export const patientHistory = (patientId: string) => streamPost("/patient-history", { patientId });
export const appealSummary = (claimId: string) => streamPost("/appeal-summary", { claimId });

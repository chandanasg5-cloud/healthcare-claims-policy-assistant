import type { ChatEvent, ChatMessage, ClaimRow } from "./types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getClaims(): Promise<ClaimRow[]> {
  const res = await fetch(`${API}/claims`);
  if (!res.ok) throw new Error(`GET /claims failed: ${res.status}`);
  const data = (await res.json()) as { claims: ClaimRow[] };
  return data.claims;
}

// Parse complete `data: {...}` frames out of an SSE buffer, returning typed
// chat events and the leftover partial frame.
function parseSseBuffer(buffer: string): { events: ChatEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const evt of parts) {
    const line = evt.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as ChatEvent;
      if (typeof parsed?.type === "string") events.push(parsed);
    } catch {
      // ignore keep-alive / non-JSON frames
    }
  }
  return { events, rest };
}

// POST the conversation and yield typed events as they arrive. `signal` lets
// the caller abort (e.g. re-send or unmount). The reader is always released.
export async function* chatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${API}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`POST /chat failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const e of events) yield e;
    }
    // Flush trailing multibyte bytes and a final frame with no closing "\n\n".
    buffer += decoder.decode();
    const { events } = parseSseBuffer(`${buffer}\n\n`);
    for (const e of events) yield e;
  } finally {
    reader.cancel().catch(() => {});
  }
}

"use client";

import { useEffect, useRef, useState } from "react";
import { chatStream, getClaims } from "@/lib/api";
import type { ChatMessage, ClaimRow } from "@/lib/types";
import { AssistantBody, PromptChips, type Turn } from "./chat";

export default function Page() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getClaims().then(setClaims).catch(() => setClaims([]));
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  // Convert finished turns to the wire history: user text -> user, assistant
  // answer text -> model. Steps/sources are UI-only.
  function toMessages(all: Turn[]): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const t of all) {
      if (t.role === "user") msgs.push({ role: "user", text: t.text });
      else if (t.text) msgs.push({ role: "model", text: t.text });
    }
    return msgs;
  }

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setBusy(true);

    const base: Turn[] = [...turns, { role: "user", text: q }];
    setTurns([...base, { role: "assistant", steps: [], text: "", sources: [] }]);

    const update = (fn: (a: Extract<Turn, { role: "assistant" }>) => Turn) =>
      setTurns((ts) => {
        const last = ts.at(-1);
        if (!last || last.role !== "assistant") return ts;
        return [...ts.slice(0, -1), fn(last)];
      });

    try {
      for await (const ev of chatStream(toMessages(base), controller.signal)) {
        if (controller.signal.aborted) break;
        if (ev.type === "step") update((a) => ({ ...a, steps: [...a.steps, { tool: ev.tool, label: ev.label }] }));
        else if (ev.type === "sources") update((a) => ({ ...a, sources: [...a.sources, ...ev.chunks] }));
        else if (ev.type === "text") update((a) => ({ ...a, text: a.text + ev.text }));
        else if (ev.type === "error") update((a) => ({ ...a, error: ev.message }));
      }
    } catch {
      if (!controller.signal.aborted) {
        update((a) => ({ ...a, error: "Stream error — is the backend running?" }));
      }
    } finally {
      if (abortRef.current === controller) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-6xl gap-6 p-6">
      <aside className="w-64 shrink-0 overflow-y-auto">
        <h2 className="mb-2 font-semibold">Claims</h2>
        <ul className="space-y-1 text-sm">
          {claims.map((c) => (
            <li key={c.claim_id} className="border-b border-slate-200 py-1">
              <button
                className="flex w-full justify-between hover:bg-slate-100"
                onClick={() =>
                  setInput(
                    c.status === "denied"
                      ? `Why was ${c.claim_id} denied?`
                      : `Show me the details of ${c.claim_id}.`,
                  )
                }
              >
                <span>{c.claim_id}</span>
                <span className={c.status === "denied" ? "text-red-600" : "text-emerald-600"}>
                  {c.status}
                </span>
              </button>
            </li>
          ))}
          {claims.length === 0 && <li className="py-1 text-slate-400">No claims loaded.</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <h1 className="text-2xl font-bold">🏥 Healthcare Claims Policy Assistant</h1>
        <p className="mb-3 text-sm text-slate-600">
          Ask anything about the claims — answers cite real CMS policy. Claims data is synthetic.
        </p>

        <div className="flex-1 space-y-4 overflow-y-auto rounded bg-slate-50 p-4">
          {turns.length === 0 && (
            <p className="text-sm text-slate-400">
              Start with a suggestion below, or click a claim on the left.
            </p>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">
                {t.text}
              </div>
            ) : (
              <div key={i} className="max-w-[90%] rounded-lg bg-white px-3 py-2 shadow-sm">
                <AssistantBody turn={t} busy={busy && i === turns.length - 1} />
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>

        <div className="mt-3">
          <PromptChips disabled={busy} onPick={send} />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="Ask about a claim, a policy, or a patient…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

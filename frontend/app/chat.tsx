"use client";

import type { SourceChunk } from "@/lib/types";

export interface StepLine {
  tool: string;
  label: string;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; steps: StepLine[]; text: string; sources: SourceChunk[]; error?: string };

export function AssistantBody({ turn, busy }: { turn: Extract<Turn, { role: "assistant" }>; busy: boolean }) {
  return (
    <div className="space-y-2">
      {turn.steps.length > 0 && (
        <ol className="space-y-0.5 text-xs text-slate-500">
          {turn.steps.map((s, i) => (
            <li key={i}>⚙ {s.label}</li>
          ))}
        </ol>
      )}
      {turn.text && <div className="whitespace-pre-wrap text-sm">{turn.text}</div>}
      {!turn.text && busy && <div className="text-sm text-slate-400">Thinking…</div>}
      {turn.error && <div className="text-sm text-red-600">{turn.error}</div>}
      {turn.sources.length > 0 && (
        <details className="rounded border border-slate-200 bg-slate-50 text-xs">
          <summary className="cursor-pointer px-2 py-1 font-medium text-slate-600">
            Sources ({turn.sources.length})
          </summary>
          <ul className="space-y-2 p-2">
            {turn.sources.map((s) => (
              <li key={s.id}>
                <div className="font-mono text-slate-500">{s.source}</div>
                <div className="whitespace-pre-wrap text-slate-700">{s.text}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const CHIPS = [
  "Why was CLM-1003 denied?",
  "Which policy governs MRI without prior authorization?",
  "Summarize PAT-002's claim history.",
  "Which claims share CLM-1005's denial code?",
  "Draft an appeal for CLM-1007.",
];

export function PromptChips({ disabled, onPick }: { disabled: boolean; onPick: (q: string) => void }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {CHIPS.map((c) => (
        <button
          key={c}
          disabled={disabled}
          onClick={() => onPick(c)}
          className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-700 hover:bg-slate-300 disabled:opacity-50"
        >
          {c}
        </button>
      ))}
    </div>
  );
}

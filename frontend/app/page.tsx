"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  getClaims,
  getSimilarDenied,
  whyDenied,
  whichPolicy,
  patientHistory,
  appealSummary,
} from "@/lib/api";
import type { ClaimRow } from "@/lib/types";

const TABS = [
  "Why denied?",
  "Which policy?",
  "Patient history",
  "Similar denials",
  "Appeal summary",
] as const;
type Tab = (typeof TABS)[number];

export default function Page() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [tab, setTab] = useState<Tab>("Why denied?");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [deniedId, setDeniedId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [question, setQuestion] = useState(
    "An MRI was performed without prior authorization on file.",
  );
  const [similar, setSimilar] = useState<ClaimRow[] | null>(null);

  useEffect(() => {
    getClaims()
      .then(setClaims)
      .catch(() => setClaims([]));
  }, []);

  const denied = claims.filter((c) => c.status === "denied");
  const patients = [...new Set(claims.map((c) => c.patient_id))].sort();

  async function run(gen: AsyncGenerator<string>) {
    setAnswer("");
    setBusy(true);
    try {
      for await (const t of gen) setAnswer((a) => a + t);
    } catch {
      setAnswer((a) => a + "\n[stream error — is the backend running?]");
    } finally {
      setBusy(false);
    }
  }

  function switchTab(t: Tab) {
    setTab(t);
    setAnswer("");
    setSimilar(null);
  }

  return (
    <main className="mx-auto flex max-w-6xl gap-6 p-6">
      <aside className="w-64 shrink-0">
        <h2 className="mb-2 font-semibold">Claims</h2>
        <ul className="space-y-1 text-sm">
          {claims.map((c) => (
            <li
              key={c.claim_id}
              className="flex justify-between border-b border-slate-200 py-1"
            >
              <span>{c.claim_id}</span>
              <span
                className={
                  c.status === "denied" ? "text-red-600" : "text-emerald-600"
                }
              >
                {c.status}
              </span>
            </li>
          ))}
          {claims.length === 0 && (
            <li className="py-1 text-slate-400">No claims loaded.</li>
          )}
        </ul>
      </aside>

      <section className="flex-1">
        <h1 className="text-2xl font-bold">
          🏥 Healthcare Claims Policy Assistant
        </h1>
        <p className="mb-4 text-sm text-slate-600">
          Answers grounded in policy documents, with the governing rule cited.
        </p>

        <nav className="mb-4 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`rounded px-3 py-1 text-sm ${
                tab === t
                  ? "bg-slate-900 text-white"
                  : "bg-slate-200 text-slate-800"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        {tab === "Why denied?" && (
          <Controls>
            <DeniedSelect denied={denied} value={deniedId} onChange={setDeniedId} />
            <RunButton
              disabled={!deniedId || busy}
              onClick={() => run(whyDenied(deniedId))}
            >
              Explain denial
            </RunButton>
          </Controls>
        )}

        {tab === "Which policy?" && (
          <Controls>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <RunButton disabled={busy} onClick={() => run(whichPolicy(question))}>
              Find the rule
            </RunButton>
          </Controls>
        )}

        {tab === "Patient history" && (
          <Controls>
            <select
              className="rounded border border-slate-300 px-2 py-1"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">Select a patient</option>
              {patients.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <RunButton
              disabled={!patientId || busy}
              onClick={() => run(patientHistory(patientId))}
            >
              Summarize
            </RunButton>
          </Controls>
        )}

        {tab === "Similar denials" && (
          <Controls>
            <DeniedSelect denied={denied} value={deniedId} onChange={setDeniedId} />
            <RunButton
              disabled={!deniedId || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setSimilar(await getSimilarDenied(deniedId));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Find similar
            </RunButton>
          </Controls>
        )}

        {tab === "Appeal summary" && (
          <Controls>
            <DeniedSelect denied={denied} value={deniedId} onChange={setDeniedId} />
            <RunButton
              disabled={!deniedId || busy}
              onClick={() => run(appealSummary(deniedId))}
            >
              Draft appeal
            </RunButton>
          </Controls>
        )}

        {tab === "Similar denials" ? (
          similar === null ? null : similar.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No other claims share this denial code.
            </p>
          ) : (
            <ul className="mt-4 space-y-1 text-sm">
              {similar.map((c) => (
                <li key={c.claim_id}>
                  {c.claim_id} — {c.denial_reason}
                </li>
              ))}
            </ul>
          )
        ) : (
          <pre className="mt-4 min-h-24 whitespace-pre-wrap rounded bg-slate-100 p-3 text-sm">
            {answer}
          </pre>
        )}
      </section>
    </main>
  );
}

function Controls({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function RunButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function DeniedSelect({
  denied,
  value,
  onChange,
}: {
  denied: ClaimRow[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="rounded border border-slate-300 px-2 py-1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Select a denied claim</option>
      {denied.map((c) => (
        <option key={c.claim_id} value={c.claim_id}>
          {c.claim_id}
        </option>
      ))}
    </select>
  );
}

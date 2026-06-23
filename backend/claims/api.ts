import { api, Query, StreamOut } from "encore.dev/api";
import { db } from "./db";
import { ensureSeeded } from "./seed";
import type { ClaimRow } from "./parse";
import { askStream } from "./claude";
import { retrieve } from "./retrieval";
import { formatClaim, policyContext } from "./format";

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

export const similarDenied = api(
  { method: "GET", path: "/similar-denied", expose: true },
  async (p: { claimId: Query<string> }): Promise<{ claims: ClaimRow[] }> => {
    await ensureSeeded();
    const ref = await db.queryRow<ClaimRow>`
      SELECT * FROM claims WHERE claim_id = ${p.claimId}
    `;
    if (!ref || !ref.denial_code) return { claims: [] };
    const rows = db.query<ClaimRow>`
      SELECT * FROM claims
      WHERE denial_code = ${ref.denial_code} AND claim_id != ${ref.claim_id}
      ORDER BY claim_id
    `;
    const out: ClaimRow[] = [];
    for await (const r of rows) out.push(r);
    return { claims: out };
  },
);

export async function getClaim(claimId: string): Promise<ClaimRow | null> {
  await ensureSeeded();
  const row = await db.queryRow<ClaimRow>`SELECT * FROM claims WHERE claim_id = ${claimId}`;
  return row ?? null;
}

interface TextMsg { text: string; }

async function pipe(stream: StreamOut<TextMsg>, userContent: string) {
  try {
    for await (const text of askStream(userContent)) {
      await stream.send({ text });
    }
  } finally {
    await stream.close();
  }
}

export const whyDenied = api.streamOut<{ claimId: string }, TextMsg>(
  { path: "/why-denied", expose: true },
  async (h, stream) => {
    const row = await getClaim(h.claimId);
    if (!row) { await stream.send({ text: `No claim found with id ${h.claimId}.` }); await stream.close(); return; }
    const query = `${row.denial_reason} ${row.procedure_desc} denial ${row.denial_code}`;
    const ctx = policyContext(await retrieve(query));
    await pipe(stream,
      `CLAIM:\n${formatClaim(row)}\n\nRELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
      `Question: Why was claim ${h.claimId} denied? Explain the reason and cite the ` +
      `policy rule that supports the denial.`);
  },
);

export const whichPolicy = api.streamOut<{ question: string }, TextMsg>(
  { path: "/which-policy", expose: true },
  async (h, stream) => {
    const ctx = policyContext(await retrieve(h.question));
    await pipe(stream,
      `RELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
      `Question: Which policy rule applies to the following situation, and what ` +
      `does it require? ${h.question}`);
  },
);

export const patientHistory = api.streamOut<{ patientId: string }, TextMsg>(
  { path: "/patient-history", expose: true },
  async (h, stream) => {
    await ensureSeeded();
    const rows = db.query<ClaimRow>`SELECT * FROM claims WHERE patient_id = ${h.patientId} ORDER BY claim_id`;
    const claims: ClaimRow[] = [];
    for await (const r of rows) claims.push(r);
    if (claims.length === 0) { await stream.send({ text: `No claims found for patient ${h.patientId}.` }); await stream.close(); return; }
    const listing = claims.map(formatClaim).join("\n");
    await pipe(stream,
      `CLAIM HISTORY FOR ${h.patientId}:\n${listing}\n\n` +
      `Question: Summarize this patient's claim history. Note totals, what was ` +
      `approved versus denied, and any recurring denial patterns.`);
  },
);

export const appealSummary = api.streamOut<{ claimId: string }, TextMsg>(
  { path: "/appeal-summary", expose: true },
  async (h, stream) => {
    const row = await getClaim(h.claimId);
    if (!row) { await stream.send({ text: `No claim found with id ${h.claimId}.` }); await stream.close(); return; }
    const query = `appeal ${row.denial_reason} ${row.denial_code}`;
    const ctx = policyContext(await retrieve(query));
    await pipe(stream,
      `CLAIM:\n${formatClaim(row)}\n\nRELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
      `Task: Draft a concise appeal summary for this denied claim. State the claim ` +
      `details, the denial reason, the policy basis for an appeal (cite the rule), ` +
      `and what documentation the provider should submit. Keep it under 200 words.`);
  },
);

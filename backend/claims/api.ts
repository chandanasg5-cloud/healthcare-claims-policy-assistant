import { api, Query } from "encore.dev/api";
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

// --- Streaming answer endpoints: SSE over api.raw (no generated client needed) ---
// Each answers a POST with a small JSON body and streams Claude's reply as
// Server-Sent Events: `data: {"text":"..."}\n\n` per delta. The browser consumes
// these with plain fetch() + a ReadableStream reader.

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function sseInit(resp: any): void {
  resp.setHeader("Content-Type", "text/event-stream");
  resp.setHeader("Cache-Control", "no-cache");
}

function sseSend(resp: any, text: string): void {
  resp.write(`data: ${JSON.stringify({ text })}\n\n`);
}

async function streamAnswer(resp: any, userContent: string): Promise<void> {
  for await (const text of askStream(userContent)) sseSend(resp, text);
}

// Wraps a streaming handler so the SSE response is ALWAYS ended — even if the
// body is malformed or Claude errors mid-stream — otherwise the connection hangs.
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
      sseSend(resp, "Invalid request body.");
      return;
    }
    await handler(body);
  } catch {
    sseSend(resp, "Sorry, an error occurred while generating the answer.");
  } finally {
    resp.end();
  }
}

export const whyDenied = api.raw(
  { expose: true, method: "POST", path: "/why-denied" },
  (req, resp) =>
    sseEndpoint(req, resp, async ({ claimId }) => {
      const row = await getClaim(claimId);
      if (!row) { sseSend(resp, `No claim found with id ${claimId}.`); return; }
      const query = `${row.denial_reason} ${row.procedure_desc} denial ${row.denial_code}`;
      const ctx = policyContext(await retrieve(query));
      await streamAnswer(resp,
        `CLAIM:\n${formatClaim(row)}\n\nRELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
        `Question: Why was claim ${claimId} denied? Explain the reason and cite the ` +
        `policy rule that supports the denial.`);
    }),
);

export const whichPolicy = api.raw(
  { expose: true, method: "POST", path: "/which-policy" },
  (req, resp) =>
    sseEndpoint(req, resp, async ({ question }) => {
      const ctx = policyContext(await retrieve(question));
      await streamAnswer(resp,
        `RELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
        `Question: Which policy rule applies to the following situation, and what ` +
        `does it require? ${question}`);
    }),
);

export const patientHistory = api.raw(
  { expose: true, method: "POST", path: "/patient-history" },
  (req, resp) =>
    sseEndpoint(req, resp, async ({ patientId }) => {
      await ensureSeeded();
      const rows = db.query<ClaimRow>`SELECT * FROM claims WHERE patient_id = ${patientId} ORDER BY claim_id`;
      const claims: ClaimRow[] = [];
      for await (const r of rows) claims.push(r);
      if (claims.length === 0) { sseSend(resp, `No claims found for patient ${patientId}.`); return; }
      const listing = claims.map(formatClaim).join("\n");
      await streamAnswer(resp,
        `CLAIM HISTORY FOR ${patientId}:\n${listing}\n\n` +
        `Question: Summarize this patient's claim history. Note totals, what was ` +
        `approved versus denied, and any recurring denial patterns.`);
    }),
);

export const appealSummary = api.raw(
  { expose: true, method: "POST", path: "/appeal-summary" },
  (req, resp) =>
    sseEndpoint(req, resp, async ({ claimId }) => {
      const row = await getClaim(claimId);
      if (!row) { sseSend(resp, `No claim found with id ${claimId}.`); return; }
      const query = `appeal ${row.denial_reason} ${row.denial_code}`;
      const ctx = policyContext(await retrieve(query));
      await streamAnswer(resp,
        `CLAIM:\n${formatClaim(row)}\n\nRELEVANT POLICY EXCERPTS:\n${ctx}\n\n` +
        `Task: Draft a concise appeal summary for this denied claim. State the claim ` +
        `details, the denial reason, the policy basis for an appeal (cite the rule), ` +
        `and what documentation the provider should submit. Keep it under 200 words.`);
    }),
);

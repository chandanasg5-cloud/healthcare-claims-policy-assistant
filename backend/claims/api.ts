import { api, Query } from "encore.dev/api";
import { db } from "./db";
import { ensureSeeded } from "./seed";
import type { ClaimRow } from "./parse";

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

import { db } from "./db";
import { chunkPolicy, parseClaimsCsv } from "./parse";
// Seed data is embedded (claims/data.ts) rather than read from disk: the
// deployed bundle does not include loose files under claims/data/.
import { CLAIMS_CSV, POLICIES } from "./data";

let seeded: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  if (!seeded) seeded = doSeed();
  return seeded;
}

async function doSeed(): Promise<void> {
  const existing = await db.queryRow`SELECT COUNT(*)::int AS n FROM claims`;
  if (existing && existing.n > 0) return;

  const claims = parseClaimsCsv(CLAIMS_CSV);
  for (const c of claims) {
    await db.exec`
      INSERT INTO claims (claim_id, patient_id, date_of_service, procedure_code, procedure_desc,
                          diagnosis_code, billed_amount, status, denial_code, denial_reason)
      VALUES (${c.claim_id}, ${c.patient_id}, ${c.date_of_service}, ${c.procedure_code}, ${c.procedure_desc},
              ${c.diagnosis_code}, ${c.billed_amount}, ${c.status}, ${c.denial_code}, ${c.denial_reason})
      ON CONFLICT (claim_id) DO NOTHING
    `;
  }

  for (const [file, text] of Object.entries(POLICIES)) {
    for (const chunk of chunkPolicy(text, file)) {
      await db.exec`
        INSERT INTO policy_chunks (id, source, text)
        VALUES (${chunk.id}, ${chunk.source}, ${chunk.text})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
}

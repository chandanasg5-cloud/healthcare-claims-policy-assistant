import { db } from "./db";
import { ensureSeeded } from "./seed";
import type { ClaimRow } from "./parse";
import { formatClaim, policyContext } from "./format";
import { retrieve } from "./retrieval";
import { validateToolArgs } from "./toolspec";
import type { ToolOutcome } from "./agent";

export async function getClaim(claimId: string): Promise<ClaimRow | null> {
  await ensureSeeded();
  const row = await db.queryRow<ClaimRow>`SELECT * FROM claims WHERE claim_id = ${claimId}`;
  return row ?? null;
}

async function collect(rows: AsyncGenerator<ClaimRow>): Promise<ClaimRow[]> {
  const out: ClaimRow[] = [];
  for await (const r of rows) out.push(r);
  return out;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const v = validateToolArgs(name, args);
  if (!v.ok) return { output: `Error: ${v.error}` };
  await ensureSeeded();

  switch (name) {
    case "get_claim": {
      const row = await getClaim(args.claimId as string);
      return { output: row ? formatClaim(row) : `No claim found with id ${args.claimId}.` };
    }
    case "get_patient_claims": {
      const claims = await collect(
        db.query<ClaimRow>`SELECT * FROM claims WHERE patient_id = ${args.patientId as string} ORDER BY claim_id`,
      );
      return {
        output: claims.length
          ? claims.map(formatClaim).join("\n")
          : `No claims found for patient ${args.patientId}.`,
      };
    }
    case "find_similar_denied": {
      const ref = await getClaim(args.claimId as string);
      if (!ref || !ref.denial_code) return { output: `No denied claim found with id ${args.claimId}.` };
      const claims = await collect(
        db.query<ClaimRow>`
          SELECT * FROM claims
          WHERE denial_code = ${ref.denial_code} AND claim_id != ${ref.claim_id}
          ORDER BY claim_id`,
      );
      return {
        output: claims.length
          ? claims.map(formatClaim).join("\n")
          : "No other claims share this denial code.",
      };
    }
    case "search_policies": {
      const hits = await retrieve(args.query as string, 4);
      if (hits.length === 0) return { output: "No policy text matched that query." };
      return { output: policyContext(hits), sources: hits };
    }
    case "claims_overview": {
      const rows = db.query<{ status: string; denial_code: string; n: number; total: string }>`
        SELECT status, denial_code, COUNT(*)::int AS n,
               SUM(billed_amount::numeric)::text AS total
        FROM claims GROUP BY status, denial_code ORDER BY status, denial_code`;
      const lines: string[] = [];
      for await (const r of rows) {
        lines.push(`${r.status}${r.denial_code ? ` (${r.denial_code})` : ""}: ${r.n} claims, $${r.total} billed`);
      }
      return { output: lines.join("\n") };
    }
    default:
      return { output: `Error: unknown tool ${name}` };
  }
}

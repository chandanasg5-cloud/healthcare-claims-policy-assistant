import type { ClaimRow } from "./parse";
import type { Retrieved } from "./retrieval";

export function formatClaim(c: ClaimRow): string {
  const base =
    `Claim ${c.claim_id} | patient ${c.patient_id} | date ${c.date_of_service} | ` +
    `procedure ${c.procedure_code} (${c.procedure_desc}) | diagnosis ${c.diagnosis_code} | ` +
    `billed $${c.billed_amount} | status ${c.status}`;
  if (c.status === "denied") {
    return `${base} | denial ${c.denial_code}: ${c.denial_reason}`;
  }
  return base;
}

export function policyContext(retrieved: Retrieved[]): string {
  return retrieved.map((r) => `[${r.source}]\n${r.text}`).join("\n\n");
}

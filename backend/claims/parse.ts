export interface ClaimRow {
  claim_id: string;
  patient_id: string;
  date_of_service: string;
  procedure_code: string;
  procedure_desc: string;
  diagnosis_code: string;
  billed_amount: string;
  status: string;
  denial_code: string;
  denial_reason: string;
}

const CLAIM_FIELDS: (keyof ClaimRow)[] = [
  "claim_id", "patient_id", "date_of_service", "procedure_code", "procedure_desc",
  "diagnosis_code", "billed_amount", "status", "denial_code", "denial_reason",
];

export function chunkPolicy(text: string, source: string) {
  const blocks = text.split("\n\n");
  const chunks: { id: string; source: string; text: string }[] = [];
  blocks.forEach((raw, i) => {
    const block = raw.trim();
    if (block.length < 20) return;
    chunks.push({ id: `${source}-${i}`, source, text: block });
  });
  return chunks;
}

// Minimal CSV parser for this dataset (no quoted commas present in the synthetic data).
export function parseClaimsCsv(csv: string): ClaimRow[] {
  const lines = csv.trim().split("\n");
  lines.shift(); // header
  return lines.map((line) => {
    const cells = line.split(",");
    const row = {} as ClaimRow;
    CLAIM_FIELDS.forEach((field, i) => {
      row[field] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

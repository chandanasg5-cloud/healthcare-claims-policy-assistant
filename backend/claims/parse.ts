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

export interface PolicyDoc {
  title: string;
  sourceUrl: string;
  body: string;
}

// Frontmatter is `---\nkey: value\n---` at the very start of the file.
export function parsePolicyDoc(raw: string): PolicyDoc {
  if (!raw.startsWith("---")) return { title: "", sourceUrl: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { title: "", sourceUrl: "", body: raw };
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n+/, "");
  const get = (key: string) =>
    fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim() ?? "";
  return { title: get("title"), sourceUrl: get("source_url"), body };
}

const MAX_CHUNK = 1200;

// Chunks follow the document's `## ` sections; each chunk is prefixed with its
// section heading so retrieval hits carry their context. Long sections are
// packed into ~MAX_CHUNK-char chunks on paragraph boundaries.
export function chunkPolicy(text: string, source: string) {
  const { body } = parsePolicyDoc(text);
  const chunks: { id: string; source: string; text: string }[] = [];
  let n = 0;
  for (const section of body.split(/\n(?=## )/)) {
    const heading = section.match(/^## (.+)$/m)?.[1]?.trim() ?? "";
    const headingLen = heading ? heading.length + 1 : 0; // +1 for newline
    const paras = section
      .split("\n\n")
      .map((p) => p.trim())
      .filter((p) => p.length >= 20 && !p.startsWith("## "));
    let buf = "";
    const flush = () => {
      if (!buf) return;
      chunks.push({
        id: `${source}#${n++}`,
        source,
        text: heading ? `${heading}\n${buf}` : buf,
      });
      buf = "";
    };
    for (let p of paras) {
      const maxBufLen = Math.max(1, MAX_CHUNK - headingLen);
      while (p.length > 0) {
        const curBufLen = buf ? buf.length + 2 : 0;
        const availableForP = maxBufLen - curBufLen;
        if (availableForP <= 0 || (buf && curBufLen + p.length > maxBufLen)) {
          flush();
        } else if (p.length <= availableForP) {
          buf = buf ? `${buf}\n\n${p}` : p;
          p = "";
        } else {
          const chunk = p.slice(0, availableForP);
          buf = buf ? `${buf}\n\n${chunk}` : chunk;
          p = p.slice(availableForP);
          flush();
        }
      }
    }
    flush();
  }
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

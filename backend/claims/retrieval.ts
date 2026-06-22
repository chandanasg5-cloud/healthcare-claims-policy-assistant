import { db } from "./db";
import { ensureSeeded } from "./seed";

export interface Retrieved {
  text: string;
  source: string;
}

export async function retrieve(query: string, k = 4): Promise<Retrieved[]> {
  await ensureSeeded();
  const rows = db.query<{ text: string; source: string }>`
    SELECT text, source
    FROM policy_chunks
    WHERE tsv @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(tsv, plainto_tsquery('english', ${query})) DESC
    LIMIT ${k}
  `;
  const out: Retrieved[] = [];
  for await (const row of rows) out.push({ text: row.text, source: row.source });
  return out;
}

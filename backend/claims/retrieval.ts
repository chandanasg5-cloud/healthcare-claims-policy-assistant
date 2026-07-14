import { db } from "./db";
import { ensureSeeded } from "./seed";

export interface Retrieved {
  id: string;
  text: string;
  source: string;
}

export async function retrieve(query: string, k = 4): Promise<Retrieved[]> {
  await ensureSeeded();
  // plainto_tsquery ANDs every term, which is too strict for analyst phrasing
  // over real policy text ("MRI without prior authorization" would need every
  // word in a single chunk). Rewrite the parsed query to OR semantics and let
  // ts_rank favor chunks that match more of the terms.
  const rows = db.query<Retrieved>`
    SELECT id, text, source
    FROM policy_chunks
    WHERE tsv @@ replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery
    ORDER BY ts_rank(tsv, replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')::tsquery) DESC
    LIMIT ${k}
  `;
  const out: Retrieved[] = [];
  for await (const row of rows) out.push({ id: row.id, text: row.text, source: row.source });
  return out;
}

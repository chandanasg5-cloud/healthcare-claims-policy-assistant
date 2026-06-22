# Vercel + Encore Re-architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Streamlit/Python Healthcare Claims Policy Assistant with a Next.js frontend (Vercel) + Encore TypeScript backend (Encore Cloud), GitHub-driven CI/CD, in a monorepo.

**Architecture:** A single Encore service `claims` owns a Postgres database (claims + policy chunks with a full-text index), retrieval via Postgres full-text search, and all Claude calls (`@anthropic-ai/sdk`, streaming). A Next.js App Router frontend calls the Encore API and renders the five analyst features. Both deploy from one GitHub monorepo: `frontend/` → Vercel (root dir `frontend/`), `backend/` → Encore Cloud.

**Tech Stack:** Encore.ts, Postgres (full-text search), `@anthropic-ai/sdk`, Next.js 14 (App Router) + React + Tailwind, Vitest (backend tests).

## Global Constraints

- Claude model: `claude-opus-4-8` (exact string). Never substitute.
- Thinking: `thinking: { type: "adaptive" }`. Do **not** use `budget_tokens`, `temperature`, `top_p`, or `top_k` (they 400 on this model).
- `max_tokens: 2048` for answer endpoints.
- System prompt: ported verbatim from the original `rag.py` `SYSTEM_PROMPT` (see Task 4).
- No authentication; single-user; synthetic data only.
- Anthropic API key comes from an Encore secret named `AnthropicApiKey` — never hardcode it.
- Policy chunking rule (ported from Python `_chunk_policy`): split file text on blank lines (`\n\n`), trim each block, drop blocks shorter than 20 characters; chunk id = `<filename>-<index>`, source = `<filename>`.
- Claims CSV columns (exact order): `claim_id, patient_id, date_of_service, procedure_code, procedure_desc, diagnosis_code, billed_amount, status, denial_code, denial_reason`.

---

## File Structure

```
backend/
├── encore.app                       # app id + global CORS allowing the Vercel origin
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── claims/
    ├── encore.service.ts            # defines the "claims" service
    ├── db.ts                        # SQLDatabase handle
    ├── migrations/
    │   └── 1_schema.up.sql          # claims + policy_chunks tables, tsv generated column + GIN index
    ├── data/
    │   ├── claims.csv               # moved from repo data/
    │   └── policies/*.md            # moved from repo data/policies/
    ├── seed.ts                      # parse CSV + chunk policies, lazy idempotent seed
    ├── retrieval.ts                 # full-text search over policy_chunks
    ├── claude.ts                    # @anthropic-ai/sdk wrapper + system prompt + streaming helper
    ├── format.ts                    # _format_claim / _policy_context ports
    ├── api.ts                       # the 5 feature endpoints + GET /claims
    ├── seed.test.ts
    ├── retrieval.test.ts
    ├── format.test.ts
    └── api.test.ts
frontend/
├── package.json
├── next.config.mjs
├── tailwind.config.ts
├── postcss.config.mjs
├── tsconfig.json
├── .env.local.example               # NEXT_PUBLIC_API_URL
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   └── page.tsx                     # tabs + claims sidebar
└── lib/
    ├── types.ts                     # shared response types
    └── api.ts                       # fetch + streaming client
```

The original `app.py`, `rag.py`, `requirements.txt`, `.env.example`, and root `data/` are removed from the working tree (kept in git history). The policy `.md` files and `claims.csv` are **moved** to `backend/claims/data/`.

---

### Task 1: Backend scaffold + database schema

**Files:**
- Create: `backend/encore.app`
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/claims/encore.service.ts`
- Create: `backend/claims/db.ts`
- Create: `backend/claims/migrations/1_schema.up.sql`

**Interfaces:**
- Produces: `db` (the `SQLDatabase` handle) exported from `backend/claims/db.ts`, used by every later backend task.

- [ ] **Step 1: Create `backend/encore.app`**

```json
{
  "id": "",
  "global_cors": {
    "allow_origins_without_credentials": ["*"]
  }
}
```

(The `id` is filled when you run `encore app create` or link the app; leave `""` for local dev. The CORS block lets the browser call the API directly from the Vercel origin.)

- [ ] **Step 2: Create `backend/package.json`**

```json
{
  "name": "claims-backend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "encore.dev": "^1.40.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": { "~encore/*": ["./encore.gen/*"] }
  }
}
```

- [ ] **Step 4: Create `backend/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

- [ ] **Step 5: Create `backend/claims/encore.service.ts`**

```typescript
import { Service } from "encore.dev/service";

export default new Service("claims");
```

- [ ] **Step 6: Create `backend/claims/db.ts`**

```typescript
import { SQLDatabase } from "encore.dev/storage/sqldb";

export const db = new SQLDatabase("claims", {
  migrations: "./migrations",
});
```

- [ ] **Step 7: Create `backend/claims/migrations/1_schema.up.sql`**

```sql
CREATE TABLE claims (
    claim_id        TEXT PRIMARY KEY,
    patient_id      TEXT NOT NULL,
    date_of_service TEXT NOT NULL,
    procedure_code  TEXT NOT NULL,
    procedure_desc  TEXT NOT NULL,
    diagnosis_code  TEXT NOT NULL,
    billed_amount   TEXT NOT NULL,
    status          TEXT NOT NULL,
    denial_code     TEXT NOT NULL DEFAULT '',
    denial_reason   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE policy_chunks (
    id     TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    text   TEXT NOT NULL,
    tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX policy_chunks_tsv_idx ON policy_chunks USING GIN (tsv);
```

- [ ] **Step 8: Move the data files into the backend**

```bash
mkdir -p backend/claims/data
git mv data/claims.csv backend/claims/data/claims.csv
git mv data/policies backend/claims/data/policies
```

- [ ] **Step 9: Verify the app compiles and the DB provisions**

Run (from `backend/`): `encore run`
Expected: starts without error and logs that the `claims` database migration `1_schema` applied. Stop it with Ctrl-C.

- [ ] **Step 10: Commit**

```bash
git add backend/
git commit -m "feat(backend): Encore scaffold + claims/policy_chunks schema"
```

---

### Task 2: Seed logic (parse CSV + chunk policies)

**Files:**
- Create: `backend/claims/seed.ts`
- Test: `backend/claims/seed.test.ts`

**Interfaces:**
- Consumes: `db` from `./db`.
- Produces:
  - `chunkPolicy(text: string, source: string): { id: string; source: string; text: string }[]`
  - `parseClaimsCsv(csv: string): ClaimRow[]` where `ClaimRow` has the 10 CSV columns as `string` fields.
  - `ensureSeeded(): Promise<void>` — idempotent; populates both tables from `data/` on first call.

- [ ] **Step 1: Write the failing test for `chunkPolicy`**

```typescript
import { describe, it, expect } from "vitest";
import { chunkPolicy, parseClaimsCsv } from "./seed";

describe("chunkPolicy", () => {
  it("splits on blank lines, drops short blocks, ids by source+index", () => {
    const text = "# Title\n\nThis is a long enough paragraph block.\n\nshort\n\nAnother sufficiently long paragraph here.";
    const chunks = chunkPolicy(text, "COV-001.md");
    expect(chunks).toEqual([
      { id: "COV-001.md-1", source: "COV-001.md", text: "This is a long enough paragraph block." },
      { id: "COV-001.md-3", source: "COV-001.md", text: "Another sufficiently long paragraph here." },
    ]);
  });
});

describe("parseClaimsCsv", () => {
  it("parses rows into the 10 claim fields, empty denial fields preserved", () => {
    const csv = [
      "claim_id,patient_id,date_of_service,procedure_code,procedure_desc,diagnosis_code,billed_amount,status,denial_code,denial_reason",
      "CLM-1001,PAT-001,2025-01-15,99396,Annual wellness visit,Z00.00,250.00,approved,,",
    ].join("\n");
    const rows = parseClaimsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claim_id: "CLM-1001",
      procedure_desc: "Annual wellness visit",
      status: "approved",
      denial_code: "",
      denial_reason: "",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx vitest run claims/seed.test.ts`
Expected: FAIL — `chunkPolicy`/`parseClaimsCsv` not exported.

- [ ] **Step 3: Implement `backend/claims/seed.ts`**

```typescript
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

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

let seeded: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  if (!seeded) seeded = doSeed();
  return seeded;
}

async function doSeed(): Promise<void> {
  const existing = await db.queryRow`SELECT COUNT(*)::int AS n FROM claims`;
  if (existing && existing.n > 0) return;

  const claims = parseClaimsCsv(readFileSync(join(DATA_DIR, "claims.csv"), "utf-8"));
  for (const c of claims) {
    await db.exec`
      INSERT INTO claims (claim_id, patient_id, date_of_service, procedure_code, procedure_desc,
                          diagnosis_code, billed_amount, status, denial_code, denial_reason)
      VALUES (${c.claim_id}, ${c.patient_id}, ${c.date_of_service}, ${c.procedure_code}, ${c.procedure_desc},
              ${c.diagnosis_code}, ${c.billed_amount}, ${c.status}, ${c.denial_code}, ${c.denial_reason})
      ON CONFLICT (claim_id) DO NOTHING
    `;
  }

  const policyDir = join(DATA_DIR, "policies");
  for (const file of readdirSync(policyDir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(policyDir, file), "utf-8");
    for (const chunk of chunkPolicy(text, file)) {
      await db.exec`
        INSERT INTO policy_chunks (id, source, text)
        VALUES (${chunk.id}, ${chunk.source}, ${chunk.text})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `npx vitest run claims/seed.test.ts`
Expected: PASS (both `chunkPolicy` and `parseClaimsCsv` tests).

- [ ] **Step 5: Commit**

```bash
git add backend/claims/seed.ts backend/claims/seed.test.ts
git commit -m "feat(backend): idempotent seed from claims.csv and policy markdown"
```

---

### Task 3: Retrieval (Postgres full-text search)

**Files:**
- Create: `backend/claims/retrieval.ts`
- Test: `backend/claims/retrieval.test.ts`

**Interfaces:**
- Consumes: `db` from `./db`, `ensureSeeded` from `./seed`.
- Produces: `retrieve(query: string, k?: number): Promise<Retrieved[]>` where `interface Retrieved { text: string; source: string }` (default `k = 4`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { retrieve } from "./retrieval";

describe("retrieve", () => {
  it("returns the prior-authorization policy chunk for an MRI-without-auth query", async () => {
    const results = await retrieve("MRI performed without prior authorization", 4);
    expect(results.length).toBeGreaterThan(0);
    const joined = results.map((r) => r.text).join(" ");
    expect(joined).toContain("D-NOAUTH");
    expect(results[0].source).toContain("COV-002");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `encore test claims/retrieval.test.ts`
Expected: FAIL — `retrieve` not defined. (Use `encore test`, not bare vitest, so the test DB is provisioned.)

- [ ] **Step 3: Implement `backend/claims/retrieval.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `encore test claims/retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/claims/retrieval.ts backend/claims/retrieval.test.ts
git commit -m "feat(backend): full-text policy retrieval"
```

---

### Task 4: Claude wrapper + context formatters

**Files:**
- Create: `backend/claims/claude.ts`
- Create: `backend/claims/format.ts`
- Test: `backend/claims/format.test.ts`

**Interfaces:**
- Consumes: `Retrieved` from `./retrieval`; `ClaimRow` from `./seed`.
- Produces:
  - `format.ts`: `formatClaim(c: ClaimRow): string`, `policyContext(retrieved: Retrieved[]): string`.
  - `claude.ts`: `SYSTEM_PROMPT: string`, and `async function* askStream(userContent: string): AsyncGenerator<string>` yielding text deltas.

- [ ] **Step 1: Write the failing test for the formatters**

```typescript
import { describe, it, expect } from "vitest";
import { formatClaim, policyContext } from "./format";
import type { ClaimRow } from "./seed";

const denied: ClaimRow = {
  claim_id: "CLM-1003", patient_id: "PAT-002", date_of_service: "2025-02-10",
  procedure_code: "70551", procedure_desc: "MRI brain", diagnosis_code: "G43.909",
  billed_amount: "1800.00", status: "denied", denial_code: "D-NOAUTH",
  denial_reason: "No prior authorization on file",
};

describe("formatClaim", () => {
  it("includes denial detail only for denied claims", () => {
    const line = formatClaim(denied);
    expect(line).toContain("Claim CLM-1003");
    expect(line).toContain("denial D-NOAUTH: No prior authorization on file");
  });

  it("omits denial detail for approved claims", () => {
    const approved = { ...denied, status: "approved", denial_code: "", denial_reason: "" };
    expect(formatClaim(approved)).not.toContain("denial");
  });
});

describe("policyContext", () => {
  it("labels each excerpt with its source", () => {
    const ctx = policyContext([{ source: "COV-002.md", text: "rule text" }]);
    expect(ctx).toContain("[COV-002.md]");
    expect(ctx).toContain("rule text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx vitest run claims/format.test.ts`
Expected: FAIL — `formatClaim`/`policyContext` not exported.

- [ ] **Step 3: Implement `backend/claims/format.ts`**

```typescript
import type { ClaimRow } from "./seed";
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
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `npx vitest run claims/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `backend/claims/claude.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { secret } from "encore.dev/config";

const anthropicKey = secret("AnthropicApiKey");

export const SYSTEM_PROMPT = `You are a healthcare claims policy assistant for claims analysts.
You answer strictly from the policy excerpts and claim data provided in the user
message. Ground every statement in that context.

Rules:
- Cite the specific policy rule id (for example COV-002.2) whenever you rely on it.
- If the provided context does not contain the answer, say so plainly rather than
  guessing.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note.`;

function client(): Anthropic {
  const key = anthropicKey();
  if (!key) {
    throw new Error("AnthropicApiKey secret is not set. Set it with `encore secret set`.");
  }
  return new Anthropic({ apiKey: key });
}

export async function* askStream(userContent: string): AsyncGenerator<string> {
  const stream = client().messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/claims/format.ts backend/claims/format.test.ts backend/claims/claude.ts
git commit -m "feat(backend): Claude streaming wrapper + context formatters"
```

---

### Task 5: Non-streaming endpoints (GET /claims, GET /similar-denied)

**Files:**
- Create: `backend/claims/api.ts`
- Test: `backend/claims/api.test.ts`

**Interfaces:**
- Consumes: `db` from `./db`, `ensureSeeded` from `./seed`, `ClaimRow` from `./seed`.
- Produces (used by frontend + later task in same file):
  - `listClaims(): Promise<{ claims: ClaimRow[] }>` — endpoint `GET /claims`.
  - `similarDenied(p: { claimId: string }): Promise<{ claims: ClaimRow[] }>` — endpoint `GET /similar-denied`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { listClaims, similarDenied } from "./api";

describe("listClaims", () => {
  it("returns all seeded claims", async () => {
    const res = await listClaims();
    expect(res.claims.length).toBeGreaterThan(0);
    expect(res.claims.some((c) => c.claim_id === "CLM-1001")).toBe(true);
  });
});

describe("similarDenied", () => {
  it("returns other claims with the same denial code, excluding the reference", async () => {
    const res = await similarDenied({ claimId: "CLM-1003" }); // D-NOAUTH
    expect(res.claims.every((c) => c.claim_id !== "CLM-1003")).toBe(true);
    expect(res.claims.every((c) => c.denial_code === "D-NOAUTH")).toBe(true);
  });

  it("returns empty when the reference claim has no denial code", async () => {
    const res = await similarDenied({ claimId: "CLM-1001" }); // approved
    expect(res.claims).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `encore test claims/api.test.ts`
Expected: FAIL — `listClaims`/`similarDenied` not defined.

- [ ] **Step 3: Implement `backend/claims/api.ts` (this task's portion)**

```typescript
import { api, Query } from "encore.dev/api";
import { db } from "./db";
import { ensureSeeded, type ClaimRow } from "./seed";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `encore test claims/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/claims/api.ts backend/claims/api.test.ts
git commit -m "feat(backend): GET /claims and GET /similar-denied"
```

---

### Task 6: Streaming feature endpoints

**Files:**
- Modify: `backend/claims/api.ts` (append the four streaming endpoints + a shared lookup helper)
- Modify: `backend/claims/api.test.ts` (append not-found-guard tests)

**Interfaces:**
- Consumes: `askStream` from `./claude`; `retrieve` from `./retrieval`; `formatClaim`, `policyContext` from `./format`; `db`, `ensureSeeded`, `ClaimRow` from earlier.
- Produces endpoints (all `api.streamOut`, streaming text deltas as `{ text: string }`):
  - `whyDenied` — `POST /why-denied`, handshake `{ claimId: string }`
  - `whichPolicy` — `POST /which-policy`, handshake `{ question: string }`
  - `patientHistory` — `POST /patient-history`, handshake `{ patientId: string }`
  - `appealSummary` — `POST /appeal-summary`, handshake `{ claimId: string }`
- Also produces helper `getClaim(claimId: string): Promise<ClaimRow | null>` (exported for tests).

- [ ] **Step 1: Write the failing not-found-guard test (append to `api.test.ts`)**

```typescript
import { getClaim } from "./api";

describe("getClaim", () => {
  it("returns null for an unknown claim id", async () => {
    expect(await getClaim("CLM-DOES-NOT-EXIST")).toBeNull();
  });
  it("returns the row for a known claim id", async () => {
    const c = await getClaim("CLM-1003");
    expect(c?.denial_code).toBe("D-NOAUTH");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `encore test claims/api.test.ts`
Expected: FAIL — `getClaim` not exported.

- [ ] **Step 3: Append the helper + streaming endpoints to `backend/claims/api.ts`**

Add these imports at the top of the file:

```typescript
import { StreamOut } from "encore.dev/api";
import { askStream } from "./claude";
import { retrieve } from "./retrieval";
import { formatClaim, policyContext } from "./format";
```

Append to the file:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `encore test claims/api.test.ts`
Expected: PASS (the `getClaim` tests; the streaming endpoints compile).

- [ ] **Step 5: Manual smoke test of one streaming endpoint**

Set the secret, then run the app and exercise `why-denied`:

```bash
encore secret set --type local AnthropicApiKey
# paste your sk-ant-... key when prompted
encore run
```

In Encore's local dashboard (URL printed by `encore run`), call the `whyDenied` stream with `{ "claimId": "CLM-1003" }`.
Expected: streamed text explaining the D-NOAUTH denial, citing a COV-002 rule.

- [ ] **Step 6: Commit**

```bash
git add backend/claims/api.ts backend/claims/api.test.ts
git commit -m "feat(backend): streaming why-denied/which-policy/patient-history/appeal-summary"
```

---

### Task 7: Generate the typed frontend client

**Files:**
- Create: `frontend/lib/client.ts` (generated — do not hand-edit)

**Interfaces:**
- Produces: the generated Encore request client used by `frontend/lib/api.ts` in Task 9.

- [ ] **Step 1: Generate the client from the backend**

Run (from `backend/`): `encore gen client --output ../frontend/lib/client.ts --env local`
Expected: writes `frontend/lib/client.ts` exporting a `Client` class with `claims.listClaims`, `claims.similarDenied`, and the four streaming methods.

> Note: regenerate this file (with `--env <your-cloud-env>` and the deployed base URL) after the backend is deployed to Encore Cloud, so the frontend points at the cloud API.

- [ ] **Step 2: Commit**

```bash
git add frontend/lib/client.ts
git commit -m "chore(frontend): generate Encore API client"
```

---

### Task 8: Frontend scaffold + non-streaming features

**Files:**
- Create: `frontend/package.json`, `frontend/next.config.mjs`, `frontend/tsconfig.json`,
  `frontend/tailwind.config.ts`, `frontend/postcss.config.mjs`, `frontend/.env.local.example`
- Create: `frontend/app/layout.tsx`, `frontend/app/globals.css`, `frontend/app/page.tsx`
- Create: `frontend/lib/types.ts`, `frontend/lib/api.ts`

**Interfaces:**
- Consumes: generated `Client` from `./client` (Task 7).
- Produces: a running Next.js app showing the claims table (`GET /claims`) and the "Similar denials" tab (`GET /similar-denied`).

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "claims-frontend",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.6",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create the config files**

`frontend/next.config.mjs`:
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
```

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`frontend/tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

`frontend/postcss.config.mjs`:
```javascript
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`frontend/.env.local.example`:
```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

- [ ] **Step 3: Create `frontend/app/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Create `frontend/lib/types.ts`**

```typescript
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
```

- [ ] **Step 5: Create `frontend/lib/api.ts` (non-streaming portion)**

```typescript
import Client, { Environment, Local } from "./client";
import type { ClaimRow } from "./types";

const target = process.env.NEXT_PUBLIC_API_URL ?? Local;
const client = new Client(target as Environment);

export async function getClaims(): Promise<ClaimRow[]> {
  const res = await client.claims.listClaims();
  return res.claims as ClaimRow[];
}

export async function getSimilarDenied(claimId: string): Promise<ClaimRow[]> {
  const res = await client.claims.similarDenied({ claimId });
  return res.claims as ClaimRow[];
}

export { client };
```

- [ ] **Step 6: Create `frontend/app/layout.tsx`**

```tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Claims Policy Assistant" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
```

- [ ] **Step 7: Create `frontend/app/page.tsx` (claims table + Similar-denials tab only)**

```tsx
"use client";
import { useEffect, useState } from "react";
import { getClaims, getSimilarDenied } from "@/lib/api";
import type { ClaimRow } from "@/lib/types";

const TABS = ["Why denied?", "Which policy?", "Patient history", "Similar denials", "Appeal summary"] as const;

export default function Page() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [tab, setTab] = useState<typeof TABS[number]>("Similar denials");
  const [similar, setSimilar] = useState<ClaimRow[]>([]);
  const [refClaim, setRefClaim] = useState("");

  useEffect(() => { getClaims().then(setClaims); }, []);
  const denied = claims.filter((c) => c.status === "denied");

  return (
    <main className="flex gap-6 p-6">
      <aside className="w-72 shrink-0">
        <h2 className="font-semibold mb-2">Claims</h2>
        <ul className="text-sm space-y-1">
          {claims.map((c) => (
            <li key={c.claim_id} className="flex justify-between border-b py-1">
              <span>{c.claim_id}</span><span className="text-slate-500">{c.status}</span>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex-1">
        <h1 className="text-2xl font-bold mb-1">🏥 Healthcare Claims Policy Assistant</h1>
        <p className="text-slate-600 mb-4 text-sm">Answers grounded in policy documents, with the governing rule cited.</p>
        <nav className="flex gap-2 mb-4">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded text-sm ${tab === t ? "bg-slate-900 text-white" : "bg-slate-200"}`}>{t}</button>
          ))}
        </nav>
        {tab === "Similar denials" && (
          <div>
            <select className="border rounded px-2 py-1 mr-2" value={refClaim} onChange={(e) => setRefClaim(e.target.value)}>
              <option value="">Select a denied claim</option>
              {denied.map((c) => <option key={c.claim_id} value={c.claim_id}>{c.claim_id}</option>)}
            </select>
            <button className="bg-slate-900 text-white px-3 py-1 rounded text-sm"
              onClick={async () => setSimilar(await getSimilarDenied(refClaim))} disabled={!refClaim}>Find similar</button>
            {similar.length === 0 ? <p className="mt-3 text-sm text-slate-500">No similar denials shown.</p> : (
              <ul className="mt-3 text-sm">{similar.map((c) => <li key={c.claim_id}>{c.claim_id} — {c.denial_reason}</li>)}</ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
```

(Add a path alias so `@/lib/...` resolves: ensure `frontend/tsconfig.json` `compilerOptions.paths` includes `"@/*": ["./*"]` — add it now.)

- [ ] **Step 8: Run the frontend against the local backend**

In one terminal (from `backend/`): `encore run`
In another (from `frontend/`): `cp .env.local.example .env.local && npm install && npm run dev`
Open `http://localhost:3000`.
Expected: the claims sidebar lists CLM-1001…; the "Similar denials" tab returns CLM peers for a D-NOAUTH claim.

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): Next.js scaffold, claims table, similar-denials tab"
```

---

### Task 9: Frontend streaming features

**Files:**
- Modify: `frontend/lib/api.ts` (add streaming helpers)
- Modify: `frontend/app/page.tsx` (add the four streaming tabs)

**Interfaces:**
- Consumes: the generated streaming client methods (`client.claims.whyDenied()`, etc.) which return a stream that is async-iterable over `{ text: string }`.
- Produces: live token rendering for the four answer features.

- [ ] **Step 1: Add streaming helpers to `frontend/lib/api.ts`**

```typescript
// Each generated streamOut method returns a stream async-iterable over { text }.
export async function* whyDenied(claimId: string) {
  const stream = await client.claims.whyDenied({ claimId });
  for await (const msg of stream) yield (msg as { text: string }).text;
}
export async function* whichPolicy(question: string) {
  const stream = await client.claims.whichPolicy({ question });
  for await (const msg of stream) yield (msg as { text: string }).text;
}
export async function* patientHistory(patientId: string) {
  const stream = await client.claims.patientHistory({ patientId });
  for await (const msg of stream) yield (msg as { text: string }).text;
}
export async function* appealSummary(claimId: string) {
  const stream = await client.claims.appealSummary({ claimId });
  for await (const msg of stream) yield (msg as { text: string }).text;
}
```

- [ ] **Step 2: Add a streaming render helper + the four tabs to `frontend/app/page.tsx`**

Add this state and runner inside the component:

```tsx
const [answer, setAnswer] = useState("");
const [busy, setBusy] = useState(false);

async function run(gen: AsyncGenerator<string>) {
  setAnswer(""); setBusy(true);
  try { for await (const t of gen) setAnswer((a) => a + t); }
  finally { setBusy(false); }
}
```

Render blocks for each tab (place above the existing "Similar denials" block). Import the helpers at the top: `import { whyDenied, whichPolicy, patientHistory, appealSummary } from "@/lib/api";` and derive `const patients = [...new Set(claims.map((c) => c.patient_id))].sort();`.

```tsx
{tab === "Why denied?" && (
  <div>
    <select className="border rounded px-2 py-1 mr-2" value={refClaim} onChange={(e) => setRefClaim(e.target.value)}>
      <option value="">Select a denied claim</option>
      {denied.map((c) => <option key={c.claim_id} value={c.claim_id}>{c.claim_id}</option>)}
    </select>
    <button className="bg-slate-900 text-white px-3 py-1 rounded text-sm" disabled={!refClaim || busy}
      onClick={() => run(whyDenied(refClaim))}>Explain denial</button>
    <pre className="mt-3 whitespace-pre-wrap text-sm">{answer}</pre>
  </div>
)}

{tab === "Which policy?" && (
  <WhichPolicy run={run} answer={answer} busy={busy} />
)}

{tab === "Patient history" && (
  <div>
    <select className="border rounded px-2 py-1 mr-2" value={refClaim} onChange={(e) => setRefClaim(e.target.value)}>
      <option value="">Select a patient</option>
      {patients.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
    <button className="bg-slate-900 text-white px-3 py-1 rounded text-sm" disabled={!refClaim || busy}
      onClick={() => run(patientHistory(refClaim))}>Summarize</button>
    <pre className="mt-3 whitespace-pre-wrap text-sm">{answer}</pre>
  </div>
)}

{tab === "Appeal summary" && (
  <div>
    <select className="border rounded px-2 py-1 mr-2" value={refClaim} onChange={(e) => setRefClaim(e.target.value)}>
      <option value="">Select a denied claim</option>
      {denied.map((c) => <option key={c.claim_id} value={c.claim_id}>{c.claim_id}</option>)}
    </select>
    <button className="bg-slate-900 text-white px-3 py-1 rounded text-sm" disabled={!refClaim || busy}
      onClick={() => run(appealSummary(refClaim))}>Draft appeal</button>
    <pre className="mt-3 whitespace-pre-wrap text-sm">{answer}</pre>
  </div>
)}
```

Add the small free-text component at the bottom of the file:

```tsx
function WhichPolicy({ run, answer, busy }: { run: (g: AsyncGenerator<string>) => void; answer: string; busy: boolean }) {
  const [q, setQ] = useState("An MRI was performed without prior authorization on file.");
  return (
    <div>
      <input className="border rounded px-2 py-1 w-full mb-2" value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="bg-slate-900 text-white px-3 py-1 rounded text-sm" disabled={busy}
        onClick={() => run(whichPolicy(q))}>Find the rule</button>
      <pre className="mt-3 whitespace-pre-wrap text-sm">{answer}</pre>
    </div>
  );
}
```

(Reset `answer` when switching tabs: in the `onClick` of each tab button, also call `setAnswer("")`.)

- [ ] **Step 3: Verify streaming end-to-end**

With `encore run` and `npm run dev` both up, open `http://localhost:3000`, pick CLM-1003 on "Why denied?", click Explain denial.
Expected: text streams in token-by-token, names the D-NOAUTH reason, cites a COV-002 rule.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/api.ts frontend/app/page.tsx
git commit -m "feat(frontend): streaming why-denied/which-policy/patient-history/appeal-summary tabs"
```

---

### Task 10: Remove the Streamlit app + deployment docs

**Files:**
- Delete: `app.py`, `rag.py`, `requirements.txt`, `.env.example` (root)
- Modify: `README.md`
- Create: `DEPLOY.md`

**Interfaces:** none (cleanup + documentation).

- [ ] **Step 1: Remove the old Python app from the working tree**

```bash
git rm app.py rag.py requirements.txt .env.example
```

(The files remain in git history. `data/` was already moved into `backend/` in Task 1.)

- [ ] **Step 2: Rewrite `README.md`**

Replace the run instructions with the monorepo layout and local-dev steps:

```markdown
# Healthcare Claims Policy Assistant

Next.js (Vercel) frontend + Encore (TypeScript) backend. An analyst asks plain-language
questions about denied claims and gets answers grounded in policy documents, with the
governing rule cited.

## Layout
- `frontend/` — Next.js App Router app, deployed to Vercel (root directory `frontend/`).
- `backend/`  — Encore TypeScript service + Postgres, deployed to Encore Cloud.

## Local development
1. Backend: `cd backend && encore secret set --type local AnthropicApiKey && encore run`
2. Frontend: `cd frontend && cp .env.local.example .env.local && npm install && npm run dev`
3. Open http://localhost:3000

All data is synthetic and for demonstration only.
```

- [ ] **Step 3: Create `DEPLOY.md` (the connect-the-three-services runbook)**

```markdown
# Deployment — GitHub → Vercel + Encore Cloud

## Backend (Encore Cloud)
1. Install the CLI and log in: `brew install encoredev/tap/encore && encore auth login`.
2. From `backend/`: `encore app create` (or link an existing app); commit the `id` written into `encore.app`.
3. In the Encore Cloud dashboard, connect this GitHub repo. Encore builds the app in `backend/` and provisions Postgres automatically on push to `main`.
4. Set the production secret: `encore secret set --type prod AnthropicApiKey` (paste the sk-ant-… key), or set it in the dashboard.
5. Note the deployed API base URL (e.g. `https://<app>-<env>.encr.app`).

## Frontend (Vercel)
1. In the Vercel dashboard, import the same GitHub repo.
2. Set **Root Directory = `frontend/`**.
3. Add env var `NEXT_PUBLIC_API_URL = <the Encore Cloud base URL>`.
4. Deploy. Vercel auto-deploys on every push to `main`.

## Regenerate the client for the cloud API
After the backend is deployed, regenerate the typed client to point at the cloud env:
`cd backend && encore gen client --output ../frontend/lib/client.ts --env <env-name>`
Commit the result.

All three are now connected to GitHub; a push to `main` deploys both.
```

- [ ] **Step 4: Run the full backend test suite once more**

Run (from `backend/`): `encore test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove Streamlit app; add README + DEPLOY runbook"
```

---

## Self-Review

**Spec coverage:**
- Monorepo `frontend/` + `backend/` → Tasks 1, 8, 10 ✓
- Postgres + full-text `tsvector` retrieval → Tasks 1, 3 ✓
- Claims + policy chunks seeded from CSV/markdown → Tasks 1, 2 ✓
- Claude wrapper (`claude-opus-4-8`, adaptive thinking, ported system prompt, streaming) → Task 4 ✓
- All 5 features (why-denied, which-policy, patient-history, similar-denied [no LLM], appeal-summary) → Tasks 5, 6 ✓
- Context-assembly parity (`formatClaim`/`policyContext`, per-endpoint queries) → Tasks 4, 6 ✓
- Not-found 404/guard behavior → Task 6 (guards return a plain "No claim/patient found" message, matching the original app's user-facing strings) ✓
- Missing-API-key fails fast → Task 4 ✓
- Next.js frontend, tabs, sidebar, streaming render, `NEXT_PUBLIC_API_URL` → Tasks 8, 9 ✓
- CORS for the Vercel origin → Task 1 (`encore.app` global_cors) ✓
- CI/CD wiring (GitHub → Vercel root dir `frontend/`, Encore Cloud backend, secrets) → Task 10 (`DEPLOY.md`) ✓
- Remove Streamlit, reuse data as seed → Tasks 1, 10 ✓
- Tests for retrieve / similar-denied / not-found / seed → Tasks 2, 3, 5, 6 ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output.

**Type consistency:** `ClaimRow` (10 string fields) defined in `seed.ts` (Task 2), reused in `format.ts`, `api.ts`, and re-declared identically in `frontend/lib/types.ts`. `Retrieved { text; source }` defined in `retrieval.ts` (Task 3), consumed by `format.ts`/`api.ts`. `retrieve(query, k=4)`, `askStream(userContent)`, `formatClaim`, `policyContext`, `getClaim`, `ensureSeeded` names are consistent across tasks. Streaming message type `{ text: string }` consistent between backend `TextMsg` and frontend consumers.

**Note on guards vs spec:** The spec mentions "typed 404s." The plan implements the guard as a streamed plain-text "No claim found …" message inside the stream endpoints (faithful to the original Streamlit app's behavior, and simpler over a streaming channel than an HTTP 404). The non-streaming `similar-denied` returns an empty list for missing/no-denial-code claims, also matching the original. This is a deliberate, consistent choice.

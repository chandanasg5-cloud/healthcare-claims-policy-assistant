# Agentic Analyst Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five canned features with a free-form, multi-turn analyst chat driven by a hand-rolled agent loop over Gemini function calling, grounded in a real CMS policy corpus, with visible tool steps and cited sources.

**Architecture:** New `POST /chat` SSE endpoint on the Encore.ts backend runs an agent loop (`agent.ts`) that streams Gemini rounds, executes up to 5 Postgres-backed tools between rounds, and emits typed SSE events (`step`/`sources`/`text`/`error`/`done`). The Next.js frontend becomes a two-pane chat that renders the step trail and a collapsible sources panel. The retrieval corpus becomes real public-domain CMS policy excerpts; claims stay synthetic (~60) but exercise the real rules.

**Tech Stack:** TypeScript, Encore.ts (`api.raw` SSE, Postgres FTS), `@google/genai` (`gemini-2.5-flash`), Next.js App Router, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-07-13-agentic-chat-design.md`

## Global Constraints

- Model: `gemini-2.5-flash`, `maxOutputTokens: 2048`, `thinkingConfig: { thinkingBudget: 0 }` (thinking disabled).
- Agent loop: **max 6 rounds**, **max 3 tool calls per round**, server uses only the **last 20 messages**.
- SSE protocol (one JSON object per `data:` line, verbatim shapes):
  `{"type":"step","tool":"...","label":"..."}`, `{"type":"sources","chunks":[{"id","source","text"}]}`, `{"type":"text","text":"..."}`, `{"type":"error","message":"..."}`, `{"type":"done"}` (always last).
- Policy corpus: 8 docs of real CMS text, **under ~100 KB total**, each with frontmatter (`title`, `source_url`, `retrieved`). CMS material is public domain; keep source URLs accurate.
- Claims are synthetic; README must state the real-policies/synthetic-claims split.
- `backend/claims/data.ts` is GENERATED — after any change to `backend/claims/data/`, run `node scripts/gen-data.mjs` from `backend/`. Never hand-edit `data.ts`.
- No new dependencies (backend already has `@google/genai`; frontend gets none).
- Server is stateless: the client resends history each request.
- Pure tests run with `npx vitest run <file>` from `backend/` (no Docker). DB-backed tests need `encore test` (Docker); if Docker is unavailable, note it and rely on deploy verification (this is the project's established practice).
- Backend deploys via `git push encore main` (remote already configured); GitHub push updates Vercel.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Policy-doc parsing and chunking for real CMS documents

The current `chunkPolicy` splits on blank lines only. Real CMS docs have frontmatter and `##` sections; chunks must carry their section heading (retrieval context) and stay under ~1200 chars.

**Files:**
- Modify: `backend/claims/parse.ts` (replace `chunkPolicy`, add `parsePolicyDoc`)
- Test: `backend/claims/parse.test.ts` (replace existing `chunkPolicy` tests; keep `parseClaimsCsv` tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `parsePolicyDoc(raw: string): { title: string; sourceUrl: string; body: string }` and `chunkPolicy(text: string, source: string): { id: string; source: string; text: string }[]` (same signature as today — `seed.ts` keeps working unmodified). Chunk ids are `` `${source}#${n}` `` with `n` counting from 0 across the whole doc.

- [ ] **Step 1: Write the failing tests**

In `backend/claims/parse.test.ts`, DELETE any existing `describe`/`it` blocks that test `chunkPolicy` (keep all `parseClaimsCsv` tests), then add:

```ts
import { parsePolicyDoc, chunkPolicy } from "./parse";

const DOC = `---
title: Medicare Claims Processing Manual, Chapter 1 (excerpt)
source_url: https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c01.pdf
retrieved: 2026-07-13
---

# Timely Filing

## 70 - Time Limitations for Filing Part A and Part B Claims

Claims must be filed no later than 12 calendar months after the date of service.

A claim received after the deadline is denied for timely filing.

## 70.7 - Exceptions

${"Administrative error language. ".repeat(60)}

${"Retroactive entitlement language. ".repeat(60)}
`;

describe("parsePolicyDoc", () => {
  it("extracts frontmatter fields and strips them from the body", () => {
    const doc = parsePolicyDoc(DOC);
    expect(doc.title).toBe("Medicare Claims Processing Manual, Chapter 1 (excerpt)");
    expect(doc.sourceUrl).toContain("cms.gov");
    expect(doc.body.startsWith("# Timely Filing")).toBe(true);
    expect(doc.body).not.toContain("source_url");
  });

  it("passes through documents without frontmatter", () => {
    const doc = parsePolicyDoc("# Plain\n\nJust text here, long enough to matter.");
    expect(doc.title).toBe("");
    expect(doc.body).toContain("Just text");
  });
});

describe("chunkPolicy", () => {
  it("excludes frontmatter from chunks and prefixes each chunk with its section heading", () => {
    const chunks = chunkPolicy(DOC, "timely-filing.md");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.text).not.toContain("source_url");
    const filing = chunks.find((c) => c.text.includes("12 calendar months"));
    expect(filing).toBeDefined();
    expect(filing!.text).toContain("70 - Time Limitations");
  });

  it("splits long sections into chunks under ~1400 chars with sequential ids", () => {
    const chunks = chunkPolicy(DOC, "timely-filing.md");
    for (const c of chunks) expect(c.text.length).toBeLessThan(1400);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `timely-filing.md#${i}`));
    expect(chunks.filter((c) => c.text.includes("Administrative error")).length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run claims/parse.test.ts`
Expected: FAIL — `parsePolicyDoc` is not exported; heading-prefix assertions fail.

- [ ] **Step 3: Implement**

In `backend/claims/parse.ts`, replace the existing `chunkPolicy` function with:

```ts
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
    for (const p of paras) {
      if (buf && buf.length + p.length + 2 > MAX_CHUNK) flush();
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    flush();
  }
  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run claims/parse.test.ts`
Expected: PASS (all parse tests).

- [ ] **Step 5: Type-check and commit**

```bash
cd backend && npx tsc --noEmit
git add claims/parse.ts claims/parse.test.ts
git commit -m "feat(backend): frontmatter-aware, heading-keyed policy chunker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Real CMS policy corpus

Replace the three authored `COV-00x` docs with 8 curated excerpts of real CMS policy text. Text is fetched from cms.gov at execution time (WebFetch or curl); the plan cannot inline it. Curation rules below are binding.

**Files:**
- Create: `backend/scripts/policy-sources.json` (provenance manifest)
- Create: `backend/scripts/fetch-policies.mjs` (downloads raw sources for reference)
- Create: 8 files under `backend/claims/data/policies/` (listed below)
- Delete: `backend/claims/data/policies/COV-001-preventive-care.md`, `COV-002-prior-authorization.md`, `COV-003-medical-necessity.md`

**Interfaces:**
- Produces: the 8 policy markdown files consumed by `gen-data.mjs`/`seed.ts`, and the doc-name strings used by `DENIAL_POLICY_MAP` in Task 3.

**The 8 documents** (exact filenames; each maps to denial codes used in Task 3):

| File | Real source (fetch from) | Must contain |
|---|---|---|
| `ncd-220-2-mri.md` | NCD 220.2 Magnetic Resonance Imaging — https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=177 (if 404: search "NCD 220.2" at https://www.cms.gov/medicare-coverage-database/search.aspx) | "220.2", covered/non-covered indications for MRI |
| `ncd-220-1-ct.md` | NCD 220.1 Computed Tomography — https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=176 (fallback: search "NCD 220.1") | "220.1", conditions for CT coverage incl. "medically appropriate" language |
| `reasonable-and-necessary.md` | Medicare Benefit Policy Manual, IOM 100-02 ch. 16 (General Exclusions) — https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/bp102c16.pdf | exclusion of services "not reasonable and necessary", experimental/investigational language |
| `prior-authorization-opd.md` | CMS Prior Authorization for Certain Hospital OPD Services — https://www.cms.gov/research-statistics-data-systems/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-certain-hospital-outpatient-department-opd-services | "prior authorization" as condition of payment; provisional affirmation validity period |
| `out-of-network.md` | Medicare Managed Care Manual, IOM 100-16 ch. 4 — https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/mc86c04.pdf | plan/network rules for non-contracted (out-of-network) providers, emergency exception |
| `timely-filing.md` | Medicare Claims Processing Manual, IOM 100-04 ch. 1 §70 — https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c01.pdf | "12 calendar months" timely filing limit, exceptions |
| `claim-edits.md` | Medicare Claims Processing Manual duplicate-claim and coding-edit language (IOM 100-04; ch. 1 duplicate claims sections) | duplicate claim denial language; valid diagnosis coding requirement |
| `appeals-redeterminations.md` | Medicare Claims Processing Manual, IOM 100-04 ch. 29 (Appeals) — https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c29.pdf | redetermination, 120-day appeal window, required documentation |

**Curation rules (binding):**
- Each file starts with frontmatter: `title:` (official document title + "(excerpt)"), `source_url:` (the URL actually fetched), `retrieved: 2026-07-13` (or actual date).
- Body: `# <title>` then `## <section>` headings matching the real document's section names/numbers where possible. Copy real sentences; trim lists aggressively. Target 4–12 KB per file, total corpus < 100 KB (`wc -c backend/claims/data/policies/*.md`).
- Do NOT invent rules. If a fetched source lacks needed language, pick a better CMS source and update `policy-sources.json`.

- [ ] **Step 1: Write the manifest**

`backend/scripts/policy-sources.json` — one entry per doc:

```json
{
  "retrieved": "2026-07-13",
  "sources": [
    { "file": "ncd-220-2-mri.md", "title": "NCD 220.2 Magnetic Resonance Imaging", "url": "https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=177" },
    { "file": "ncd-220-1-ct.md", "title": "NCD 220.1 Computed Tomography", "url": "https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=176" },
    { "file": "reasonable-and-necessary.md", "title": "Medicare Benefit Policy Manual ch.16 General Exclusions", "url": "https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/bp102c16.pdf" },
    { "file": "prior-authorization-opd.md", "title": "Prior Authorization for Certain Hospital OPD Services", "url": "https://www.cms.gov/research-statistics-data-systems/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-certain-hospital-outpatient-department-opd-services" },
    { "file": "out-of-network.md", "title": "Medicare Managed Care Manual ch.4", "url": "https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/mc86c04.pdf" },
    { "file": "timely-filing.md", "title": "Medicare Claims Processing Manual ch.1 (Timely Filing)", "url": "https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c01.pdf" },
    { "file": "claim-edits.md", "title": "Medicare Claims Processing Manual (Duplicate Claims / Coding Edits)", "url": "https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c01.pdf" },
    { "file": "appeals-redeterminations.md", "title": "Medicare Claims Processing Manual ch.29 (Appeals)", "url": "https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c29.pdf" }
  ]
}
```

Update URLs in this manifest if any fetch required a different source.

- [ ] **Step 2: Write the fetch script**

`backend/scripts/fetch-policies.mjs`:

```js
// Downloads the raw CMS sources listed in policy-sources.json into
// claims/data/sources/ (gitignored) so the curated excerpts in
// claims/data/policies/ can be reproduced and audited.
//   node scripts/fetch-policies.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "scripts", "policy-sources.json"), "utf-8"));
const outDir = join(root, "claims", "data", "sources");
mkdirSync(outDir, { recursive: true });

for (const s of manifest.sources) {
  const res = await fetch(s.url);
  if (!res.ok) {
    console.error(`FAILED ${s.file}: ${res.status} ${s.url}`);
    continue;
  }
  const ext = extname(new URL(s.url).pathname) || ".html";
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(outDir, s.file.replace(/\.md$/, ext)), buf);
  console.log(`fetched ${s.file} <- ${s.url} (${buf.length} bytes)`);
}
```

Add `sources/` to the gitignore: append the line `backend/claims/data/sources/` to the repo root `.gitignore`.

- [ ] **Step 3: Fetch and curate the 8 docs**

Run: `cd backend && node scripts/fetch-policies.mjs` (PDFs land in `claims/data/sources/`; extract text with `pdftotext` if available, otherwise fetch the same content via WebFetch on the URL). For each of the 8 docs, write the curated markdown per the curation rules, delete the three `COV-*.md` files.

Verify:
```bash
ls backend/claims/data/policies/            # exactly the 8 new files
wc -c backend/claims/data/policies/*.md     # total < 100000
grep -L "source_url:" backend/claims/data/policies/*.md   # empty output (all have frontmatter)
grep -l "12 calendar months" backend/claims/data/policies/timely-filing.md
grep -l "220.2" backend/claims/data/policies/ncd-220-2-mri.md
```

- [ ] **Step 4: Commit**

```bash
git add -A backend/claims/data/policies backend/scripts .gitignore
git commit -m "feat(data): replace authored policies with real CMS policy excerpts

NCD 220.1/220.2, Benefit Policy Manual ch.16, OPD prior authorization,
Managed Care Manual ch.4, Claims Processing Manual ch.1/29. Public-domain
CMS text; provenance in scripts/policy-sources.json.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`data.ts` is regenerated in Task 3 together with the new claims.)

---

### Task 3: Synthetic claims (60) + coverage invariant + regenerate data.ts

**Files:**
- Modify: `backend/claims/data/claims.csv` (replace entirely)
- Create: `backend/claims/coverage.ts` (denial-code → policy-doc map)
- Modify: `backend/claims/data.ts` (regenerated — do not hand-edit)
- Test: `backend/claims/coverage.test.ts`
- Modify: `backend/claims/retrieval.test.ts` (expectations for the real corpus)

**Interfaces:**
- Consumes: `POLICIES` from `./data` (regenerated), `parseClaimsCsv` from `./parse`.
- Produces: `DENIAL_POLICY_MAP: Record<string, { doc: string; mustContain: string }>` from `./coverage`.

- [ ] **Step 1: Replace claims.csv**

Full contents of `backend/claims/data/claims.csv` (header + 60 rows, 10 patients, dates across 2025; every denial code governed by the Task 2 corpus):

```csv
claim_id,patient_id,date_of_service,procedure_code,procedure_desc,diagnosis_code,billed_amount,status,denial_code,denial_reason
CLM-1001,PAT-001,2025-01-15,99396,Annual wellness visit,Z00.00,250.00,approved,,
CLM-1002,PAT-001,2025-06-20,99396,Annual wellness visit,Z00.00,250.00,denied,D-DUP,Duplicate of a claim already processed for the same service and date span
CLM-1003,PAT-002,2025-02-10,70551,MRI brain without contrast,G43.909,1800.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1004,PAT-002,2025-03-05,74177,CT abdomen and pelvis with contrast,R10.9,1200.00,approved,,
CLM-1005,PAT-003,2025-04-12,99385,Annual wellness visit,Z00.00,230.00,denied,D-OON,Provider is out of network and no exception applies
CLM-1006,PAT-004,2025-05-01,70551,MRI brain without contrast,G43.909,1800.00,denied,D-AUTHEXP,Prior authorization expired before the date of service
CLM-1007,PAT-005,2025-05-18,29826,Shoulder arthroscopy subacromial decompression,M75.100,4200.00,denied,D-NMN,Documentation does not establish medical necessity
CLM-1008,PAT-006,2025-06-02,0345T,Transcatheter mitral valve repair (investigational use),I25.10,9500.00,denied,D-EXP,Experimental or investigational service is excluded from coverage
CLM-1009,PAT-003,2025-07-09,74177,CT abdomen and pelvis with contrast,R10.31,1200.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1010,PAT-002,2025-08-21,99396,Annual wellness visit,Z00.00,250.00,approved,,
CLM-1011,PAT-007,2025-09-03,70551,MRI brain without contrast,G44.209,1800.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1012,PAT-005,2025-09-15,99213,Office visit established patient,J06.9,140.00,denied,D-CODE,Diagnosis code invalid or not coded to highest specificity
CLM-1013,PAT-001,2025-02-03,93000,Electrocardiogram routine,I10,95.00,approved,,
CLM-1014,PAT-001,2025-03-14,80053,Comprehensive metabolic panel,E11.9,48.00,approved,,
CLM-1015,PAT-001,2025-09-30,72148,MRI lumbar spine without contrast,M54.50,1650.00,denied,D-NMN,Imaging not supported by documented conservative treatment
CLM-1016,PAT-001,2025-11-12,99214,Office visit established patient,E11.9,185.00,approved,,
CLM-1017,PAT-002,2025-04-18,99213,Office visit established patient,G43.909,140.00,approved,,
CLM-1018,PAT-002,2025-10-05,70553,MRI brain with and without contrast,R51.9,2100.00,denied,D-NMN,Headache diagnosis does not meet imaging coverage indications
CLM-1019,PAT-002,2025-11-20,85025,Complete blood count,D64.9,32.00,approved,,
CLM-1020,PAT-003,2025-01-28,99203,Office visit new patient,Z00.00,175.00,approved,,
CLM-1021,PAT-003,2025-08-14,66984,Cataract surgery with IOL insertion,H25.11,3400.00,approved,,
CLM-1022,PAT-003,2025-10-22,92134,Retinal OCT imaging,H35.30,210.00,denied,D-TFL,Claim received more than 12 months after the date of service
CLM-1023,PAT-004,2025-01-09,99385,Annual wellness visit,Z00.00,230.00,approved,,
CLM-1024,PAT-004,2025-03-27,72148,MRI lumbar spine without contrast,M54.16,1650.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1025,PAT-004,2025-06-30,64483,Epidural steroid injection lumbar,M54.16,890.00,denied,D-NMN,Injection frequency exceeds coverage guidelines without documented benefit
CLM-1026,PAT-004,2025-08-08,99214,Office visit established patient,M54.16,185.00,approved,,
CLM-1027,PAT-004,2025-12-02,80053,Comprehensive metabolic panel,E78.5,48.00,denied,D-DUP,Duplicate of a claim already processed for the same service and date span
CLM-1028,PAT-005,2025-02-21,73721,MRI knee without contrast,M23.205,1500.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1029,PAT-005,2025-07-11,29881,Knee arthroscopy with meniscectomy,M23.205,3800.00,approved,,
CLM-1030,PAT-005,2025-11-05,97110,Physical therapy therapeutic exercise,M25.561,120.00,approved,,
CLM-1031,PAT-006,2025-01-17,99204,Office visit new patient,I25.10,260.00,approved,,
CLM-1032,PAT-006,2025-03-08,93458,Cardiac catheterization left heart,I25.10,5200.00,approved,,
CLM-1033,PAT-006,2025-07-25,0715T,Percutaneous coronary lithotripsy (investigational),I25.10,8800.00,denied,D-EXP,Experimental or investigational service is excluded from coverage
CLM-1034,PAT-006,2025-10-19,80061,Lipid panel,E78.5,42.00,denied,D-TFL,Claim received more than 12 months after the date of service
CLM-1035,PAT-007,2025-02-14,99385,Annual wellness visit,Z00.00,230.00,approved,,
CLM-1036,PAT-007,2025-05-23,74177,CT abdomen and pelvis with contrast,K57.30,1200.00,denied,D-AUTHEXP,Prior authorization expired before the date of service
CLM-1037,PAT-007,2025-08-29,45378,Diagnostic colonoscopy,K57.30,1450.00,approved,,
CLM-1038,PAT-007,2025-12-10,99213,Office visit established patient,K57.30,140.00,denied,D-CODE,Diagnosis code invalid or not coded to highest specificity
CLM-1039,PAT-008,2025-01-30,99203,Office visit new patient,M17.11,175.00,approved,,
CLM-1040,PAT-008,2025-04-07,73721,MRI knee without contrast,M17.11,1500.00,denied,D-NMN,Osteoarthritis staging does not require MRI under coverage policy
CLM-1041,PAT-008,2025-06-16,20610,Knee joint injection,M17.11,240.00,approved,,
CLM-1042,PAT-008,2025-09-24,27447,Total knee arthroplasty,M17.11,28500.00,denied,D-NOAUTH,No prior authorization on file for service requiring prior authorization
CLM-1043,PAT-008,2025-11-30,97110,Physical therapy therapeutic exercise,Z47.1,120.00,denied,D-OON,Provider is out of network and no exception applies
CLM-1044,PAT-009,2025-02-06,99385,Annual wellness visit,Z00.00,230.00,approved,,
CLM-1045,PAT-009,2025-04-29,76700,Abdominal ultrasound complete,R10.9,320.00,approved,,
CLM-1046,PAT-009,2025-07-17,74177,CT abdomen and pelvis with contrast,R10.9,1200.00,denied,D-NMN,Ultrasound findings do not support advanced imaging necessity
CLM-1047,PAT-009,2025-09-08,43239,Upper GI endoscopy with biopsy,K21.9,1900.00,denied,D-OON,Provider is out of network and no exception applies
CLM-1048,PAT-009,2025-12-18,99214,Office visit established patient,K21.9,185.00,approved,,
CLM-1049,PAT-010,2025-01-22,99396,Annual wellness visit,Z00.00,250.00,approved,,
CLM-1050,PAT-010,2025-03-19,77067,Screening mammography bilateral,Z12.31,290.00,approved,,
CLM-1051,PAT-010,2025-06-05,77065,Diagnostic mammography unilateral,N63.10,340.00,denied,D-DUP,Duplicate of a claim already processed for the same service and date span
CLM-1052,PAT-010,2025-08-13,19083,Breast biopsy with ultrasound guidance,N63.10,1750.00,approved,,
CLM-1053,PAT-010,2025-10-27,0042T,Cerebral perfusion analysis (investigational),I67.9,2300.00,denied,D-EXP,Experimental or investigational service is excluded from coverage
CLM-1054,PAT-010,2025-12-22,99213,Office visit established patient,N63.10,140.00,denied,D-TFL,Claim received more than 12 months after the date of service
CLM-1055,PAT-003,2025-05-30,70551,MRI brain without contrast,R51.9,1800.00,denied,D-NMN,Headache diagnosis does not meet imaging coverage indications
CLM-1056,PAT-006,2025-05-09,99215,Office visit established patient high complexity,I50.9,240.00,approved,,
CLM-1057,PAT-008,2025-02-27,99213,Office visit established patient,M17.11,140.00,denied,D-DUP,Duplicate of a claim already processed for the same service and date span
CLM-1058,PAT-005,2025-12-04,72148,MRI lumbar spine without contrast,M54.50,1650.00,denied,D-AUTHEXP,Prior authorization expired before the date of service
CLM-1059,PAT-009,2025-11-11,93306,Echocardiogram complete,I48.91,850.00,approved,,
CLM-1060,PAT-007,2025-07-02,99406,Smoking cessation counseling,F17.210,45.00,denied,D-CODE,Diagnosis code invalid or not coded to highest specificity
```

- [ ] **Step 2: Write the failing coverage test**

`backend/claims/coverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DENIAL_POLICY_MAP } from "./coverage";
import { parseClaimsCsv } from "./parse";
import { CLAIMS_CSV, POLICIES } from "./data";

describe("denial-code policy coverage", () => {
  const claims = parseClaimsCsv(CLAIMS_CSV);
  const denialCodes = [...new Set(claims.filter((c) => c.denial_code).map((c) => c.denial_code))];

  it("has 60 claims across 10 patients", () => {
    expect(claims.length).toBe(60);
    expect(new Set(claims.map((c) => c.patient_id)).size).toBe(10);
  });

  it("maps every denial code used in claims.csv to a policy doc", () => {
    for (const code of denialCodes) expect(DENIAL_POLICY_MAP[code], code).toBeDefined();
  });

  it("every mapped doc exists in the corpus and contains its governing language", () => {
    for (const [code, m] of Object.entries(DENIAL_POLICY_MAP)) {
      expect(POLICIES[m.doc], `${code} -> ${m.doc}`).toBeDefined();
      expect(POLICIES[m.doc].toLowerCase()).toContain(m.mustContain.toLowerCase());
    }
  });

  it("every policy doc declares a cms.gov source_url", () => {
    for (const [name, text] of Object.entries(POLICIES)) {
      expect(text, name).toMatch(/^---[\s\S]*?source_url:\s*https:\/\/www\.cms\.gov/);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run claims/coverage.test.ts`
Expected: FAIL — `./coverage` module does not exist.

- [ ] **Step 4: Implement coverage.ts and regenerate data.ts**

`backend/claims/coverage.ts`:

```ts
// Maps each denial code used in claims.csv to the corpus document that
// governs it and a phrase that must appear in that document. Enforced by
// coverage.test.ts so demo questions never dead-end.
export const DENIAL_POLICY_MAP: Record<string, { doc: string; mustContain: string }> = {
  "D-NOAUTH": { doc: "prior-authorization-opd.md", mustContain: "prior authorization" },
  "D-AUTHEXP": { doc: "prior-authorization-opd.md", mustContain: "provisional affirmation" },
  "D-OON": { doc: "out-of-network.md", mustContain: "network" },
  "D-NMN": { doc: "reasonable-and-necessary.md", mustContain: "reasonable and necessary" },
  "D-EXP": { doc: "reasonable-and-necessary.md", mustContain: "investigational" },
  "D-TFL": { doc: "timely-filing.md", mustContain: "12 calendar months" },
  "D-DUP": { doc: "claim-edits.md", mustContain: "duplicate" },
  "D-CODE": { doc: "claim-edits.md", mustContain: "diagnosis" },
};
```

If a `mustContain` phrase is absent from the curated doc, prefer adjusting the excerpt (include the real sentence) over weakening the phrase.

Regenerate the embedded data: `cd backend && node scripts/gen-data.mjs`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run claims/coverage.test.ts claims/parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Update retrieval.test.ts for the real corpus**

Replace the body of the existing `describe("retrieve")` in `backend/claims/retrieval.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { retrieve } from "./retrieval";

describe("retrieve", () => {
  it("returns prior-authorization policy text for an MRI-without-auth query", async () => {
    const results = await retrieve("MRI performed without prior authorization", 4);
    expect(results.length).toBeGreaterThan(0);
    const joined = results.map((r) => r.text).join(" ").toLowerCase();
    expect(joined).toContain("prior authorization");
    expect(results[0].id).toContain("#");
  });

  it("returns timely-filing text for a late-claim query", async () => {
    const results = await retrieve("claim filed after twelve month deadline timely filing", 4);
    expect(results.map((r) => r.source)).toContain("timely-filing.md");
  });
});
```

(The `id` field on results is added in Task 4 — this test file is run under `encore test`, which happens in Task 4's verification. Do not run it here; just commit the updated expectations.)

- [ ] **Step 7: Type-check and commit**

```bash
cd backend && npx tsc --noEmit
git add claims/data/claims.csv claims/coverage.ts claims/coverage.test.ts claims/data.ts claims/retrieval.test.ts
git commit -m "feat(data): 60 synthetic claims exercising the real CMS corpus, with coverage invariant

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Retrieval ids + DB-backed tools

**Files:**
- Modify: `backend/claims/retrieval.ts` (return chunk `id`)
- Create: `backend/claims/tools.ts` (tool executors; `getClaim` moves here from `api.ts` in spirit — `api.ts` keeps its own copy until Task 7 removes it)
- Test: `backend/claims/tools.test.ts` (DB-backed — runs under `encore test`)

**Interfaces:**
- Consumes: `validateToolArgs` from `./toolspec` (Task 5 — see note below), `retrieve` from `./retrieval`, `formatClaim`/`policyContext` from `./format`, `db`, `ensureSeeded`.
- Produces:
  - `retrieve(query: string, k?: number): Promise<Retrieved[]>` where `Retrieved = { id: string; text: string; source: string }`
  - `runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>` where `ToolOutcome = { output: string; sources?: { id: string; source: string; text: string }[] }`
  - `getClaim(claimId: string): Promise<ClaimRow | null>` exported from `tools.ts`

**Note on order:** Tasks 4 and 5 are cross-referenced (`tools.ts` imports `validateToolArgs` from `toolspec.ts`; the agent imports both). **Execute Task 5 before Task 4** if implementing strictly in order matters to you; they are written separately because they carry separate test cycles. Task 5 has no dependency on Task 4.

- [ ] **Step 1: Write the failing DB-backed test**

`backend/claims/tools.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runTool } from "./tools";

describe("runTool", () => {
  it("rejects unknown tools and bad args with model-readable errors", async () => {
    expect((await runTool("no_such_tool", {})).output).toContain("Error");
    expect((await runTool("get_claim", {})).output).toContain("Error");
    expect((await runTool("get_claim", { claimId: "" })).output).toContain("Error");
  });

  it("get_claim returns a formatted claim or a not-found message", async () => {
    expect((await runTool("get_claim", { claimId: "CLM-1003" })).output).toContain("D-NOAUTH");
    expect((await runTool("get_claim", { claimId: "CLM-9999" })).output).toContain("No claim found");
  });

  it("get_patient_claims lists all of a patient's claims", async () => {
    const { output } = await runTool("get_patient_claims", { patientId: "PAT-002" });
    expect(output).toContain("CLM-1003");
    expect(output).toContain("CLM-1018");
  });

  it("find_similar_denied returns other claims with the same code", async () => {
    const { output } = await runTool("find_similar_denied", { claimId: "CLM-1003" });
    expect(output).toContain("CLM-1009");
    expect(output).not.toContain("CLM-1003");
  });

  it("search_policies returns policy text plus source chunks", async () => {
    const r = await runTool("search_policies", { query: "prior authorization imaging" });
    expect(r.output.toLowerCase()).toContain("prior authorization");
    expect(r.sources && r.sources.length).toBeGreaterThan(0);
    expect(r.sources![0].id).toContain("#");
  });

  it("claims_overview aggregates counts and billed totals", async () => {
    const { output } = await runTool("claims_overview", {});
    expect(output).toContain("approved");
    expect(output).toContain("D-NOAUTH");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && encore test claims/tools.test.ts` (requires Docker; if unavailable, run `npx tsc --noEmit` to confirm the module is missing and continue — deploy verification in Task 10 covers behavior).
Expected: FAIL — `./tools` does not exist.

- [ ] **Step 3: Add `id` to retrieval and implement tools.ts**

In `backend/claims/retrieval.ts`, change the interface and query:

```ts
export interface Retrieved {
  id: string;
  text: string;
  source: string;
}

export async function retrieve(query: string, k = 4): Promise<Retrieved[]> {
  await ensureSeeded();
  const rows = db.query<Retrieved>`
    SELECT id, text, source
    FROM policy_chunks
    WHERE tsv @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(tsv, plainto_tsquery('english', ${query})) DESC
    LIMIT ${k}
  `;
  const out: Retrieved[] = [];
  for await (const row of rows) out.push({ id: row.id, text: row.text, source: row.source });
  return out;
}
```

Create `backend/claims/tools.ts`:

```ts
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
        db.query<ClaimRow>`SELECT * FROM claims WHERE patient_id = ${args.patientId} ORDER BY claim_id`,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && encore test claims/tools.test.ts claims/retrieval.test.ts` (Docker; skip if unavailable) and `npx tsc --noEmit`.
Expected: PASS / clean type-check. Note: `agent.ts`/`toolspec.ts` must exist (Task 5) for tsc to pass — see the ordering note above.

- [ ] **Step 5: Commit**

```bash
git add claims/retrieval.ts claims/tools.ts claims/tools.test.ts
git commit -m "feat(backend): DB-backed agent tools and chunk ids in retrieval

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Tool spec (pure) — declarations, validation, step labels

**Files:**
- Create: `backend/claims/toolspec.ts`
- Test: `backend/claims/toolspec.test.ts` (pure — plain vitest)

**Interfaces:**
- Produces:
  - `toolDeclarations: ToolDeclaration[]` — Gemini-compatible function declarations (`type` values are the string enum values `"OBJECT"`/`"STRING"` so they cast directly to `@google/genai` `Type`).
  - `validateToolArgs(name: string, args: Record<string, unknown>): { ok: true } | { ok: false; error: string }`
  - `stepLabel(name: string, args: Record<string, unknown>): string`

- [ ] **Step 1: Write the failing tests**

`backend/claims/toolspec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toolDeclarations, validateToolArgs, stepLabel } from "./toolspec";

describe("toolDeclarations", () => {
  it("declares exactly the five tools", () => {
    expect(toolDeclarations.map((d) => d.name).sort()).toEqual([
      "claims_overview", "find_similar_denied", "get_claim", "get_patient_claims", "search_policies",
    ]);
  });
});

describe("validateToolArgs", () => {
  it("accepts valid args and rejects unknown tools / missing / empty args", () => {
    expect(validateToolArgs("get_claim", { claimId: "CLM-1003" }).ok).toBe(true);
    expect(validateToolArgs("claims_overview", {}).ok).toBe(true);
    expect(validateToolArgs("nope", {}).ok).toBe(false);
    expect(validateToolArgs("get_claim", {}).ok).toBe(false);
    expect(validateToolArgs("search_policies", { query: "  " }).ok).toBe(false);
    expect(validateToolArgs("get_claim", { claimId: 42 }).ok).toBe(false);
  });
});

describe("stepLabel", () => {
  it("produces human-readable labels", () => {
    expect(stepLabel("get_claim", { claimId: "CLM-1003" })).toBe("Looking up claim CLM-1003");
    expect(stepLabel("search_policies", { query: "prior auth" })).toBe("Searching policies: prior auth");
    expect(stepLabel("get_patient_claims", { patientId: "PAT-002" })).toBe("Fetching claims for patient PAT-002");
    expect(stepLabel("find_similar_denied", { claimId: "CLM-1005" })).toBe("Finding claims similar to CLM-1005");
    expect(stepLabel("claims_overview", {})).toBe("Computing claims overview");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run claims/toolspec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/claims/toolspec.ts`:

```ts
// Pure tool metadata shared by the agent loop, the Gemini client, and the
// executors. No encore/db imports — unit-testable without a database.

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "OBJECT";
    properties: Record<string, { type: "STRING"; description: string }>;
    required: string[];
  };
}

export const toolDeclarations: ToolDeclaration[] = [
  {
    name: "get_claim",
    description: "Look up a single claim by id, including status and denial details.",
    parameters: {
      type: "OBJECT",
      properties: { claimId: { type: "STRING", description: "Claim id, e.g. CLM-1003" } },
      required: ["claimId"],
    },
  },
  {
    name: "get_patient_claims",
    description: "List all claims for one patient.",
    parameters: {
      type: "OBJECT",
      properties: { patientId: { type: "STRING", description: "Patient id, e.g. PAT-002" } },
      required: ["patientId"],
    },
  },
  {
    name: "find_similar_denied",
    description: "Find other claims denied with the same denial code as the given claim.",
    parameters: {
      type: "OBJECT",
      properties: { claimId: { type: "STRING", description: "Reference denied claim id" } },
      required: ["claimId"],
    },
  },
  {
    name: "search_policies",
    description:
      "Full-text search the CMS policy corpus (coverage rules, prior authorization, appeals, timely filing, network rules). Always use before citing a policy.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "Search terms, e.g. 'prior authorization MRI'" } },
      required: ["query"],
    },
  },
  {
    name: "claims_overview",
    description: "Aggregate claim counts and billed totals by status and denial code.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
];

export function validateToolArgs(
  name: string,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const decl = toolDeclarations.find((d) => d.name === name);
  if (!decl) return { ok: false, error: `unknown tool ${name}` };
  for (const req of decl.parameters.required) {
    const v = args[req];
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `missing or empty argument ${req} for ${name}` };
    }
  }
  return { ok: true };
}

export function stepLabel(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "?");
  switch (name) {
    case "get_claim": return `Looking up claim ${a("claimId")}`;
    case "get_patient_claims": return `Fetching claims for patient ${a("patientId")}`;
    case "find_similar_denied": return `Finding claims similar to ${a("claimId")}`;
    case "search_policies": return `Searching policies: ${a("query")}`;
    case "claims_overview": return "Computing claims overview";
    default: return `Running ${name}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run claims/toolspec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claims/toolspec.ts claims/toolspec.test.ts
git commit -m "feat(backend): pure tool spec — declarations, validation, step labels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Agent loop (pure)

**Files:**
- Create: `backend/claims/agent.ts`
- Test: `backend/claims/agent.test.ts` (pure — fake model client and fake tool runner; plain vitest, no DB, no network)

**Interfaces:**
- Consumes: `stepLabel` from `./toolspec`.
- Produces (all exported from `agent.ts`):
  - `ChatMessage = { role: "user" | "model"; text: string }`
  - `SourceChunk = { id: string; source: string; text: string }`
  - `AgentEvent = { type: "step"; tool: string; label: string } | { type: "sources"; chunks: SourceChunk[] } | { type: "text"; text: string }` (`error`/`done` are emitted by the endpoint, Task 7)
  - `FunctionCall = { name: string; args: Record<string, unknown> }`
  - `GenPart = { text?: string; functionCall?: FunctionCall; functionResponse?: { name: string; response: { output: string } } }`
  - `GenContent = { role: "user" | "model"; parts: GenPart[] }`
  - `RoundChunk = { text?: string; functionCalls?: FunctionCall[] }`
  - `ModelClient = { streamRound(contents: GenContent[]): AsyncGenerator<RoundChunk> }`
  - `ToolOutcome = { output: string; sources?: SourceChunk[] }`
  - `ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>`
  - `chatStream(history: ChatMessage[], model: ModelClient, runTool: ToolRunner): AsyncGenerator<AgentEvent>`
  - Constants: `MAX_ROUNDS = 6`, `MAX_CALLS_PER_ROUND = 3`, `HISTORY_LIMIT = 20`

- [ ] **Step 1: Write the failing tests**

`backend/claims/agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  chatStream, MAX_ROUNDS, HISTORY_LIMIT,
  type AgentEvent, type GenContent, type ModelClient, type RoundChunk, type ToolRunner,
} from "./agent";

// Fake model: pops one scripted round per streamRound call; records contents.
function fakeModel(rounds: RoundChunk[][]): ModelClient & { seen: GenContent[][] } {
  const seen: GenContent[][] = [];
  return {
    seen,
    async *streamRound(contents: GenContent[]) {
      seen.push(structuredClone(contents));
      for (const chunk of rounds.shift() ?? [{ text: "fallback answer" }]) yield chunk;
    },
  };
}

const echoTool: ToolRunner = async (name, args) => ({
  output: `${name}:${JSON.stringify(args)}`,
  ...(name === "search_policies"
    ? { sources: [{ id: "timely-filing.md#0", source: "timely-filing.md", text: "12 calendar months" }] }
    : {}),
});

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("chatStream", () => {
  it("streams a plain text answer when the model calls no tools", async () => {
    const model = fakeModel([[{ text: "Hello " }, { text: "analyst." }]]);
    const events = await drain(chatStream([{ role: "user", text: "hi" }], model, echoTool));
    expect(events).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "analyst." },
    ]);
    expect(model.seen.length).toBe(1);
  });

  it("runs a tool round-trip: step event, sources event, result fed back, final answer", async () => {
    const model = fakeModel([
      [{ functionCalls: [{ name: "search_policies", args: { query: "timely filing" } }] }],
      [{ text: "Per policy, 12 months." }],
    ]);
    const events = await drain(chatStream([{ role: "user", text: "deadline?" }], model, echoTool));
    expect(events[0]).toEqual({ type: "step", tool: "search_policies", label: "Searching policies: timely filing" });
    expect(events[1].type).toBe("sources");
    expect(events[2]).toEqual({ type: "text", text: "Per policy, 12 months." });
    // Round 2 must include the functionCall turn and a functionResponse turn.
    const round2 = model.seen[1];
    const flat = JSON.stringify(round2);
    expect(flat).toContain("functionCall");
    expect(flat).toContain("functionResponse");
    expect(flat).toContain("search_policies");
  });

  it("feeds tool-runner exceptions back to the model as error output instead of throwing", async () => {
    const model = fakeModel([
      [{ functionCalls: [{ name: "get_claim", args: { claimId: "CLM-1" } }] }],
      [{ text: "Could not look that up." }],
    ]);
    const boom: ToolRunner = async () => { throw new Error("db down"); };
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, boom));
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(JSON.stringify(model.seen[1])).toContain("db down");
  });

  it("rejects calls beyond MAX_CALLS_PER_ROUND with an error response, without running them", async () => {
    let runs = 0;
    const counting: ToolRunner = async (name, args) => { runs++; return { output: "ok" }; };
    const model = fakeModel([
      [{ functionCalls: [
        { name: "get_claim", args: { claimId: "a" } },
        { name: "get_claim", args: { claimId: "b" } },
        { name: "get_claim", args: { claimId: "c" } },
        { name: "get_claim", args: { claimId: "d" } },
      ] }],
      [{ text: "done" }],
    ]);
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, counting));
    expect(runs).toBe(3);
    expect(events.filter((e) => e.type === "step").length).toBe(3);
    expect(JSON.stringify(model.seen[1])).toContain("too many tool calls");
  });

  it("forces a final tool-free answer at MAX_ROUNDS", async () => {
    const toolRound: RoundChunk[] = [{ functionCalls: [{ name: "get_claim", args: { claimId: "CLM-1" } }] }];
    const rounds: RoundChunk[][] = [];
    for (let i = 0; i < MAX_ROUNDS - 1; i++) rounds.push(structuredClone(toolRound));
    rounds.push([{ text: "final forced answer" }, { functionCalls: [{ name: "get_claim", args: { claimId: "ignored" } }] }]);
    const model = fakeModel(rounds);
    const events = await drain(chatStream([{ role: "user", text: "x" }], model, echoTool));
    expect(model.seen.length).toBe(MAX_ROUNDS);
    const last = model.seen[MAX_ROUNDS - 1];
    expect(JSON.stringify(last.at(-1))).toContain("Do not call any more tools");
    expect(events.filter((e) => e.type === "step").length).toBe(MAX_ROUNDS - 1);
    expect(events.at(-1)).toEqual({ type: "text", text: "final forced answer" });
  });

  it("truncates history to HISTORY_LIMIT messages", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "model") as "user" | "model",
      text: `m${i}`,
    }));
    const model = fakeModel([[{ text: "ok" }]]);
    await drain(chatStream(long, model, echoTool));
    expect(model.seen[0].length).toBe(HISTORY_LIMIT);
    expect(JSON.stringify(model.seen[0][0])).toContain("m10");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run claims/agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/claims/agent.ts`:

```ts
import { stepLabel } from "./toolspec";

export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface SourceChunk {
  id: string;
  source: string;
  text: string;
}

export type AgentEvent =
  | { type: "step"; tool: string; label: string }
  | { type: "sources"; chunks: SourceChunk[] }
  | { type: "text"; text: string };

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GenPart {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: { output: string } };
}

export interface GenContent {
  role: "user" | "model";
  parts: GenPart[];
}

export interface RoundChunk {
  text?: string;
  functionCalls?: FunctionCall[];
}

export interface ModelClient {
  streamRound(contents: GenContent[]): AsyncGenerator<RoundChunk>;
}

export interface ToolOutcome {
  output: string;
  sources?: SourceChunk[];
}

export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export const MAX_ROUNDS = 6;
export const MAX_CALLS_PER_ROUND = 3;
export const HISTORY_LIMIT = 20;

// One agent conversation: streams model rounds, executes tool calls between
// rounds, and yields UI events. The model client and tool runner are injected
// so the loop is unit-testable without network or database.
export async function* chatStream(
  history: ChatMessage[],
  model: ModelClient,
  runTool: ToolRunner,
): AsyncGenerator<AgentEvent> {
  const contents: GenContent[] = history
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const isLastRound = round === MAX_ROUNDS;
    if (isLastRound) {
      contents.push({
        role: "user",
        parts: [{ text: "Answer now from the information already gathered. Do not call any more tools." }],
      });
    }

    let roundText = "";
    const calls: FunctionCall[] = [];
    for await (const chunk of model.streamRound(contents)) {
      if (chunk.text) {
        roundText += chunk.text;
        yield { type: "text", text: chunk.text };
      }
      if (chunk.functionCalls && !isLastRound) calls.push(...chunk.functionCalls);
    }
    if (calls.length === 0) return;

    const modelParts: GenPart[] = [];
    if (roundText) modelParts.push({ text: roundText });
    for (const c of calls) modelParts.push({ functionCall: c });
    contents.push({ role: "model", parts: modelParts });

    const responseParts: GenPart[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (i >= MAX_CALLS_PER_ROUND) {
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { output: "Error: too many tool calls in one round; use at most 3." },
          },
        });
        continue;
      }
      yield { type: "step", tool: call.name, label: stepLabel(call.name, call.args) };
      let outcome: ToolOutcome;
      try {
        outcome = await runTool(call.name, call.args);
      } catch (err) {
        outcome = { output: `Error: tool failed: ${err instanceof Error ? err.message : "unknown error"}` };
      }
      if (outcome.sources?.length) yield { type: "sources", chunks: outcome.sources };
      responseParts.push({ functionResponse: { name: call.name, response: { output: outcome.output } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run claims/agent.test.ts claims/toolspec.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add claims/agent.ts claims/agent.test.ts
git commit -m "feat(backend): agent loop with injected model client and tool runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Gemini model client + system prompt; wire /chat endpoint; remove old endpoints

**Files:**
- Modify: `backend/claims/gemini.ts` (replace `askStream` with `geminiModelClient`, new system prompt)
- Modify: `backend/claims/api.ts` (add `/chat`, delete `whyDenied`/`whichPolicy`/`patientHistory`/`appealSummary`/`similarDenied` and the local `getClaim`)
- Modify: `backend/claims/api.test.ts` (drop the `similarDenied` describe block)

**Interfaces:**
- Consumes: `chatStream`, `ChatMessage`, `ModelClient`, `GenContent`, `RoundChunk` from `./agent`; `runTool` from `./tools`; `toolDeclarations` from `./toolspec`.
- Produces: `geminiModelClient(): ModelClient` from `gemini.ts`; `POST /chat` SSE endpoint.

- [ ] **Step 1: Rewrite gemini.ts**

Replace the entire contents of `backend/claims/gemini.ts` with:

```ts
import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { secret } from "encore.dev/config";
import type { GenContent, ModelClient, RoundChunk } from "./agent";
import { toolDeclarations } from "./toolspec";

const geminiKey = secret("GeminiApiKey");

const MODEL = "gemini-2.5-flash";

export const SYSTEM_PROMPT = `You are a healthcare claims policy assistant for claims analysts.
You answer using ONLY what your tools return: claim records and excerpts of real
CMS policy documents. Ground every statement in tool results.

Rules:
- Use tools rather than guessing. Look up claims before discussing them; run
  search_policies before citing any policy.
- Cite the governing policy by its real identifier as it appears in the excerpt
  (e.g. NCD 220.2, or the manual chapter/section) and name the source document.
- The claims data is synthetic demo data; the policy excerpts are real CMS text.
- If the retrieved policy text does not answer the question, say so plainly.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note.`;

function client(): GoogleGenAI {
  const key = geminiKey();
  if (!key) {
    throw new Error("GeminiApiKey secret is not set. Set it with `encore secret set`.");
  }
  return new GoogleGenAI({ apiKey: key });
}

// Adapts one Gemini streaming call to the agent loop's ModelClient interface.
export function geminiModelClient(): ModelClient {
  const ai = client();
  return {
    async *streamRound(contents: GenContent[]): AsyncGenerator<RoundChunk> {
      const stream = await ai.models.generateContentStream({
        model: MODEL,
        contents: contents as Content[],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
          tools: [{ functionDeclarations: toolDeclarations as unknown as FunctionDeclaration[] }],
        },
      });
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield { text };
        const calls = chunk.functionCalls;
        if (calls?.length) {
          yield {
            functionCalls: calls.map((c) => ({
              name: c.name ?? "",
              args: (c.args ?? {}) as Record<string, unknown>,
            })),
          };
        }
      }
    },
  };
}
```

- [ ] **Step 2: Rewrite the endpoint layer**

In `backend/claims/api.ts`:

1. DELETE the endpoints `whyDenied`, `whichPolicy`, `patientHistory`, `appealSummary`, `similarDenied`, the exported `getClaim` function, and the `streamAnswer` helper.
2. Change imports: remove `askStream`, `retrieve`, `formatClaim`, `policyContext`; add the new ones.
3. Replace `sseSend` and `sseEndpoint`, and add the `/chat` endpoint.

The resulting file (complete):

```ts
import { api } from "encore.dev/api";
import { db } from "./db";
import { ensureSeeded } from "./seed";
import type { ClaimRow } from "./parse";
import { chatStream, type ChatMessage } from "./agent";
import { geminiModelClient } from "./gemini";
import { runTool } from "./tools";

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

// --- Chat: agent loop over SSE via api.raw (no generated client needed) ---
// The client POSTs {messages:[{role,text}...]} and receives typed events, one
// JSON object per `data:` line: step | sources | text | error | done.

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

function sseSend(resp: any, event: Record<string, unknown>): void {
  resp.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Runs an SSE handler so the response ALWAYS ends with a `done` event and
// `resp.end()` — even if the body is malformed or Gemini errors mid-stream.
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
      sseSend(resp, { type: "error", message: "Invalid request body." });
      return;
    }
    await handler(body);
  } catch {
    sseSend(resp, { type: "error", message: "Sorry, an error occurred while generating the answer." });
  } finally {
    sseSend(resp, { type: "done" });
    resp.end();
  }
}

function parseMessages(body: any): ChatMessage[] | null {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const m of body.messages) {
    if ((m?.role !== "user" && m?.role !== "model") || typeof m?.text !== "string" || m.text.trim() === "") {
      return null;
    }
    messages.push({ role: m.role, text: m.text });
  }
  return messages.at(-1)?.role === "user" ? messages : null;
}

export const chat = api.raw(
  { expose: true, method: "POST", path: "/chat" },
  (req, resp) =>
    sseEndpoint(req, resp, async (body) => {
      const messages = parseMessages(body);
      if (!messages) {
        sseSend(resp, { type: "error", message: "Body must be {messages:[{role,text}...]} ending with a user message." });
        return;
      }
      await ensureSeeded();
      for await (const event of chatStream(messages, geminiModelClient(), runTool)) {
        sseSend(resp, event);
      }
    }),
);
```

4. In `backend/claims/api.test.ts`, DELETE the `describe("similarDenied", ...)` block and remove `similarDenied` (and `getClaim` if imported) from the import statement. Keep the `listClaims` tests. If other tests import `getClaim` from `./api`, change them to import from `./tools`.

- [ ] **Step 3: Type-check and run all pure tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run claims/agent.test.ts claims/toolspec.test.ts claims/parse.test.ts claims/coverage.test.ts claims/format.test.ts`
Expected: clean type-check; all pure tests PASS.

- [ ] **Step 4: DB-backed tests if Docker available**

Run: `cd backend && encore test`
Expected: PASS. If Docker is unavailable, skip — Task 10 verifies against the deployed environment.

- [ ] **Step 5: Commit**

```bash
git add claims/gemini.ts claims/api.ts claims/api.test.ts
git commit -m "feat(backend): /chat SSE endpoint running the Gemini agent loop; remove canned endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend chat client (types + SSE parsing)

**Files:**
- Modify: `frontend/lib/types.ts` (add chat types)
- Modify: `frontend/lib/api.ts` (replace old streaming helpers with `chatStream`)

**Interfaces:**
- Consumes: `POST /chat` protocol from Task 7.
- Produces (used by Task 9):
  - `ChatMessage = { role: "user" | "model"; text: string }`
  - `SourceChunk = { id: string; source: string; text: string }`
  - `ChatEvent = { type: "step"; tool: string; label: string } | { type: "sources"; chunks: SourceChunk[] } | { type: "text"; text: string } | { type: "error"; message: string } | { type: "done" }`
  - `getClaims(): Promise<ClaimRow[]>` (unchanged)
  - `chatStream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<ChatEvent>`

- [ ] **Step 1: Add types**

Append to `frontend/lib/types.ts`:

```ts
export interface ChatMessage {
  role: "user" | "model";
  text: string;
}

export interface SourceChunk {
  id: string;
  source: string;
  text: string;
}

export type ChatEvent =
  | { type: "step"; tool: string; label: string }
  | { type: "sources"; chunks: SourceChunk[] }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };
```

- [ ] **Step 2: Replace the streaming client**

Replace the entire contents of `frontend/lib/api.ts` with:

```ts
import type { ChatEvent, ChatMessage, ClaimRow } from "./types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function getClaims(): Promise<ClaimRow[]> {
  const res = await fetch(`${API}/claims`);
  if (!res.ok) throw new Error(`GET /claims failed: ${res.status}`);
  const data = (await res.json()) as { claims: ClaimRow[] };
  return data.claims;
}

// Parse complete `data: {...}` frames out of an SSE buffer, returning typed
// chat events and the leftover partial frame.
function parseSseBuffer(buffer: string): { events: ChatEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const evt of parts) {
    const line = evt.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as ChatEvent;
      if (typeof parsed?.type === "string") events.push(parsed);
    } catch {
      // ignore keep-alive / non-JSON frames
    }
  }
  return { events, rest };
}

// POST the conversation and yield typed events as they arrive. `signal` lets
// the caller abort (e.g. re-send or unmount). The reader is always released.
export async function* chatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${API}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`POST /chat failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const e of events) yield e;
    }
    // Flush trailing multibyte bytes and a final frame with no closing "\n\n".
    buffer += decoder.decode();
    const { events } = parseSseBuffer(`${buffer}\n\n`);
    for (const e of events) yield e;
  } finally {
    reader.cancel().catch(() => {});
  }
}
```

- [ ] **Step 3: Type-check (page.tsx still references removed helpers — expected to fail here)**

Run: `cd frontend && npx tsc --noEmit`
Expected: errors ONLY in `app/page.tsx` about `whyDenied`/`getSimilarDenied` etc. no longer being exported. That's the Task 9 surface; if errors appear in `lib/`, fix them now.

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/types.ts frontend/lib/api.ts
git commit -m "feat(frontend): typed /chat SSE client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend chat UI

**Files:**
- Create: `frontend/app/chat.tsx` (chat rendering components)
- Modify: `frontend/app/page.tsx` (full rewrite: layout, sidebar, chat state)

**Interfaces:**
- Consumes: `getClaims`, `chatStream` from `@/lib/api`; `ChatEvent`, `ChatMessage`, `ClaimRow`, `SourceChunk` from `@/lib/types`.
- Produces: the deployed UI. `chat.tsx` exports `AssistantBody`, `PromptChips`, and the `Turn` type used by `page.tsx`.

- [ ] **Step 1: Create chat components**

`frontend/app/chat.tsx`:

```tsx
"use client";

import type { SourceChunk } from "@/lib/types";

export interface StepLine {
  tool: string;
  label: string;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; steps: StepLine[]; text: string; sources: SourceChunk[]; error?: string };

export function AssistantBody({ turn, busy }: { turn: Extract<Turn, { role: "assistant" }>; busy: boolean }) {
  return (
    <div className="space-y-2">
      {turn.steps.length > 0 && (
        <ol className="space-y-0.5 text-xs text-slate-500">
          {turn.steps.map((s, i) => (
            <li key={i}>⚙ {s.label}</li>
          ))}
        </ol>
      )}
      {turn.text && <div className="whitespace-pre-wrap text-sm">{turn.text}</div>}
      {!turn.text && busy && <div className="text-sm text-slate-400">Thinking…</div>}
      {turn.error && <div className="text-sm text-red-600">{turn.error}</div>}
      {turn.sources.length > 0 && (
        <details className="rounded border border-slate-200 bg-slate-50 text-xs">
          <summary className="cursor-pointer px-2 py-1 font-medium text-slate-600">
            Sources ({turn.sources.length})
          </summary>
          <ul className="space-y-2 p-2">
            {turn.sources.map((s) => (
              <li key={s.id}>
                <div className="font-mono text-slate-500">{s.source}</div>
                <div className="whitespace-pre-wrap text-slate-700">{s.text}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const CHIPS = [
  "Why was CLM-1003 denied?",
  "Which policy governs MRI without prior authorization?",
  "Summarize PAT-002's claim history.",
  "Which claims share CLM-1005's denial code?",
  "Draft an appeal for CLM-1007.",
];

export function PromptChips({ disabled, onPick }: { disabled: boolean; onPick: (q: string) => void }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {CHIPS.map((c) => (
        <button
          key={c}
          disabled={disabled}
          onClick={() => onPick(c)}
          className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-700 hover:bg-slate-300 disabled:opacity-50"
        >
          {c}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite page.tsx**

Replace the entire contents of `frontend/app/page.tsx` with:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { chatStream, getClaims } from "@/lib/api";
import type { ChatMessage, ClaimRow } from "@/lib/types";
import { AssistantBody, PromptChips, type Turn } from "./chat";

export default function Page() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getClaims().then(setClaims).catch(() => setClaims([]));
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  // Convert finished turns to the wire history: user text -> user, assistant
  // answer text -> model. Steps/sources are UI-only.
  function toMessages(all: Turn[]): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const t of all) {
      if (t.role === "user") msgs.push({ role: "user", text: t.text });
      else if (t.text) msgs.push({ role: "model", text: t.text });
    }
    return msgs;
  }

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput("");
    setBusy(true);

    const base: Turn[] = [...turns, { role: "user", text: q }];
    setTurns([...base, { role: "assistant", steps: [], text: "", sources: [] }]);

    const update = (fn: (a: Extract<Turn, { role: "assistant" }>) => Turn) =>
      setTurns((ts) => {
        const last = ts.at(-1);
        if (!last || last.role !== "assistant") return ts;
        return [...ts.slice(0, -1), fn(last)];
      });

    try {
      for await (const ev of chatStream(toMessages(base), controller.signal)) {
        if (controller.signal.aborted) break;
        if (ev.type === "step") update((a) => ({ ...a, steps: [...a.steps, { tool: ev.tool, label: ev.label }] }));
        else if (ev.type === "sources") update((a) => ({ ...a, sources: [...a.sources, ...ev.chunks] }));
        else if (ev.type === "text") update((a) => ({ ...a, text: a.text + ev.text }));
        else if (ev.type === "error") update((a) => ({ ...a, error: ev.message }));
      }
    } catch {
      if (!controller.signal.aborted) {
        update((a) => ({ ...a, error: "Stream error — is the backend running?" }));
      }
    } finally {
      if (abortRef.current === controller) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-6xl gap-6 p-6">
      <aside className="w-64 shrink-0 overflow-y-auto">
        <h2 className="mb-2 font-semibold">Claims</h2>
        <ul className="space-y-1 text-sm">
          {claims.map((c) => (
            <li key={c.claim_id} className="border-b border-slate-200 py-1">
              <button
                className="flex w-full justify-between hover:bg-slate-100"
                onClick={() =>
                  setInput(
                    c.status === "denied"
                      ? `Why was ${c.claim_id} denied?`
                      : `Show me the details of ${c.claim_id}.`,
                  )
                }
              >
                <span>{c.claim_id}</span>
                <span className={c.status === "denied" ? "text-red-600" : "text-emerald-600"}>
                  {c.status}
                </span>
              </button>
            </li>
          ))}
          {claims.length === 0 && <li className="py-1 text-slate-400">No claims loaded.</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <h1 className="text-2xl font-bold">🏥 Healthcare Claims Policy Assistant</h1>
        <p className="mb-3 text-sm text-slate-600">
          Ask anything about the claims — answers cite real CMS policy. Claims data is synthetic.
        </p>

        <div className="flex-1 space-y-4 overflow-y-auto rounded bg-slate-50 p-4">
          {turns.length === 0 && (
            <p className="text-sm text-slate-400">
              Start with a suggestion below, or click a claim on the left.
            </p>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">
                {t.text}
              </div>
            ) : (
              <div key={i} className="max-w-[90%] rounded-lg bg-white px-3 py-2 shadow-sm">
                <AssistantBody turn={t} busy={busy && i === turns.length - 1} />
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>

        <div className="mt-3">
          <PromptChips disabled={busy} onPick={send} />
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
              placeholder="Ask about a claim, a policy, or a patient…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean (the Task 8 page.tsx errors are gone).

- [ ] **Step 4: Commit**

```bash
git add frontend/app/page.tsx frontend/app/chat.tsx
git commit -m "feat(frontend): agentic chat UI with step trail, sources panel, prompt chips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, deploy, and end-to-end verification

**Files:**
- Modify: `README.md` (features, architecture diagram, data section)
- Modify: `DEPLOY.md` (verification section mentions `/chat` instead of `/why-denied`)

- [ ] **Step 1: Update README.md**

In `README.md`:
- Replace the five-bullet "What it does" list with a description of the chat: free-form questions, the agent loop, the five tools, visible steps, cited real CMS rules.
- In the architecture diagram, change `└──► Claude (claude-opus-4-8)` — already reads Gemini — to show the loop: `└──► Gemini agent loop (gemini-2.5-flash + 5 tools)`.
- Replace the "Data" section with: policies under `backend/claims/data/policies/` are **real CMS policy excerpts** (public domain; provenance in `backend/scripts/policy-sources.json`, each file's frontmatter carries its `source_url`); claims in `backend/claims/data/claims.csv` are **synthetic** (real claim-level data is PHI) and authored to exercise the real rules. Note the regeneration rule: after editing data, run `node scripts/gen-data.mjs`.

In `DEPLOY.md`, in the "Verify after the first deploy" paragraph, replace the reference to running "one streaming feature (e.g. \"Why denied?\")" with "ask one question in the chat (e.g. \"Why was CLM-1003 denied?\") and confirm step lines and the answer stream in".

- [ ] **Step 2: Full local gate**

```bash
cd backend && npx tsc --noEmit && npx vitest run claims/agent.test.ts claims/toolspec.test.ts claims/parse.test.ts claims/coverage.test.ts claims/format.test.ts
cd ../frontend && npx tsc --noEmit
```
Expected: all green. Optionally `cd backend && encore test` if Docker is running.

- [ ] **Step 3: Commit and deploy**

```bash
git add README.md DEPLOY.md
git commit -m "docs: agentic chat + real CMS corpus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main      # Vercel auto-deploys the frontend
git push encore main      # triggers the Encore staging deploy
```

- [ ] **Step 4: Verify the deployed backend**

Watch for the deploy to land (poll until `/claims` returns the NEW data — 60 claims):

```bash
curl -s https://staging-healthcare-claims-policy-assistant-wou2.encr.app/claims | grep -c CLM-
# expect: 60 (repeat until the new deploy is live)
```

NOTE: the DB may still hold the OLD seed (12 claims, COV chunks) because `doSeed` skips seeding when rows exist. If `/claims` returns 12 claims after the deploy is live, reset the seeded tables via the Encore Cloud dashboard's database shell (or `encore db shell claims --env=staging` locally):

```sql
TRUNCATE claims; TRUNCATE policy_chunks;
```

then hit `/claims` again to re-trigger seeding and expect 60.

Then verify the agent end-to-end (expect step, sources, text, done events; a real rule id cited):

```bash
curl -s -N -X POST https://staging-healthcare-claims-policy-assistant-wou2.encr.app/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","text":"Why was CLM-1003 denied, and can it be appealed?"}]}' | head -c 2500
```

Expected: `data: {"type":"step","tool":"get_claim",...}` then policy search steps, a `sources` event, streamed `text` events citing prior-authorization policy, and a final `{"type":"done"}`.

Multi-turn check:

```bash
curl -s -N -X POST https://staging-healthcare-claims-policy-assistant-wou2.encr.app/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","text":"Why was CLM-1003 denied?"},{"role":"model","text":"CLM-1003 was denied under D-NOAUTH because no prior authorization was on file."},{"role":"user","text":"What about the rest of that patient'\''s claims?"}]}' | head -c 2000
```

Expected: a `get_patient_claims` (or `get_claim` then `get_patient_claims`) step for PAT-002 and an answer covering the patient's other claims.

- [ ] **Step 5: Browser verification (user)**

Open https://healthcare-claims-policy-assistant.vercel.app — ask "Why was CLM-1003 denied?"; confirm the step lines appear, the answer streams, the sources panel opens, and a follow-up question uses the conversation context.

- [ ] **Step 6: Final commit of any fixes; update memory**

If verification surfaced fixes, commit them. Update the `healthcare-claims-project` memory file: chat endpoint replaces the five endpoints; real CMS corpus with provenance manifest; seed reset requires TRUNCATE when data changes shape.

---

## Self-Review Notes

- **Spec coverage:** endpoint+loop+tools (Tasks 4–7), typed SSE (7, 8), chat UI with steps/sources/chips/sidebar prefill (9), real corpus + ingest provenance (2), synthetic claims + invariant (3), chunker adaptation (1), README real/synthetic disclosure (10), removal of old endpoints (7), stateless 20-message history (6, 7), error handling (6, 7), fake-model tests (6). `done`/`error` are endpoint-level events (spec's protocol table) — implemented in Task 7's `sseEndpoint`, parsed in Task 8.
- **Ordering:** Task 5 (toolspec) and Task 6 (agent) have no DB dependency; Task 4 imports both. Execute as 1, 2, 3, 5, 6, 4, 7, 8, 9, 10 if strict compile-at-every-commit matters; task numbering groups by subsystem.
- **Seed reset:** existing deployments keep old seed rows; Task 10 Step 4 handles the TRUNCATE explicitly.

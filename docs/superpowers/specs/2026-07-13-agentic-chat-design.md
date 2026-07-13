# Agentic Analyst Chat — Design

**Date:** 2026-07-13
**Status:** Approved
**Goal:** Portfolio depth. Replace the five canned features with a free-form, multi-turn
analyst chat driven by a hand-rolled agent loop over Gemini function calling, with
visible tool steps and cited sources. Modest data expansion so demos never dead-end.

## Context

The deployed app (Next.js on Vercel + Encore.ts on Encore Cloud, Postgres FTS
retrieval, Gemini 2.5 Flash over SSE) offers five single-purpose buttons. It works,
but each feature is one fixed prompt over one fixed lookup. The policy corpus (3 docs)
has gaps: e.g. CLM-1005 (denied D-OON, out of network) has no governing policy text,
so appeal drafting correctly refuses. This design replaces the buttons with an agentic
chat and fills the corpus gaps.

## Decisions (from brainstorm)

- Chat **is** the app; old features become suggested prompt chips.
- Multi-turn memory **within a browser session only** — no server-side persistence, no auth.
- Tool steps are **visible** in the UI; retrieved policy excerpts appear in a
  collapsible sources panel.
- Data: **real CMS policy text + synthetic claims**. The retrieval corpus becomes
  excerpts of real, public-domain CMS coverage policy (NCDs/LCDs and Medicare manual
  chapters); claims stay synthetic (~60 / ~10 patients) but are authored to exercise
  those real rules. Claim-level data with denials is PHI and not publicly available,
  so synthetic claims are a necessity, and are labeled as such.
- Architecture: **custom agent loop** (no agent framework, no new heavy deps).

## 1. Backend

### Endpoint

`POST /chat` via `api.raw` (SSE), joining the existing `sseEndpoint` wrapper that
guarantees `resp.end()`. Request body:

```json
{ "messages": [ { "role": "user" | "model", "text": "..." } ] }
```

The client sends full history each request; the server is stateless. The server uses
at most the **last 20 messages**; older ones are dropped server-side.

The four old SSE endpoints (`/why-denied`, `/which-policy`, `/patient-history`,
`/appeal-summary`) are **removed**. `GET /claims` stays (sidebar). `GET /similar-denied`
is removed as an endpoint; its query moves into a tool.

### Agent loop (`claims/agent.ts`)

`chatStream(history)` — an async generator yielding typed events. Each round calls
Gemini (`gemini-2.5-flash`, function calling enabled, thinking disabled) in streaming
mode with the tool declarations:

- Text parts stream out immediately as `text` events.
- Function-call parts are collected; after the round's stream ends, each call is
  executed, a `step` event is emitted per call, and results are appended to the
  conversation for the next round.
- A round with no function calls is the final answer; the loop ends.

Guards: **max 6 rounds**, **max 3 tool calls per round** (extra calls are rejected
with an error result the model sees). On hitting the round cap, the model is sent a
final instruction to answer from what it has, without tools.

The model client is injected via a small interface (`streamRound(contents, tools)`)
so tests can drive the loop with a fake.

### Tools (`claims/tools.ts`)

| Tool | Args | Backed by |
|---|---|---|
| `get_claim` | `claimId` | existing `getClaim()` |
| `get_patient_claims` | `patientId` | existing patient query |
| `find_similar_denied` | `claimId` | existing similar-denied query |
| `search_policies` | `query` | existing `retrieve()`; also emits a `sources` event |
| `claims_overview` | — | new SQL aggregate: claim counts and billed totals by status and denial code |

Tool executor errors (bad args, unknown id, SQL failure) return an error **string to
the model** so it can recover; they do not abort the stream.

### SSE protocol

One JSON object per `data:` line:

```
{"type":"step","tool":"search_policies","label":"Searching policies: prior authorization"}
{"type":"sources","chunks":[{"id":"IOM 100-04 ch.1 §70","source":"timely-filing.md","text":"..."}]}
{"type":"text","text":"Claim CLM-"}
{"type":"error","message":"..."}   // Gemini/API failure; stream ends after this
{"type":"done"}                    // always the last event
```

### System prompt

Extends the current prompt: answer only from tool results, cite rule ids, use tools
rather than guessing, admit when the corpus lacks an answer, keep answers pasteable
into a case note.

## 2. Frontend

`app/page.tsx` becomes a two-pane chat layout:

- **Sidebar** (kept): claims list; clicking a claim pre-fills the input with a
  question referencing it (e.g. "Why was CLM-1003 denied?").
- **Chat pane**: message list with user/assistant bubbles. Each assistant message
  shows, in order: its step lines (subdued status rows, shown live while streaming
  and retained afterward), the streamed answer text, and a collapsible
  "Sources (n)" panel listing retrieved policy excerpts with rule ids.
- **Prompt chips** above the input reproduce the five old features as suggested
  questions.
- History lives in React state only; refresh clears it (by design).
- `lib/api.ts`: single `chatStream(messages, callbacks)` helper that POSTs to `/chat`
  and parses the typed SSE events (reusing the current reader/decoder handling,
  including abort-on-unmount).

## 3. Data: real CMS policy corpus + synthetic claims

### Policy corpus (real, public domain)

The three authored `COV-00x` docs are replaced by a curated set of **real CMS policy
excerpts** stored as markdown in `claims/data/policies/`, each with frontmatter
recording title, real rule identifier scheme, source URL, and retrieval date.
Target coverage, mapped to the denial codes used in claims:

| Denial code | Real policy source |
|---|---|
| D-NMN (medical necessity) | LCD/NCD text for MRI brain and CT abdomen (e.g. MRI LCD; NCD 220.1 CT scans) |
| D-EXP (experimental) | Medicare "reasonable and necessary" / non-covered NCD language |
| D-NOAUTH, D-AUTHEXP | CMS prior-authorization program rules (hospital OPD prior auth) |
| D-OON (out of network) | Medicare Managed Care Manual ch. 4 (out-of-network rules) |
| D-TFL (timely filing) | Medicare Claims Processing Manual ch. 1 §70 (12-month timely filing) |
| D-DUP (duplicate) | Claims Processing Manual duplicate-claim edit language |
| Appeals (all codes) | CMS appeals process guidance (redetermination levels, deadlines, documentation) |

- A one-time ingest script `scripts/fetch-policies.mjs` downloads the sources from
  cms.gov, converts to markdown excerpts, and writes them with frontmatter. Curated
  excerpts, not whole manuals: corpus target **8–12 docs, under ~100 KB total**, so
  the embedded `data.ts` stays reasonable. The fetched markdown is committed; the
  script exists so provenance is reproducible.
- **Rule ids become real identifiers** (e.g. `NCD 220.1`, `IOM 100-04 ch.1 §70`);
  the chunker keys chunks on the section headings of the real documents. `chunkPolicy`
  is adapted as needed for the real docs' structure (plan-level detail).
- CMS material is public domain; each doc's frontmatter cites its source URL and the
  sources panel shows the document title.

### Claims (synthetic by necessity)

- `claims.csv`: ~60 claims, ~10 patients, dates across 2025, wider procedure mix,
  plus new denial code **D-TFL**. Claims are authored so each denial is genuinely
  governed by a rule in the real corpus (e.g. an MRI denied for a diagnosis the real
  LCD does not list as an indication).
- Invariant: **every denial code appearing in claims.csv is governed by at least one
  policy chunk in the corpus**. A test enforces this.
- README/data docs state plainly: policies are real CMS text; claims are synthetic.
- `claims/data.ts` regenerated with `node scripts/gen-data.mjs` (deployed bundle
  cannot read loose files — see 2026-07-13 seed fix).

## 4. Error handling & testing

- Malformed request body / Gemini API failure → SSE `error` event, then `done`,
  response always ended (existing wrapper).
- Unit tests (vitest, fake model client — no network, no API key):
  - loop executes a tool call round-trip and feeds results back;
  - rounds cap forces a final answer;
  - per-round tool-call cap rejects extras;
  - event ordering: steps/sources precede text, `done` is last;
  - tool executors validate args and return model-readable errors.
- Data tests: CSV parses; denial-code→policy coverage invariant; every policy doc
  has source-URL frontmatter.
- Existing format tests unchanged; parse/retrieval tests are updated for the new
  chunker and the real corpus (they currently assert `COV-002` sources).
- Deploy verification: curl `/chat` with a multi-tool question; browser check of
  steps + sources rendering on the deployed site.

## Out of scope (YAGNI)

Auth, persisted conversations, embeddings/vector search, evals suite, analytics
dashboard, claim uploads. All are natural follow-ons but not part of this change.

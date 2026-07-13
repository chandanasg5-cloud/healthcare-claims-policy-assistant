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
- Data grows to **~60 claims / ~10 patients / 6 policy docs**.
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
{"type":"sources","chunks":[{"id":"COV-002.1","source":"COV-002-...md","text":"..."}]}
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

## 3. Data expansion

- `claims.csv`: ~60 claims, ~10 patients, dates across 2025, wider procedure mix,
  plus one new denial code **D-TFL** (claim filed past timely-filing deadline).
- New policy docs in `claims/data/policies/`:
  - **COV-004 Network coverage** — in/out-of-network rules, OON reimbursement
    exceptions (fixes the CLM-1005 gap).
  - **COV-005 Appeals process** — deadlines, required documentation, appeal levels.
  - **COV-006 Timely filing** — filing windows, D-TFL, exceptions.
- Invariant: **every denial code appearing in claims.csv is governed by at least one
  policy rule**. A test enforces this.
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
- Data tests: CSV parses; denial-code→policy coverage invariant.
- Existing parse/format/retrieval tests unchanged.
- Deploy verification: curl `/chat` with a multi-tool question; browser check of
  steps + sources rendering on the deployed site.

## Out of scope (YAGNI)

Auth, persisted conversations, embeddings/vector search, evals suite, analytics
dashboard, claim uploads. All are natural follow-ons but not part of this change.

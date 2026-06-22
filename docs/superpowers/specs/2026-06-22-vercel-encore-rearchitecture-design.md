# Vercel + Encore Re-architecture — Design

**Date:** 2026-06-22
**Status:** Approved (design phase)
**Repo:** `chandanasg5-cloud/healthcare-claims-policy-assistant`

## Goal

Re-architect the existing Python/Streamlit Healthcare Claims Policy Assistant into a
**Next.js frontend on Vercel** + an **Encore (TypeScript) backend on Encore Cloud**, with
**GitHub** driving CI/CD for both. The user's explicit objective is to have Vercel, Encore,
and GitHub connected to each other with something real to deploy.

This **replaces** the Streamlit app. Behavior stays faithful to today's app: the same five
analyst features, the same system prompt, the same model (`claude-opus-4-8`), and rule
citations preserved. Only the stack and the retrieval method change.

## Scope decisions (settled during brainstorming)

- **Target:** Re-architect to Vercel (frontend) + Encore (TypeScript backend), GitHub CI/CD.
- **Retrieval:** Postgres **full-text search** (`tsvector`/`tsquery`) — no embeddings, no extra
  API key. Anthropic has no embeddings API; this is the simplest Encore-native option and is
  adequate for the small, well-worded policy corpus.
- **Project type:** Demo/portfolio, **full feature parity** (all 5 features). No authentication,
  single-user, synthetic data.
- **Repo layout:** **Monorepo** — `frontend/` (Vercel) + `backend/` (Encore Cloud) in the
  existing GitHub repo.
- **Frontend:** Next.js App Router on Vercel.
- **Claude:** `@anthropic-ai/sdk` in the backend; streaming; `claude-opus-4-8`;
  `thinking: { type: "adaptive" }`. Key supplied via an Encore secret.

## Architecture overview

```
        GitHub monorepo (chandanasg5-cloud/healthcare-claims-policy-assistant)
        ├── frontend/   --push-->  Vercel        (Next.js App Router, root dir = frontend/)
        └── backend/    --push-->  Encore Cloud   (Encore TS app, root = backend/)

   Browser --> Next.js (Vercel) --HTTPS/JSON+SSE--> Encore API --> Postgres (Encore-provisioned)
                                                          |
                                                          +--> Claude (claude-opus-4-8) via @anthropic-ai/sdk
```

Three units, each understandable and testable on its own:

- **`frontend/`** — Next.js UI. No business logic; renders the 5 features and calls the backend.
- **`backend/`** — Encore TypeScript service. Owns the database, policy/claims data, retrieval,
  and all Claude calls.
- **Postgres** — provisioned and managed by Encore; holds `claims` and `policy_chunks`
  (with a full-text `tsvector` index).

## Backend (Encore) components

A single Encore service, `claims`, exposed as typed API endpoints. Internally split by
responsibility:

- **`db/` (SQL migrations + seed)**
  - `claims` table — columns mirror `claims.csv`: `claim_id`, `patient_id`, `date_of_service`,
    `procedure_code`, `procedure_desc`, `diagnosis_code`, `billed_amount`, `status`,
    `denial_code`, `denial_reason`.
  - `policy_chunks` table — `id` (text), `source` (text), `text` (text),
    `tsv tsvector` with a GIN index; `tsv` populated from `text`.
  - Seed migration loads `claims.csv` rows and the chunked policy `.md` files. Chunking logic
    is ported from the current `_chunk_policy` (split on blank lines, drop blocks < 20 chars,
    id = `<source>-<index>`).
- **`retrieval.ts`** — `retrieve(query, k=4)` runs a Postgres full-text search over
  `policy_chunks` using `plainto_tsquery` + `ts_rank`, returning the top-k chunks with their
  `source`. Replaces ChromaDB + the Python `retrieve()`.
- **`claude.ts`** — wraps `@anthropic-ai/sdk`. Holds the system prompt (ported verbatim from
  `rag.py` `SYSTEM_PROMPT`) and a streaming helper built on `client.messages.stream(...)` with
  `model: "claude-opus-4-8"`, `max_tokens: 2048`, `thinking: { type: "adaptive" }`.
  `ANTHROPIC_API_KEY` is read from an Encore secret; a missing key fails fast with a clear error.
- **`api.ts`** — the endpoints below. Each assembles the Claude context exactly as the Python
  builders do today (`why_denied`, `which_policy`, `patient_history`, `appeal_summary`),
  including the `_format_claim` and `_policy_context` formatting.

## API endpoints (the 5 features)

| Endpoint | Replaces | Returns |
|---|---|---|
| `GET /claims` | sidebar list / selectboxes | claims list for the UI (JSON) |
| `POST /why-denied` `{claimId}` | "Why denied?" | streamed (SSE) Claude answer |
| `POST /which-policy` `{question}` | "Which policy applies?" | streamed answer |
| `POST /patient-history` `{patientId}` | "Patient history" | streamed answer |
| `GET /similar-denied?claimId=` | "Similar denials" | JSON list (pure SQL, **no Claude** — matches today's pandas-only behavior) |
| `POST /appeal-summary` `{claimId}` | "Appeal summary" | streamed answer |

- The four answer endpoints use Encore's **streaming API** (server-sent text) so the frontend
  keeps the token-by-token feel of the current `st.write_stream`.
- `similar-denied` is a plain SQL query: claims sharing the reference claim's `denial_code`,
  excluding the reference claim, only when a denial code exists. No LLM call (faithful to today).

### Context-assembly parity (per endpoint)

- `why-denied`: look up claim by id (404 if absent); build query
  `"<denial_reason> <procedure_desc> denial <denial_code>"`; retrieve; prompt asks why the claim
  was denied and to cite the supporting rule.
- `which-policy`: retrieve on the free-text question; prompt asks which rule applies and what it
  requires.
- `patient-history`: gather all claims for the patient (404 if none); list them; prompt asks for
  totals, approved vs denied, recurring denial patterns. (No retrieval — matches today.)
- `appeal-summary`: look up claim (404 if absent); query `"appeal <denial_reason> <denial_code>"`;
  retrieve; prompt asks for a concise appeal summary (< 200 words) citing the rule.

## Frontend (Next.js on Vercel)

- App Router, one page with the 5 features as tabs (mirrors the current Streamlit tabs), plus a
  claims sidebar/table populated from `GET /claims`.
- A small typed API client. The backend base URL comes from `NEXT_PUBLIC_API_URL`, set in Vercel
  to the Encore Cloud URL.
- Streaming responses rendered incrementally as tokens arrive.
- Styling: clean, minimal (Tailwind) — appropriate for a claims/healthcare tool.

## CI/CD wiring (the user's actual goal)

1. **GitHub** — existing repo, restructured into `frontend/` + `backend/`.
2. **Vercel** — connect the GitHub repo (OAuth in the Vercel dashboard), set
   **Root Directory = `frontend/`**. Every push to `main` auto-deploys the frontend. Add
   `NEXT_PUBLIC_API_URL` as a Vercel env var (the Encore Cloud URL).
3. **Encore Cloud** — connect the same GitHub repo (OAuth in the Encore dashboard). Encore builds
   the app in `backend/` and provisions Postgres automatically. Set the `ANTHROPIC_API_KEY`
   secret in Encore.

All code and config are produced as part of implementation. The three OAuth "connect" actions
happen in the respective dashboards (cannot be automated here); a precise step list will be
provided.

## Error handling

- Not-found claims/patients return typed 404s (porting today's "No claim found" / "No claims
  found" guards).
- Missing `ANTHROPIC_API_KEY` fails fast with a clear message.
- Claude API errors are caught and surfaced to the frontend rather than crashing the stream.

## Testing

- Encore service tests:
  - `retrieve()` returns the expected chunk for a known query.
  - `similar-denied` SQL returns the right peers and excludes the reference claim.
  - not-found paths return 404.
  - seed migration loads claims + policy chunks (smoke test on counts).
- Frontend kept thin enough to verify by running it against the backend (manual/visual check).

## Migration / cleanup

- This replaces the Python/Streamlit app entirely.
- Keep `app.py`, `rag.py`, and the old layout in git history, but remove them from the working
  tree. The policy `.md` files and `claims.csv` are **reused** as backend seed data (moved under
  `backend/`).

## Out of scope

- Authentication, multi-user data isolation, real (non-synthetic) data.
- Semantic/vector retrieval and embeddings (full-text search chosen instead).
- A hosted vector database.

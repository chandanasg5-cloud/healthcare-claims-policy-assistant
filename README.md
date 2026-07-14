# Healthcare Claims Policy Assistant

An agentic chat assistant for claims analysts: free-form, multi-turn questions
about denied healthcare claims, answered by an agent loop that looks up claims,
searches **real CMS policy documents**, and cites the governing rule (e.g.
`NCD 220.2`, `IOM 100-04 ch.1 §70`) — with its tool steps and sources visible
in the UI.

Re-architected from a Streamlit prototype into a **Next.js frontend (Vercel)** +
**Encore TypeScript backend (Encore Cloud)** monorepo, driven by GitHub CI/CD.

## What it does

One chat box. The agent decides which tools to run — visibly, step by step:

- `get_claim` / `get_patient_claims` / `find_similar_denied` — Postgres lookups
- `search_policies` — full-text search over real CMS policy excerpts
- `claims_overview` — aggregate denial counts and dollars

Ask "Why was CLM-1003 denied, and can it be appealed?" and the agent looks up
the claim, searches the prior-authorization and appeals policies, streams a
grounded answer citing the real rule, and shows the policy excerpts it used.
Follow-ups work ("what about her other claims?") — the conversation is
multi-turn within a browser session.

## Architecture

```
Browser ──► Next.js (Vercel) ──fetch JSON + SSE──► Encore API ──► Postgres
                                                        │           (claims +
                                                        │            policy_chunks,
                                                        │            full-text tsvector)
                                                        └──► Gemini agent loop
                                                             (gemini-2.5-flash + 5 tools)
```

- **Retrieval** is Postgres **full-text search** (`tsvector` / `plainto_tsquery` /
  `ts_rank`) over chunked policy documents — no external embeddings service.
- **Streaming** answers use **Server-Sent Events** (`api.raw`), so the frontend talks
  to the backend with plain `fetch` — no generated client, no codegen step.
- The model answers **only** from retrieved policy excerpts and cites the rule id,
  so answers are traceable rather than guessed.

## Layout

- `frontend/` — Next.js App Router app → Vercel (set **Root Directory = `frontend/`**).
- `backend/`  — Encore TypeScript service + Postgres → Encore Cloud.
- `docs/superpowers/` — design spec and implementation plan.

## Tech stack

TypeScript · Encore.ts · Postgres (full-text search) · Next.js · Tailwind ·
Google Gemini (`gemini-2.5-flash`) · Server-Sent Events

## Local development

The backend needs a Postgres database. Encore provisions it locally **via Docker**
(`encore run`), or on Encore Cloud when deployed (see `DEPLOY.md`).

```bash
# Backend (requires Docker for the local DB)
cd backend
encore secret set --type local GeminiApiKey      # paste your Google AI Studio key
encore run

# Frontend (no Docker needed)
cd frontend
cp .env.local.example .env.local                 # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev                                       # http://localhost:3000
```

Without Docker, run the backend on Encore Cloud and point the frontend's
`NEXT_PUBLIC_API_URL` at the deployed URL.

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) — connect GitHub to Encore Cloud (`backend/`) and
Vercel (`frontend/`); both auto-deploy on push to `main`.

## Data

- `backend/claims/data/policies/` holds **real CMS policy excerpts** (public
  domain): NCD 220.1/220.2, Medicare manual chapters on prior authorization,
  out-of-network rules, timely filing, claim edits, and appeals. Provenance
  (source URLs, retrieval dates, curation notes) lives in
  `backend/scripts/policy-sources.json` and each file's frontmatter.
- `backend/claims/data/claims.csv` holds **synthetic claims** (real claim-level
  data is PHI and not publicly available), authored so every denial is governed
  by a real rule in the corpus — a tested invariant (`coverage.test.ts`).
- `backend/claims/data.ts` is **generated** — after editing the data files, run
  `node scripts/gen-data.mjs` from `backend/` (the deployed bundle cannot read
  loose files).

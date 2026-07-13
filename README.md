# Healthcare Claims Policy Assistant

A retrieval-augmented assistant that lets a claims analyst ask plain-language
questions about denied healthcare claims and get answers grounded in the actual
policy documents, with the governing rule cited (e.g. `COV-002.2`).

Re-architected from a Streamlit prototype into a **Next.js frontend (Vercel)** +
**Encore TypeScript backend (Encore Cloud)** monorepo, driven by GitHub CI/CD.

## What it does

An analyst can ask:

- **Why was this claim denied?** — explains the denial and cites the policy rule.
- **Which policy rule applies?** — retrieves the relevant rule for any situation.
- **Summarize this patient's claim history.** — totals, approvals vs denials, patterns.
- **Find similar denied claims.** — groups claims by denial code (no LLM).
- **Generate an appeal summary.** — drafts a policy-grounded appeal for a denial.

## Architecture

```
Browser ──► Next.js (Vercel) ──fetch JSON + SSE──► Encore API ──► Postgres
                                                        │           (claims +
                                                        │            policy_chunks,
                                                        │            full-text tsvector)
                                                        └──► Gemini (gemini-2.5-flash)
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

`backend/claims/data/policies/` holds sample coverage policies (preventive care,
prior authorization, medical necessity); `backend/claims/data/claims.csv` holds
synthetic claims. All data here is synthetic and for demonstration only.

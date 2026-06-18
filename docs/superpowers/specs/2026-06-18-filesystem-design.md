# Healthcare Claims Policy Assistant — File System Design

**Date:** 2026-06-18  
**Status:** Approved  
**Goal:** Restructure the existing Streamlit RAG app into a production-ready, deployable layout on Encore.dev using the two-service split pattern.

---

## Architecture

Two Encore Python services under one `encore.app`:

- **`backend/`** — API service. Exposes REST endpoints for claims lookup, policy ingestion, and RAG queries. Owns ChromaDB and all Anthropic API calls.
- **`frontend/`** — Streamlit service. Calls the backend API over HTTP. No direct access to ChromaDB or Anthropic.

Encore manages secrets (`ANTHROPIC_API_KEY`), routing between services, and deployment to Encore Cloud.

---

## File Structure

```
healthcare-claims-policy-assistant/
├── encore.app                        # Encore app manifest (name, id)
│
├── backend/                          # Encore Python service
│   ├── encore.service.ts             # Service declaration (name: "backend")
│   ├── claims/
│   │   ├── __init__.py
│   │   └── endpoints.py              # GET /claims, GET /claims/{id}
│   ├── rag/
│   │   ├── __init__.py
│   │   ├── endpoints.py              # POST /query
│   │   └── retriever.py              # ChromaDB + embedding logic
│   ├── ingest/
│   │   ├── __init__.py
│   │   └── endpoints.py              # POST /ingest (PDF → ChromaDB)
│   ├── requirements.txt
│   └── chroma_db/                    # Local ChromaDB persistence (gitignored)
│
├── frontend/                         # Streamlit app (calls backend API)
│   ├── encore.service.ts             # Service declaration (name: "frontend")
│   ├── app.py                        # Streamlit entrypoint
│   ├── pages/
│   │   ├── query.py                  # Query a claim against policy
│   │   └── ingest.py                 # Upload/ingest policy docs
│   └── requirements.txt
│
├── data/
│   ├── policies/                     # PDF/Markdown policy documents
│   └── claims.csv                    # Synthetic claims dataset
│
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-06-18-filesystem-design.md
│
├── .env.example                      # ANTHROPIC_API_KEY placeholder (local dev only)
├── .gitignore
└── README.md
```

---

## Data Flow

### Query flow (runtime)
1. User submits a question in `frontend/pages/query.py`
2. Streamlit POSTs `{"claim_id": "123", "question": "..."}` to `backend` → `POST /query`
3. `backend/rag/endpoints.py` fetches the claim record from `data/claims.csv` via `backend/claims/`
4. `backend/rag/retriever.py` embeds the question and retrieves relevant policy chunks from ChromaDB
5. Anthropic API generates an answer grounded in the retrieved chunks
6. Response `{"answer": "...", "citations": [...]}` returned to Streamlit for display

### Ingest flow (on-demand)
1. User uploads a PDF via `frontend/pages/ingest.py`
2. Streamlit POSTs to `backend` → `POST /ingest`
3. `backend/ingest/endpoints.py` reads the file, chunks it, embeds it, writes to `chroma_db/`
4. Ingest is idempotent — re-ingesting the same document overwrites by document ID

---

## Error Handling

| Error condition | Backend response | Frontend display |
|---|---|---|
| Claim ID not found | `{"error": "claim_not_found"}` → HTTP 404 | "Claim not found. Check the ID and try again." |
| No matching policy chunks | `{"error": "no_policy_chunks_found"}` → HTTP 422 | "No relevant policy rules found for this query." |
| Anthropic API unavailable | `{"error": "llm_unavailable"}` → HTTP 503 | "The assistant is temporarily unavailable. Try again shortly." |

---

## Secrets

- `ANTHROPIC_API_KEY` declared as an Encore secret in `backend/`
- Set locally: `encore secret set --type dev ANTHROPIC_API_KEY`
- Set in prod: Encore Cloud dashboard
- `.env.example` documents local dev setup only; no `.env` in production

---

## Testing Layout

```
backend/
└── tests/
    ├── test_claims.py      # unit: CSV lookup, missing ID handling
    ├── test_retriever.py   # unit: chunking, embedding, ChromaDB roundtrip
    └── test_rag.py         # integration: full query → answer pipeline (mocked Anthropic)
```

---

## Out of Scope

- Authentication / user login
- Persistent claims database (CSV is sufficient for this stage)
- Multi-tenant policy document sets

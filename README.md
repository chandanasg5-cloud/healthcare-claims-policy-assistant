# Healthcare Claims Policy Assistant

A retrieval-augmented (RAG) assistant that lets a claims analyst ask plain-language
questions about denied healthcare claims and get answers grounded in the actual
policy documents, with the governing rule cited.

It connects three things claims and healthcare-analyst roles care about: claims
data, policy interpretation, and turning complex rules into a usable answer.

## What it does

An analyst can ask:

- **Why was this claim denied?** — explains the denial and cites the policy rule.
- **Which policy rule applies?** — retrieves the relevant rule for any situation.
- **Summarize this patient's claim history.** — totals, approvals vs denials, patterns.
- **Find similar denied claims.** — groups claims by denial reason.
- **Generate an appeal summary.** — drafts a policy-grounded appeal for a denial.

## How it works

```
policy docs (PDF / Markdown)
        │  chunk + embed
        ▼
   ChromaDB vector store ──► retrieve top-k relevant rules
        │                              │
   claims.csv (pandas) ────────────────┤  assemble grounded context
                                       ▼
                              Claude (claude-opus-4-8)
                                       │  cite the rule, answer
                                       ▼
                                Streamlit UI
```

The model is instructed to answer **only** from the retrieved policy excerpts and
to cite the specific rule id (e.g. `COV-002.2`), so answers are traceable rather
than guessed — which is the entire point in claims work.

## Tech stack

Python · Streamlit · ChromaDB (vector database) · Anthropic Claude · pandas · pypdf

## Run it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then paste your Anthropic API key into .env
export ANTHROPIC_API_KEY=sk-ant-...   # or rely on the .env file
streamlit run app.py
```

## Data

`data/policies/` holds sample coverage policies (preventive care, prior
authorization, medical necessity). `data/claims.csv` holds synthetic claims.
Drop your own policy PDFs into `data/policies/` and they are indexed automatically.

All data here is synthetic and for demonstration only.

"""Core retrieval-augmented generation logic for the Claims Policy Assistant.

Pipeline: policy documents -> chunked -> embedded in ChromaDB (vector store).
A question retrieves the most relevant policy chunks, which are passed to Gemini
as grounding context. Gemini answers and cites the specific policy rule it used.
"""

from __future__ import annotations

import os
import glob
from dataclasses import dataclass
from pathlib import Path

import chromadb
import pandas as pd
from google import genai
from google.genai import types
from pypdf import PdfReader

DATA_DIR = Path(__file__).parent / "data"
POLICY_DIR = DATA_DIR / "policies"
CLAIMS_CSV = DATA_DIR / "claims.csv"
CHROMA_DIR = Path(__file__).parent / ".chroma"

MODEL = "gemini-2.5-flash"


# --------------------------------------------------------------------------- #
# Data loading
# --------------------------------------------------------------------------- #
def load_claims() -> pd.DataFrame:
    df = pd.read_csv(CLAIMS_CSV, dtype=str).fillna("")
    return df


def _read_policy_text(path: str) -> str:
    if path.lower().endswith(".pdf"):
        reader = PdfReader(path)
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    return Path(path).read_text(encoding="utf-8")


def _chunk_policy(text: str, source: str) -> list[dict]:
    """Split a policy into paragraph-level chunks, keeping the source filename."""
    chunks = []
    for i, block in enumerate(p.strip() for p in text.split("\n\n")):
        if len(block) < 20:
            continue
        chunks.append({"id": f"{source}-{i}", "text": block, "source": source})
    return chunks


# --------------------------------------------------------------------------- #
# Vector store
# --------------------------------------------------------------------------- #
def build_index(reset: bool = False) -> chromadb.Collection:
    """Embed all policy chunks into a persistent ChromaDB collection."""
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    if reset:
        try:
            client.delete_collection("policies")
        except Exception:
            pass
    collection = client.get_or_create_collection("policies")

    if collection.count() > 0 and not reset:
        return collection

    paths = glob.glob(str(POLICY_DIR / "*.md")) + glob.glob(str(POLICY_DIR / "*.pdf"))
    docs, ids, metas = [], [], []
    for path in paths:
        source = Path(path).name
        for chunk in _chunk_policy(_read_policy_text(path), source):
            docs.append(chunk["text"])
            ids.append(chunk["id"])
            metas.append({"source": source})
    if docs:
        collection.add(documents=docs, ids=ids, metadatas=metas)
    return collection


@dataclass
class Retrieved:
    text: str
    source: str
    score: float


def retrieve(collection: chromadb.Collection, query: str, k: int = 4) -> list[Retrieved]:
    res = collection.query(query_texts=[query], n_results=k)
    out = []
    for text, meta, dist in zip(
        res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        out.append(Retrieved(text=text, source=meta["source"], score=1 - dist))
    return out


# --------------------------------------------------------------------------- #
# Gemini
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = """You are a healthcare claims policy assistant for claims analysts.
You answer strictly from the policy excerpts and claim data provided in the user
message. Ground every statement in that context.

Rules:
- Cite the specific policy rule id (for example COV-002.2) whenever you rely on it.
- If the provided context does not contain the answer, say so plainly rather than
  guessing.
- Be concise and precise. Lead with the direct answer, then the supporting rule.
- Use plain language an analyst can paste into a case note."""


def _client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Add it to your environment or a .env file."
        )
    return genai.Client(api_key=api_key)


def ask_stream(user_content: str):
    """Yield Gemini's answer text incrementally (for Streamlit st.write_stream)."""
    client = _client()
    stream = client.models.generate_content_stream(
        model=MODEL,
        contents=user_content,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=2048,
        ),
    )
    for chunk in stream:
        if chunk.text:
            yield chunk.text


def ask(user_content: str) -> str:
    return "".join(ask_stream(user_content))


# --------------------------------------------------------------------------- #
# Context builders for the five analyst questions
# --------------------------------------------------------------------------- #
def _format_claim(row: pd.Series) -> str:
    return (
        f"Claim {row['claim_id']} | patient {row['patient_id']} | "
        f"date {row['date_of_service']} | procedure {row['procedure_code']} "
        f"({row['procedure_desc']}) | diagnosis {row['diagnosis_code']} | "
        f"billed ${row['billed_amount']} | status {row['status']}"
        + (
            f" | denial {row['denial_code']}: {row['denial_reason']}"
            if row["status"] == "denied"
            else ""
        )
    )


def _policy_context(retrieved: list[Retrieved]) -> str:
    return "\n\n".join(f"[{r.source}]\n{r.text}" for r in retrieved)


def why_denied(collection, claims: pd.DataFrame, claim_id: str) -> str:
    row = claims[claims["claim_id"] == claim_id]
    if row.empty:
        return f"No claim found with id {claim_id}."
    row = row.iloc[0]
    query = f"{row['denial_reason']} {row['procedure_desc']} denial {row['denial_code']}"
    ctx = _policy_context(retrieve(collection, query))
    return ask(
        f"CLAIM:\n{_format_claim(row)}\n\n"
        f"RELEVANT POLICY EXCERPTS:\n{ctx}\n\n"
        f"Question: Why was claim {claim_id} denied? Explain the reason and cite the "
        f"policy rule that supports the denial."
    )


def which_policy(collection, question: str) -> str:
    ctx = _policy_context(retrieve(collection, question))
    return ask(
        f"RELEVANT POLICY EXCERPTS:\n{ctx}\n\n"
        f"Question: Which policy rule applies to the following situation, and what "
        f"does it require? {question}"
    )


def patient_history(collection, claims: pd.DataFrame, patient_id: str) -> str:
    rows = claims[claims["patient_id"] == patient_id]
    if rows.empty:
        return f"No claims found for patient {patient_id}."
    listing = "\n".join(_format_claim(r) for _, r in rows.iterrows())
    return ask(
        f"CLAIM HISTORY FOR {patient_id}:\n{listing}\n\n"
        f"Question: Summarize this patient's claim history. Note totals, what was "
        f"approved versus denied, and any recurring denial patterns."
    )


def similar_denied(claims: pd.DataFrame, claim_id: str) -> pd.DataFrame:
    row = claims[claims["claim_id"] == claim_id]
    if row.empty:
        return pd.DataFrame()
    code = row.iloc[0]["denial_code"]
    if not code:
        return pd.DataFrame()
    sim = claims[
        (claims["denial_code"] == code) & (claims["claim_id"] != claim_id)
    ]
    return sim


def appeal_summary(collection, claims: pd.DataFrame, claim_id: str) -> str:
    row = claims[claims["claim_id"] == claim_id]
    if row.empty:
        return f"No claim found with id {claim_id}."
    row = row.iloc[0]
    query = f"appeal {row['denial_reason']} {row['denial_code']}"
    ctx = _policy_context(retrieve(collection, query))
    return ask(
        f"CLAIM:\n{_format_claim(row)}\n\n"
        f"RELEVANT POLICY EXCERPTS:\n{ctx}\n\n"
        f"Task: Draft a concise appeal summary for this denied claim. State the claim "
        f"details, the denial reason, the policy basis for an appeal (cite the rule), "
        f"and what documentation the provider should submit. Keep it under 200 words."
    )

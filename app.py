"""Streamlit UI for the Healthcare Claims Policy Assistant."""

import streamlit as st

import rag

st.set_page_config(page_title="Claims Policy Assistant", page_icon="🏥", layout="wide")


@st.cache_resource(show_spinner="Indexing policies...")
def _setup():
    collection = rag.build_index()
    claims = rag.load_claims()
    return collection, claims


collection, claims = _setup()

st.title("🏥 Healthcare Claims Policy Assistant")
st.caption(
    "A retrieval-augmented assistant that answers claims questions from policy "
    "documents and cites the rule it used. Built with ChromaDB + Claude."
)

with st.sidebar:
    st.header("Claims")
    st.dataframe(
        claims[["claim_id", "patient_id", "procedure_desc", "status", "denial_code"]],
        hide_index=True,
        use_container_width=True,
    )

tabs = st.tabs(
    [
        "Why denied?",
        "Which policy applies?",
        "Patient history",
        "Similar denials",
        "Appeal summary",
    ]
)

claim_ids = claims["claim_id"].tolist()
denied_ids = claims[claims["status"] == "denied"]["claim_id"].tolist()
patient_ids = sorted(claims["patient_id"].unique().tolist())

with tabs[0]:
    st.subheader("Why was this claim denied?")
    claim_id = st.selectbox("Denied claim", denied_ids, key="why")
    if st.button("Explain denial", key="why_btn"):
        row = claims[claims["claim_id"] == claim_id].iloc[0]
        query = f"{row['denial_reason']} {row['procedure_desc']} {row['denial_code']}"
        ctx = rag._policy_context(rag.retrieve(collection, query))
        st.write_stream(
            rag.ask_stream(
                f"CLAIM:\n{rag._format_claim(row)}\n\nRELEVANT POLICY EXCERPTS:\n{ctx}"
                f"\n\nQuestion: Why was claim {claim_id} denied? Explain the reason and "
                f"cite the policy rule that supports the denial."
            )
        )

with tabs[1]:
    st.subheader("Which policy rule applies?")
    q = st.text_input(
        "Describe the situation",
        "An MRI was performed without prior authorization on file.",
        key="which",
    )
    if st.button("Find the rule", key="which_btn"):
        ctx = rag._policy_context(rag.retrieve(collection, q))
        st.write_stream(
            rag.ask_stream(
                f"RELEVANT POLICY EXCERPTS:\n{ctx}\n\nQuestion: Which policy rule "
                f"applies, and what does it require? {q}"
            )
        )

with tabs[2]:
    st.subheader("Summarize a patient's claim history")
    pid = st.selectbox("Patient", patient_ids, key="hist")
    st.dataframe(
        claims[claims["patient_id"] == pid], hide_index=True, use_container_width=True
    )
    if st.button("Summarize", key="hist_btn"):
        rows = claims[claims["patient_id"] == pid]
        listing = "\n".join(rag._format_claim(r) for _, r in rows.iterrows())
        st.write_stream(
            rag.ask_stream(
                f"CLAIM HISTORY FOR {pid}:\n{listing}\n\nQuestion: Summarize this "
                f"patient's claim history. Note totals, approved versus denied, and any "
                f"recurring denial patterns."
            )
        )

with tabs[3]:
    st.subheader("Find similar denied claims")
    claim_id = st.selectbox("Reference claim", denied_ids, key="sim")
    if st.button("Find similar", key="sim_btn"):
        sim = rag.similar_denied(claims, claim_id)
        if sim.empty:
            st.info("No other claims share this denial code.")
        else:
            st.write(f"Other claims denied under the same code:")
            st.dataframe(sim, hide_index=True, use_container_width=True)

with tabs[4]:
    st.subheader("Generate an appeal summary")
    claim_id = st.selectbox("Denied claim", denied_ids, key="appeal")
    if st.button("Draft appeal", key="appeal_btn"):
        row = claims[claims["claim_id"] == claim_id].iloc[0]
        query = f"appeal {row['denial_reason']} {row['denial_code']}"
        ctx = rag._policy_context(rag.retrieve(collection, query))
        st.write_stream(
            rag.ask_stream(
                f"CLAIM:\n{rag._format_claim(row)}\n\nRELEVANT POLICY EXCERPTS:\n{ctx}"
                f"\n\nTask: Draft a concise appeal summary for this denied claim. State "
                f"the claim details, the denial reason, the policy basis for an appeal "
                f"(cite the rule), and what documentation to submit. Under 200 words."
            )
        )

CREATE TABLE claims (
    claim_id        TEXT PRIMARY KEY,
    patient_id      TEXT NOT NULL,
    date_of_service TEXT NOT NULL,
    procedure_code  TEXT NOT NULL,
    procedure_desc  TEXT NOT NULL,
    diagnosis_code  TEXT NOT NULL,
    billed_amount   TEXT NOT NULL,
    status          TEXT NOT NULL,
    denial_code     TEXT NOT NULL DEFAULT '',
    denial_reason   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE policy_chunks (
    id     TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    text   TEXT NOT NULL,
    tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX policy_chunks_tsv_idx ON policy_chunks USING GIN (tsv);

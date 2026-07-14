// Maps each denial code used in claims.csv to the corpus document that
// governs it and a phrase that must appear in that document. Enforced by
// coverage.test.ts so demo questions never dead-end.
export const DENIAL_POLICY_MAP: Record<string, { doc: string; mustContain: string }> = {
  "D-NOAUTH": { doc: "prior-authorization-opd.md", mustContain: "prior authorization" },
  "D-AUTHEXP": { doc: "prior-authorization-opd.md", mustContain: "provisional affirmation" },
  "D-OON": { doc: "out-of-network.md", mustContain: "network" },
  "D-NMN": { doc: "reasonable-and-necessary.md", mustContain: "reasonable and necessary" },
  "D-EXP": { doc: "reasonable-and-necessary.md", mustContain: "investigational" },
  "D-TFL": { doc: "timely-filing.md", mustContain: "calendar year" },
  "D-DUP": { doc: "claim-edits.md", mustContain: "duplicate" },
  "D-CODE": { doc: "claim-edits.md", mustContain: "diagnosis" },
};

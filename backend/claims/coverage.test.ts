import { describe, it, expect } from "vitest";
import { DENIAL_POLICY_MAP } from "./coverage";
import { parseClaimsCsv } from "./parse";
import { CLAIMS_CSV, POLICIES } from "./data";

describe("denial-code policy coverage", () => {
  const claims = parseClaimsCsv(CLAIMS_CSV);
  const denialCodes = [...new Set(claims.filter((c) => c.denial_code).map((c) => c.denial_code))];

  it("has 60 claims across 10 patients", () => {
    expect(claims.length).toBe(60);
    expect(new Set(claims.map((c) => c.patient_id)).size).toBe(10);
  });

  it("maps every denial code used in claims.csv to a policy doc", () => {
    for (const code of denialCodes) expect(DENIAL_POLICY_MAP[code], code).toBeDefined();
  });

  it("every mapped doc exists in the corpus and contains its governing language", () => {
    for (const [code, m] of Object.entries(DENIAL_POLICY_MAP)) {
      expect(POLICIES[m.doc], `${code} -> ${m.doc}`).toBeDefined();
      expect(POLICIES[m.doc].toLowerCase()).toContain(m.mustContain.toLowerCase());
    }
  });

  it("every policy doc declares a cms.gov source_url", () => {
    for (const [name, text] of Object.entries(POLICIES)) {
      expect(text, name).toMatch(/^---[\s\S]*?source_url:\s*https:\/\/www\.cms\.gov/);
    }
  });
});

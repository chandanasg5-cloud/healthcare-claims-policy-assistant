import { describe, it, expect } from "vitest";
import { formatClaim, policyContext } from "./format";
import type { ClaimRow } from "./parse";

const denied: ClaimRow = {
  claim_id: "CLM-1003", patient_id: "PAT-002", date_of_service: "2025-02-10",
  procedure_code: "70551", procedure_desc: "MRI brain", diagnosis_code: "G43.909",
  billed_amount: "1800.00", status: "denied", denial_code: "D-NOAUTH",
  denial_reason: "No prior authorization on file",
};

describe("formatClaim", () => {
  it("includes denial detail only for denied claims", () => {
    const line = formatClaim(denied);
    expect(line).toContain("Claim CLM-1003");
    expect(line).toContain("denial D-NOAUTH: No prior authorization on file");
  });

  it("omits denial detail for approved claims", () => {
    const approved = { ...denied, status: "approved", denial_code: "", denial_reason: "" };
    expect(formatClaim(approved)).not.toContain("denial");
  });
});

describe("policyContext", () => {
  it("labels each excerpt with its source", () => {
    const ctx = policyContext([{ source: "COV-002.md", text: "rule text" }]);
    expect(ctx).toContain("[COV-002.md]");
    expect(ctx).toContain("rule text");
  });
});

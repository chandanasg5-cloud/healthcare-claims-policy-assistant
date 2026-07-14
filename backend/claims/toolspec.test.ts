import { describe, it, expect } from "vitest";
import { toolDeclarations, validateToolArgs, stepLabel } from "./toolspec";

describe("toolDeclarations", () => {
  it("declares exactly the five tools", () => {
    expect(toolDeclarations.map((d) => d.name).sort()).toEqual([
      "claims_overview", "find_similar_denied", "get_claim", "get_patient_claims", "search_policies",
    ]);
  });
});

describe("validateToolArgs", () => {
  it("accepts valid args and rejects unknown tools / missing / empty args", () => {
    expect(validateToolArgs("get_claim", { claimId: "CLM-1003" }).ok).toBe(true);
    expect(validateToolArgs("claims_overview", {}).ok).toBe(true);
    expect(validateToolArgs("nope", {}).ok).toBe(false);
    expect(validateToolArgs("get_claim", {}).ok).toBe(false);
    expect(validateToolArgs("search_policies", { query: "  " }).ok).toBe(false);
    expect(validateToolArgs("get_claim", { claimId: 42 }).ok).toBe(false);
  });
});

describe("stepLabel", () => {
  it("produces human-readable labels", () => {
    expect(stepLabel("get_claim", { claimId: "CLM-1003" })).toBe("Looking up claim CLM-1003");
    expect(stepLabel("search_policies", { query: "prior auth" })).toBe("Searching policies: prior auth");
    expect(stepLabel("get_patient_claims", { patientId: "PAT-002" })).toBe("Fetching claims for patient PAT-002");
    expect(stepLabel("find_similar_denied", { claimId: "CLM-1005" })).toBe("Finding claims similar to CLM-1005");
    expect(stepLabel("claims_overview", {})).toBe("Computing claims overview");
  });
});

import { describe, it, expect } from "vitest";
import { runTool } from "./tools";

describe("runTool", () => {
  it("rejects unknown tools and bad args with model-readable errors", async () => {
    expect((await runTool("no_such_tool", {})).output).toContain("Error");
    expect((await runTool("get_claim", {})).output).toContain("Error");
    expect((await runTool("get_claim", { claimId: "" })).output).toContain("Error");
  });

  it("get_claim returns a formatted claim or a not-found message", async () => {
    expect((await runTool("get_claim", { claimId: "CLM-1003" })).output).toContain("D-NOAUTH");
    expect((await runTool("get_claim", { claimId: "CLM-9999" })).output).toContain("No claim found");
  });

  it("get_patient_claims lists all of a patient's claims", async () => {
    const { output } = await runTool("get_patient_claims", { patientId: "PAT-002" });
    expect(output).toContain("CLM-1003");
    expect(output).toContain("CLM-1018");
  });

  it("find_similar_denied returns other claims with the same code", async () => {
    const { output } = await runTool("find_similar_denied", { claimId: "CLM-1003" });
    expect(output).toContain("CLM-1009");
    expect(output).not.toContain("CLM-1003 |");
  });

  it("search_policies returns policy text plus source chunks", async () => {
    const r = await runTool("search_policies", { query: "prior authorization imaging" });
    expect(r.output.toLowerCase()).toContain("prior authorization");
    expect(r.sources && r.sources.length).toBeGreaterThan(0);
    expect(r.sources![0].id).toContain("#");
  });

  it("claims_overview aggregates counts and billed totals", async () => {
    const { output } = await runTool("claims_overview", {});
    expect(output).toContain("approved");
    expect(output).toContain("D-NOAUTH");
  });
});

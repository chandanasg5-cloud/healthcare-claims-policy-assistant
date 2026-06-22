import { describe, it, expect } from "vitest";
import { chunkPolicy, parseClaimsCsv } from "./parse";

describe("chunkPolicy", () => {
  it("splits on blank lines, drops short blocks, ids by source+index", () => {
    const text = "# Title\n\nThis is a long enough paragraph block.\n\nshort\n\nAnother sufficiently long paragraph here.";
    const chunks = chunkPolicy(text, "COV-001.md");
    expect(chunks).toEqual([
      { id: "COV-001.md-1", source: "COV-001.md", text: "This is a long enough paragraph block." },
      { id: "COV-001.md-3", source: "COV-001.md", text: "Another sufficiently long paragraph here." },
    ]);
  });
});

describe("parseClaimsCsv", () => {
  it("parses rows into the 10 claim fields, empty denial fields preserved", () => {
    const csv = [
      "claim_id,patient_id,date_of_service,procedure_code,procedure_desc,diagnosis_code,billed_amount,status,denial_code,denial_reason",
      "CLM-1001,PAT-001,2025-01-15,99396,Annual wellness visit,Z00.00,250.00,approved,,",
    ].join("\n");
    const rows = parseClaimsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claim_id: "CLM-1001",
      procedure_desc: "Annual wellness visit",
      status: "approved",
      denial_code: "",
      denial_reason: "",
    });
  });
});

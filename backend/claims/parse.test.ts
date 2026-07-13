import { describe, it, expect } from "vitest";
import { parsePolicyDoc, chunkPolicy, parseClaimsCsv } from "./parse";

const DOC = `---
title: Medicare Claims Processing Manual, Chapter 1 (excerpt)
source_url: https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c01.pdf
retrieved: 2026-07-13
---

# Timely Filing

## 70 - Time Limitations for Filing Part A and Part B Claims

Claims must be filed no later than 12 calendar months after the date of service.

A claim received after the deadline is denied for timely filing.

## 70.7 - Exceptions

${"Administrative error language. ".repeat(60)}

${"Retroactive entitlement language. ".repeat(60)}
`;

describe("parsePolicyDoc", () => {
  it("extracts frontmatter fields and strips them from the body", () => {
    const doc = parsePolicyDoc(DOC);
    expect(doc.title).toBe("Medicare Claims Processing Manual, Chapter 1 (excerpt)");
    expect(doc.sourceUrl).toContain("cms.gov");
    expect(doc.body.startsWith("# Timely Filing")).toBe(true);
    expect(doc.body).not.toContain("source_url");
  });

  it("passes through documents without frontmatter", () => {
    const doc = parsePolicyDoc("# Plain\n\nJust text here, long enough to matter.");
    expect(doc.title).toBe("");
    expect(doc.body).toContain("Just text");
  });
});

describe("chunkPolicy", () => {
  it("excludes frontmatter from chunks and prefixes each chunk with its section heading", () => {
    const chunks = chunkPolicy(DOC, "timely-filing.md");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.text).not.toContain("source_url");
    const filing = chunks.find((c) => c.text.includes("12 calendar months"));
    expect(filing).toBeDefined();
    expect(filing!.text).toContain("70 - Time Limitations");
  });

  it("splits long sections into chunks under ~1400 chars with sequential ids", () => {
    const chunks = chunkPolicy(DOC, "timely-filing.md");
    for (const c of chunks) expect(c.text.length).toBeLessThan(1400);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `timely-filing.md#${i}`));
    expect(chunks.filter((c) => c.text.includes("Administrative error")).length).toBeGreaterThan(1);
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

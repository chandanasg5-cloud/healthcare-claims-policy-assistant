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

  // Strips a chunk's leading `heading\n` line (if present) to get just the
  // body text that was packed from the original paragraph(s).
  const stripHeadingLine = (chunkText: string, heading: string) =>
    heading && chunkText.startsWith(`${heading}\n`)
      ? chunkText.slice(heading.length + 1)
      : chunkText;

  const normalizeWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();

  it("never breaks a word across chunks when splitting an oversized paragraph", () => {
    // Build one long paragraph of distinct, unique words with no sentence
    // punctuation at all, forcing the whitespace-boundary fallback path.
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const longParagraph = words.join(" ");
    const doc = `---
title: Long Paragraph Test
source_url: https://example.com/doc
---

## A Long Section

${longParagraph}
`;
    const chunks = chunkPolicy(doc, "long-para.md");
    expect(chunks.length).toBeGreaterThan(1);

    const bodies: string[] = [];
    for (const c of chunks) {
      const body = stripHeadingLine(c.text, "A Long Section");
      // Every chunk body must start and end on a non-whitespace char, i.e.
      // it was never cut mid-word (a mid-word cut would leave a body that
      // still starts/ends cleanly, but the *reconstruction* check below is
      // what actually catches split words; this assertion just rules out
      // stray leading/trailing whitespace from the join).
      expect(body).toMatch(/^\S[\s\S]*\S$/);
      bodies.push(body);
    }

    // No word may appear split across two chunks: rejoining chunk bodies
    // with a single space and normalizing whitespace must reproduce the
    // original paragraph exactly (word-for-word).
    const reconstructed = normalizeWhitespace(bodies.join(" "));
    expect(reconstructed).toBe(normalizeWhitespace(longParagraph));
  });

  it("loses no text when reassembling chunks from a long fixture section", () => {
    const { body } = parsePolicyDoc(DOC);
    const exceptionsSection = body
      .split(/\n(?=## )/)
      .find((s) => s.startsWith("## 70.7 - Exceptions"))!;
    const originalText = exceptionsSection.replace(/^## .+\n/, "").trim();

    const chunks = chunkPolicy(DOC, "timely-filing.md");
    const exceptionsChunks = chunks.filter((c) => c.text.includes("70.7 - Exceptions"));
    expect(exceptionsChunks.length).toBeGreaterThan(1);

    const reassembled = exceptionsChunks
      .map((c) => stripHeadingLine(c.text, "70.7 - Exceptions"))
      .join(" ");
    expect(normalizeWhitespace(reassembled)).toBe(normalizeWhitespace(originalText));
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

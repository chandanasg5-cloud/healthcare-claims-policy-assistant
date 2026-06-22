import { describe, it, expect } from "vitest";
import { retrieve } from "./retrieval";

describe("retrieve", () => {
  it("returns the prior-authorization policy chunk for an MRI-without-auth query", async () => {
    const results = await retrieve("MRI performed without prior authorization", 4);
    expect(results.length).toBeGreaterThan(0);
    const joined = results.map((r) => r.text).join(" ");
    expect(joined).toContain("D-NOAUTH");
    expect(results[0].source).toContain("COV-002");
  });
});

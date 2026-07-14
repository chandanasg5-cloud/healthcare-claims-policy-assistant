import { describe, it, expect } from "vitest";
import { retrieve } from "./retrieval";

describe("retrieve", () => {
  it("returns prior-authorization policy text for an MRI-without-auth query", async () => {
    const results = await retrieve("MRI performed without prior authorization", 4);
    expect(results.length).toBeGreaterThan(0);
    const joined = results.map((r) => r.text).join(" ").toLowerCase();
    expect(joined).toContain("prior authorization");
    expect(results[0].id).toContain("#");
  });

  it("returns timely-filing text for a late-claim query", async () => {
    const results = await retrieve("claim filed after twelve month deadline timely filing", 4);
    expect(results.map((r) => r.source)).toContain("timely-filing.md");
  });
});

import { describe, it, expect } from "vitest";
import { listClaims } from "./api";
import { getClaim } from "./tools";

describe("listClaims", () => {
  it("returns all seeded claims", async () => {
    const res = await listClaims();
    expect(res.claims.length).toBeGreaterThan(0);
    expect(res.claims.some((c) => c.claim_id === "CLM-1001")).toBe(true);
  });
});

describe("getClaim", () => {
  it("returns null for an unknown claim id", async () => {
    expect(await getClaim("CLM-DOES-NOT-EXIST")).toBeNull();
  });
  it("returns the row for a known claim id", async () => {
    const c = await getClaim("CLM-1003");
    expect(c?.denial_code).toBe("D-NOAUTH");
  });
});

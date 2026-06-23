import { describe, it, expect } from "vitest";
import { listClaims, similarDenied, getClaim } from "./api";

describe("listClaims", () => {
  it("returns all seeded claims", async () => {
    const res = await listClaims();
    expect(res.claims.length).toBeGreaterThan(0);
    expect(res.claims.some((c) => c.claim_id === "CLM-1001")).toBe(true);
  });
});

describe("similarDenied", () => {
  it("returns other claims with the same denial code, excluding the reference", async () => {
    const res = await similarDenied({ claimId: "CLM-1003" }); // D-NOAUTH
    expect(res.claims.every((c) => c.claim_id !== "CLM-1003")).toBe(true);
    expect(res.claims.every((c) => c.denial_code === "D-NOAUTH")).toBe(true);
  });

  it("returns empty when the reference claim has no denial code", async () => {
    const res = await similarDenied({ claimId: "CLM-1001" }); // approved
    expect(res.claims).toEqual([]);
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

// Regenerates claims/data.ts from the raw files in claims/data/.
// The deployed bundle doesn't include loose data files, so seed data is
// embedded as a TypeScript module. Run after editing claims/data/:
//   node scripts/gen-data.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "claims", "data");

const claimsCsv = readFileSync(join(dataDir, "claims.csv"), "utf-8");
const policies = {};
for (const f of readdirSync(join(dataDir, "policies")).filter((f) => f.endsWith(".md")).sort()) {
  policies[f] = readFileSync(join(dataDir, "policies", f), "utf-8");
}

const out = `// GENERATED FILE — do not edit by hand.
// Source of truth: claims/data/ — regenerate with \`node scripts/gen-data.mjs\`.

export const CLAIMS_CSV = ${JSON.stringify(claimsCsv)};

export const POLICIES: Record<string, string> = ${JSON.stringify(policies, null, 2)};
`;

writeFileSync(join(dataDir, "..", "data.ts"), out);
console.log("wrote claims/data.ts");

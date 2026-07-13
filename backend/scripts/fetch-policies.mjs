// Downloads the raw CMS sources listed in policy-sources.json into
// claims/data/sources/ (gitignored) so the curated excerpts in
// claims/data/policies/ can be reproduced and audited.
//   node scripts/fetch-policies.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "scripts", "policy-sources.json"), "utf-8"));
const outDir = join(root, "claims", "data", "sources");
mkdirSync(outDir, { recursive: true });

// cms.gov blocks requests without a browser-like User-Agent.
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

for (const s of manifest.sources) {
  const res = await fetch(s.url, { headers });
  if (!res.ok) {
    console.error(`FAILED ${s.file}: ${res.status} ${s.url}`);
    continue;
  }
  const ext = extname(new URL(s.url).pathname) || ".html";
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(outDir, s.file.replace(/\.md$/, ext)), buf);
  console.log(`fetched ${s.file} <- ${s.url} (${buf.length} bytes)`);
}

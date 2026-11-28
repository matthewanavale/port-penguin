// AC11: prints the gzip size of every JS and CSS file in dist/assets/ and
// fails when the total is above the limit. Run after `npm run build`.
// It uses only syntax that Node type stripping accepts (D24).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT_KB = 225; // AC11 (B22 of run 2b; 2a Amendment A1 set 210)
const dir = join(process.cwd(), "dist", "assets");

let files: string[] = [];
try {
  files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
} catch {
  console.error(`size: cannot read ${dir}; run "npm run build" first`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`size: no JS or CSS files in ${dir}`);
  process.exit(1);
}

let total = 0;
for (const f of files.sort()) {
  const bytes = gzipSync(readFileSync(join(dir, f))).length;
  total += bytes;
  console.log(`${(bytes / 1000).toFixed(2).padStart(8)} KB  ${f}`);
}
const kb = total / 1000;
console.log(
  `${kb.toFixed(2).padStart(8)} KB  total gzip (limit ${LIMIT_KB} KB)`,
);
if (kb > LIMIT_KB) {
  console.error(`size: ${kb.toFixed(2)} KB is above the ${LIMIT_KB} KB limit`);
  process.exit(1);
}

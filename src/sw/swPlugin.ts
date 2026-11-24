// Writes dist/sw.js from src/sw/sw.template.js at build time (D10). The cache
// name is port-penguin-<hash>, where <hash> comes from the names and the
// bytes of every output file, so a new build with different output gets a
// new cache name. The asset list holds every output file except sw.js.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ResolvedConfig } from "vite";

export interface OutputFile {
  /** Path relative to dist/, with forward slashes. */
  fileName: string;
  source: string | Uint8Array;
}

export interface ServiceWorkerBuild {
  code: string;
  cacheName: string;
  assets: string[];
}

const SW_FILE = "sw.js";

export function buildServiceWorker(input: {
  template: string;
  files: OutputFile[];
}): ServiceWorkerBuild {
  const files = input.files
    .filter((f) => f.fileName !== SW_FILE)
    .sort((a, b) =>
      a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
    );
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f.fileName);
    hash.update("\0");
    hash.update(f.source);
    hash.update("\0");
  }
  const cacheName = "port-penguin-" + hash.digest("hex").slice(0, 16);
  const assets = ["./", ...files.map((f) => f.fileName)];
  const code = input.template
    .replaceAll("__CACHE__", () => JSON.stringify(cacheName))
    .replaceAll("__ASSETS__", () => JSON.stringify(assets));
  return { code, cacheName, assets };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** The Vite plugin: after the bundle and public/ are written, writes dist/sw.js. */
export function swPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "port-penguin-sw",
    apply: "build",
    configResolved(config: ResolvedConfig) {
      outDir = join(config.root, config.build.outDir);
    },
    writeBundle: {
      sequential: true,
      order: "post",
      handler() {
        const template = readFileSync(
          fileURLToPath(new URL("./sw.template.js", import.meta.url)),
          "utf8",
        );
        const files = listFiles(outDir).map((full) => ({
          fileName: relative(outDir, full).split(sep).join("/"),
          source: readFileSync(full),
        }));
        const { code } = buildServiceWorker({ template, files });
        writeFileSync(join(outDir, SW_FILE), code);
      },
    },
  };
}

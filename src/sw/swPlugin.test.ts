// AC10 and D10: the build writes dist/sw.js from src/sw/sw.template.js. The
// cache name is port-penguin-<hash>, where <hash> comes from the output
// files, and the asset list holds every output file the page uses.
//
// Contract (src/sw/swPlugin.ts):
//   buildServiceWorker({ template, files }) -> { code, cacheName, assets }
//     files: every file in dist/ as { fileName, source }
//   swPlugin(): a Vite plugin (used in vite.config.ts) that calls it
import { describe, expect, it } from "vitest";
import { buildServiceWorker, swPlugin } from "./swPlugin";
import realTemplate from "./sw.template.js?raw";

const TEMPLATE = `const CACHE = __CACHE__;
const ASSETS = __ASSETS__;
self.addEventListener("install", () => {});
`;

type File = { fileName: string; source: string | Uint8Array };
const DIST: File[] = [
  {
    fileName: "index.html",
    source:
      "<!doctype html><script type=module src=/assets/index-a1b2.js></script>",
  },
  { fileName: "assets/index-a1b2.js", source: "console.log('game')" },
  { fileName: "assets/index-c3d4.css", source: "body{margin:0}" },
  { fileName: "manifest.webmanifest", source: '{"name":"Port Penguin"}' },
  { fileName: "icon.svg", source: "<svg/>" },
  { fileName: "icon-192.png", source: new Uint8Array([137, 80, 78, 71, 1]) },
  { fileName: "icon-512.png", source: new Uint8Array([137, 80, 78, 71, 2]) },
  {
    fileName: "icon-maskable-512.png",
    source: new Uint8Array([137, 80, 78, 71, 3]),
  },
];
const build = (files: File[], template = TEMPLATE) =>
  buildServiceWorker({ template, files });

describe("generated service worker (AC10, D10)", () => {
  it("names the cache port-penguin-<hash>", () => {
    expect(build(DIST).cacheName).toMatch(/^port-penguin-[0-9a-f]{8,}$/);
  });

  it("gives the same name for the same output files", () => {
    expect(build(DIST).cacheName).toBe(
      build(DIST.map((f) => ({ ...f }))).cacheName,
    );
  });

  it("gives a different name when one output file changes", () => {
    const changed = DIST.map((f) =>
      f.fileName === "assets/index-a1b2.js"
        ? { ...f, source: "console.log('game v2')" }
        : f,
    );
    expect(build(changed).cacheName).not.toBe(build(DIST).cacheName);
  });

  it("gives a different name when one binary output file changes", () => {
    const changed = DIST.map((f) =>
      f.fileName === "icon-192.png"
        ? { ...f, source: new Uint8Array([137, 80, 78, 71, 9]) }
        : f,
    );
    expect(build(changed).cacheName).not.toBe(build(DIST).cacheName);
  });

  it("gives a different name when a file is renamed", () => {
    const renamed = DIST.map((f) =>
      f.fileName === "assets/index-c3d4.css"
        ? { ...f, fileName: "assets/index-e5f6.css" }
        : f,
    );
    expect(build(renamed).cacheName).not.toBe(build(DIST).cacheName);
  });

  it("lists the page root and every output file in the assets, but not sw.js itself", () => {
    const { assets } = build([...DIST, { fileName: "sw.js", source: "old" }]);
    expect(assets).toContain("./");
    for (const f of DIST)
      expect(assets.some((a) => a.replace(/^\.\//, "") === f.fileName)).toBe(
        true,
      );
    expect(assets.some((a) => a.replace(/^\.\//, "") === "sw.js")).toBe(false);
  });

  it("does not let sw.js change the cache name", () => {
    expect(
      build([...DIST, { fileName: "sw.js", source: "anything" }]).cacheName,
    ).toBe(build(DIST).cacheName);
  });

  it("fills the template: no placeholder is left, the code holds the name and the assets", () => {
    const r = build(DIST);
    expect(r.code).not.toContain("__CACHE__");
    expect(r.code).not.toContain("__ASSETS__");
    expect(r.code).toContain(JSON.stringify(r.cacheName));
    for (const a of r.assets) expect(r.code).toContain(JSON.stringify(a));
    expect(() => new Function(r.code)).not.toThrow();
  });
});

describe("the real template (src/sw/sw.template.js)", () => {
  it("has both placeholders", () => {
    expect(realTemplate).toContain("__CACHE__");
    expect(realTemplate).toContain("__ASSETS__");
  });

  it("gives valid JavaScript that handles install, activate, and fetch", () => {
    const { code, cacheName } = build(DIST, realTemplate);
    expect(code).toContain(cacheName);
    const events: string[] = [];
    const self = { addEventListener: (type: string) => events.push(type) };
    new Function("self", "caches", "fetch", code)(self, {}, () =>
      Promise.reject(new Error("offline")),
    );
    expect(events.sort()).toEqual(["activate", "fetch", "install"]);
  });
});

describe("the Vite plugin", () => {
  it("is a named plugin", () => {
    const p = swPlugin();
    expect(typeof p.name).toBe("string");
    expect(p.name.length).toBeGreaterThan(0);
  });
});

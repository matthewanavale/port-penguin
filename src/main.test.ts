// @vitest-environment jsdom
// AC6b: after the page loads, window.__pp exists and exposes sha256, state,
// and M. The hashes are fixed known values, and M is compared with a frozen
// JSON snapshot of the run-1 tasks (src/test/fixtures/run1-M.json).
import { beforeAll, describe, expect, it } from "vitest";
import pageHtml from "../index.html?raw";
import run1 from "./test/fixtures/run1-M.json";

type PP = {
  sha256(s: string): string;
  state(): Record<string, unknown> & { cur: number; cwd: string };
  M: { title: string; ch: number; check: unknown }[];
};

/** The new optional save keys of D11. A save may hold them; the state may not need them. */
const OPTIONAL_KEYS = [
  "exported",
  "vars",
  "functions",
  "aliases",
  "options",
  "crontab",
];

/** Fixed known SHA-256 values (computed with Node crypto, independent of the engine). */
const KNOWN_HASHES: [string, string][] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["ahoy", "2355f39e9d5f0c96c668f4d8e83fe9e76246caa8c85bd888b8d80826968e7b31"],
  [
    "héllo wörld 🐧",
    "4f64478802ca128a761936e06d8d3c91f5c28497324352b1cae949e19078c43e",
  ],
];

let pp: PP | undefined;

beforeAll(async () => {
  // The page: its body markup, then the entry module.
  const doc = new DOMParser().parseFromString(pageHtml, "text/html");
  document.body.innerHTML = doc.body.innerHTML;
  localStorage.clear();
  const w = window as unknown as Record<string, unknown>;
  w.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  w.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const d = document as unknown as Record<string, unknown>;
  d.fonts ??= { ready: Promise.resolve() };

  await import("./main");
  await new Promise((r) => setTimeout(r, 0));
  pp = (window as unknown as { __pp?: PP }).__pp;
});

describe("window.__pp (AC6b)", () => {
  it("exists after load", () => {
    expect(pp).toBeDefined();
  });

  it("sha256 gives the fixed known hashes", () => {
    const p = pp as PP;
    for (const [input, hash] of KNOWN_HASHES)
      expect(p.sha256(input)).toBe(hash);
  });

  it("M holds the same 70 tasks as the frozen run-1 snapshot, with their checks", () => {
    const p = pp as PP;
    expect(p.M).toHaveLength(70);
    expect(JSON.parse(JSON.stringify(p.M))).toEqual(run1.tasks);
    for (const m of p.M) expect(typeof m.check).toBe("function");
  });

  it("state() returns the live game state with the run-1 keys, plus optional new keys", () => {
    const s = (pp as PP).state();
    const keys = Object.keys(s).filter((k) => !OPTIONAL_KEYS.includes(k));
    expect(keys.sort()).toEqual(run1.stateKeys);
    expect(s.cur).toBe(0);
    expect(s.cwd).toBe("/home/cadet");
    expect((pp as PP).state()).toBe(s);
  });
});

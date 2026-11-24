// @vitest-environment jsdom
// AC6b: after the page loads, window.__pp exists and exposes sha256, state,
// and M, with the same behavior as the old index.html.
import { beforeAll, describe, expect, it } from "vitest";
import pageHtml from "../index.html?raw";
import { openLegacy } from "./test/legacyHarness";
import type { LegacyPP, LegacyState } from "./test/legacyHarness";

type PP = {
  sha256(s: string): string;
  state(): LegacyState;
  M: { title: string; ch: number; check: unknown }[];
};

let pp: PP | undefined;
let legacy: { pp: LegacyPP; state: LegacyState };

beforeAll(async () => {
  // The old page, for comparison.
  const g = openLegacy();
  legacy = { pp: g.pp(), state: g.state() };

  // The new page: its body markup, then the entry module.
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

  it("sha256 gives the same hashes as the old page", () => {
    const p = pp as PP;
    for (const s of ["", "abc", "ahoy", "héllo wörld 🐧"]) {
      expect(p.sha256(s)).toBe(legacy.pp.sha256(s));
    }
    expect(p.sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("M holds the same 70 tasks, with their checks", () => {
    const p = pp as PP;
    expect(p.M.map((m) => [m.title, m.ch])).toEqual(
      legacy.pp.M.map((m) => [m.title, m.ch]),
    );
    for (const m of p.M) expect(typeof m.check).toBe("function");
  });

  it("state() returns the live game state with the same keys as the old page", () => {
    const s = (pp as PP).state();
    expect(Object.keys(s).sort()).toEqual(Object.keys(legacy.state).sort());
    expect(s.cur).toBe(0);
    expect(s.cwd).toBe("/home/cadet");
    expect((pp as PP).state()).toBe(s);
  });
});

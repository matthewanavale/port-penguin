// B5: the engine reads the time only through clock.ts. A second test group
// checks the default clock and the injected clock.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockDate, clockNow, defaultClock, setClock } from "./clock";
import type { Clock } from "./clock";
import { makeFakeClock } from "../test/determinism";

const ROOT = join(process.cwd(), "src", "engine");
/** The clock module, and the scheduler that B7 exempts for `performance.now()`. */
const EXEMPT = new Set(["clock.ts", "sched.ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no time read outside the clock module (B5)", () => {
  it("has no Date.now() and no argument-less new Date() in src/engine", () => {
    const bad: string[] = [];
    for (const p of sources(ROOT)) {
      if (EXEMPT.has(basename(p))) continue;
      const text = stripComments(readFileSync(p, "utf-8"));
      if (/\bDate\.now\s*\(/.test(text)) bad.push(`${p}: Date.now()`);
      if (/\bnew\s+Date\s*\(\s*\)/.test(text)) bad.push(`${p}: new Date()`);
    }
    expect(bad).toEqual([]);
  });
});

afterEach(() => {
  setClock();
  vi.useRealTimers();
});

describe("clock", () => {
  it("defaults to Date.now", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    expect(clockNow()).toBe(1_000_000);
    expect(clockDate().getTime()).toBe(1_000_000);
  });

  it("reads an injected clock, and the default again after setClock()", () => {
    const fake: Clock = {
      now: () => 42,
      setTimer: () => 0,
      clearTimer: () => undefined,
    };
    setClock(fake);
    expect(clockNow()).toBe(42);
    expect(clockDate().getTime()).toBe(42);
    setClock();
    expect(clockNow()).not.toBe(42);
  });

  it("the default timer runs and clears", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const id = defaultClock.setTimer(10, fn);
    defaultClock.clearTimer(id);
    vi.advanceTimersByTime(20);
    expect(fn).not.toHaveBeenCalled();
    defaultClock.setTimer(10, fn);
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("fake engine clock (B5)", () => {
  it("runs due timers in time order and moves the time", async () => {
    const c = makeFakeClock(1000);
    const seen: string[] = [];
    c.setTimer(300, () => seen.push(`b@${c.now()}`));
    c.setTimer(100, () => {
      seen.push(`a@${c.now()}`);
      c.setTimer(50, () => seen.push(`c@${c.now()}`));
    });
    const gone = c.setTimer(200, () => seen.push("gone"));
    c.clearTimer(gone);
    await c.advance(99);
    expect(seen).toEqual([]);
    await c.advance(1);
    expect(seen).toEqual(["a@1100"]);
    await c.advance(500);
    expect(seen).toEqual(["a@1100", "c@1150", "b@1300"]);
    expect(c.now()).toBe(1600);
    expect(c.pending()).toBe(0);
  });
});

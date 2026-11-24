// AC4: the same walkthrough as legacy.test.ts, on the ported engine. All 70
// tasks complete in order, the final state shows 70 of 70 tasks and the last
// rank, and the final saved JSON equals the legacy fixture's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, M, rankFor, SAVE_KEY } from "../engine/index";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";
import { openLegacy } from "./legacyHarness";
import { SOLUTIONS } from "./solutions";

function openEngine() {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  const engine = createEngine({
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  });
  engine.start();
  return { engine, saved: () => store.get(SAVE_KEY) ?? null };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("walkthrough on the ported engine (AC4)", () => {
  it("has the same 70 tasks, in the same order, as the solutions", () => {
    expect(M).toHaveLength(70);
    expect(M.map((m) => m.title)).toEqual(SOLUTIONS.map((s) => s.title));
  });

  it("completes all 70 tasks in order and reaches the last rank", () => {
    const { engine, saved } = openEngine();
    for (const sol of SOLUTIONS) {
      for (const cmd of sol.commands) engine.execute(cmd);
      expect(engine.state.done, `task ${sol.task}: ${sol.title}`).toContain(
        sol.task - 1,
      );
    }
    expect(engine.state.done).toHaveLength(70);
    expect(engine.state.cur).toBe(70);
    expect(rankFor(engine.state.done.length)).toBe("Harbor master");

    const mine = saved();
    vi.useRealTimers();
    vi.restoreAllMocks();
    const legacy = openLegacy();
    try {
      for (const sol of SOLUTIONS)
        for (const cmd of sol.commands) legacy.run(cmd);
      expect(JSON.parse(mine as string)).toEqual(
        JSON.parse(legacy.saved() as string),
      );
    } finally {
      legacy.close();
    }
  });
});

// AC5 and D4: a state saved by the old index.html under port-penguin-v2
// loads into the ported engine. The game continues at the same task, with
// the same files, containers, history, and hint unlock state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { OutLine } from "../engine/output";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";
import { openLegacy } from "./legacyHarness";
import type { LegacyState } from "./legacyHarness";
import { SOLUTIONS } from "./solutions";

const plain = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

function openEngine(saved: string) {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED + 1));
  const store = new Map<string, string>([[SAVE_KEY, saved]]);
  const engine = createEngine({
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  });
  return { engine, saved: () => store.get(SAVE_KEY) ?? null };
}

/** Plays the legacy game through `tasks` solutions, unlocks hints, and returns its save. */
function legacySave(
  tasks: number,
  unlock: boolean,
): { json: string; state: LegacyState } {
  const g = openLegacy();
  try {
    for (const sol of SOLUTIONS.slice(0, tasks))
      for (const cmd of sol.commands) g.run(cmd);
    if (unlock) g.pp().state().unlocked = true;
    g.run("ls");
    return { json: g.saved() as string, state: g.state() };
  } finally {
    g.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loading a legacy save (AC5)", () => {
  it("continues at the same task with the same files, containers, history, and unlock state", () => {
    const old = legacySave(58, true);
    expect(old.state.cur).toBe(58);
    expect(old.state.dk.containers.length).toBeGreaterThan(0);

    const { engine, saved } = openEngine(old.json);
    expect(engine.resumed).toBe(true);
    engine.start();
    const s = engine.state;
    expect(s.cur).toBe(old.state.cur);
    expect(s.done).toEqual(old.state.done);
    expect(s.cwd).toBe(old.state.cwd);
    expect(s.fs).toEqual(old.state.fs);
    expect(s.dk).toEqual(old.state.dk);
    expect(s.procs).toEqual(old.state.procs);
    expect(s.env).toEqual(old.state.env);
    expect(s.hist).toEqual(old.state.hist);
    expect(s.unlocked).toBe(true);
    // The first save after loading writes the same state back.
    expect(JSON.parse(saved() as string)).toEqual(JSON.parse(old.json));
  });

  it("plays the next task from the loaded state", () => {
    const old = legacySave(58, false);
    const { engine } = openEngine(old.json);
    engine.start();
    const next = SOLUTIONS[58];
    for (const cmd of next.commands) engine.execute(cmd);
    expect(engine.state.done).toContain(58);
    expect(engine.state.cur).toBe(59);
  });

  it("gives the same hint as the legacy page after loading an unlocked save", () => {
    const old = legacySave(20, true);
    const g = openLegacy({ saved: old.json });
    let legacyHint: string;
    try {
      legacyHint = g.run("hint").text;
    } finally {
      g.close();
    }
    const { engine } = openEngine(old.json);
    engine.start();
    expect(plain(engine.execute("hint").lines)).toBe(legacyHint);
    expect(legacyHint.startsWith("Hint: ")).toBe(true);
  });

  it("runs the setup of the current task when the save has not run it yet", () => {
    const old = JSON.parse(legacySave(35, false).json) as LegacyState & {
      setup: Record<string, boolean>;
    };
    expect(old.cur).toBe(35);
    delete old.setup["35"];
    old.procs = (old.procs as { cmd: string }[]).filter(
      (p) => !p.cmd.startsWith("fog-horn"),
    );
    const json = JSON.stringify(old);

    const g = openLegacy({ saved: json });
    let legacyState: LegacyState;
    try {
      legacyState = g.state();
    } finally {
      g.close();
    }
    const { engine } = openEngine(json);
    const alert = plain(engine.start());
    expect(alert).toContain("fog-horn");
    expect(engine.state.procs).toEqual(legacyState.procs);
    expect(engine.state.setup).toEqual(legacyState.setup);
  });

  for (const [label, raw] of [
    ["not JSON", "{oops"],
    ["missing dk", '{"fs":{},"procs":[],"done":[]}'],
    ["done is not a list", '{"fs":{},"dk":{},"procs":[],"done":1}'],
  ] as const) {
    it(`starts a fresh game when the save is ${label}, as the legacy page does`, () => {
      const g = openLegacy({ saved: raw });
      let legacyState: LegacyState;
      try {
        legacyState = g.state();
      } finally {
        g.close();
      }
      const { engine } = openEngine(raw);
      expect(engine.resumed).toBe(false);
      expect(engine.state.cur).toBe(legacyState.cur);
      expect(engine.state.fs).toEqual(legacyState.fs);
      expect(engine.state.done).toEqual([]);
    });
  }
});

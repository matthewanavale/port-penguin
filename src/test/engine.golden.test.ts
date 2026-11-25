// AC3, AC9: every golden script runs through the engine. For each command,
// the plain text (colors removed), the exit code, the current directory, and
// the task index equal the recorded transcript. For each Tab press, the new
// line, the cursor, and the candidate list are the same. After each script,
// the JSON the engine saved under port-penguin-v2 equals the recorded save,
// key for key. This file only compares; `npm run golden:record` (D9 (3))
// records through ./golden.record, which this file imports.
//
// Engine contract used here (src/engine/index.ts):
//   createEngine({ storage }) -> Engine
//   engine.start(): OutLine[]           set up the current task, then save
//   engine.execute(line): { lines, cleared }
//       `lines` is the output after the command (no echoed prompt). When
//       `cleared` is true, `lines` is only the output after the last clear.
//   engine.complete(value, cursor): { value, cursor, listing: string[] }
//   engine.state                        the live game state (S)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { OutLine } from "../engine/output";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";
import type { Golden, GoldenStep } from "./golden";
import "./golden.record";
import { SCRIPTS } from "./scripts";

const goldens = import.meta.glob<Golden>("./golden/*.json", {
  eager: true,
  import: "default",
});
const goldenFor = (name: string): Golden | undefined =>
  goldens[`./golden/${name}.json`];

/** Plain text of output lines, with every style removed. */
const plain = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

/** A fresh engine with the same clock and random source as the recording (D15b). */
function openEngine(saved?: string) {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  if (saved !== undefined) store.set(SAVE_KEY, saved);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  const engine = createEngine({ storage });
  engine.start();
  return {
    engine,
    saved: () => store.get(SAVE_KEY) ?? null,
    advance(ms: number) {
      clock.advance(ms);
      vi.setSystemTime(clock.now());
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("golden transcripts on the ported engine (AC3, AC5b)", () => {
  it("has a golden file for every script", () => {
    expect(
      SCRIPTS.filter((s) => !goldenFor(s.name)).map((s) => s.name),
    ).toEqual([]);
  });

  for (const script of SCRIPTS) {
    it(`"${script.name}" gives the same transcript and the same saved JSON`, () => {
      const golden = goldenFor(script.name);
      expect(golden, `missing golden file for ${script.name}`).toBeDefined();
      const g = golden as Golden;
      const { engine, saved, advance } = openEngine();

      g.steps.forEach((step: GoldenStep, i) => {
        if ("advanceMs" in step) {
          advance(step.advanceMs);
        } else if ("tab" in step) {
          const r = engine.complete(step.tab, step.cursor);
          expect(
            {
              value: r.value,
              newCursor: r.cursor,
              listing: r.listing.length ? r.listing.join("  ") : null,
            },
            `step ${i}: Tab on ${JSON.stringify(step.tab)}`,
          ).toEqual({
            value: step.value,
            newCursor: step.newCursor,
            listing: step.listing,
          });
        } else {
          const r = engine.execute(step.input);
          const s = engine.state;
          expect(
            {
              text: plain(r.lines),
              cleared: r.cleared,
              code: s.lastCode,
              cwd: s.cwd,
              cur: s.cur,
            },
            `step ${i}: ${step.input}`,
          ).toEqual({
            text: step.text,
            cleared: step.cleared,
            code: step.code,
            cwd: step.cwd,
            cur: step.cur,
          });
        }
      });

      const mine = saved();
      expect(mine).not.toBeNull();
      expect(JSON.parse(mine as string)).toEqual(JSON.parse(g.save as string));
    });
  }
});

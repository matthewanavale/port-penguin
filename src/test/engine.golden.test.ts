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
//   engine.start(): Promise<OutLine[]>  set up the current task, then save
//   engine.execute(line): Promise<{ lines, chunks }>
//       Command output comes through `onOutput` (B15); `lines` holds the game
//       lines. The harness (engineHarness.ts `collector`) builds the plain
//       text of the old `lines`: the output after the last `clear`, then the
//       game lines; and `cleared`, true when the input ran `clear`.
//   engine.complete(value, cursor): { value, cursor, listing: string[] }
//   engine.state                        the live game state (S)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, SAVE_KEY } from "../engine/index";
import { setClock } from "../engine/clock";
import { makeFakeClock, seededRandom, SEED, START_MS } from "./determinism";
import { collector } from "./engineHarness";
import type { Golden, GoldenStep } from "./golden";
import "./golden.record";
import { SCRIPTS } from "./scripts";

const goldens = import.meta.glob<Golden>("./golden/*.json", {
  eager: true,
  import: "default",
});
const goldenFor = (name: string): Golden | undefined =>
  goldens[`./golden/${name}.json`];

/** A fresh engine with the same clock and random source as the recording (D15b). */
async function openEngine(saved?: string) {
  const clock = makeFakeClock(START_MS);
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  if (saved !== undefined) store.set(SAVE_KEY, saved);
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };
  const col = collector();
  const engine = createEngine({ storage, clock, onOutput: col.onOutput });
  await engine.start();
  return {
    engine,
    col,
    saved: () => store.get(SAVE_KEY) ?? null,
    advance: (ms: number) => clock.advance(ms),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setClock();
});

describe("golden transcripts on the ported engine (AC3, AC5b)", () => {
  it("has a golden file for every script", () => {
    expect(
      SCRIPTS.filter((s) => !goldenFor(s.name)).map((s) => s.name),
    ).toEqual([]);
  });

  for (const script of SCRIPTS) {
    it(`"${script.name}" gives the same transcript and the same saved JSON`, async () => {
      const golden = goldenFor(script.name);
      expect(golden, `missing golden file for ${script.name}`).toBeDefined();
      const g = golden as Golden;
      const { engine, col, saved, advance } = await openEngine();

      for (const [i, step] of g.steps.entries() as IterableIterator<
        [number, GoldenStep]
      >) {
        if ("advanceMs" in step) {
          await advance(step.advanceMs);
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
          col.reset();
          const r = await engine.execute(step.input);
          const s = engine.state;
          const shown = col.take(r);
          expect(
            {
              text: shown.text,
              cleared: shown.cleared,
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
      }

      const mine = saved();
      expect(mine).not.toBeNull();
      expect(JSON.parse(mine as string)).toEqual(JSON.parse(g.save as string));
    });
  }
});

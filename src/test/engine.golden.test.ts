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
import { afterEach, describe, expect, it } from "vitest";
import type { Golden, GoldenStep } from "./golden";
import "./golden.record";
import { acts, closeSession, mayWait, openSession } from "./goldenSession";
import type { Running } from "./goldenSession";
import { SCRIPTS } from "./scripts";

const goldens = import.meta.glob<Golden>("./golden/*.json", {
  eager: true,
  import: "default",
});
const goldenFor = (name: string): Golden | undefined =>
  goldens[`./golden/${name}.json`];

afterEach(closeSession);

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
      const session = await openSession();
      const steps = g.steps;
      let running: Running | null = null;
      /** Compares what the input that ended gave with its own golden step. */
      const check = async (r: Running): Promise<void> => {
        const step = steps[r.index] as Extract<GoldenStep, { input: string }>;
        const o = await r.result;
        expect(o, `step ${r.index}: ${step.input}`).toEqual({
          text: step.text,
          cleared: step.cleared,
          code: step.code,
          cwd: step.cwd,
          cur: step.cur,
        });
      };
      const settleRunning = async (): Promise<void> => {
        if (running?.done()) {
          const r: Running = running;
          running = null;
          await check(r);
        }
      };

      for (const [i, step] of steps.entries() as IterableIterator<
        [number, GoldenStep]
      >) {
        if ("input" in step) {
          expect(running, `step ${i}: an input is still waiting`).toBeNull();
          running = await session.begin(i, step.input, mayWait(steps, i));
          if (!acts(steps, i)) {
            const r: Running = running;
            running = null;
            await session.wait(r);
            await check(r);
          } else await settleRunning();
        } else {
          if ("advanceMs" in step) await session.advance(step.advanceMs);
          else if ("keys" in step) await session.keys(step.keys);
          else if ("signal" in step) await session.signal(step.signal);
          else {
            const r = session.engine.complete(step.tab, step.cursor);
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
          }
          await settleRunning();
        }
      }
      expect(running, "an input is still waiting at the end").toBeNull();

      const mine = session.saved();
      expect(mine).not.toBeNull();
      expect(JSON.parse(mine as string)).toEqual(JSON.parse(g.save as string));
    });
  }
});

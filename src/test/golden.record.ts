// D9 (3): records the golden files from the new engine. It is imported by
// engine.golden.test.ts, which only compares. The recording test registers
// only in record mode: `npm run golden:record` runs vitest with --update, and
// the setup below turns that into RECORD=1 for this file. A re-record keeps
// the `reason` and `replaces` of every step, because they are written on the
// step in src/test/scripts.ts and copied here.
import { expect, it } from "vitest";
import type { OutLine } from "../engine/output";
import type { Golden, GoldenStep } from "./golden";
import { acts, closeSession, mayWait, openSession } from "./goldenSession";
import type { Running } from "./goldenSession";
import { lineOf, SCRIPTS } from "./scripts";
import type { GoldenScript } from "./scripts";

/** Plain text of output lines, with every style removed. */
export const plain = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

/** Runs one golden script on a fresh engine and records every step. */
export async function recordGolden(script: GoldenScript): Promise<Golden> {
  try {
    const session = await openSession();
    const steps: GoldenStep[] = [];
    let running: Running | null = null;
    /** Fills the result of the input that ended into its own step. */
    const finish = async (r: Running, note: object): Promise<void> => {
      const o = await r.result;
      steps[r.index] = {
        input: lineOf(script.steps[r.index]) as string,
        text: o.text,
        cleared: o.cleared,
        code: o.code,
        cwd: o.cwd,
        cur: o.cur,
        ...note,
      };
    };
    const notes: Record<number, object> = {};
    const settleRunning = async (): Promise<void> => {
      if (running?.done()) {
        const r: Running = running;
        running = null;
        await finish(r, notes[r.index] ?? {});
      }
    };
    for (const [i, step] of script.steps.entries()) {
      const line = lineOf(step);
      if (line !== undefined) {
        if (running)
          throw new Error(
            `${script.name} step ${i}: the input of step ${(running as Running).index} is still waiting`,
          );
        notes[i] =
          typeof step === "object" && "input" in step
            ? {
                reason: step.reason,
                ...(step.replaces !== undefined
                  ? { replaces: step.replaces }
                  : {}),
              }
            : {};
        steps[i] = undefined as unknown as GoldenStep;
        running = await session.begin(i, line, mayWait(script.steps, i));
        // No later step acts on it: it must end by itself.
        if (!acts(script.steps, i)) {
          const r: Running = running;
          running = null;
          await session.wait(r);
          await finish(r, notes[i]);
        } else await settleRunning();
        continue;
      }
      if (typeof step !== "object") continue;
      if ("advanceMs" in step) {
        await session.advance(step.advanceMs);
        steps[i] = { advanceMs: step.advanceMs };
      } else if ("keys" in step) {
        await session.keys(step.keys);
        steps[i] = {
          keys: step.keys,
          ...(step.reason !== undefined ? { reason: step.reason } : {}),
        };
      } else if ("signal" in step) {
        await session.signal(step.signal);
        steps[i] = {
          signal: step.signal,
          ...(step.reason !== undefined ? { reason: step.reason } : {}),
        };
      } else if ("tab" in step) {
        const cursor = step.cursor ?? step.tab.length;
        const r = session.engine.complete(step.tab, cursor);
        steps[i] = {
          tab: step.tab,
          cursor,
          value: r.value,
          newCursor: r.cursor,
          listing: r.listing.length ? r.listing.join("  ") : null,
          ...(step.reason !== undefined ? { reason: step.reason } : {}),
        };
      }
      await settleRunning();
    }
    if (running)
      throw new Error(
        `${script.name}: the input of step ${(running as Running).index} is still waiting at the end`,
      );
    return { script: script.name, steps, save: session.saved() };
  } finally {
    closeSession();
  }
}

/** True under `vitest --update`, which is what `npm run golden:record` runs. */
function recording(): boolean {
  const state = expect.getState() as unknown as {
    snapshotState?: { _updateSnapshot?: string };
  };
  return (
    process.env.RECORD === "1" || state.snapshotState?._updateSnapshot === "all"
  );
}

for (const script of SCRIPTS) {
  // `recording()` reads the snapshot mode, which exists only while a test
  // runs, so the check is here and not at collection time.
  it(`records "${script.name}"`, async (ctx) => {
    if (!recording()) ctx.skip();
    process.env.RECORD = "1";
    const g = await recordGolden(script);
    await expect(JSON.stringify(g, null, 2) + "\n").toMatchFileSnapshot(
      `./golden/${script.name}.json`,
    );
  });
}

// D9 (3): records the golden files from the new engine. It is imported by
// engine.golden.test.ts, which only compares. The recording test registers
// only in record mode: `npm run golden:record` runs vitest with --update, and
// the setup below turns that into RECORD=1 for this file. A re-record keeps
// the `reason` and `replaces` of every step, because they are written on the
// step in src/test/scripts.ts and copied here.
import { expect, it, vi } from "vitest";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { OutLine } from "../engine/output";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";
import type { Golden, GoldenStep } from "./golden";
import { lineOf, SCRIPTS } from "./scripts";
import type { GoldenScript } from "./scripts";

/** Plain text of output lines, with every style removed. */
export const plain = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

/** Runs one golden script on a fresh engine and records every step. */
export function recordGolden(script: GoldenScript): Golden {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  try {
    const engine = createEngine({
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    engine.start();
    const steps: GoldenStep[] = [];
    for (const step of script.steps) {
      const line = lineOf(step);
      if (line !== undefined) {
        const note =
          typeof step === "object" && "input" in step
            ? {
                reason: step.reason,
                ...(step.replaces !== undefined
                  ? { replaces: step.replaces }
                  : {}),
              }
            : {};
        const r = engine.execute(line);
        const s = engine.state;
        steps.push({
          input: line,
          text: plain(r.lines),
          cleared: r.cleared,
          code: s.lastCode,
          cwd: s.cwd,
          cur: s.cur,
          ...note,
        });
      } else if (typeof step === "object" && "advanceMs" in step) {
        clock.advance(step.advanceMs);
        vi.setSystemTime(clock.now());
        steps.push({ advanceMs: step.advanceMs });
      } else if (typeof step === "object" && "tab" in step) {
        const cursor = step.cursor ?? step.tab.length;
        const r = engine.complete(step.tab, cursor);
        steps.push({
          tab: step.tab,
          cursor,
          value: r.value,
          newCursor: r.cursor,
          listing: r.listing.length ? r.listing.join("  ") : null,
        });
      }
    }
    return { script: script.name, steps, save: store.get(SAVE_KEY) ?? null };
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
  it.runIf(recording())(`records "${script.name}"`, async () => {
    process.env.RECORD = "1";
    const g = recordGolden(script);
    await expect(JSON.stringify(g, null, 2) + "\n").toMatchFileSnapshot(
      `./golden/${script.name}.json`,
    );
  });
}

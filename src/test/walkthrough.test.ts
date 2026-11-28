// AC7: the 70-task walkthrough passes on the engine with src/test/solutions.ts
// unchanged, and the final `done` and `cur` equal the run-1 save of the
// end of the walkthrough.
import { afterEach, describe, expect, it } from "vitest";
import { M } from "../engine/index";
import run1End from "./fixtures/run1-saves/walkthrough-end.json";
import { openShell, restore } from "./engineHarness";
import { SOLUTIONS } from "./solutions";

afterEach(restore);

describe("walkthrough (AC7)", () => {
  it("has one solution per task, in task order", () => {
    expect(SOLUTIONS).toHaveLength(M.length);
    expect(SOLUTIONS.map((s) => s.title)).toEqual(M.map((m) => m.title));
    expect(SOLUTIONS.map((s) => s.task)).toEqual(M.map((_, i) => i + 1));
  });

  it("completes all 70 tasks in order", async () => {
    const sh = await openShell();
    for (const sol of SOLUTIONS) {
      for (const cmd of sol.commands) await sh.run(cmd);
      expect(sh.engine.state.done, `task ${sol.task}: ${sol.title}`).toContain(
        sol.task - 1,
      );
    }
    expect(sh.engine.state.done).toHaveLength(70);
    expect(sh.engine.state.cur).toBe(70);
  });

  it("ends with the same done and cur as the run-1 save", async () => {
    const sh = await openShell();
    for (const sol of SOLUTIONS)
      for (const cmd of sol.commands) await sh.run(cmd);
    const s = sh.engine.state;
    expect(s.done).toEqual(run1End.done);
    expect(s.cur).toBe(run1End.cur);
  });
});

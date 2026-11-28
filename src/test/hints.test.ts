// AC6, D12, D22: learner hints. A hint is a game line: it goes to the
// terminal only, after the command ends, only for a command typed at the
// prompt, in the dim color, and never in stdout or stderr.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutLine } from "../engine/output";
import { openShell, restore } from "./engineHarness";
import type { RunResult, Shell } from "./engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const lineText = (l: OutLine) => l.runs.map((r) => r.text).join("");
const dim = (l: OutLine) =>
  l.runs.length > 0 && l.runs.every((r) => (r.style ?? l.style) === "dim");
/** The dim lines of a result: the learner hints and the D19/D21 notes. */
const dimLines = (r: RunResult) => r.lines.filter(dim).map(lineText);
const helpHints = (r: RunResult) => dimLines(r).filter((l) => /help/i.test(l));

/** B16 (a): the hint is sent with the first keyboard read of a prompt command (the terminal shows it). */
const KEYBOARD = (cmd: string): string =>
  `port-penguin: ${cmd} is reading the keyboard. Type input and press Enter; Ctrl-D ends the input, Ctrl-C stops ${cmd}.`;

describe("command not found (AC6)", () => {
  it("prints the bash error and then the hint on its own dim line", async () => {
    const r = await sh.run("foo");
    expect(r.err).toBe("bash: foo: command not found\n");
    expect(r.code).toBe(127);
    const lines = r.lines.map(lineText);
    expect(lines[0]).toBe("bash: foo: command not found");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(helpHints(r).length).toBe(1);
  });

  it("keeps the hint out of stdout and stderr", async () => {
    const r = await sh.run("foo");
    expect(r.out).toBe("");
    expect(r.both).toBe("bash: foo: command not found\n");
  });

  it("prints only the hint when stderr is redirected", async () => {
    const r = await sh.run("foo 2>/dev/null");
    expect(r.both).toBe("");
    expect(r.text).not.toContain("command not found");
    expect(helpHints(r).length).toBe(1);
  });

  it("prints no hint for x=$(foo)", async () => {
    expect(helpHints(await sh.run("x=$(foo)"))).toEqual([]);
  });

  it("prints no hint for a script that runs foo", async () => {
    await sh.run("printf 'foo\\n' > s.sh");
    const r = await sh.run("bash s.sh");
    expect(r.err).toContain("foo: command not found");
    expect(helpHints(r)).toEqual([]);
  });

  it("prints no hint inside a function", async () => {
    expect(helpHints(await sh.run("f() { foo; }; f"))).toEqual([]);
  });
});

describe("keyboard input (B4, B16)", () => {
  it("makes cat wait for the keyboard; with nobody typing it gets end of input, exit 0", async () => {
    const r = await sh.run("cat");
    expect(r.both).toBe("");
    expect(r.code).toBe(0);
    expect(sh.reads.length).toBe(1);
    // The hint is for the terminal only: never in stdout, stderr, or the game lines.
    expect(dimLines(r)).not.toContain(KEYBOARD("cat"));
    expect(sh.reads[0].hint).toBe(KEYBOARD("cat"));
  });

  it("makes read v exit 1 at end of input and send the hint (first time per page load only)", async () => {
    const first = await sh.run("read v");
    expect(first.code).toBe(1);
    expect(sh.reads[0].hint).toBe(KEYBOARD("read"));
    await sh.run("read w");
    expect(sh.reads[1].hint).toBeUndefined();
  });

  it("asks for no keyboard when stdin is a pipe or a file", async () => {
    await sh.run("echo hi > f");
    await sh.run("echo a | cat");
    await sh.run("cat < f");
    await sh.run("cat f");
    expect(sh.reads).toEqual([]);
  });

  it("sends no hint in a script", async () => {
    await sh.run("printf 'cat\\n' > s.sh");
    await sh.run("bash s.sh");
    expect(sh.reads.every((q) => q.hint === undefined)).toBe(true);
  });
});

// AC6, D12, D22: learner hints. A hint is a game line: it goes to the
// terminal only, after the command ends, only for a command typed at the
// prompt, in the dim color, and never in stdout or stderr.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutLine } from "../engine/output";
import { openShell, restore } from "./engineHarness";
import type { RunResult, Shell } from "./engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const lineText = (l: OutLine) => l.runs.map((r) => r.text).join("");
const dim = (l: OutLine) =>
  l.runs.length > 0 && l.runs.every((r) => (r.style ?? l.style) === "dim");
/** The dim lines of a result: the learner hints and the D19/D21 notes. */
const dimLines = (r: RunResult) => r.result.lines.filter(dim).map(lineText);
const helpHints = (r: RunResult) => dimLines(r).filter((l) => /help/i.test(l));

const KEYBOARD =
  "port-penguin: keyboard input comes in a later update; use a pipe or < FILE";

describe("command not found (AC6)", () => {
  it("prints the bash error and then the hint on its own dim line", () => {
    const r = sh.run("foo");
    expect(r.err).toBe("bash: foo: command not found\n");
    expect(r.code).toBe(127);
    const lines = r.result.lines.map(lineText);
    expect(lines[0]).toBe("bash: foo: command not found");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(helpHints(r).length).toBe(1);
  });

  it("keeps the hint out of stdout and stderr", () => {
    const r = sh.run("foo");
    expect(r.out).toBe("");
    expect(r.both).toBe("bash: foo: command not found\n");
  });

  it("prints only the hint when stderr is redirected", () => {
    const r = sh.run("foo 2>/dev/null");
    expect(r.both).toBe("");
    expect(r.text).not.toContain("command not found");
    expect(helpHints(r).length).toBe(1);
  });

  it("prints no hint for x=$(foo)", () => {
    expect(helpHints(sh.run("x=$(foo)"))).toEqual([]);
  });

  it("prints no hint for a script that runs foo", () => {
    sh.run("printf 'foo\\n' > s.sh");
    const r = sh.run("bash s.sh");
    expect(r.err).toContain("foo: command not found");
    expect(helpHints(r)).toEqual([]);
  });

  it("prints no hint inside a function", () => {
    expect(helpHints(sh.run("f() { foo; }; f"))).toEqual([]);
  });
});

describe("keyboard input (D22)", () => {
  it("makes cat with no pipe read an empty stdin, exit 0, and show the hint", () => {
    const r = sh.run("cat");
    expect(r.both).toBe("");
    expect(r.code).toBe(0);
    expect(dimLines(r)).toContain(KEYBOARD);
  });

  it("makes read v exit 1 and show the hint", () => {
    const r = sh.run("read v");
    expect(r.code).toBe(1);
    expect(dimLines(r)).toContain(KEYBOARD);
  });

  it("shows no keyboard hint when stdin is a pipe or a file", () => {
    sh.run("echo hi > f");
    expect(dimLines(sh.run("echo a | cat"))).not.toContain(KEYBOARD);
    expect(dimLines(sh.run("cat < f"))).not.toContain(KEYBOARD);
    expect(dimLines(sh.run("cat f"))).not.toContain(KEYBOARD);
  });

  it("shows no keyboard hint in a script", () => {
    sh.run("printf 'cat\\n' > s.sh");
    expect(dimLines(sh.run("bash s.sh"))).not.toContain(KEYBOARD);
  });
});

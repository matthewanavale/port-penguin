// Risks: players type valid bash that is not simulated. The reply is the real
// bash or coreutils message for an unknown option or command, never a
// JavaScript error. 200 command lines from a fixed list (40 commands times 5
// forms) must not throw and must not show a JavaScript error on screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

const COMMANDS = [
  "ls",
  "cat",
  "echo",
  "grep",
  "find",
  "sed",
  "awk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "head",
  "tail",
  "wc",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "touch",
  "chmod",
  "tar",
  "xargs",
  "date",
  "seq",
  "diff",
  "stat",
  "du",
  "df",
  "env",
  "which",
  "type",
  "printf",
  "read",
  "export",
  "declare",
  "cd",
  "docker",
  "curl",
  "paste",
  "crontab",
];

const FORMS: ((c: string) => string)[] = [
  (c) => c,
  (c) => `${c} --nosuchoption`,
  (c) => `${c} -Z nofile`,
  (c) => `${c} 'unterminated`,
  (c) => `echo in | ${c} "$(echo a b)" {1..3} \${undefined:-x} 2>&1 | head -3`,
];

const LINES = COMMANDS.flatMap((c) => FORMS.map((f) => f(c)));

const JS_ERROR =
  /TypeError|RangeError|ReferenceError|SyntaxError:|Cannot read prop|is not a function|\[object |undefined|NaN|at .*\.ts:\d+/;

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

describe("random command lines", () => {
  it("has 200 lines", () => {
    expect(LINES).toHaveLength(200);
  });

  for (const line of LINES) {
    it(`does not throw or show a JavaScript error: ${line}`, () => {
      let r;
      expect(() => {
        r = sh.run(line);
      }).not.toThrow();
      const got = r as unknown as { text: string; code: number };
      expect(got.text).not.toMatch(JS_ERROR);
      expect(Number.isInteger(got.code)).toBe(true);
    });
  }
});

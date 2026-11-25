// AC3, AC4, Risks: the utilities. Errors, usage messages, and exit codes of
// GNU coreutils 9.4, and behavior that the Ubuntu reference cases do not
// reach. Expected texts were taken from ubuntu:24.04.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

describe("coreutils messages and exit codes", () => {
  const cases: [string, string, number][] = [
    [
      "ls -z",
      "ls: invalid option -- 'z'\nTry 'ls --help' for more information.\n",
      2,
    ],
    [
      "cat --nosuch",
      "cat: unrecognized option '--nosuch'\nTry 'cat --help' for more information.\n",
      1,
    ],
    [
      "sort --bogus",
      "sort: unrecognized option '--bogus'\nTry 'sort --help' for more information.\n",
      2,
    ],
    [
      "cp",
      "cp: missing file operand\nTry 'cp --help' for more information.\n",
      1,
    ],
    [
      "rm nosuchfile",
      "rm: cannot remove 'nosuchfile': No such file or directory\n",
      1,
    ],
    ["mkdir /tmp", "mkdir: cannot create directory ‘/tmp’: File exists\n", 1],
    ["head -n x f", "head: invalid number of lines: ‘x’\n", 1],
    ["wc -l nofile", "wc: nofile: No such file or directory\n", 1],
    ["grep -q x nofile", "grep: nofile: No such file or directory\n", 2],
    ["ls nodir", "ls: cannot access 'nodir': No such file or directory\n", 2],
    ["cat nodir/", "cat: nodir/: No such file or directory\n", 1],
    ["find . -name", "find: missing argument to `-name'\n", 1],
    [
      "cd /nonexistent",
      "bash: cd: /nonexistent: No such file or directory\n",
      1,
    ],
    [
      "echo hi > /nonexistent/f",
      "bash: /nonexistent/f: No such file or directory\n",
      1,
    ],
  ];
  for (const [cmd, err, code] of cases) {
    it(`${cmd} gives the Ubuntu message and code ${code}`, () => {
      const r = sh.run(cmd);
      expect({ err: r.err, code: r.code }).toEqual({ err, code });
    });
  }
});

describe("find", () => {
  beforeEach(() => {
    sh.run("mkdir -p d/sub; touch d/a.txt d/sub/b.txt d/c.md");
  });

  it("combines tests with -o, !, and -exec ... {} +", () => {
    expect(sh.run("find d -name '*.md' -o -name a.txt | sort").out).toBe(
      "d/a.txt\nd/c.md\n",
    );
    expect(sh.run("find d -type f ! -name '*.txt'").out).toBe("d/c.md\n");
    expect(sh.run("find d -name '*.txt' -exec echo {} +").out).toMatch(
      /^d\/(a|sub\/b)\.txt d\/(a|sub\/b)\.txt\n$/,
    );
  });

  it("deletes files and directories depth first", () => {
    expect(sh.run("find d -delete; ls d").err).toContain("No such file");
  });
});

describe("text tools", () => {
  it("runs awk programs with fields, patterns, variables, and arrays", () => {
    expect(
      sh.run(
        "printf 'a 1\nb 2\na 3\n' | awk '{c[$1]+=$2} END{print c[\"a\"], c[\"b\"]}'",
      ).out,
    ).toBe("4 2\n");
    expect(sh.run("echo 'x y z' | awk '{print NF, $NF}'").out).toBe("3 z\n");
    expect(sh.run("awk 'BEGIN{print 1+1}'").out).toBe("2\n");
  });

  it("runs sed with ranges, -n, and in-place edits", () => {
    expect(sh.run("seq 1 5 | sed -n '2,4p'").out).toBe("2\n3\n4\n");
    sh.run("printf 'a\nb\n' > f; sed -i 's/a/X/' f");
    expect(sh.run("cat f").out).toBe("X\nb\n");
  });

  it("runs tr, cut, paste, and tee", () => {
    expect(sh.run("echo hello | tr a-z A-Z").out).toBe("HELLO\n");
    expect(sh.run("echo a:b:c | cut -d: -f2").out).toBe("b\n");
    expect(sh.run("echo hi | tee f; cat f").out).toBe("hi\nhi\n");
  });
});

describe("storage cap (D21)", () => {
  it("fails a write past 5 MB with the Linux message and keeps the old file", () => {
    sh.run("echo keep > f");
    // 1 MB per value (D5), so build several files.
    for (let i = 0; i < 5; i++)
      sh.run(`x=$(printf '%0*d' 1000000 0); echo "$x" > big${i}`);
    const r = sh.run("x=$(printf '%0*d' 1000000 0); echo \"$x\" > big9");
    expect(r.err).toBe("bash: big9: No space left on device\n");
    expect(r.code).toBe(1);
    expect(sh.run("cat f").out).toBe("keep\n");
  });

  it("keeps the old text of an existing file that a write cannot fit (G-COR-3)", () => {
    sh.run("echo keep > f");
    for (let i = 0; i < 5; i++)
      sh.run(`x=$(printf '%0*d' 1000000 0); echo "$x" > big${i}`);
    const r = sh.run("x=$(printf '%0*d' 1000000 0); echo " + '"$x"' + " > f");
    expect(r.err).toBe("bash: f: No space left on device" + "\n");
    expect(r.code).toBe(1);
    expect(sh.run("cat f").out).toBe("keep" + "\n");
  });

  it("reports a write past the cap on an exec redirect (G-COR-4)", () => {
    for (let i = 0; i < 5; i++)
      sh.run(`x=$(printf '%0*d' 1000000 0); echo "$x" > big${i}`);
    const r = sh.run(
      "x=$(printf '%0*d' 1000000 0); exec > live; echo " + '"$x"; exec >&2',
    );
    expect(r.err).toContain("No space left on device");
  });

  it("names the utility in the message when a utility writes", () => {
    for (let i = 0; i < 5; i++)
      sh.run(`x=$(printf '%0*d' 1000000 0); echo "$x" > big${i}`);
    const r = sh.run("cp big0 big8");
    expect(r.err).toContain("cp: ");
    expect(r.err).toContain("No space left on device");
    expect(r.code).toBe(1);
  });
});

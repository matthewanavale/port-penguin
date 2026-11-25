// AC3, D3: expansion order and the rules that the order creates. The order is
// brace, tilde, parameter and variable, arithmetic, command substitution,
// word splitting, filename (glob), quote removal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const out = (cmd: string) => sh.run(cmd).out;

describe("expansion order (D3)", () => {
  it("expands braces before variables", () => {
    expect(out("x=a,b; echo {$x}")).toBe("{a,b}\n");
    expect(out("n=3; echo {1..$n}")).toBe("{1..3}\n");
  });

  it("expands tilde before variables, and not inside quotes", () => {
    expect(out("echo ~/x")).toBe("/home/cadet/x\n");
    expect(out("echo \"~\" '~' a~")).toBe("~ ~ a~\n");
    expect(out("h='~'; echo $h")).toBe("~\n");
  });

  it("splits words after parameter expansion, not before", () => {
    expect(out('x="a b"; set -- $x; echo $#')).toBe("2\n");
    expect(out('x="a b"; set -- "$x"; echo $#')).toBe("1\n");
  });

  it("runs arithmetic and command substitution inside a word", () => {
    expect(out("echo $((1+1))x")).toBe("2x\n");
    expect(out('echo "[$(echo a; echo b)]"')).toBe("[a\nb]\n");
    expect(out("echo $(( $(echo 2) * 3 ))")).toBe("6\n");
  });

  it("strips trailing newlines of a command substitution", () => {
    expect(out("x=$(printf 'a\n\n\n'); echo \"[$x]\"")).toBe("[a]\n");
  });

  it("globs after splitting, so an unquoted pattern in a variable matches", () => {
    sh.run("touch a.txt b.txt");
    expect(out("p='*.txt'; echo $p")).toBe("a.txt b.txt\n");
    expect(out("p='*.txt'; echo \"$p\"")).toBe("*.txt\n");
  });

  it("removes quotes last", () => {
    expect(out("echo \"a\"'b'c")).toBe("abc\n");
    expect(out("echo \"a  b\" 'c  d'")).toBe("a  b c  d\n");
  });

  it("does not expand the result of an expansion again", () => {
    expect(out("x='$HOME'; echo $x")).toBe("$HOME\n");
    expect(out("x='{a,b}'; echo $x")).toBe("{a,b}\n");
  });
});

describe("empty and unset values", () => {
  it("drops an unquoted empty expansion and keeps a quoted one", () => {
    expect(out("set -- $unset; echo $#")).toBe("0\n");
    expect(out('set -- "$unset"; echo $#')).toBe("1\n");
    expect(out("echo a $unset b")).toBe("a b\n");
  });

  it('gives no words for "$@" with no parameters', () => {
    expect(out('set --; set -- "$@"; echo $#')).toBe("0\n");
  });
});

describe("word splitting with IFS", () => {
  it("splits on white space by default and on a custom IFS", () => {
    expect(out('x=" a  b "; set -- $x; echo $#')).toBe("2\n");
    expect(out("IFS=:; x=a:b::c; set -- $x; echo $#")).toBe("4\n");
  });

  it("keeps the value whole when IFS is empty", () => {
    expect(out('IFS=; x="a b"; set -- $x; echo $#')).toBe("1\n");
  });
});

describe("globs", () => {
  beforeEach(() => {
    sh.run("touch a1 a2 b1 .h");
  });

  it("matches in sorted order and skips dot files", () => {
    expect(out("echo *")).toBe("a1 a2 b1\n");
  });

  it("keeps the pattern when nothing matches, unless nullglob is set", () => {
    expect(out("echo z*")).toBe("z*\n");
    expect(out("shopt -s nullglob; echo z*; echo end")).toBe("\nend\n");
  });

  it("does not glob inside quotes", () => {
    expect(out("echo \"*\" '?'")).toBe("* ?\n");
  });

  it("supports extended globs only after shopt -s extglob", () => {
    sh.run("shopt -s extglob");
    expect(out("echo !(a*)")).toBe("b1\n");
    // One line cannot enable and use it: bash parses the whole line first.
    sh.run("shopt -u extglob");
    expect(sh.run("shopt -s extglob; echo !(a*)").code).toBe(2);
  });
});

describe("parameter forms", () => {
  it("applies the default, assign, error, and alternative forms", () => {
    expect(out("echo ${u:-d} ${u-d} ${u:+alt}[]")).toBe("d d []\n");
    expect(out("echo ${u:=d}; echo $u")).toBe("d\nd\n");
    const r = sh.run("echo ${v:?missing}");
    expect(r.err).toContain("v: missing");
    expect(r.code).toBe(1);
  });

  it("cuts and replaces", () => {
    expect(out("p=/a/b.tar.gz; echo ${p##*/} ${p%%.*} ${p#*/} ${p%.*}")).toBe(
      "b.tar.gz /a/b a/b.tar.gz /a/b.tar\n",
    );
    expect(out("s=aXbX; echo ${s/X/-} ${s//X/-}")).toBe("a-bX a-b-\n");
  });

  it("slices and changes case", () => {
    expect(out("s=abcdef; echo ${s:1:3} ${s: -2} ${s^^} ${s^}")).toBe(
      "bcd ef ABCDEF Abcdef\n",
    );
  });
});

describe("arithmetic", () => {
  it("follows C precedence and integer division", () => {
    expect(
      out("echo $((2+3*4)) $((7/2)) $((-7/2)) $((2**3**2)) $((1<<3|1))"),
    ).toBe("14 3 -3 512 9\n");
  });

  it("reports division by zero", () => {
    const r = sh.run("echo $((1/0))");
    expect(r.err).toContain("division by 0");
    expect(r.code).toBe(1);
  });
});

// AC3, D3: expansion order and the rules that the order creates. The order is
// brace, tilde, parameter and variable, arithmetic, command substitution,
// word splitting, filename (glob), quote removal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const out = async (cmd: string) => (await sh.run(cmd)).out;

describe("expansion order (D3)", () => {
  it("expands braces before variables", async () => {
    expect(await out("x=a,b; echo {$x}")).toBe("{a,b}\n");
    expect(await out("n=3; echo {1..$n}")).toBe("{1..3}\n");
  });

  it("expands tilde before variables, and not inside quotes", async () => {
    expect(await out("echo ~/x")).toBe("/home/cadet/x\n");
    expect(await out("echo \"~\" '~' a~")).toBe("~ ~ a~\n");
    expect(await out("h='~'; echo $h")).toBe("~\n");
  });

  it("splits words after parameter expansion, not before", async () => {
    expect(await out('x="a b"; set -- $x; echo $#')).toBe("2\n");
    expect(await out('x="a b"; set -- "$x"; echo $#')).toBe("1\n");
  });

  it("runs arithmetic and command substitution inside a word", async () => {
    expect(await out("echo $((1+1))x")).toBe("2x\n");
    expect(await out('echo "[$(echo a; echo b)]"')).toBe("[a\nb]\n");
    expect(await out("echo $(( $(echo 2) * 3 ))")).toBe("6\n");
  });

  it("strips trailing newlines of a command substitution", async () => {
    expect(await out("x=$(printf 'a\n\n\n'); echo \"[$x]\"")).toBe("[a]\n");
  });

  it("globs after splitting, so an unquoted pattern in a variable matches", async () => {
    await sh.run("touch a.txt b.txt");
    expect(await out("p='*.txt'; echo $p")).toBe("a.txt b.txt\n");
    expect(await out("p='*.txt'; echo \"$p\"")).toBe("*.txt\n");
  });

  it("removes quotes last", async () => {
    expect(await out("echo \"a\"'b'c")).toBe("abc\n");
    expect(await out("echo \"a  b\" 'c  d'")).toBe("a  b c  d\n");
  });

  it("does not expand the result of an expansion again", async () => {
    expect(await out("x='$HOME'; echo $x")).toBe("$HOME\n");
    expect(await out("x='{a,b}'; echo $x")).toBe("{a,b}\n");
  });
});

describe("empty and unset values", () => {
  it("drops an unquoted empty expansion and keeps a quoted one", async () => {
    expect(await out("set -- $unset; echo $#")).toBe("0\n");
    expect(await out('set -- "$unset"; echo $#')).toBe("1\n");
    expect(await out("echo a $unset b")).toBe("a b\n");
  });

  it('gives no words for "$@" with no parameters', async () => {
    expect(await out('set --; set -- "$@"; echo $#')).toBe("0\n");
  });
});

describe("word splitting with IFS", () => {
  it("splits on white space by default and on a custom IFS", async () => {
    expect(await out('x=" a  b "; set -- $x; echo $#')).toBe("2\n");
    expect(await out("IFS=:; x=a:b::c; set -- $x; echo $#")).toBe("4\n");
  });

  it("keeps the value whole when IFS is empty", async () => {
    expect(await out('IFS=; x="a b"; set -- $x; echo $#')).toBe("1\n");
  });
});

describe("globs", () => {
  beforeEach(async () => {
    await sh.run("touch a1 a2 b1 .h");
  });

  it("matches in sorted order and skips dot files", async () => {
    expect(await out("echo *")).toBe("a1 a2 b1\n");
  });

  it("keeps the pattern when nothing matches, unless nullglob is set", async () => {
    expect(await out("echo z*")).toBe("z*\n");
    expect(await out("shopt -s nullglob; echo z*; echo end")).toBe("\nend\n");
  });

  it("does not glob inside quotes", async () => {
    expect(await out("echo \"*\" '?'")).toBe("* ?\n");
  });

  it("supports extended globs only after shopt -s extglob", async () => {
    await sh.run("shopt -s extglob");
    expect(await out("echo !(a*)")).toBe("b1\n");
    // One line cannot enable and use it: bash parses the whole line first.
    await sh.run("shopt -u extglob");
    expect((await sh.run("shopt -s extglob; echo !(a*)")).code).toBe(2);
  });
});

describe("parameter forms", () => {
  it("applies the default, assign, error, and alternative forms", async () => {
    expect(await out("echo ${u:-d} ${u-d} ${u:+alt}[]")).toBe("d d []\n");
    expect(await out("echo ${u:=d}; echo $u")).toBe("d\nd\n");
    const r = await sh.run("echo ${v:?missing}");
    expect(r.err).toContain("v: missing");
    expect(r.code).toBe(1);
  });

  it("cuts and replaces", async () => {
    expect(
      await out("p=/a/b.tar.gz; echo ${p##*/} ${p%%.*} ${p#*/} ${p%.*}"),
    ).toBe("b.tar.gz /a/b a/b.tar.gz /a/b.tar\n");
    expect(await out("s=aXbX; echo ${s/X/-} ${s//X/-}")).toBe("a-bX a-b-\n");
  });

  it("slices and changes case", async () => {
    expect(await out("s=abcdef; echo ${s:1:3} ${s: -2} ${s^^} ${s^}")).toBe(
      "bcd ef ABCDEF Abcdef\n",
    );
  });
});

describe("arithmetic", () => {
  it("follows C precedence and integer division", async () => {
    expect(
      await out("echo $((2+3*4)) $((7/2)) $((-7/2)) $((2**3**2)) $((1<<3|1))"),
    ).toBe("14 3 -3 512 9\n");
  });

  it("reports division by zero", async () => {
    const r = await sh.run("echo $((1/0))");
    expect(r.err).toContain("division by 0");
    expect(r.code).toBe(1);
  });
});

describe("pattern replacement (G-COR-5, G-COR-6)", () => {
  it("turns an unquoted & into the matched text, as bash 5.2 does", async () => {
    expect(await out("v=abc; echo ${v/b/[&]}")).toBe("a[b]c" + "\n");
    expect(await out("v=abc; echo ${v/b*/<&>}")).toBe("a<bc>" + "\n");
    expect(await out("v=aXbX; echo ${v//X/&&}")).toBe("aXXbXX" + "\n");
    expect(await out("v=abc; echo ${v/#a/&-}")).toBe("a-bc" + "\n");
    expect(await out("v=abc; echo ${v/%c/-&}")).toBe("ab-c" + "\n");
  });

  it("keeps a quoted or escaped & literal", async () => {
    expect(await out("v=abc; echo ${v/b/'[&]'}")).toBe("a[&]c" + "\n");
    expect(await out('v=abc; echo ${v/b/"[&]"}')).toBe("a[&]c" + "\n");
    expect(await out("v=abc; echo ${v/b/[\\&]}")).toBe("a[&]c" + "\n");
  });

  it("stops a glob replace over a huge string at the step limit", async () => {
    const r = await sh.run(
      "x=$(printf '%0*d' 1000 0); y=${x//0*1/b}; echo done",
    );
    expect(r.text).toMatch(/port-penguin: stopped: .+ steps/);
    expect(r.code).toBe(130);
  });
});

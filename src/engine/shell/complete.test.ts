// Scope: Tab completion that understands the new syntax. A command name is
// completed after |, ||, &&, ;, (, {, $(, a backtick, and the keywords then,
// do, and else. A variable name is completed after $.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
});
afterEach(restore);

const tab = (value: string) => sh.engine.complete(value, value.length);

describe("command names in new positions", () => {
  const prefixes = [
    "echo hi | ",
    "false || ",
    "true && ",
    "echo a; ",
    "( ",
    "{ ",
    "echo $(",
    "echo `",
    "if true; then ",
    "for i in 1; do ",
    "if false; then :; else ",
  ];
  for (const p of prefixes) {
    it(`completes pw to pwd after ${JSON.stringify(p)}`, () => {
      const r = tab(p + "pw");
      expect(r.value.startsWith(p + "pwd")).toBe(true);
      expect(r.listing).toEqual([]);
    });
  }

  it("lists the candidates when several match", () => {
    const r = tab("echo a | hist");
    expect(r.value.startsWith("echo a | history")).toBe(true);
    const many = tab("true && ch");
    expect(many.listing.length).toBeGreaterThan(1);
    expect(many.listing).toContain("chmod");
  });

  it("still completes a file name in an argument position", () => {
    const r = tab("cat | cat welc");
    expect(r.value).toBe("cat | cat welcome.txt ");
  });
});

describe("variable names after $", () => {
  it("completes an exported or shell variable", () => {
    sh.run("export FOOBAR=1");
    const r = tab("echo $FOOB");
    expect(r.value.startsWith("echo $FOOBAR")).toBe(true);
  });

  it("completes after ${ and inside double quotes", () => {
    sh.run("MYVAR_X=1");
    expect(tab("echo ${MYVAR").value.startsWith("echo ${MYVAR_X")).toBe(true);
    expect(tab('echo "$MYVAR').value.startsWith('echo "$MYVAR_X')).toBe(true);
  });

  it("lists variables that share the prefix", () => {
    sh.run("AAA1=1; AAA2=2");
    const r = tab("echo $AAA");
    expect(r.listing).toEqual(expect.arrayContaining(["AAA1", "AAA2"]));
  });
});

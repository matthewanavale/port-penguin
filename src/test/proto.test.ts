// G-SEC-2: names that the player types are plain keys. They never reach
// Object.prototype and never hit an inherited member.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

let sh: Shell;
let before: string[];
beforeEach(() => {
  before = Object.getOwnPropertyNames(Object.prototype).sort();
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const protoKeys = () => Object.getOwnPropertyNames(Object.prototype).sort();

describe("prototype names", () => {
  it("makes readonly __proto__ a plain variable", () => {
    sh.run("readonly __proto__");
    sh.run("readonly __proto__=1; declare -r __proto__; export __proto__");
    expect(protoKeys()).toEqual(before);
    expect(({} as Record<string, unknown>).attrs).toBeUndefined();
    expect(sh.run("echo ok").out).toBe("ok\n");
  });

  it("makes declare -i/-l/-u __proto__ plain", () => {
    sh.run("declare -i __proto__; declare -l __proto__; declare -u __proto__");
    expect(protoKeys()).toEqual(before);
    expect(({} as Record<string, unknown>).attrs).toBeUndefined();
  });

  it("keeps other variables unset-able after a reload", () => {
    sh.run("readonly __proto__=1; v=1");
    const again = openShell({ saved: sh.store.get(SAVE_KEY) as string });
    expect(again.run("unset v; echo [$v]").out).toBe("[]\n");
    expect(again.run("unset v").err).toBe("");
  });

  it("expands $constructor and $toString as empty", () => {
    const r = sh.run(
      "echo [$constructor][$toString][$__proto__][$hasOwnProperty]",
    );
    expect(r.out).toBe("[][][][]\n");
    expect(r.text).not.toMatch(/TypeError|undefined/);
  });

  it("accepts alias constructor and toString", () => {
    const r = sh.run(
      "alias constructor='echo c'; alias toString='echo t'; constructor; toString",
    );
    expect(r.out).toBe("c\nt\n");
    expect(r.text).not.toMatch(/TypeError/);
  });

  it("reports an unknown alias, function and command named like Object members", () => {
    for (const n of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      const r = sh.run(n);
      expect(r.err, n).toBe(`bash: ${n}: command not found\n`);
      expect(r.code, n).toBe(127);
      expect(sh.run(`type ${n}`).code, n).toBe(1);
      expect(sh.run(`unalias ${n}`).err, n).toContain("not found");
    }
  });

  it("stores associative keys named __proto__ and constructor", () => {
    const r = sh.run(
      "declare -A m; m[__proto__]=a; m[constructor]=b; echo ${m[__proto__]} ${m[constructor]} ${#m[@]}",
    );
    expect(r.out).toBe("a b 2\n");
    expect(protoKeys()).toEqual(before);
  });

  it("unpacks a tar member named __proto__ as a file", () => {
    sh.run("mkdir d; echo hi > d/__proto__; echo yo > d/constructor");
    sh.run("tar -cf a.tar d; rm -r d; tar -xf a.tar");
    expect(sh.run("cat d/__proto__").out).toBe("hi\n");
    expect(sh.run("ls d").out).toContain("constructor");
    expect(protoKeys()).toEqual(before);
  });

  it("does not find a file named like an Object member", () => {
    expect(sh.run("ls constructor").code).toBe(2);
    expect(sh.run("cat toString").err).toBe(
      "cat: toString: No such file or directory\n",
    );
    expect(sh.run("cd __proto__").code).toBe(1);
  });

  it("does not find a file in a saved game either", () => {
    const again = openShell({ saved: sh.store.get(SAVE_KEY) as string });
    expect(again.run("ls constructor").code).toBe(2);
    expect(again.run("cd __proto__").code).toBe(1);
  });
});

// G-SEC-2: names that the player types are plain keys. They never reach
// Object.prototype and never hit an inherited member.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

let sh: Shell;
let before: string[];
beforeEach(async () => {
  before = Object.getOwnPropertyNames(Object.prototype).sort();
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const protoKeys = () => Object.getOwnPropertyNames(Object.prototype).sort();

describe("prototype names", () => {
  it("makes readonly __proto__ a plain variable", async () => {
    await sh.run("readonly __proto__");
    await sh.run(
      "readonly __proto__=1; declare -r __proto__; export __proto__",
    );
    expect(protoKeys()).toEqual(before);
    expect(({} as Record<string, unknown>).attrs).toBeUndefined();
    expect((await sh.run("echo ok")).out).toBe("ok\n");
  });

  it("makes declare -i/-l/-u __proto__ plain", async () => {
    await sh.run(
      "declare -i __proto__; declare -l __proto__; declare -u __proto__",
    );
    expect(protoKeys()).toEqual(before);
    expect(({} as Record<string, unknown>).attrs).toBeUndefined();
  });

  it("keeps other variables unset-able after a reload", async () => {
    await sh.run("readonly __proto__=1; v=1");
    const again = await openShell({ saved: sh.store.get(SAVE_KEY) as string });
    expect((await again.run("unset v; echo [$v]")).out).toBe("[]\n");
    expect((await again.run("unset v")).err).toBe("");
  });

  it("expands $constructor and $toString as empty", async () => {
    const r = await sh.run(
      "echo [$constructor][$toString][$__proto__][$hasOwnProperty]",
    );
    expect(r.out).toBe("[][][][]\n");
    expect(r.text).not.toMatch(/TypeError|undefined/);
  });

  it("accepts alias constructor and toString", async () => {
    const r = await sh.run(
      "alias constructor='echo c'; alias toString='echo t'; constructor; toString",
    );
    expect(r.out).toBe("c\nt\n");
    expect(r.text).not.toMatch(/TypeError/);
  });

  it("reports an unknown alias, function and command named like Object members", async () => {
    for (const n of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      const r = await sh.run(n);
      expect(r.err, n).toBe(`bash: ${n}: command not found\n`);
      expect(r.code, n).toBe(127);
      expect((await sh.run(`type ${n}`)).code, n).toBe(1);
      expect((await sh.run(`unalias ${n}`)).err, n).toContain("not found");
    }
  });

  it("stores associative keys named __proto__ and constructor", async () => {
    const r = await sh.run(
      "declare -A m; m[__proto__]=a; m[constructor]=b; echo ${m[__proto__]} ${m[constructor]} ${#m[@]}",
    );
    expect(r.out).toBe("a b 2\n");
    expect(protoKeys()).toEqual(before);
  });

  it("unpacks a tar member named __proto__ as a file", async () => {
    await sh.run("mkdir d; echo hi > d/__proto__; echo yo > d/constructor");
    await sh.run("tar -cf a.tar d; rm -r d; tar -xf a.tar");
    expect((await sh.run("cat d/__proto__")).out).toBe("hi\n");
    expect((await sh.run("ls d")).out).toContain("constructor");
    expect(protoKeys()).toEqual(before);
  });

  it("does not find a file named like an Object member", async () => {
    expect((await sh.run("ls constructor")).code).toBe(2);
    expect((await sh.run("cat toString")).err).toBe(
      "cat: toString: No such file or directory\n",
    );
    expect((await sh.run("cd __proto__")).code).toBe(1);
  });

  it("does not find a file in a saved game either", async () => {
    const again = await openShell({ saved: sh.store.get(SAVE_KEY) as string });
    expect((await again.run("ls constructor")).code).toBe(2);
    expect((await again.run("cd __proto__")).code).toBe(1);
  });
});

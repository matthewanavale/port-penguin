// Phase D: the engine around the interpreter. `type bash`, `clear`, `exit` at
// the prompt, HISTCONTROL, the terminal width, and the prompt shell state.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

describe("type bash and type sh", () => {
  it("print the program path, as Ubuntu does", async () => {
    expect((await sh.run("type bash")).out).toBe("bash is /usr/bin/bash\n");
    expect((await sh.run("type sh")).out).toBe("sh is /usr/bin/sh\n");
    expect((await sh.run("type -t bash")).out).toBe("file\n");
  });

  it("still runs bash and sh", async () => {
    expect((await sh.run("bash -c 'echo ok'")).out).toBe("ok\n");
    expect((await sh.run("sh -c 'echo ok'")).out).toBe("ok\n");
  });
});

describe("m[x y]=v", () => {
  it("is one assignment", async () => {
    const r = await sh.run('declare -A m; m[x y]=sp; echo "${m[x y]}"');
    expect(r.out).toBe("sp\n");
    expect(r.code).toBe(0);
  });

  it("is two words in an argument, as in bash", async () => {
    const r = await sh.run("printf '%s\\n' m[a b]=c");
    expect(r.out).toBe("m[a\nb]=c\n");
    expect(r.code).toBe(0);
  });
});

describe("clear", () => {
  it("sends a clear event and keeps only the output after it", async () => {
    const r = await sh.run("echo before; clear; echo after");
    expect(r.cleared).toBe(true);
    expect(r.text).toBe("after");
    expect((await sh.run("echo next")).cleared).toBe(false);
  });
});

describe("exit at the prompt (D16)", () => {
  it("prints exit, goes home, and keeps only exported variables", async () => {
    await sh.run(
      "export KEEP=1; LOSE=2; alias zz='echo zz'; f() { :; }; cd /tmp/w",
    );
    const r = await sh.run("exit 3");
    expect(r.err).toBe("exit\n");
    expect(sh.engine.state.cwd).toBe("/home/cadet");
    expect((await sh.run('echo "[$KEEP][$LOSE]"')).out).toBe("[1][]\n");
    expect((await sh.run("type zz")).code).not.toBe(0);
    expect((await sh.run("type f")).code).not.toBe(0);
    // ~/.bashrc ran again: the skel aliases are back.
    expect((await sh.run("type ll")).out).toContain("aliased");
  });
});

describe("history (HISTCONTROL=ignoreboth from ~/.bashrc)", () => {
  it("skips a line that starts with a space and a repeat of the last line", async () => {
    await sh.run("echo a");
    await sh.run(" echo hidden");
    await sh.run("echo a");
    await sh.run("echo b");
    await sh.run("echo a");
    const hist = sh.engine.state.hist;
    expect(hist.filter((h) => h === "echo a")).toHaveLength(2);
    expect(hist).not.toContain(" echo hidden");
    expect(hist).not.toContain("echo hidden");
  });
});

describe("terminal width (D23)", () => {
  it("uses 80 columns until the terminal passes its width", async () => {
    expect((await sh.run("echo $COLUMNS")).out).toBe("80\n");
    sh.engine.setColumns(40);
    expect((await sh.run("echo $COLUMNS")).out).toBe("40\n");
    sh.engine.setColumns(80);
  });
});

describe("incomplete input", () => {
  it("execute runs nothing and the prompt becomes > ", async () => {
    const text = (): string =>
      sh.engine
        .prompt()
        .map((r) => r.text)
        .join("");
    expect(sh.engine.isComplete("if true; then")).toBe(false);
    expect(text()).toBe("> ");
    const r = await sh.engine.execute("if true; then");
    expect(r.chunks).toEqual([]);
    expect(sh.engine.state.hist.at(-1)).not.toBe("if true; then");
    sh.engine.cancelInput();
    expect(text()).toContain("cadet@");
    expect(sh.engine.state.lastCode).toBe(130);
  });
});

describe("prompt shell state in the save", () => {
  it("keeps cwd, exported names, functions, aliases, and arrays across a reload", async () => {
    await sh.run(
      "export E1=1; a=(1 2 3); f() { echo fn; }; alias zz='echo zz'",
    );
    const saved = sh.store.get(SAVE_KEY) as string;
    const again = await openShell({ saved });
    expect(again.engine.state.cwd).toBe("/tmp/w");
    expect((await again.run("echo $E1 ${a[1]}; f; zz")).out).toBe(
      "1 2\nfn\nzz\n",
    );
    expect((await again.run("env | grep -c '^E1='")).out).toBe("1\n");
  });

  it("does not save the variables that ~/.bashrc sets", () => {
    const env = (
      JSON.parse(sh.store.get(SAVE_KEY) as string) as {
        env: Record<string, string>;
      }
    ).env;
    expect(env.LS_COLORS).toBeUndefined();
    expect(env.HISTCONTROL).toBeUndefined();
  });
});

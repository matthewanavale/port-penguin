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

describe("nested interactive shell (B14, AC8)", () => {
  it("starts a child shell at once: execute resolves and busy stays false", async () => {
    const r = await sh.run("bash");
    expect(r.code).toBe(0);
    expect(r.both).toBe("");
    expect(sh.engine.busy()).toBe(false);
    expect((await sh.run("echo $SHLVL")).out).toBe("2\n");
  });

  it("starts the child for sh and for options such as --norc", async () => {
    await sh.run("sh");
    expect((await sh.run("echo $SHLVL")).out).toBe("2\n");
    await sh.run("bash --norc");
    expect((await sh.run("echo $SHLVL")).out).toBe("3\n");
    await sh.run("exit");
    await sh.run("exit");
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
  });

  it("gives the child only the exported variables, and SHLVL plus 1", async () => {
    await sh.run("export KEEP=1; LOSE=2; alias zz='echo zz'; f() { :; }");
    await sh.run("bash");
    expect((await sh.run('echo "[$KEEP][$LOSE][$SHLVL]"')).out).toBe(
      "[1][][2]\n",
    );
    expect((await sh.run("type f")).code).not.toBe(0);
    expect((await sh.run("env | grep -c '^SHLVL=2$'")).out).toBe("1\n");
    expect((await sh.run("echo $?")).out).toBe("0\n");
  });

  it("runs ~/.bashrc in the child, and not with --norc", async () => {
    await sh.run("bash");
    expect((await sh.run("type ll")).out).toContain("aliased");
    await sh.run("exit");
    await sh.run("bash --norc");
    expect((await sh.run("type ll")).code).not.toBe(0);
  });

  it("exit N returns to the parent with $? N and restores its state", async () => {
    await sh.run("P=parent; cd /tmp/w");
    await sh.run("bash");
    await sh.run("cd /tmp; X=1; P=child; export Y=2");
    expect(sh.engine.state.cwd).toBe("/tmp");
    const r = await sh.run("exit 3");
    expect(r.err).toBe("exit\n");
    expect(sh.engine.state.lastCode).toBe(3);
    expect(sh.engine.state.cwd).toBe("/tmp/w");
    expect((await sh.run('echo "[$P][$X][$Y]"')).out).toBe("[parent][][]\n");
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
  });

  it("saves the child's values while it is active, and a reload brings back the top shell", async () => {
    await sh.run("bash");
    await sh.run("cd /tmp; export Z=9");
    const saved = sh.store.get(SAVE_KEY) as string;
    const again = await openShell({ saved });
    expect(again.engine.state.cwd).toBe("/tmp");
    expect((await again.run("echo $Z")).out).toBe("9\n");
    // Only the top shell comes back: one exit leaves the game shell (D16).
    await again.run("exit");
    expect(again.engine.state.cwd).toBe("/home/cadet");
  });

  it("checks tasks on a command typed in the child, and once per input", async () => {
    const start = sh.engine.state.cur;
    await sh.run("bash");
    expect(sh.engine.state.cur).toBe(start);
    const r = await sh.run("pwd");
    expect(r.out).toBe("/tmp/w\n");
    expect(sh.engine.state.hist.at(-1)).toBe("pwd");
  });

  it("keeps > for an incomplete input in the child, and the same prompt text", async () => {
    await sh.run("bash");
    expect(sh.engine.isComplete("if true; then")).toBe(false);
    expect(sh.engine.prompt().map((x) => x.text)).toEqual(["> "]);
    sh.engine.cancelInput();
    expect(
      sh.engine
        .prompt()
        .map((x) => x.text)
        .join(""),
    ).toContain("cadet@");
  });

  it("stops the 65th nested bash with the D6 nesting message", async () => {
    for (let i = 0; i < 64; i++) {
      const r = await sh.run("bash --norc");
      expect(r.code).toBe(0);
    }
    const r = await sh.run("bash --norc");
    expect(r.text).toContain("nesting too deep (64)");
    expect((await sh.run("echo $SHLVL")).out).toBe("65\n");
    for (let i = 0; i < 64; i++) await sh.run("exit");
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
  });

  it("reads a pipe or a file as a script", async () => {
    expect((await sh.run("echo 'echo hi' | bash")).out).toBe("hi\n");
    await sh.run("echo 'echo from file' > s.txt");
    expect((await sh.run("bash < s.txt")).out).toBe("from file\n");
    expect(sh.engine.busy()).toBe(false);
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
  });

  it("prints the B14 message and returns 1 where bash must run as a whole command", async () => {
    const msg =
      "port-penguin: an interactive bash runs only as a whole command; type bash on its own line\n";
    const a = await sh.run("bash; echo after");
    expect(a.err).toBe(msg);
    expect(a.out).toBe("after\n");
    const b = await sh.run("f() { bash; }; f; echo $?");
    expect(b.err).toBe(msg);
    expect(b.out).toBe("1\n");
    const c = await sh.run("bash | cat");
    expect(c.err).toBe(msg);
    expect(c.code).toBe(0);
    const d = await sh.run("bash &");
    expect(d.err).toContain("[1]");
    const e = await sh.run("(bash)");
    expect(e.err).toBe(msg);
    const f = await sh.run("bash\nbash");
    expect(f.err).toBe(msg + msg);
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
  });

  it("ends the jobs of the child at exit, and keeps the parent's jobs", async () => {
    await sh.run("sleep 50 &");
    await sh.run("bash");
    await sh.run("sleep 60 &");
    expect((await sh.run("jobs")).out).toMatch(
      /^\[1\]\+ {2}Running +sleep 60 &\n$/,
    );
    await sh.run("exit");
    const j = (await sh.run("jobs")).out;
    expect(j).toMatch(/^\[1\]\+ {2}Running +sleep 50 &\n$/);
    expect((await sh.run("ps")).out).not.toContain("sleep 60");
  });

  it("a panel action closes every nested shell and drops the snapshots (AC10)", async () => {
    await sh.run("P=top; export E=1");
    await sh.run("bash");
    await sh.run("cd /tmp");
    await sh.engine.reset();
    expect(sh.engine.state.cwd).toBe("/home/cadet");
    expect((await sh.run("echo $SHLVL")).out).toBe("1\n");
    // A later exit goes through D16, not through an old snapshot.
    await sh.run("export K=1; cd /tmp");
    await sh.run("exit");
    expect(sh.engine.state.cwd).toBe("/home/cadet");
    expect((await sh.run("echo [$K][$P]")).out).toBe("[1][]\n");
  });

  it("skip keeps the child's current values and closes the nested shell", async () => {
    await sh.run("bash");
    await sh.run("cd /tmp");
    await sh.engine.skip();
    expect(sh.engine.state.cwd).toBe("/tmp");
    await sh.run("exit");
    // No snapshot is left: the exit is the D16 exit of the top shell.
    expect(sh.engine.state.cwd).toBe("/home/cadet");
  });
});

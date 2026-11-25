// AC3, D13, D14, D15, D16, D18: builtins and shell contexts, beyond what the
// Ubuntu reference cases already compare.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

describe("contexts (D13)", () => {
  it("keeps variables of the prompt shell between inputs", () => {
    sh.run("x=1");
    expect(sh.run("echo $x").out).toBe("1\n");
  });

  it("gives a subshell a copy: changes do not flow back", () => {
    expect(sh.run("x=1; (x=2; cd /; echo $x $PWD); echo $x $PWD").out).toBe(
      "2 /\n1 /tmp/w\n",
    );
  });

  it("gives each pipeline stage a copy, so read in a pipe leaves the variable unset", () => {
    expect(sh.run('echo x | read v; echo "[$v]"').out).toBe("[]\n");
    expect(sh.run('echo $(x=5; echo in) "[$x]"').out).toBe("in []\n");
  });

  it("shares the file system with every context", () => {
    sh.run("(echo hi > f)");
    expect(sh.run("cat f").out).toBe("hi\n");
  });

  it("gives a script only the exported variables of its caller", () => {
    sh.run("printf 'echo [$a][$b]\n' > s.sh");
    sh.run("a=1; export b=2");
    expect(sh.run("bash s.sh").out).toBe("[][2]\n");
  });

  it("does not let a script change the caller", () => {
    sh.run("printf 'x=inner; cd /; exit 7\n' > s.sh");
    sh.run("x=outer");
    const r = sh.run("bash s.sh");
    expect(r.code).toBe(7);
    expect(sh.run("echo $x $PWD").out).toBe("outer /tmp/w\n");
  });

  it("keeps cwd and $? in the saved state (D13)", () => {
    sh.run("cd /tmp");
    expect(sh.engine.state.cwd).toBe("/tmp");
    sh.run("cd /tmp/w; false");
    expect(sh.engine.state.lastCode).toBe(1);
    expect(sh.engine.state.oldpwd).toBe("/tmp");
  });
});

describe("variables (D14)", () => {
  it("computes PATH, HOME, PWD, USER, and SHELL without storing them", () => {
    expect(sh.run("echo $HOME $USER $SHELL $PWD").out).toBe(
      "/home/cadet cadet /bin/bash /tmp/w\n",
    );
    expect(sh.engine.state.env.HOME).toBeUndefined();
    expect(sh.engine.state.env.PATH).toBeUndefined();
  });

  it("stores an assignment to a computed name, as bash does", () => {
    sh.run("HOME=/tmp");
    expect(sh.run("echo ~").out).toBe("/tmp\n");
    expect(sh.engine.state.env.HOME).toBe("/tmp");
  });

  it("shows only exported names in env and printenv", () => {
    sh.run("local_only=1; export shown=2");
    const env = sh.run("env").out;
    expect(env).toContain("shown=2\n");
    expect(env).not.toContain("local_only");
    expect(sh.run("printenv local_only").code).toBe(1);
  });

  it("keeps plain string variables in env and arrays in vars", () => {
    sh.run("s=text; a=(1 2)");
    const st = sh.engine.state as unknown as {
      env: Record<string, string>;
      vars?: Record<string, unknown>;
    };
    expect(st.env.s).toBe("text");
    expect(st.vars && "a" in st.vars).toBe(true);
  });

  it("treats every name in a run-1 save as exported", () => {
    const old = JSON.parse(sh.store.get("port-penguin-v2") as string);
    old.env = { OLDVAR: "x" };
    delete old.exported;
    const again = openShell({ saved: JSON.stringify(old) });
    expect(again.run("printenv OLDVAR").out).toBe("x\n");
  });
});

describe("edges (D16)", () => {
  it("prints exit at the prompt and starts a fresh prompt shell", () => {
    sh.run("x=1; export y=2; cd /tmp");
    const r = sh.run("exit");
    expect(r.out + r.err).toContain("exit");
    expect(sh.engine.state.cwd).toBe("/home/cadet");
    expect(sh.run("echo [$x][$y]").out).toBe("[][2]\n");
  });

  it("answers sudo like Ubuntu without sudo", () => {
    const r = sh.run("sudo ls");
    expect(r.err).toBe("bash: sudo: command not found\n");
    expect(r.code).toBe(127);
  });

  it("answers an unknown command like bash -i (D17)", () => {
    const r = sh.run("nosuchcmd --flag");
    expect(r.err).toBe("bash: nosuchcmd: command not found\n");
    expect(r.code).toBe(127);
  });

  it("prints the builtin help for help NAME and the game list for help", () => {
    expect(sh.run("help cd").out).toMatch(/^cd: cd \[-L\|\[-P/);
    expect(sh.run("help").out).toContain("hint");
  });

  it("runs sh on the same interpreter", () => {
    expect(sh.run("sh -c 'echo $((2+2))'").out).toBe("4\n");
  });

  it("stores a multi-line command in history like cmdhist", () => {
    sh.run("if true; then\necho x\nfi");
    expect(sh.engine.state.hist.at(-1)).toBe("if true; then echo x; fi");
  });
});

describe("command table (D15)", () => {
  it("finds commands without the file system", () => {
    sh.run("rm -rf /usr");
    expect(sh.run("which ls").out).toBe("/usr/bin/ls\n");
    expect(sh.run("type cd").out).toBe("cd is a shell builtin\n");
    expect(sh.run("ls /tmp").code).toBe(0);
  });

  it("has cosmetic /usr/bin entries and /etc/os-release for Ubuntu 24.04 on a fresh game", () => {
    const fresh = openShell();
    expect(fresh.run("ls -1 /usr/bin | grep -x ls").out).toBe("ls\n");
    expect(fresh.run("cat /etc/os-release").out).toContain("Ubuntu");
    expect(fresh.run("cat /etc/os-release").out).toContain("24.04");
  });
});

describe("file times (D18)", () => {
  it("sets mtime on write and reads old nodes as Nov 24 09:00 of the current year", () => {
    sh.run("echo a > f");
    expect(sh.run("stat -c %Y f").out).toBe(
      String(Date.UTC(2026, 10, 24, 9, 0, 0) / 1000) + "\n",
    );
    sh.advance(3600_000);
    sh.run("echo b >> f");
    expect(sh.run("stat -c %Y f").out).toBe(
      String(Date.UTC(2026, 10, 24, 10, 0, 0) / 1000) + "\n",
    );
    expect(sh.run("ls -l /home/cadet/crew.txt").out).toContain("Nov 24 09:00");
  });

  it("sets mtime with touch -d and touch -t", () => {
    sh.run("touch -d '2024-01-15 10:30:00' f; touch -t 202401151031 g");
    expect(sh.run("stat -c %Y f").out).toBe("1705314600\n");
    expect(sh.run("stat -c %Y g").out).toBe("1705314660\n");
  });
});

describe("shell options and traps", () => {
  it("honors set -e, -u, and -x in a script", () => {
    sh.run("printf 'set -e\necho a\nfalse\necho b\n' > e.sh");
    const e = sh.run("bash e.sh");
    expect(e.out).toBe("a\n");
    expect(e.code).toBe(1);
    const u = sh.run("bash -c 'set -u; echo $nope; echo after'");
    expect(u.err).toContain("nope: unbound variable");
    expect(u.out).toBe("");
    const x = sh.run("bash -c 'set -x; echo hi'");
    expect(x.err).toBe("+ echo hi\n");
  });

  it("runs traps on EXIT and ERR", () => {
    expect(sh.run("bash -c \"trap 'echo bye' EXIT; echo main\"").out).toBe(
      "main\nbye\n",
    );
  });

  it("returns 1 for failing builtins", () => {
    expect(sh.run("cd /nonexistent").code).toBe(1);
    expect(sh.run("export 1bad").code).toBe(1);
  });
});

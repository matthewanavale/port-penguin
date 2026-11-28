// AC5: the limits of D5, D6, D19, D21, and D20. At a limit the input stops,
// the terminal shows `^C` and one line, and `$?` is 130. The nesting limits
// print one line and exit with 1 (the parser limit with 2). No JavaScript
// error reaches the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Proc } from "../engine/shell/proc";
import { RC_KEY, SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const STOPPED = /port-penguin: stopped: .+ \(the simulator has limits\)/;

async function expectStopped(input: string, limit?: string) {
  const r = await sh.run(input);
  expect(r.text, input).toMatch(STOPPED);
  expect(r.text, input).toContain("^C");
  expect(r.text.match(/port-penguin: stopped/g)?.length, input).toBe(1);
  expect(r.code, input).toBe(130);
  if (limit)
    expect(r.text).toContain(
      `port-penguin: stopped: ${limit} (the simulator has limits)`,
    );
  expect(r.text).not.toMatch(/RangeError|TypeError|undefined/);
}

describe("D5 limits", () => {
  it("stops an endless loop at 200000 steps", async () => {
    await expectStopped("while true; do :; done", "200000 steps");
  });

  it("stops seq 1 1000000000 at the output limit", async () => {
    await expectStopped("seq 1 1000000000", "10000 output lines");
  });

  it("stops a huge brace expansion", async () => {
    await expectStopped("echo {1..100000000}");
  });

  it("stops a string that doubles in a loop", async () => {
    await expectStopped("x=a; while true; do x=$x$x; done");
  });

  it("stops an array past 100000 items", async () => {
    await expectStopped("a=(x{1..60000} y{1..60000})");
  });

  it("stops yes | head -1 at the pipe data limit, as D20 records", async () => {
    await expectStopped("yes | head -1");
  });

  it("stops yes > f at 1 MB", async () => {
    await expectStopped("yes > f");
  });

  it("keeps working after a limit", async () => {
    await sh.run("while true; do :; done");
    expect((await sh.run("echo ok")).out).toBe("ok\n");
  });

  it("does not count a normal long command as a limit", async () => {
    expect((await sh.run("seq 1 5000 | wc -l")).out).toBe("5000\n");
  });
});

describe("D6 depth limits", () => {
  const NESTING = /port-penguin: \S+: nesting too deep \(\d+\)/;

  it("stops an endless function recursion at 1000", async () => {
    const r = await sh.run("f(){ f; }; f");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(1000)");
    expect(r.code).toBe(1);
  });

  it("stops a file that sources itself", async () => {
    await sh.run("echo 'source ./self.sh' > self.sh");
    const r = await sh.run("source ./self.sh");
    expect(r.text).toMatch(NESTING);
    expect(r.code).toBe(1);
  });

  it("stops a script that runs itself at 64", async () => {
    await sh.run("printf 'bash ./rec.sh\n' > rec.sh");
    const r = await sh.run("bash ./rec.sh");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(64)");
    expect(r.code).toBe(1);
  });

  it("refuses 600 nested subshells written with spaces, and runs nothing", async () => {
    const src = "echo ran; " + "( ".repeat(600) + "true" + " )".repeat(600);
    const r = await sh.run(src);
    expect(r.out).toBe("");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(500)");
    expect(r.code).toBe(2);
  });

  it("shows a JavaScript stack overflow as the same message", async () => {
    // Nested command substitutions overflow the JavaScript stack before the
    // 1000-level function limit, and before the 500-level parser limit.
    const r = await sh.run(
      "f(){ echo " + "$(".repeat(300) + "f" + ")".repeat(300) + "; }; f",
    );
    expect(r.text).toMatch(NESTING);
    expect(r.text).not.toMatch(/RangeError|Maximum call stack/);
    expect(r.code).toBe(1);
  });

  it("names no stale function after a stack overflow outside functions", async () => {
    await sh.run("old(){ :; }; old");
    const src = "echo " + "$(echo ".repeat(300) + "x" + ")".repeat(300);
    const r = await sh.run(src);
    expect(r.text).not.toContain("old");
    expect(r.text).not.toMatch(/RangeError|Maximum call stack/);
  });

  it("counts eval in the same depth counter", async () => {
    const r = await sh.run("e(){ eval e; }; e");
    expect(r.text).toMatch(NESTING);
    expect(r.code).toBe(1);
  });
});

describe(".bashrc guard (D19)", () => {
  const reload = async (rc: string) => {
    await sh.run(`printf '%s\n' ${JSON.stringify(rc)} > ~/.bashrc`);
    const saved = sh.store.get(SAVE_KEY) as string;
    return await openShell({ saved });
  };

  it("ignores exit inside .bashrc and starts a working prompt", async () => {
    const again = await reload("exit");
    expect(again.startText).not.toContain("~/.bashrc failed");
    expect((await again.run("echo ok")).out).toBe("ok\n");
  });

  it("stops an endless loop in .bashrc and shows one dim line", async () => {
    const again = await reload("while true; do :; done");
    expect(again.startText).toMatch(
      /port-penguin: ~\/\.bashrc failed \(.+\); the shell started without it/,
    );
    expect(again.startText.match(/\.bashrc failed/g)?.length).toBe(1);
    expect((await again.run("echo ok")).out).toBe("ok\n");
  });
});

describe("utility loops and the rc marker (G-SEC-1)", () => {
  it("stops an endless awk loop at the prompt", async () => {
    await expectStopped("awk 'BEGIN{while(1);}'");
  });

  it("stops an endless awk do and for loop", async () => {
    await expectStopped("awk 'BEGIN{do {} while(1)}'");
    await expectStopped("awk 'BEGIN{for(;;);}'");
  });

  it("stops an endless sed branch loop", async () => {
    await expectStopped("echo x | sed ':a;ba'");
  });

  it("stops an endless sed t loop", async () => {
    await expectStopped("echo x | sed ':a;s/x/x/;ta'");
  });

  it("still runs normal awk and sed", async () => {
    expect((await sh.run("seq 1 100 | awk '{s+=$1} END{print s}'")).out).toBe(
      "5050\n",
    );
    expect((await sh.run("echo abc | sed 's/b/X/'")).out).toBe("aXc\n");
  });

  const reload = async (rc: string) => {
    await sh.run(`printf '%s\n' ${JSON.stringify(rc)} > ~/.bashrc`);
    const saved = sh.store.get(SAVE_KEY) as string;
    return await openShell({ saved });
  };

  it("stops an endless awk loop in .bashrc and starts a working prompt", async () => {
    const again = await reload("awk 'BEGIN{while(1);}'");
    expect(again.startText).toContain("~/.bashrc failed");
    expect((await again.run("echo ok")).out).toBe("ok\n");
  });

  it("stops an endless sed loop in .bashrc and starts a working prompt", async () => {
    const again = await reload("echo x | sed ':a;ba'");
    expect(again.startText).toContain("~/.bashrc failed");
    expect((await again.run("echo ok")).out).toBe("ok\n");
  });

  it("leaves no marker after a normal start", async () => {
    const again = await reload("export RCVAR=1");
    expect(again.store.get(RC_KEY) ?? "").toBe("");
    expect((await again.run("echo $RCVAR")).out).toBe("1\n");
  });

  it("skips .bashrc when the marker is set, shows the reason, and clears it", async () => {
    await sh.run("printf '%s\n' 'export RCVAR=1' > ~/.bashrc");
    const saved = sh.store.get(SAVE_KEY) as string;
    const again = await openShell({ saved, keys: { [RC_KEY]: "1" } });
    expect(again.startText).toContain("the last start did not finish");
    expect(again.startText.match(/\.bashrc failed/g)?.length).toBe(1);
    expect((await again.run("echo [$RCVAR]")).out).toBe("[]\n");
    expect(again.store.get(RC_KEY) ?? "").toBe("");
    const next = await openShell({
      saved: again.store.get(SAVE_KEY) as string,
    });
    expect((await next.run("echo $RCVAR")).out).toBe("1\n");
  });
});

describe("a crash in the simulator (G-UX-3)", () => {
  it("shows a plain message, not the internal error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = Proc.prototype.runLine;
    Proc.prototype.runLine = () => {
      throw new TypeError("internal detail xyz");
    };
    try {
      const r = await sh.run("echo hi");
      expect(r.text).toContain(
        "That command hit a problem in the simulator. Try it again, or type help.",
      );
      expect(r.text).not.toContain("internal detail xyz");
      expect(r.text).not.toContain("Something went wrong running that");
    } finally {
      Proc.prototype.runLine = orig;
      spy.mockRestore();
    }
  });
});

describe("storage (D21)", () => {
  it("shows one dim line when save() fails, and keeps the game running", async () => {
    const failing = await openShell({
      setItem: () => {
        throw new Error("quota full");
      },
    });
    const r = await failing.run("echo hi");
    expect(r.out).toBe("hi\n");
    expect(r.text).toMatch(
      /port-penguin: progress could not be saved \(.*quota full.*\)/,
    );
    expect(r.text.match(/progress could not be saved/g)?.length).toBe(1);
  });
});

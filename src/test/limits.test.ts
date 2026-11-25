// AC5: the limits of D5, D6, D19, D21, and D20. At a limit the input stops,
// the terminal shows `^C` and one line, and `$?` is 130. The nesting limits
// print one line and exit with 1 (the parser limit with 2). No JavaScript
// error reaches the screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

let sh: Shell;
beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const STOPPED = /port-penguin: stopped: .+ \(the simulator has limits\)/;

function expectStopped(input: string, limit?: string) {
  const r = sh.run(input);
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
  it("stops an endless loop at 200000 steps", () => {
    expectStopped("while true; do :; done", "200000 steps");
  });

  it("stops seq 1 1000000000 at the output limit", () => {
    expectStopped("seq 1 1000000000", "10000 output lines");
  });

  it("stops a huge brace expansion", () => {
    expectStopped("echo {1..100000000}");
  });

  it("stops a string that doubles in a loop", () => {
    expectStopped("x=a; while true; do x=$x$x; done");
  });

  it("stops an array past 100000 items", () => {
    expectStopped("a=(x{1..60000} y{1..60000})");
  });

  it("stops yes | head -1 at the pipe data limit, as D20 records", () => {
    expectStopped("yes | head -1");
  });

  it("stops yes > f at 1 MB", () => {
    expectStopped("yes > f");
  });

  it("keeps working after a limit", () => {
    sh.run("while true; do :; done");
    expect(sh.run("echo ok").out).toBe("ok\n");
  });

  it("does not count a normal long command as a limit", () => {
    expect(sh.run("seq 1 5000 | wc -l").out).toBe("5000\n");
  });
});

describe("D6 depth limits", () => {
  const NESTING = /port-penguin: \S+: nesting too deep \(\d+\)/;

  it("stops an endless function recursion at 1000", () => {
    const r = sh.run("f(){ f; }; f");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(1000)");
    expect(r.code).toBe(1);
  });

  it("stops a file that sources itself", () => {
    sh.run("echo 'source ./self.sh' > self.sh");
    const r = sh.run("source ./self.sh");
    expect(r.text).toMatch(NESTING);
    expect(r.code).toBe(1);
  });

  it("stops a script that runs itself at 64", () => {
    sh.run("printf 'bash ./rec.sh\n' > rec.sh");
    const r = sh.run("bash ./rec.sh");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(64)");
    expect(r.code).toBe(1);
  });

  it("refuses 600 nested subshells written with spaces, and runs nothing", () => {
    const src = "echo ran; " + "( ".repeat(600) + "true" + " )".repeat(600);
    const r = sh.run(src);
    expect(r.out).toBe("");
    expect(r.text).toMatch(NESTING);
    expect(r.text).toContain("(500)");
    expect(r.code).toBe(2);
  });

  it("shows a JavaScript stack overflow as the same message", () => {
    const r = sh.run("f(){ local a=$1; f $((a+1)); }; f 1");
    expect(r.text).toMatch(NESTING);
    expect(r.text).not.toMatch(/RangeError|Maximum call stack/);
  });

  it("counts eval in the same depth counter", () => {
    const r = sh.run("e(){ eval e; }; e");
    expect(r.text).toMatch(NESTING);
    expect(r.code).toBe(1);
  });
});

describe(".bashrc guard (D19)", () => {
  const reload = (rc: string) => {
    sh.run(`printf '%s\n' ${JSON.stringify(rc)} > ~/.bashrc`);
    const saved = sh.store.get(SAVE_KEY) as string;
    return openShell({ saved });
  };

  it("ignores exit inside .bashrc and starts a working prompt", () => {
    const again = reload("exit");
    expect(again.startText).not.toContain("~/.bashrc failed");
    expect(again.run("echo ok").out).toBe("ok\n");
  });

  it("stops an endless loop in .bashrc and shows one dim line", () => {
    const again = reload("while true; do :; done");
    expect(again.startText).toMatch(
      /port-penguin: ~\/\.bashrc failed \(.+\); the shell started without it/,
    );
    expect(again.startText.match(/\.bashrc failed/g)?.length).toBe(1);
    expect(again.run("echo ok").out).toBe("ok\n");
  });
});

describe("storage (D21)", () => {
  it("shows one dim line when save() fails, and keeps the game running", () => {
    const failing = openShell({
      setItem: () => {
        throw new Error("quota full");
      },
    });
    const r = failing.run("echo hi");
    expect(r.out).toBe("hi\n");
    expect(r.text).toMatch(
      /port-penguin: progress could not be saved \(.*quota full.*\)/,
    );
    expect(r.text.match(/progress could not be saved/g)?.length).toBe(1);
  });
});

// B4, B16, B24, B27: the tty (line mode, character mode, echo, Ctrl-D,
// type-ahead) and the commands that read the keyboard through it (AC4).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../test/engineHarness";
import type { Shell } from "../test/engineHarness";
import { AHEAD_MAX, Tty } from "./tty";

describe("the tty in line mode (B4)", () => {
  it("sends the line with its newline at Enter, with echo", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: true });
    expect(t.feed("hel")).toBe("hel");
    expect(t.feed("lo\r")).toBe("lo\r\n");
    expect(await p).toBe("hello\n");
    expect(t.reading).toBe(false);
  });

  it("edits the line with backspace, Ctrl-U, and Ctrl-W", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: true });
    expect(t.feed("abc\x7f")).toBe("abc\b \b");
    t.feed("\x15");
    t.feed("one two\x17");
    t.feed("\n");
    expect(await p).toBe("one \n");
  });

  it("does not echo when echo is off", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: false });
    expect(t.feed("pw\n")).toBe("");
    expect(await p).toBe("pw\n");
  });

  it("gives end of input for Ctrl-D on an empty line", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: true });
    t.feed("\x04");
    expect(await p).toBeNull();
  });

  it("sends the line with no newline for Ctrl-D on a non-empty line", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: true });
    t.feed("ab\x04");
    expect(await p).toBe("ab");
  });

  it("ends the wait when the request is aborted", async () => {
    const t = new Tty();
    const ac = new AbortController();
    const p = t.read({ mode: "line", echo: true, signal: ac.signal });
    ac.abort();
    expect(await p).toBeNull();
    expect(t.reading).toBe(false);
  });

  it("uses the line editor for read -e, with Left and Delete", async () => {
    const t = new Tty();
    const p = t.read({ mode: "line", echo: true, edit: true });
    t.feed("ab");
    t.feed("\x1b[D");
    t.feed("X");
    t.feed("\r");
    expect(await p).toBe("aXb\n");
  });
});

describe("the tty in character mode (B4)", () => {
  it("sends the keys at once when the count is reached", async () => {
    const t = new Tty();
    const p = t.read({ mode: "char", count: 2, echo: true });
    expect(t.feed("a")).toBe("a");
    expect(t.reading).toBe(true);
    t.feed("b");
    expect(await p).toBe("ab");
  });

  it("sends Enter as a newline key", async () => {
    const t = new Tty();
    const p = t.read({ mode: "char", count: 1, echo: true });
    expect(t.feed("\r")).toBe("\r\n");
    expect(await p).toBe("\n");
  });
});

describe("type-ahead (B24)", () => {
  it("echoes the keys at once and gives them to the next reader first", async () => {
    const t = new Tty();
    expect(t.feed("ab\r")).toBe("ab\r\n");
    expect(t.hasAhead).toBe(true);
    const p = t.read({ mode: "line", echo: true });
    expect(await p).toBe("ab\n");
    expect(t.hasAhead).toBe(false);
  });

  it("keeps at most 4096 characters", () => {
    const t = new Tty();
    t.feed("x".repeat(AHEAD_MAX + 100));
    expect(t.takeAhead().length).toBe(AHEAD_MAX);
  });

  it("empties at flush", () => {
    const t = new Tty();
    t.feed("abc");
    t.flush();
    expect(t.takeAhead()).toBe("");
  });

  it("lets backspace undo type-ahead of the same line", () => {
    const t = new Tty();
    t.feed("ab\x7f");
    expect(t.takeAhead()).toBe("a");
  });
});

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
});
afterEach(restore);

describe("commands that read the keyboard (AC4)", () => {
  it("read v takes the typed line", async () => {
    const r = sh.start('read v; echo "[$v]"');
    await sh.keys("hello\r");
    const res = await r.result;
    expect(res.out).toBe("[hello]\n");
    expect(sh.echoed()).toBe("hello\r\n");
  });

  it("read -n 1 takes one key at once", async () => {
    const r = sh.start('read -n 1 k; echo "[$k]"');
    await sh.keys("x");
    const res = await r.result;
    expect(res.out).toBe("[x]\n");
  });

  it("read -N 3 takes three keys, and Enter counts as one", async () => {
    const r = sh.start('read -N 3 k; echo "[$k]"');
    await sh.keys("a\rb");
    const res = await r.result;
    expect(res.out).toBe("[a\nb]\n");
  });

  it("read -s does not echo", async () => {
    const r = sh.start('read -s pw; echo "[$pw]"');
    await sh.keys("secret\r");
    const res = await r.result;
    expect(res.out).toBe("[secret]\n");
    expect(sh.echoed()).toBe("");
  });

  it("read -p writes its text to stderr first", async () => {
    const r = sh.start('read -p "Name: " n; echo "$n"');
    await sh.keys("Ann\r");
    const res = await r.result;
    expect(res.err).toBe("Name: ");
    expect(res.out).toBe("Ann\n");
  });

  it("read -t 1 gives 142 after the clock moves 1 s", async () => {
    const r = sh.start("read -t 1 v; echo $?");
    await sh.advance(999);
    expect(r.done()).toBe(false);
    await sh.advance(1);
    const res = await r.result;
    expect(res.out).toBe("142\n");
    // The next read is not stuck behind the timed-out request.
    expect(sh.tty.reading).toBe(false);
  });

  it("read -t 5 returns at once when the line comes in time", async () => {
    const r = sh.start('read -t 5 v; echo "$? $v"');
    await sh.keys("ok\r");
    const res = await r.result;
    expect(res.out).toBe("0 ok\n");
  });

  it("read -e edits the line", async () => {
    const r = sh.start('read -e v; echo "[$v]"');
    await sh.keys("ab");
    await sh.keys("\x1b[D");
    await sh.keys("X\r");
    const res = await r.result;
    expect(res.out).toBe("[aXb]\n");
  });

  it("select shows the menu and PS3, then takes the choice", async () => {
    const r = sh.start(
      'select c in alpha beta; do echo "got $c ($REPLY)"; break; done',
    );
    await sh.keys("2\r");
    const res = await r.result;
    expect(res.err).toBe("1) alpha  2) beta\n#? ");
    expect(res.out).toBe("got beta (2)\n");
  });

  it("select shows the menu again on an empty line, and sets the name empty for a bad number", async () => {
    const r = sh.start(
      'PS3="pick: "; select c in a b; do echo "[$c]"; break; done',
    );
    await sh.keys("\r");
    await sh.keys("9\r");
    const res = await r.result;
    expect(res.err).toBe("1) a  2) b\npick: 1) a  2) b\npick: ");
    expect(res.out).toBe("[]\n");
  });

  it("select ends with status 1 at the end of input", async () => {
    const r = sh.start("select c in a b; do :; done; echo $?");
    await sh.keys("\x04");
    const res = await r.result;
    expect(res.out).toBe("\n1\n");
  });

  it("cat echoes each line and ends at Ctrl-D", async () => {
    const r = sh.start("cat");
    await sh.keys("one\r");
    expect(sh.sofar()).toBe("one\n");
    await sh.keys("two\r");
    expect(sh.sofar()).toBe("one\ntwo\n");
    await sh.keys("\x04");
    const res = await r.result;
    expect(res.out).toBe("one\ntwo\n");
    expect(res.code).toBe(0);
  });

  it("wc -l counts the typed lines", async () => {
    const r = sh.start("wc -l");
    await sh.keys("a\rb\rc\r");
    await sh.keys("\x04");
    const res = await r.result;
    expect(res.out).toBe("3\n");
  });

  it("Ctrl-D on a non-empty line sends it with no newline, and a second one ends", async () => {
    const r = sh.start("cat");
    await sh.keys("ab\x04");
    expect(sh.sofar()).toBe("ab");
    expect(r.done()).toBe(false);
    await sh.keys("\x04");
    const res = await r.result;
    expect(res.out).toBe("ab");
  });

  it("Ctrl-C during read ends it with status 130 and echoes ^C", async () => {
    const r = sh.start("read v; echo not-here");
    await sh.keys("par");
    await sh.keys("\x03");
    const res = await r.result;
    expect(res.code).toBe(130);
    expect(res.out).toBe("");
    expect(sh.echoed()).toBe("par^C\r\n");
    expect(sh.tty.reading).toBe(false);
  });

  it("a trap on INT runs and the read ends", async () => {
    const r = sh.start("trap 'echo caught' INT; read v; echo after");
    await sh.keys("\x03");
    const res = await r.result;
    expect(res.out).toBe("caught\nafter\n");
  });

  it("shows the keyboard hint once, with the command name, only for prompt input", async () => {
    const a = sh.start("cat");
    await sh.keys("\x04");
    await a.result;
    expect(sh.reads[0].hint).toBe(
      "port-penguin: cat is reading the keyboard. Type input and press Enter; Ctrl-D ends the input, Ctrl-C stops cat.",
    );
    expect(sh.reads[0].cmd).toBe("cat");
    const b = sh.start("read v");
    await sh.keys("x\r");
    await b.result;
    expect(sh.reads[1].hint).toBeUndefined();
  });

  it("shows no hint for a command in a script or a function", async () => {
    await sh.run("printf 'cat\\n' > s.sh");
    const a = sh.start("bash s.sh");
    await sh.keys("\x04");
    await a.result;
    const b = sh.start("f() { read v; }; f");
    await sh.keys("x\r");
    await b.result;
    expect(sh.reads.length).toBe(2);
    expect(sh.reads.every((q) => q.hint === undefined)).toBe(true);
  });

  it("gives end of input at once to a read with nobody at the keyboard (run)", async () => {
    const r = await sh.run("cat; echo $?; read v; echo $?");
    expect(r.out).toBe("0\n1\n");
  });
});

describe("type-ahead with a running command (AC7, B24)", () => {
  it("echoes keys typed during sleep and keeps them for the next prompt", async () => {
    const r = sh.start("sleep 2");
    await sh.keys("ls\r");
    expect(sh.echoed()).toBe("ls\r\n");
    await sh.advance(2000);
    await r.result;
    expect(sh.tty.takeAhead()).toBe("ls\n");
  });

  it("gives the keys typed during sleep to a later read first", async () => {
    const r = sh.start('sleep 1; read v; echo "[$v]"');
    await sh.keys("hi\r");
    await sh.advance(1000);
    const res = await r.result;
    expect(res.out).toBe("[hi]\n");
  });

  it("Ctrl-C empties the type-ahead", async () => {
    const r = sh.start("sleep 100");
    await sh.keys("abc");
    await sh.keys("\x03");
    await r.result;
    expect(sh.tty.takeAhead()).toBe("");
  });
});

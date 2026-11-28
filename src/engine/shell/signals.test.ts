// B5, B6, B7: `sleep` on the engine clock, signals and traps, Ctrl-C at the
// prompt shell, and yielding. An input that waits is started and not awaited;
// the test moves the fake clock or sends a signal, then awaits the result.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, SAVE_KEY } from "../../engine/index";
import { makeFakeClock, START_MS } from "../../test/determinism";
import { openShell, restore } from "../../test/engineHarness";
import type { RunResult, Shell } from "../../test/engineHarness";
import { limitFromError } from "./limits";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
});
afterEach(restore);

/** Real time passes (the engine yields through real macrotasks). */
const real = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Starts an input and tracks whether it ended. */
function start(input: string): {
  done: () => boolean;
  result: Promise<RunResult>;
} {
  let ended = false;
  const result = sh.run(input).finally(() => (ended = true));
  return { done: () => ended, result };
}

describe("sleep on the engine clock (B5)", () => {
  it("returns only after the clock moves 2 s", async () => {
    const r = start("sleep 2; echo up");
    await sh.advance(1999);
    expect(r.done()).toBe(false);
    await sh.advance(1);
    const res = await r.result;
    expect(res.out).toBe("up\n");
    expect(res.code).toBe(0);
  });

  it("takes decimals, suffixes, and several operands", async () => {
    for (const [arg, ms] of [
      ["1.5", 1500],
      ["1m", 60_000],
      ["0.1h", 360_000],
      ["1 2", 3000],
      [".5s", 500],
    ] as const) {
      const r = start(`sleep ${arg}`);
      await sh.advance(ms - 1);
      expect(r.done(), arg).toBe(false);
      await sh.advance(1);
      await r.result;
      expect(r.done(), arg).toBe(true);
    }
  });

  it("still rejects a bad interval at once", async () => {
    const r = await sh.run("sleep abc");
    expect(r.err).toContain("invalid time interval");
    expect(r.code).toBe(1);
  });

  it("moves $SECONDS and date with the clock", async () => {
    const r = start("sleep 3; echo $SECONDS");
    await sh.advance(3000);
    expect((await r.result).out).toBe("3\n");
  });
});

describe("Ctrl-C at the prompt shell (B6)", () => {
  it("ends a waiting sleep at once with status 130", async () => {
    const r = start("sleep 100; echo not-here");
    await real(5);
    expect(sh.engine.busy()).toBe(true);
    sh.engine.signal("INT");
    const res = await r.result;
    expect(res.code).toBe(130);
    expect(res.out).toBe("");
    expect(sh.engine.busy()).toBe(false);
  });

  it("does nothing when no input runs", async () => {
    sh.engine.signal("INT");
    expect((await sh.run("echo ok")).out).toBe("ok\n");
  });

  it("ends a sleep inside a subshell, a function, and a pipeline stage", async () => {
    for (const input of [
      "(sleep 100); echo no",
      "f(){ sleep 100; }; f; echo no",
      "sleep 100 | cat; echo no",
      "echo $(sleep 100); echo no",
    ]) {
      const r = start(input);
      await real(5);
      sh.engine.signal("INT");
      const res = await r.result;
      expect(res.code, input).toBe(130);
      expect(res.out, input).toBe("");
    }
  });

  it("ends a loop that runs without a wait", async () => {
    const r = start("while :; do i=$((i+1)); done");
    await real(30);
    sh.engine.signal("INT");
    const res = await r.result;
    expect(res.code).toBe(130);
    expect(Number((await sh.run("echo $i")).out)).toBeGreaterThan(0);
  });

  it("gives the shell back: the next input runs", async () => {
    const r = start("sleep 100");
    await real(5);
    sh.engine.signal("INT");
    await r.result;
    expect((await sh.run("echo $?")).out).toBe("130\n");
  });
});

describe("other signals (B6)", () => {
  it("ends with 128 plus the number: QUIT 131, TSTP 148, TERM 143, HUP 129", async () => {
    for (const [sig, code] of [
      ["QUIT", 131],
      ["TSTP", 148],
      ["TERM", 143],
      ["HUP", 129],
      ["USR1", 138],
    ] as const) {
      const r = start("sleep 100");
      await real(5);
      sh.engine.signal(sig);
      expect((await r.result).code, sig).toBe(code);
    }
  });

  it("names the core dump for QUIT", async () => {
    const r = start("sleep 100");
    await real(5);
    sh.engine.signal("QUIT");
    expect((await r.result).err).toContain("Quit (core dumped)");
  });

  it("ignores CONT without a trap", async () => {
    const r = start("sleep 2; echo done");
    await real(5);
    sh.engine.signal("CONT");
    await sh.advance(2000);
    expect((await r.result).out).toBe("done\n");
  });
});

describe("trap on signals (B6)", () => {
  it("runs the trap and the script goes on", async () => {
    const r = start("trap 'echo caught' INT; sleep 100; echo after");
    await real(5);
    sh.engine.signal("INT");
    const res = await r.result;
    expect(res.out).toBe("caught\nafter\n");
    expect(res.code).toBe(0);
  });

  it("gives the sleep status 130 to $? before the trap", async () => {
    const r = start("trap 'echo got $?' INT; sleep 100; echo end $?");
    await real(5);
    sh.engine.signal("INT");
    expect((await r.result).out).toBe("got 130\nend 130\n");
  });

  it("runs a trap for TERM, HUP, QUIT, TSTP, CONT, USR1, USR2", async () => {
    for (const sig of ["TERM", "HUP", "QUIT", "TSTP", "CONT", "USR1", "USR2"]) {
      const r = start(`trap 'echo got-${sig}' ${sig}; sleep 100; echo end`);
      await real(5);
      sh.engine.signal(sig);
      expect((await r.result).out, sig).toBe(`got-${sig}\nend\n`);
    }
  });

  it("ignores the signal with trap '' and the sleep goes on", async () => {
    const r = start("trap '' INT; sleep 3; echo done");
    await real(5);
    sh.engine.signal("INT");
    await real(5);
    expect(r.done()).toBe(false);
    await sh.advance(3000);
    const res = await r.result;
    expect(res.out).toBe("done\n");
    expect(res.code).toBe(0);
  });

  it("runs the trap of the parent when a subshell ends by the signal", async () => {
    const r = start("trap 'echo caught' INT; (sleep 100); echo after");
    await real(5);
    sh.engine.signal("INT");
    const res = await r.result;
    expect(res.out).toBe("caught\nafter\n");
  });

  it("runs the trap in a busy loop and the loop goes on", async () => {
    const r = start(
      "n=0; trap 'n=$((n+1))' INT; while [ $n -lt 2 ]; do :; done; echo n=$n",
    );
    await real(20);
    sh.engine.signal("INT");
    await real(20);
    sh.engine.signal("INT");
    expect((await r.result).out).toBe("n=2\n");
  });

  it("a subshell resets a trap but keeps an ignore", async () => {
    const a = await sh.run("trap 'echo x' INT; (trap -p)");
    expect(a.out).toBe("");
    const b = await sh.run("trap '' INT; (trap -p)");
    expect(b.out).toContain("trap -- '' INT");
  });

  it("lists the new signals in trap -p after they are set", async () => {
    const r = await sh.run("trap 'echo t' TSTP CONT; trap -p");
    expect(r.out).toContain("trap -- 'echo t' TSTP");
    expect(r.out).toContain("trap -- 'echo t' CONT");
  });
});

describe("yielding (B7, AC6)", () => {
  it("lets a setTimeout(0) callback run within 50 ms of real time", async () => {
    const r = start("while true; do :; done");
    await real(5);
    const t0 = performance.now();
    const waited = await new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - t0), 0),
    );
    sh.engine.signal("INT");
    await r.result;
    expect(waited).toBeLessThan(50);
  });

  it("yields without the engine clock moving", async () => {
    const before = sh.clock.now();
    const r = start("while true; do :; done");
    await real(40);
    sh.engine.signal("INT");
    await r.result;
    expect(sh.clock.now()).toBe(before);
  });
});

describe("Ctrl-C while ~/.bashrc runs (B15)", () => {
  it("stops it with the D19 note, reason interrupted", async () => {
    await sh.run("printf '%s\\n' 'sleep 100' > ~/.bashrc");
    const saved = sh.store.get(SAVE_KEY) as string;
    const clock = makeFakeClock(START_MS);
    const engine = createEngine({
      clock,
      storage: {
        getItem: (k) => (k === SAVE_KEY ? saved : null),
        setItem: () => undefined,
      },
    });
    let lines: string[] | null = null;
    const started = engine.start().then((out) => {
      lines = out.map((l) => l.runs.map((r) => r.text).join(""));
    });
    await real(5);
    expect(engine.busy()).toBe(true);
    expect(lines).toBeNull();
    engine.signal("INT");
    await started;
    expect(engine.busy()).toBe(false);
    expect(lines).toEqual([
      "port-penguin: ~/.bashrc failed (interrupted); the shell started without it",
    ]);
  });

  it("waits on the engine clock, then goes on", async () => {
    await sh.run("printf '%s\\n' 'sleep 2; export RCV=1' > ~/.bashrc");
    const saved = sh.store.get(SAVE_KEY) as string;
    const clock = makeFakeClock(START_MS);
    const engine = createEngine({
      clock,
      storage: {
        getItem: (k) => (k === SAVE_KEY ? saved : null),
        setItem: () => undefined,
      },
    });
    let over = false;
    const started = engine.start().then(() => (over = true));
    await real(5);
    expect(over).toBe(false);
    await clock.advance(2000);
    await started;
    expect(engine.busy()).toBe(false);
  });
});

describe("JavaScript errors that are limits (B18)", () => {
  it("maps a stack overflow to the nesting stop", () => {
    expect(
      limitFromError(new RangeError("Maximum call stack size exceeded")),
    ).toBe("nest");
    const ff = new Error("too much recursion");
    ff.name = "InternalError";
    expect(limitFromError(ff)).toBe("nest");
  });

  it("maps Invalid string length and Invalid array length to the 1 MB string stop", () => {
    for (const m of ["Invalid string length", "Invalid array length"]) {
      const r = limitFromError(new RangeError(m));
      expect(r).not.toBeNull();
      expect(r).not.toBe("nest");
      expect((r as Error).message).toBe("1 MB string");
    }
  });

  it("does not claim other errors", () => {
    expect(limitFromError(new TypeError("x"))).toBeNull();
    expect(limitFromError(new Error("call stack"))).toBeNull();
  });
});

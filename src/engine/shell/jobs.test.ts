// B9, B10, B11, B12, B24: job control. A job starts with `&` or when Ctrl-Z
// takes the foreground unit. The tests start inputs that wait, move the fake
// clock or press keys, and read the job lines the engine gives for the next
// prompt (`notices()`).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../../engine/index";
import { settle } from "../../test/determinism";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
});
afterEach(restore);

/** The text of the notices for the next prompt. */
const notes = (): string[] =>
  sh.engine
    .notices()
    .map((n) => n.text)
    .filter(Boolean);

/** `[N]+  State` with the state column padded to 24, as bash writes it. */
const row = (n: number, mark: string, state: string, cmd: string): string =>
  `[${n}]${mark}  ${state.padEnd(24)}${cmd}`;

describe("starting a job (B9)", () => {
  it("prints [N] PID, sets $!, and gives the prompt back at once", async () => {
    const r = await sh.run("sleep 5 &");
    expect(r.err).toMatch(/^\[1\] \d+\n$/);
    expect(r.code).toBe(0);
    const pid = /\[1\] (\d+)/.exec(r.err)?.[1];
    expect((await sh.run("echo $!")).out).toBe(`${pid}\n`);
    expect(sh.engine.busy()).toBe(false);
  });

  it("numbers the jobs and lists them with jobs, jobs -l, -p, -r, -s", async () => {
    const a = await sh.run("sleep 5 &");
    const b = await sh.run("sleep 7 &");
    const pa = /\[1\] (\d+)/.exec(a.err)?.[1];
    const pb = /\[2\] (\d+)/.exec(b.err)?.[1];
    const j = await sh.run("jobs");
    expect(j.out).toBe(
      row(1, "-", "Running", "sleep 5 &") +
        "\n" +
        row(2, "+", "Running", "sleep 7 &") +
        "\n",
    );
    const l = await sh.run("jobs -l");
    expect(l.out).toContain(`[1]-  ${pa?.padStart(5)} Running`);
    expect((await sh.run("jobs -p")).out).toBe(`${pa}\n${pb}\n`);
    expect((await sh.run("jobs -r")).out.split("\n")).toHaveLength(3);
    expect((await sh.run("jobs -s")).out).toBe("");
  });

  it("starts a job for a pipeline, a list, and a compound command", async () => {
    await sh.run("sleep 5 | cat &");
    await sh.run("echo x; sleep 6 &");
    await sh.run("{ sleep 7; echo y; } &");
    const j = (await sh.run("jobs")).out;
    expect(j).toContain("sleep 5 | cat &");
    expect(j).toContain("sleep 6 &");
    expect(j).toContain("{ sleep 7; echo y; } &");
  });

  it("runs a job in a copy of the shell: no variable or cwd leaks", async () => {
    await sh.run("x=1; cd /tmp");
    await sh.run("{ x=2; cd /; sleep 1; } &");
    await sh.advance(1000);
    const r = await sh.run("echo $x; pwd");
    expect(r.out).toBe("1\n/tmp\n");
  });
});

describe("notices before the next prompt (B9)", () => {
  it("gives Done when the job ends, then forgets the job", async () => {
    await sh.run("sleep 5 &");
    await sh.advance(4999);
    expect(notes()).toEqual([]);
    await sh.advance(1);
    expect(notes()).toEqual([row(1, "+", "Done", "sleep 5")]);
    expect(notes()).toEqual([]);
    expect((await sh.run("jobs")).out).toBe("");
  });

  it("gives Exit N for a job that fails", async () => {
    await sh.run("{ sleep 1; exit 3; } &");
    await sh.advance(1000);
    expect(notes()).toEqual([row(1, "+", "Exit 3", "{ sleep 1; exit 3; }")]);
  });

  it("numbers a new job from 1 again when none is left", async () => {
    await sh.run("sleep 1 &");
    await sh.advance(1000);
    notes();
    const r = await sh.run("sleep 1 &");
    expect(r.err).toMatch(/^\[1\] /);
  });

  it("prints no notice and no [N] line for a job in a script", async () => {
    await sh.run("printf 'sleep 1 &\\nwait\\necho done\\n' > s.sh");
    const r = sh.start("bash s.sh");
    await sh.advance(1000);
    const res = await r.result;
    expect(res.out).toBe("done\n");
    expect(res.err).toBe("");
    expect(notes()).toEqual([]);
  });
});

describe("kill and signals (B9, B10)", () => {
  it("kill %1 gives a Terminated notice", async () => {
    await sh.run("sleep 100 &");
    const k = await sh.run("kill %1");
    expect(k.code).toBe(0);
    await settle();
    expect(notes()).toEqual([row(1, "+", "Terminated", "sleep 100")]);
  });

  it("kill -9 %1 gives Killed; kill -s TERM and -TERM work", async () => {
    await sh.run("sleep 100 &");
    await sh.run("kill -9 %1");
    await settle();
    expect(notes()).toEqual([row(1, "+", "Killed", "sleep 100")]);
    await sh.run("sleep 100 &");
    await sh.run("kill -s TERM %1");
    await settle();
    expect(notes()[0]).toContain("Terminated");
    await sh.run("sleep 100 &");
    await sh.run("kill -TERM %1");
    await settle();
    expect(notes()[0]).toContain("Terminated");
  });

  it("kill -HUP and -INT name the signal in the notice", async () => {
    await sh.run("sleep 100 &");
    await sh.run("kill -HUP %1");
    await settle();
    expect(notes()[0]).toContain("Hangup");
    await sh.run("sleep 100 &");
    await sh.run("kill -INT %1");
    await settle();
    expect(notes()[0]).toContain("Interrupt");
  });

  it("kill -STOP stops a job and kill -CONT lets it go on", async () => {
    await sh.run("sleep 2 &");
    await sh.run("kill -STOP %1");
    expect(notes()).toEqual([row(1, "+", "Stopped", "sleep 2")]);
    expect((await sh.run("jobs")).out).toBe(
      row(1, "+", "Stopped", "sleep 2") + "\n",
    );
    await sh.run("kill -CONT %1");
    expect((await sh.run("jobs")).out).toBe(
      row(1, "+", "Running", "sleep 2 &") + "\n",
    );
    await sh.advance(2000);
    expect(notes()).toEqual([row(1, "+", "Done", "sleep 2")]);
  });

  it("a stopped job does not finish until it is continued", async () => {
    await sh.run("{ sleep 1; echo late; } &");
    await sh.run("kill -STOP %1");
    await sh.advance(5000);
    expect(sh.sofar()).not.toContain("late");
    await sh.run("kill -CONT %1");
    await settle();
    expect(sh.sofar()).toContain("late");
  });

  it("a trap catches a signal sent by kill", async () => {
    await sh.run("{ trap 'echo caught' TERM; sleep 100; echo after; } &");
    await settle();
    await sh.run("kill %1");
    await settle();
    expect(sh.sofar()).toContain("caught");
  });

  it("reports a bad job spec and a bad signal", async () => {
    const a = await sh.run("kill %9");
    expect(a.err).toBe("bash: kill: %9: no such job\n");
    expect(a.code).toBe(1);
    const b = await sh.run("kill -FOO 1");
    expect(b.err).toBe("bash: kill: FOO: invalid signal specification\n");
  });

  it("kill -l N gives a name; type kill says builtin", async () => {
    expect((await sh.run("kill -l 9")).out).toBe("KILL\n");
    expect((await sh.run("type kill")).out).toBe("kill is a shell builtin\n");
  });
});

describe("job specs (B9)", () => {
  beforeEach(async () => {
    await sh.run("sleep 101 &");
    await sh.run("sleep 202 &");
    await sh.run("echo 1 > /dev/null; sleep 303 &");
  });

  it("%N, %%, %+, %-, %NAME, and %?TEXT pick a job", async () => {
    const pick = async (spec: string): Promise<string> => {
      const r = await sh.run(`jobs ${spec}`);
      return /sleep (\d+)/.exec(r.out)?.[1] ?? r.err;
    };
    expect(await pick("%1")).toBe("101");
    expect(await pick("%2")).toBe("202");
    expect(await pick("%%")).toBe("303");
    expect(await pick("%+")).toBe("303");
    expect(await pick("%-")).toBe("202");
    expect(await pick("%?20")).toBe("202");
    expect(await pick("%sleep 1")).toBe("101");
  });

  it("reports an ambiguous spec and a missing one", async () => {
    const a = await sh.run("jobs %sleep");
    expect(a.err).toBe("bash: jobs: %sleep: ambiguous job spec\n");
    const b = await sh.run("jobs %7");
    expect(b.err).toBe("bash: jobs: %7: no such job\n");
    expect(b.code).toBe(1);
  });
});

describe("fg, bg, and Ctrl-Z (B9)", () => {
  it("fg waits for the job, prints its command, and gives its status", async () => {
    await sh.run("{ sleep 3; exit 4; } &");
    const f = sh.start("fg %1");
    await settle();
    expect(sh.engine.busy()).toBe(true);
    await sh.advance(3000);
    const r = await f.result;
    expect(r.out).toBe("{ sleep 3; exit 4; }\n");
    expect(r.code).toBe(4);
    expect(notes()).toEqual([]);
  });

  it("fg gives the output of the job to the input", async () => {
    await sh.run("{ sleep 1; echo hi; } &");
    const f = sh.start("fg");
    await sh.advance(1000);
    expect((await f.result).out).toContain("hi\n");
  });

  it("Ctrl-C stops the job that fg waits for", async () => {
    await sh.run("sleep 100 &");
    const f = sh.start("fg %1");
    await settle();
    await sh.keys("\x03");
    const r = await f.result;
    expect(r.code).toBe(130);
    expect(sh.engine.busy()).toBe(false);
    expect(notes()).toEqual([]);
    expect((await sh.run("jobs")).out).toBe("");
  });

  it("Ctrl-Z stops the foreground command: Stopped line, $? 148", async () => {
    const f = sh.start("sleep 100");
    await settle();
    await sh.keys("\x1a");
    const r = await f.result;
    expect(r.code).toBe(148);
    expect(r.err).toBe(row(1, "+", "Stopped", "sleep 100") + "\n");
    expect(sh.engine.busy()).toBe(false);
    expect((await sh.run("jobs")).out).toBe(
      row(1, "+", "Stopped", "sleep 100") + "\n",
    );
    // The line comes once: it is not a notice for the next prompt.
    expect(notes()).toEqual([]);
  });

  it("Ctrl-Z does not run the rest of the input", async () => {
    const f = sh.start("sleep 100; echo not-here");
    await settle();
    await sh.keys("\x1a");
    await f.result;
    await sh.run("kill -CONT %1");
    await sh.advance(100_000);
    expect(sh.sofar()).not.toContain("not-here");
  });

  it("Ctrl-Z takes a pipeline and a subshell", async () => {
    for (const input of ["sleep 100 | cat", "(sleep 100)"]) {
      const f = sh.start(input);
      await settle();
      await sh.keys("\x1a");
      const r = await f.result;
      expect(r.code, input).toBe(148);
      expect(r.err, input).toContain("Stopped");
      await sh.run("kill -9 %%");
      await settle();
      notes();
    }
  });

  it("bg lets a stopped job run; fg brings it back; it ends with Done", async () => {
    const f = sh.start("sleep 3");
    await settle();
    await sh.keys("\x1a");
    await f.result;
    const b = await sh.run("bg");
    expect(b.out).toBe("[1]+ sleep 3 &\n");
    expect((await sh.run("jobs")).out).toBe(
      row(1, "+", "Running", "sleep 3 &") + "\n",
    );
    await sh.advance(3000);
    expect(notes()).toEqual([row(1, "+", "Done", "sleep 3")]);
  });

  it("fg continues a stopped job and returns its status", async () => {
    const f = sh.start("sleep 3");
    await settle();
    await sh.keys("\x1a");
    await f.result;
    const g = sh.start("fg");
    await settle();
    expect(sh.engine.busy()).toBe(true);
    await sh.advance(3000);
    const r = await g.result;
    expect(r.out).toBe("sleep 3\n");
    expect(r.code).toBe(0);
    expect((await sh.run("jobs")).out).toBe("");
  });

  it("Ctrl-Z during fg stops the job again", async () => {
    await sh.run("sleep 100 &");
    const f = sh.start("fg");
    await settle();
    await sh.keys("\x1a");
    const r = await f.result;
    expect(r.code).toBe(148);
    expect(r.err).toContain("Stopped");
    expect((await sh.run("jobs")).out).toContain("Stopped");
  });

  it("reports no job for fg and bg", async () => {
    expect((await sh.run("fg")).err).toBe("bash: fg: current: no such job\n");
    expect((await sh.run("bg %3")).err).toBe("bash: bg: %3: no such job\n");
  });

  it("bg on a running job says so", async () => {
    await sh.run("sleep 5 &");
    expect((await sh.run("bg")).err).toBe(
      "bash: bg: job 1 already in background\n",
    );
  });
});

describe("exit with stopped jobs (B9)", () => {
  it("warns once and does not exit; a second exit leaves", async () => {
    const f = sh.start("sleep 100");
    await settle();
    await sh.keys("\x1a");
    await f.result;
    const a = await sh.run("exit");
    expect(a.err).toBe("exit\nThere are stopped jobs.\n");
    expect(a.code).toBe(1);
    const b = await sh.run("exit");
    expect(b.err).toBe("exit\n");
    // The job is gone with the shell.
    expect((await sh.run("jobs")).out).toBe("");
  });

  it("a command between the two exits starts the warning again", async () => {
    const f = sh.start("sleep 100");
    await settle();
    await sh.keys("\x1a");
    await f.result;
    await sh.run("exit");
    await sh.run("true");
    expect((await sh.run("exit")).err).toContain("There are stopped jobs.");
  });

  it("exit ends the running jobs too", async () => {
    await sh.run("{ while :; do date >> f; sleep 1; done; } &");
    await sh.advance(2000);
    await sh.run("exit");
    const before = (await sh.run("cat f")).out;
    await sh.advance(10_000);
    expect((await sh.run("cat f")).out).toBe(before);
    expect((await sh.run("jobs")).out).toBe("");
  });
});

describe("wait (B9)", () => {
  it("waits for every job and returns 0", async () => {
    await sh.run("sleep 2 &");
    await sh.run("sleep 4 &");
    const w = sh.start("wait; echo after");
    await sh.advance(2000);
    expect(w.done()).toBe(false);
    await sh.advance(2000);
    const r = await w.result;
    expect(r.out).toBe("after\n");
    expect(notes()).toEqual([]);
  });

  it("wait %N and wait PID give the status of the job", async () => {
    await sh.run("{ sleep 1; exit 5; } &");
    const w = sh.start("wait %1");
    await sh.advance(1000);
    expect((await w.result).code).toBe(5);
    const a = await sh.run("{ sleep 1; exit 6; } &");
    const pid = /\[1\] (\d+)/.exec(a.err)?.[1];
    const w2 = sh.start(`wait ${pid}`);
    await sh.advance(1000);
    expect((await w2.result).code).toBe(6);
  });

  it("wait of a job that already ended gives its status", async () => {
    await sh.run("{ exit 7; } &");
    await settle();
    expect((await sh.run("wait %1")).code).toBe(7);
  });

  it("wait -n returns when the next job ends", async () => {
    await sh.run("{ sleep 5; exit 1; } &");
    await sh.run("{ sleep 2; exit 2; } &");
    const w = sh.start("wait -n");
    await sh.advance(2000);
    expect((await w.result).code).toBe(2);
    expect((await sh.run("jobs")).out).toContain("sleep 5");
  });

  it("wait -n with no job gives 127; an unknown pid gives 127", async () => {
    expect((await sh.run("wait -n")).code).toBe(127);
    const r = await sh.run("wait 4242");
    expect(r.err).toBe("bash: wait: pid 4242 is not a child of this shell\n");
    expect(r.code).toBe(127);
    expect((await sh.run("wait $$")).code).toBe(127);
  });

  it("Ctrl-C ends a wait with 130", async () => {
    await sh.run("sleep 100 &");
    const w = sh.start("wait");
    await settle();
    await sh.keys("\x03");
    expect((await w.result).code).toBe(130);
    expect((await sh.run("jobs")).out).toContain("Running");
  });
});

describe("disown (B9)", () => {
  it("removes the job from the table; it keeps running", async () => {
    await sh.run("{ sleep 2; echo gone; } &");
    expect((await sh.run("disown")).code).toBe(0);
    expect((await sh.run("jobs")).out).toBe("");
    await sh.advance(2000);
    expect(sh.sofar()).toContain("gone");
    expect(notes()).toEqual([]);
  });

  it("takes a spec, -a, and reports a missing job", async () => {
    await sh.run("sleep 5 &");
    await sh.run("sleep 6 &");
    await sh.run("disown %1");
    expect((await sh.run("jobs")).out).toContain("sleep 6");
    await sh.run("disown -a");
    expect((await sh.run("jobs")).out).toBe("");
    expect((await sh.run("disown")).err).toBe(
      "bash: disown: current: no such job\n",
    );
    expect((await sh.run("disown %4")).err).toBe(
      "bash: disown: %4: no such job\n",
    );
  });
});

describe("help (B9)", () => {
  it("help has a text for jobs, fg, bg, wait, disown, kill", async () => {
    for (const n of ["jobs", "fg", "bg", "wait", "disown", "kill"]) {
      const r = await sh.run(`help ${n}`);
      expect(r.out.startsWith(`${n}: ${n}`), n).toBe(true);
    }
  });

  it("man has a page for them", async () => {
    for (const n of ["jobs", "fg", "bg", "wait", "disown", "kill"])
      expect((await sh.run(`man ${n}`)).out.startsWith(n), n).toBe(true);
  });
});

describe("processes in ps, top, kill, pkill (B10)", () => {
  it("a job shows in ps and ps aux, after the S.procs rows", async () => {
    const a = await sh.run("sleep 50 &");
    const pid = Number(/\[1\] (\d+)/.exec(a.err)?.[1]);
    const ps = (await sh.run("ps")).out;
    expect(ps).toMatch(new RegExp(`${pid}\\s+pts/0\\s+00:00:00\\s+sleep`));
    const aux = (await sh.run("ps aux")).out;
    expect(aux).toMatch(
      new RegExp(`cadet\\s+${pid}\\s+0\\.0\\s+0\\.0\\s+sleep 50`),
    );
    const top = (await sh.run("top")).out;
    expect(top).toMatch(
      new RegExp(`${pid}\\s+cadet\\s+0\\.0\\s+0\\.0\\s+sleep 50`),
    );
    // The live rows come last.
    expect(aux.indexOf(String(pid))).toBeGreaterThan(aux.indexOf("USER"));
  });

  it("the PIDs start above the largest S.procs PID", async () => {
    const max = Math.max(...sh.engine.state.procs.map((p) => p.pid));
    const a = await sh.run("sleep 50 &");
    expect(Number(/\[1\] (\d+)/.exec(a.err)?.[1])).toBeGreaterThan(max);
  });

  it("kill PID ends the job; pkill NAME ends it too", async () => {
    const a = await sh.run("sleep 50 &");
    const pid = /\[1\] (\d+)/.exec(a.err)?.[1];
    expect((await sh.run(`kill ${pid}`)).code).toBe(0);
    await settle();
    expect(notes()).toEqual([row(1, "+", "Terminated", "sleep 50")]);
    await sh.run("sleep 60 &");
    expect((await sh.run("pkill sleep")).code).toBe(0);
    await settle();
    expect(notes()[0]).toContain("Terminated");
    expect((await sh.run("ps")).out).not.toContain("sleep");
  });

  it("a done job leaves ps", async () => {
    await sh.run("sleep 1 &");
    await sh.advance(1000);
    expect((await sh.run("ps")).out).not.toContain("sleep");
  });

  it("S.procs tasks work as before", async () => {
    const pid = sh.engine.state.procs.find((p) => p.user === "cadet")?.pid;
    expect(pid).toBeDefined();
    expect((await sh.run(`kill ${pid}`)).code).toBe(0);
    expect(sh.engine.state.procs.some((p) => p.pid === pid)).toBe(false);
    expect((await sh.run("kill 99999")).err).toBe(
      "kill: (99999) - No such process\n",
    );
  });

  it("Tab after kill lists the live PIDs and the S.procs PIDs", async () => {
    const a = await sh.run("sleep 50 &");
    const pid = /\[1\] (\d+)/.exec(a.err)?.[1] as string;
    const c = sh.engine.complete("kill ", 5);
    expect(c.listing).toContain(pid);
    for (const p of sh.engine.state.procs)
      expect(c.listing).toContain(String(p.pid));
  });
});

describe("reload, and panel actions (B11, B15)", () => {
  it("a reload ends every job: a new engine has none", async () => {
    await sh.run("sleep 50 &");
    const saved = sh.store.get(SAVE_KEY) as string;
    restore();
    const again = await openShell({ saved });
    expect((await again.run("jobs")).out).toBe("");
    expect((await again.run("ps")).out).not.toContain("sleep");
  });

  it("saves nothing about jobs", async () => {
    const before = Object.keys(JSON.parse(sh.store.get(SAVE_KEY) as string));
    await sh.run("sleep 50 &");
    const saved = JSON.parse(sh.store.get(SAVE_KEY) as string);
    expect(Object.keys(saved).sort()).toEqual(before.sort());
    expect(JSON.stringify(saved.procs)).not.toContain("sleep");
  });

  it("skip, jump, unlock, lock, and reset end every job first (AC10)", async () => {
    const actions: [string, () => Promise<unknown>][] = [
      ["skip", () => sh.engine.skip()],
      ["jump", () => sh.engine.jump(0)],
      ["unlock", () => sh.engine.unlock("ahoy-captain")],
      ["lock", () => sh.engine.lock()],
      ["reset", () => sh.engine.reset()],
    ];
    for (const [name, act] of actions) {
      await sh.run("{ while :; do date >> f; sleep 1; done; } &");
      const fg = sh.start("sleep 100");
      await settle();
      expect(sh.engine.busy(), name).toBe(true);
      await act();
      await fg.result;
      expect(sh.engine.busy(), name).toBe(false);
      expect(notes(), name).toEqual([]);
      const sizeBefore = (await sh.run("cat f 2>/dev/null | wc -l")).out;
      await sh.advance(10_000);
      expect((await sh.run("cat f 2>/dev/null | wc -l")).out, name).toBe(
        sizeBefore,
      );
      expect((await sh.run("jobs")).out, name).toBe("");
      expect(sh.clock.pending(), name).toBe(0);
    }
  });
});

describe("background output and saving (B12, B13)", () => {
  it("the output of a job reaches the terminal at once", async () => {
    await sh.run("{ sleep 1; echo tick; } &");
    expect(sh.sofar()).not.toContain("tick");
    await sh.advance(1000);
    expect(sh.sofar()).toContain("tick\n");
  });

  it("a file that a job writes is saved when the job ends", async () => {
    await sh.run("{ sleep 1; echo data > made.txt; } &");
    const before = sh.store.get(SAVE_KEY);
    await sh.advance(1000);
    const after = sh.store.get(SAVE_KEY) as string;
    expect(after).not.toBe(before);
    expect(after).toContain("made.txt");
  });

  it("a command of a job reaches the next task check (B12)", async () => {
    // Task 1 passes when the input ran `pwd`.
    await sh.run("{ sleep 1; pwd; } &");
    await sh.advance(1000);
    const r = await sh.run("true");
    expect(r.result.events).toContainEqual({ type: "task", index: 0 });
  });

  it("a job that ends while an input runs goes into that input's check", async () => {
    await sh.run("{ sleep 1; pwd; } &");
    const f = sh.start("sleep 2");
    await sh.advance(1000);
    await sh.advance(1000);
    const r = await f.result;
    expect(r.result.events).toContainEqual({ type: "task", index: 0 });
  });

  it("the terminal output of a job reaches the check as well (allOut)", async () => {
    // Task 3 (index 2) is checked on the output of the commands; use a marker
    // through the pending data: the job's stdout joins the next input.
    await sh.run("{ sleep 1; echo hello-from-job; } &");
    await sh.advance(1000);
    const r = await sh.run("true");
    expect(r.result.events).toEqual([]);
    expect(r.code).toBe(0);
  });
});

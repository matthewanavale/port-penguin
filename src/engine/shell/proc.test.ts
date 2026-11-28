// Phase A (B1, B2, B15, B19, B26): the async core. The processes of an input
// do not share a context; output streams through `onOutput`; `ExecResult.lines`
// holds only game lines; `chunks` stops at 1 MB; `Input` reads are async; awk
// replays its output and pipe runs in order; the process chain has a limit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../index";
import type { OutputEvent } from "../index";
import { Interp } from "./interp";
import { Run } from "./proc";
import type { Proc } from "./proc";
import { Context } from "./context";
import { Input } from "./io";
import { createHost } from "../linux";
import { fresh, setState } from "../state";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
  await sh.run("mkdir -p /tmp/w && cd /tmp/w");
});
afterEach(restore);

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("processes have contexts of their own (B2)", () => {
  it("keeps variables and cwd of a subshell, $( ), and a pipeline stage inside", async () => {
    const r = await sh.run(
      "X=top; (X=sub; cd /; echo $X $PWD); echo $(X=cs; cd /etc; echo $X $PWD); " +
        "echo p | { X=stage; cd /var; read v; echo $X $v; }; echo $X $PWD",
    );
    expect(r.out).toBe("sub /\ncs /etc\nstage p\ntop /tmp/w\n");
  });

  it("runs a script file and bash -c in a child that sees only exported variables", async () => {
    await sh.run(
      "printf 'echo [$A][$B]; A=changed\\n' > s.sh; A=1; export B=2",
    );
    const r = await sh.run("bash s.sh; echo $A");
    expect(r.out).toBe("[][2]\n1\n");
  });

  it("runs env CMD in a child process with the changed environment", async () => {
    const r = await sh.run("env Q=1 bash -c 'echo $Q'; echo [$Q]");
    expect(r.out).toBe("1\n[]\n");
  });

  it("runs the EXIT trap of a subshell in the subshell", async () => {
    const r = await sh.run("(trap 'echo bye $X' EXIT; X=1); echo [$X]");
    expect(r.out).toBe("bye 1\n[]\n");
  });

  it("gives each process its own counters, and ends a recursion by the chain limit (B18)", async () => {
    const r = await sh.run(
      "f(){ echo " + "$(".repeat(300) + "f" + ")".repeat(300) + "; }; f",
    );
    expect(r.text).toMatch(/port-penguin: \S+: nesting too deep \(1000\)/);
    expect(r.code).toBe(1);
  });

  it("holds `>( )` consumers of a child until the input ends", async () => {
    const r = await sh.run(
      "echo data | tee >(tr a-z A-Z > up.txt) > /dev/null; cat up.txt",
    );
    expect(r.out).toBe("");
    expect((await sh.run("cat up.txt")).out).toBe("DATA\n");
  });
});

describe("output streams through onOutput (B15)", () => {
  it("sends each chunk in write order, and the result holds the same chunks", async () => {
    const events: OutputEvent[] = [];
    const engine = createEngine({
      storage: memory(),
      onOutput: (e) => events.push(e),
    });
    await engine.start();
    const res = await engine.execute("echo one; echo two >&2; echo three");
    const seen = events.flatMap((e) => (e.kind === "chunk" ? [e.chunk] : []));
    expect(seen.map((c) => [c.stream, c.text])).toEqual([
      ["stdout", "one\n"],
      ["stderr", "two\n"],
      ["stdout", "three\n"],
    ]);
    expect(res.chunks).toEqual(seen);
    // `lines` holds game lines only: no command output.
    expect(res.lines.map((l) => l.runs.map((r) => r.text).join(""))).toEqual(
      [],
    );
  });

  it("sends a clear event for `clear`, from a subshell too", async () => {
    const events: OutputEvent[] = [];
    const engine = createEngine({
      storage: memory(),
      onOutput: (e) => events.push(e),
    });
    await engine.start();
    await engine.execute("echo a; (clear); echo b");
    expect(events.map((e) => e.kind)).toEqual(["chunk", "clear", "chunk"]);
  });

  it("does not send the output of ~/.bashrc", async () => {
    const events: OutputEvent[] = [];
    const engine = createEngine({
      storage: memory(),
      onOutput: (e) => events.push(e),
    });
    await engine.start();
    await engine.execute("true");
    expect(events).toEqual([]);
  });

  it("keeps game lines (hints, notes) out of the chunks", async () => {
    const r = await sh.run("nosuchcommand");
    expect(r.result.chunks.map((c) => c.text).join("")).toBe(
      "bash: nosuchcommand: command not found\n",
    );
    expect(r.text).toContain("Type help to see what this terminal knows.");
  });

  it("stops collecting `chunks` after the first 1 MB, and still sends every chunk", async () => {
    const run = new Run({ line: "", segs: [], ranExec: null, allOut: "" });
    const sent: number[] = [];
    const big = new Run(run.task, (e) => {
      if (e.kind === "chunk") sent.push(e.chunk.text.length);
    });
    const piece = "x".repeat(400_000);
    for (let i = 0; i < 4; i++) big.emit({ stream: "stdout", text: piece });
    expect(big.chunks.map((c) => c.text.length)).toEqual([400_000, 400_000]);
    expect(sent).toEqual([400_000, 400_000, 400_000, 400_000]);
  });
});

describe("Input reads are async (B26)", () => {
  it("reads a line, a chunk, and the rest from a text source", async () => {
    const i = new Input("ab\ncd\nef");
    expect(await i.readLine()).toEqual({ line: "ab", nl: true });
    expect(await i.readChunk(1)).toBe("c");
    expect(await i.readAll()).toBe("d\nef");
    expect(await i.readLine()).toBeNull();
    expect(await i.readChunk()).toBeNull();
    expect(i.eof).toBe(true);
  });

  it("gives the last line without a newline", async () => {
    const i = new Input("x");
    expect(await i.readLine()).toEqual({ line: "x", nl: false });
  });
});

describe("the Proc API (B2)", () => {
  function open(): Proc {
    setState(fresh());
    const ctx = new Context();
    ctx.cwd = "/home/cadet";
    return new Interp(createHost({ history: () => [] })).proc(ctx);
  }

  it("gives each process its own pid and shares the run", async () => {
    const p = open();
    const c = p.spawn(p.ctx.copy());
    expect(c.pid).not.toBe(p.pid);
    expect(c.run).toBe(p.run);
    expect(c.ctx).not.toBe(p.ctx);
  });

  it("starts a child with the counters of its parent, one process further down", () => {
    const p = open();
    p.depth = 3;
    p.nest = 2;
    p.scripts = 1;
    const c = p.spawn(p.ctx.copy());
    expect([c.depth, c.nest, c.scripts, c.chain]).toEqual([3, 2, 1, 1]);
  });

  it("runs a line and keeps the output in the run", async () => {
    const p = open();
    p.begin({ line: "echo hi", segs: [], ranExec: null, allOut: "" });
    expect(await p.runLine("echo hi")).toBe(0);
    expect(p.chunks.map((c) => c.text)).toEqual(["hi\n"]);
  });
});

describe("awk output order (B19, AC14)", () => {
  it("prints the sorted lines of a closed pipe, then the next print", async () => {
    const r = await sh.run(
      `awk 'BEGIN{print "b\\na" | "sort"; close("sort"); print "x"}'`,
    );
    expect(r.out).toBe("a\nb\nx\n");
  });

  it("runs a pipe command that is still open at the end of the program", async () => {
    const r = await sh.run(`awk 'BEGIN{print "b\\na" | "sort"; print "x"}'`);
    expect(r.out).toBe("x\na\nb\n");
  });

  it("keeps stdout and stderr in the order of writing", async () => {
    const r = await sh.run(
      `awk 'BEGIN{print "o1"; print "e1" > "/dev/stderr"; print "o2"}'`,
    );
    expect(r.result.chunks.map((c) => [c.stream, c.text])).toEqual([
      ["stdout", "o1\n"],
      ["stderr", "e1\n"],
      ["stdout", "o2\n"],
    ]);
  });

  it("reads all of stdin before its core runs", async () => {
    const r = await sh.run("printf 'a\\nb\\n' | awk '{print NR \":\" $0}'");
    expect(r.out).toBe("1:a\n2:b\n");
  });
});

describe("find -exec and xargs await the commands (B19)", () => {
  it("runs -exec and -exec ... + in order", async () => {
    await sh.run("touch a b");
    const r = await sh.run("find . -name '[ab]' -exec echo f:{} \\;");
    expect(r.out.split("\n").sort()).toEqual(["", "f:./a", "f:./b"]);
    expect((await sh.run("find . -name '[ab]' -exec echo {} +")).code).toBe(0);
  });

  it("runs xargs with a shell function in the middle of a pipe", async () => {
    const r = await sh.run("printf '1 2 3' | xargs -n1 echo n=");
    expect(r.out).toBe("n= 1\nn= 2\nn= 3\n");
  });
});

describe("time reads go through the engine clock (B5)", () => {
  it("shows the fake clock in date, and moves it with advance", async () => {
    const a = (await sh.run("date +%s")).out;
    await sh.advance(5000);
    const b = (await sh.run("date +%s")).out;
    expect(Number(b) - Number(a)).toBe(5);
  });

  it("starts $SECONDS at the clock, and counts the advance", async () => {
    await sh.advance(3000);
    expect((await sh.run("echo $SECONDS")).out).toMatch(/^[3-9]\n$/);
  });
});

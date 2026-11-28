// B3, B26: streamed pipes. The stages of a pipeline run at the same time and
// are joined by pipes of 64 KiB; a writer waits while the pipe is full; a write
// to a pipe that nobody reads ends the writer with SIGPIPE (status 141).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openShell, restore } from "../../test/engineHarness";
import type { Shell } from "../../test/engineHarness";
import { Pipe, PIPE_CAP, SigPipe } from "./pipe";

let sh: Shell;
beforeEach(async () => {
  sh = await openShell();
});
afterEach(restore);

describe("the pipe object (B3)", () => {
  it("holds data, ends at the close of its writer, and gives null", async () => {
    const p = new Pipe();
    p.write("abc");
    p.closeWriter();
    expect(await p.read(undefined, 2)).toBe("ab");
    expect(await p.read(undefined)).toBe("c");
    expect(await p.read(undefined)).toBeNull();
  });

  it("waits for data while a writer is open", async () => {
    const p = new Pipe();
    let got: string | null | undefined;
    const r = p.read(undefined).then((v) => (got = v));
    await Promise.resolve();
    expect(got).toBeUndefined();
    p.write("x");
    await r;
    expect(got).toBe("x");
  });

  it("is full at the cap, and a drain waits for a reader", async () => {
    const p = new Pipe();
    p.write("a".repeat(PIPE_CAP));
    expect(p.full).toBe(true);
    let drained = false;
    const d = p.drain(undefined).then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    await p.read(undefined, 10);
    await d;
    expect(p.full).toBe(false);
    expect(drained).toBe(true);
  });

  it("ends a write with SIGPIPE when no reader is left", () => {
    const p = new Pipe();
    p.closeReader();
    expect(() => p.write("x")).toThrow(SigPipe);
  });
});

describe("pipelines (AC3)", () => {
  it("yes | head -1 prints y, exits 0, and PIPESTATUS is 141 0", async () => {
    const r = await sh.run('yes | head -1; echo $? "${PIPESTATUS[@]}"');
    expect(r.out).toBe("y\n0 141 0\n");
  });

  it("gives the status of the last stage, and the status of a SIGPIPE stage", async () => {
    const r = await sh.run("yes | head -1 > /dev/null; echo ${PIPESTATUS[0]}");
    expect(r.out).toBe("141\n");
  });

  it("yes | head -c 100000 | wc -c prints 100000", async () => {
    const r = await sh.run("yes | head -c 100000 | wc -c");
    expect(r.out).toBe("100000\n");
  });

  it("seq 1 1000000 | grep -c 7 finishes without a limit stop", async () => {
    let n = 0;
    for (let i = 1; i <= 1_000_000; i++) if (String(i).includes("7")) n++;
    const r = await sh.run("seq 1 1000000 | grep -c 7");
    expect(r.out).toBe(`${n}\n`);
    expect(r.text).not.toContain("stopped");
  }, 30_000);

  it("seq 1 1000000 | wc -l counts a stream bigger than 1 MB", async () => {
    const r = await sh.run("seq 1 1000000 | wc -l");
    expect(r.out).toBe("1000000\n");
  }, 30_000);

  it("writes a before the clock moves 1 s and b after", async () => {
    const r = sh.start("(echo a; sleep 1; echo b) | cat");
    await sh.advance(0);
    expect(sh.sofar()).toBe("a\n");
    expect(r.done()).toBe(false);
    await sh.advance(1000);
    const res = await r.result;
    expect(res.out).toBe("a\nb\n");
  });

  it("a full pipe makes the writer wait until the reader reads", async () => {
    const r = sh.start("yes | (sleep 1; head -1)");
    await sh.advance(500);
    expect(r.done()).toBe(false);
    await sh.advance(500);
    const res = await r.result;
    expect(res.out).toBe("y\n");
  });

  it("keeps the order of the effects: the first stage runs first", async () => {
    const r = await sh.run("ls /nonexistent 2>&1 | cat; echo done");
    expect(r.out).toBe(
      "ls: cannot access '/nonexistent': No such file or directory\ndone\n",
    );
  });

  it("pipefail gives the last non-zero status", async () => {
    const r = await sh.run(
      "set -o pipefail; false | true; echo $?; true | false | true; echo $?",
    );
    expect(r.out).toBe("1\n1\n");
  });

  it("a stage that ends closes its pipes, so the next stage reads to the end", async () => {
    const r = await sh.run("echo one | cat | cat | wc -l");
    expect(r.out).toBe("1\n");
  });

  it("ends cat | cat at Ctrl-D", async () => {
    const r = sh.start("cat | cat");
    await sh.keys("hi\n");
    await sh.keys("\x04");
    const res = await r.result;
    expect(res.out).toBe("hi\n");
    expect(res.code).toBe(0);
  });

  it("ends cat | cat at Ctrl-C with status 130", async () => {
    const r = sh.start("cat | cat");
    await sh.keys("hi\n");
    await sh.keys("\x03");
    const res = await r.result;
    expect(res.code).toBe(130);
  });

  it("ends a pipeline with a sleep stage at Ctrl-C", async () => {
    const r = sh.start("sleep 100 | cat");
    await sh.advance(1);
    await sh.keys("\x03");
    const res = await r.result;
    expect(res.code).toBe(130);
  });

  it("does not leak the variables of a stage", async () => {
    const r = await sh.run("x=1; echo a | { read x; }; echo $x");
    expect(r.out).toBe("1\n");
  });
});

describe("stream commands (B26)", () => {
  it("head stops reading when it has enough", async () => {
    const r = await sh.run("printf 'a\\nb\\nc\\n' | head -2");
    expect(r.out).toBe("a\nb\n");
  });

  it("grep, tr, cut, uniq, tee, and cat read a stream", async () => {
    const r = await sh.run(
      "printf 'a1\\nb2\\na1\\nb3\\n' | grep -n b; " +
        "echo hello | tr a-z A-Z; " +
        "echo a:b:c | cut -d: -f2; " +
        "printf 'x\\nx\\ny\\n' | uniq -c; " +
        "echo out | tee t.txt; cat t.txt; " +
        "printf '1\\n2\\n' | cat -n",
    );
    expect(r.out).toBe(
      "2:b2\n4:b3\nHELLO\nb\n      2 x\n      1 y\nout\nout\n     1\t1\n     2\t2\n",
    );
  });

  it("wc counts words across chunk borders", async () => {
    const r = await sh.run("printf 'one two\\nthree' | wc");
    expect(r.out).toBe("      1       3      13\n");
  });

  it("sort and tail read the whole input", async () => {
    const r = await sh.run(
      "printf 'b\\na\\n' | sort; printf '1\\n2\\n3\\n' | tail -n 1",
    );
    expect(r.out).toBe("a\nb\n3\n");
  });
});

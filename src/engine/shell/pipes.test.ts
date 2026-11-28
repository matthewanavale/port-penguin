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

describe("the Phase C gaps (B4, B26)", () => {
  it("paste reads stdin as a stream: a row goes out when its lines are there", async () => {
    const r = sh.start("(echo a; sleep 1; echo b; echo c) | paste -d, - -");
    await sh.advance(0);
    await sh.advance(999);
    expect(sh.sofar()).toBe("");
    await sh.advance(1);
    const res = await r.result;
    // Every `-` takes the next line of the same input, as in GNU paste.
    expect(res.out).toBe("a,b\nc,\n");
  });

  it("paste gives a row at once with a file and stdin", async () => {
    await sh.run("printf '1\\n2\\n3\\n' > nums");
    const r = await sh.run("printf 'x\\ny\\n' | paste nums -");
    expect(r.out).toBe("1\tx\n2\ty\n3\t\n");
  });

  it("paste -s joins the lines of stdin", async () => {
    const r = await sh.run("printf 'a\\nb\\nc\\n' | paste -s -d+ -");
    expect(r.out).toBe("a+b+c\n");
  });

  it("xargs -n runs a batch as soon as it is full, before the input ends", async () => {
    const r = sh.start("(echo 1 2; sleep 1; echo 3 4) | xargs -n 2 echo");
    await sh.advance(0);
    expect(sh.sofar()).toBe("1 2\n");
    await sh.advance(1000);
    const res = await r.result;
    expect(res.out).toBe("1 2\n3 4\n");
  });

  it("xargs -I runs for each line while the writer goes on", async () => {
    const r = sh.start("(echo a; sleep 1; echo b) | xargs -I{} echo got-{}");
    await sh.advance(0);
    expect(sh.sofar()).toBe("got-a\n");
    await sh.advance(1000);
    expect((await r.result).out).toBe("got-a\ngot-b\n");
  });

  it("xargs stops reading at its -E marker and when its reader ends", async () => {
    const a = await sh.run("printf 'a\\nSTOP\\nb\\n' | xargs -E STOP");
    expect(a.out).toBe("a\n");
    const b = await sh.run("yes | xargs -n 1 echo | head -2");
    expect(b.out).toBe("y\ny\n");
  });

  it("xargs with quotes that cross a chunk still joins one word", async () => {
    const r = await sh.run(
      '(printf "\'a b"; printf " c\' d\\n") | xargs -n 1 echo',
    );
    expect(r.out).toBe("a b c\nd\n");
  });

  it("xargs with no input runs the command once, and -r does not", async () => {
    expect((await sh.run("true | xargs echo none")).out).toBe("none\n");
    expect((await sh.run("true | xargs -r echo none")).out).toBe("");
  });

  it("grep -A, -B, and -C stream stdin", async () => {
    const r = sh.start(
      "(echo a; echo b; echo HIT; echo c; echo d; echo e; sleep 1; echo HIT2; echo f) | grep -n -B1 -A1 HIT",
    );
    await sh.advance(0);
    expect(sh.sofar()).toBe("2-b\n3:HIT\n4-c\n");
    await sh.advance(1000);
    const res = await r.result;
    expect(res.out).toBe("2-b\n3:HIT\n4-c\n--\n6-e\n7:HIT2\n8-f\n");
  });

  it("grep -C and a numeric -2 keep the window, and -m stops the read", async () => {
    const a = await sh.run("seq 1 9 | grep -C1 5");
    expect(a.out).toBe("4\n5\n6\n");
    const b = await sh.run("seq 1 9 | grep -2 5");
    expect(b.out).toBe("3\n4\n5\n6\n7\n");
    const c = await sh.run("yes | grep -m1 -A1 y");
    expect(c.out).toBe("y\ny\n");
    expect(c.code).toBe(0);
  });

  it("grep context keeps -v, -c, and a group separator across matches", async () => {
    const a = await sh.run("seq 1 7 | grep -v -A1 '[2-6]'");
    expect(a.out).toBe("1\n2\n--\n7\n");
    const b = await sh.run("seq 1 7 | grep -c -A1 3");
    expect(b.out).toBe("1\n");
  });

  it("grep reads stdin in its place in a list of files", async () => {
    await sh.run("printf 'one\\nHIT file\\n' > f1");
    await sh.run("printf 'HIT two\\n' > f2");
    const r = await sh.run("printf 'x\\nHIT in\\n' | grep HIT f1 - f2");
    expect(r.out).toBe("f1:HIT file\n(standard input):HIT in\nf2:HIT two\n");
    const c = await sh.run("printf 'HIT\\nHIT\\n' | grep -c HIT f1 -");
    expect(c.out).toBe("f1:1\n(standard input):2\n");
  });

  it("read -t times out on a pipe with status 142, as on the terminal", async () => {
    const r = sh.start(
      "(sleep 5; echo late) | { read -t 1 v; echo status=$? v=[$v]; }",
    );
    await sh.advance(0);
    expect(sh.sofar()).toBe("");
    await sh.advance(1000);
    expect(sh.sofar()).toBe("status=142 v=[]\n");
    await sh.advance(4000);
    expect((await r.result).out).toBe("status=142 v=[]\n");
  });

  it("read -t gives the line when the data comes in time", async () => {
    const r = sh.start(
      "(sleep 1; echo fast) | { read -t 3 v; echo status=$? v=[$v]; }",
    );
    await sh.advance(1000);
    expect((await r.result).out).toBe("status=0 v=[fast]\n");
  });

  it("read -t 0 on a pipe checks for data without a wait", async () => {
    const r = await sh.run("echo x | { read -t 0 v; echo status=$?; }");
    expect(r.out).toBe("status=0\n");
  });

  it("a timeout does not end the input: the next read still gets the data", async () => {
    const r = sh.start(
      "(sleep 2; echo later) | { read -t 1 a; echo a=$?; read b; echo b=$b; }",
    );
    await sh.advance(1000);
    await sh.advance(1000);
    expect((await r.result).out).toBe("a=142\nb=later\n");
  });
});

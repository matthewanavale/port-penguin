// D10: the `ctx` that task checks receive. One test each for `segs`, `line`,
// `allOut`, and `ranExec`. The tests put a recording check in place of the
// check of the current task and run one input.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { M } from "../engine/index";
import type { Ctx } from "../engine/shell/io";
import { openShell, restore } from "./engineHarness";
import type { Shell } from "./engineHarness";

type Check = (c: Ctx) => boolean;

let sh: Shell;
let original: Check;
let seen: Ctx[];
const TASK = 0;

beforeEach(() => {
  sh = openShell();
  sh.run("mkdir -p /tmp/w && cd /tmp/w");
  original = M[TASK].check as Check;
  seen = [];
  M[TASK].check = (c: Ctx) => {
    seen.push(c);
    return false;
  };
  sh.engine.state.cur = TASK;
});
afterEach(() => {
  M[TASK].check = original;
  restore();
});

const ctxOf = (input: string): Ctx => {
  seen = [];
  sh.run(input);
  expect(seen.length).toBeGreaterThan(0);
  return seen[seen.length - 1];
};

describe("ctx rules (D10)", () => {
  it("segs: one list per simple command that ended with 0, after expansion, in run order", () => {
    const c = ctxOf(
      [
        "n=2",
        "echo a $n | tr a b",
        "false",
        "if true; then echo in; fi",
        "( echo sub )",
        "f() { echo fn; }",
        "f",
        "echo $(echo cs)",
        "X=1",
      ].join("\n"),
    );
    const flat = c.segs.map((s) => s.join(" "));
    expect(flat).toContain("echo a 2");
    expect(flat).toContain("tr a b");
    expect(flat.indexOf("echo a 2")).toBeLessThan(flat.indexOf("tr a b"));
    expect(flat).not.toContain("false");
    expect(flat).toContain("true");
    expect(flat).toContain("echo in");
    expect(flat).toContain("echo sub");
    expect(flat).toContain("echo fn");
    expect(flat).toContain("echo cs");
    expect(c.segs).toContainEqual(["X=1"]);
  });

  it("segs: includes commands inside scripts, loops, and conditions", () => {
    sh.run("printf 'echo from-script\\n' > s.sh");
    const c = ctxOf(
      "bash s.sh; while false; do :; done; for i in 1; do echo loop; done",
    );
    const flat = c.segs.map((s) => s.join(" "));
    expect(flat).toContain("echo from-script");
    expect(flat).toContain("echo loop");
  });

  it("line: the full input, lines joined with a newline", () => {
    const c = ctxOf("if true; then\necho x\nfi");
    expect(c.line).toBe("if true; then\necho x\nfi");
  });

  it("allOut: stdout that reached the terminal, not piped, redirected, or captured", () => {
    sh.run("printf 'echo script-out\\n' > s.sh");
    const c = ctxOf(
      "echo shown; echo piped | cat > /dev/null; echo redirected > f; x=$(echo captured); bash s.sh",
    );
    expect(c.allOut).toContain("shown");
    expect(c.allOut).toContain("script-out");
    expect(c.allOut).not.toContain("redirected");
    expect(c.allOut).not.toContain("captured");
    expect(c.allOut).not.toContain("piped");
  });

  it("ranExec: the basename of the last script run by its path; bash x and source x do not set it", () => {
    sh.run("printf 'echo hi\\n' > x; chmod +x x");
    expect(ctxOf("./x").ranExec).toBe("x");
    expect(ctxOf("/tmp/w/x").ranExec).toBe("x");
    expect(ctxOf("bash x").ranExec).toBeNull();
    expect(ctxOf("source x").ranExec).toBeNull();
    sh.run("printf 'echo hi\\n' > y; chmod +x y");
    expect(ctxOf("./x; ./y").ranExec).toBe("y");
  });
});

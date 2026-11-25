// Phase C: the host command table, run on the interpreter without the engine.
// The script cases of the Ubuntu fixtures that this table can answer are
// compared here; the full reference test (reference.test.ts) uses the engine.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeDate,
  seededRandom,
  SEED,
  START_MS,
} from "../test/determinism";
import { CASES, SCRIPT_PATH } from "../test/ubuntu/cases";
import type { PromptCase, ScriptCase } from "../test/ubuntu/cases";
import { HOME_FILES } from "../test/ubuntu/home";
import * as home from "../test/ubuntu/home";
import { normalize } from "../test/ubuntu/normalize";
import {
  USR_BIN,
  SKEL_BASHRC,
  SKEL_PROFILE,
  SKEL_BASH_LOGOUT,
} from "./content";
import { CMDS, createHost, EXTERNAL } from "./linux";
import { Context } from "./shell/context";
import { Interp } from "./shell/interp";
import { fresh, setState } from "./state";
import type { DirNode, FileNode } from "./state";

const NL = String.fromCharCode(10);
const file = (x: string, m = "rw-r--r--"): FileNode => ({ t: "f", x, m });

function open(script?: string): Interp {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const s = fresh();
  const homeDir = (s.fs.c.home as DirNode).c.cadet as DirNode;
  homeDir.c = {};
  for (const h of HOME_FILES) homeDir.c[h.path] = file(h.content);
  const tmp = s.fs.c.tmp as DirNode;
  tmp.c = {};
  if (script !== undefined) tmp.c["case.sh"] = file(script);
  setState(s);
  const ctx = new Context();
  ctx.cwd = "/home/cadet";
  return new Interp(createHost({ history: () => [] }), ctx);
}

function run(sh: Interp, text: string) {
  sh.begin({ line: text, segs: [], ranExec: null, allOut: "" });
  const code = sh.runLine(text);
  const part = (st: string) =>
    sh.chunks
      .filter((c) => c.stream === st)
      .map((c) => c.text)
      .join("");
  return { out: part("stdout"), err: part("stderr"), code };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const files = import.meta.glob<{
  cases: {
    id: string;
    kind: string;
    stdout?: string;
    stderr?: string;
    code?: number;
  }[];
}>("../test/ubuntu/fixtures/*.json", { eager: true, import: "default" });
const fx = new Map<
  string,
  { stdout?: string; stderr?: string; code?: number }
>();
for (const f of Object.values(files)) for (const c of f.cases) fx.set(c.id, c);

describe("host table against the script fixtures", () => {
  for (const c of CASES.filter((x) => x.kind === "script") as ScriptCase[]) {
    it(c.id, () => {
      const want = fx.get(c.id);
      if (!want) return;
      const sh = open(c.lines.join("\n") + "\n");
      const r = run(sh, `bash ${SCRIPT_PATH}`);
      expect({
        stdout: normalize(r.out),
        stderr: normalize(r.err),
        code: r.code,
      }).toEqual({
        stdout: normalize(want.stdout as string),
        stderr: normalize(want.stderr as string),
        code: want.code,
      });
    });
  }
});

describe("prompt cases of the skel home", () => {
  for (const c of CASES.filter(
    (x) => x.kind === "prompt" && x.id.startsWith("skel-"),
  ) as PromptCase[]) {
    it(c.id, () => {
      const want = fx.get(c.id) as unknown as { transcript: string };
      const sh = open();
      sh.ctx.interactive = true;
      sh.ctx.exported.add("LS_COLORS");
      expect(sh.runRc(SKEL_BASHRC)).toBeNull();
      const disp = () =>
        "cadet@port-penguin:" +
        (sh.ctx.cwd === "/home/cadet" ? "~" : sh.ctx.cwd) +
        "$ ";
      let t = disp();
      for (const input of c.inputs) {
        t += input + NL;
        sh.begin({ line: input, segs: [], ranExec: null, allOut: "" });
        sh.runLine(input);
        t += sh.chunks.map((k) => k.text).join("");
        t += disp();
      }
      expect(normalize(t)).toBe(normalize(want.transcript));
    });
  }
});

describe("table contents", () => {
  it("lists every command of the table, but hint, in /usr/bin", () => {
    expect([...USR_BIN].sort()).toEqual(EXTERNAL);
    expect(Object.keys(CMDS)).toContain("hint");
  });

  it("keeps the skel files equal to the capture files", () => {
    expect(SKEL_BASHRC).toBe(home.SKEL_BASHRC);
    expect(SKEL_PROFILE).toBe(home.SKEL_PROFILE);
    expect(SKEL_BASH_LOGOUT).toBe(home.SKEL_BASH_LOGOUT);
  });

  it("runs a command by its /usr/bin path", () => {
    const sh = open();
    expect(run(sh, "/usr/bin/printenv HOME").out).toBe("/home/cadet\n");
  });

  it("resolves relative paths against the cwd of a subshell", () => {
    const sh = open();
    expect(run(sh, "mkdir /tmp/w; (cd /tmp/w; touch a; ls)").out).toBe("a\n");
  });
});

describe("commands beyond the fixtures", () => {
  const out = (sh: Interp, t: string) => run(sh, t).out;

  it("grep: context, count, -o, -r, and exit codes", () => {
    const sh = open();
    run(
      sh,
      "printf 'a\nb\nc\nb\nd\n' > /tmp/f; mkdir /tmp/d; echo b > /tmp/d/x",
    );
    expect(out(sh, "grep -n b /tmp/f")).toBe("2:b\n4:b\n");
    expect(out(sh, "grep -c b /tmp/f")).toBe("2\n");
    expect(out(sh, "grep -A1 a /tmp/f")).toBe("a\nb\n");
    expect(out(sh, String.raw`grep -o 'b\|c' /tmp/f`)).toBe("b\nc\nb\n");
    expect(out(sh, "grep -r b /tmp/d")).toBe("/tmp/d/x:b\n");
    expect(run(sh, "grep zzz /tmp/f").code).toBe(1);
    expect(run(sh, "grep zzz /tmp/nofile").code).toBe(2);
  });

  it("sort: keys, numbers, and unique", () => {
    const sh = open();
    expect(out(sh, "printf 'b 2\na 10\nc 1\n' | sort -k2 -n")).toBe(
      "c 1\nb 2\na 10\n",
    );
    expect(out(sh, "printf 'b\na\nb\n' | sort -u")).toBe("a\nb\n");
  });

  it("wc: pads like GNU wc", () => {
    const sh = open();
    expect(out(sh, "echo hi | wc")).toBe("      1       1       3\n");
    expect(out(sh, "echo hi | wc -l")).toBe("1\n");
  });

  it("rm and mkdir refuse outside the writable folders", () => {
    const sh = open();
    expect(run(sh, "rm -rf /").err).toContain("dangerous");
    expect(run(sh, "mkdir /etc/x").err).toBe(
      "mkdir: cannot create directory ‘/etc/x’: Permission denied\n",
    );
    expect(run(sh, "rm /etc/hostname").err).toBe(
      "rm: cannot remove '/etc/hostname': Permission denied\n",
    );
  });

  it("cp, mv, and chmod follow the GNU messages", () => {
    const sh = open();
    run(sh, "echo x > /tmp/a; mkdir /tmp/d");
    expect(run(sh, "cp /tmp/d /tmp/e").err).toBe(
      "cp: -r not specified; omitting directory '/tmp/d'\n",
    );
    expect(run(sh, "mv /tmp/nothing /tmp/e").err).toBe(
      "mv: cannot stat '/tmp/nothing': No such file or directory\n",
    );
    run(sh, "chmod u=rwx,go=rx /tmp/a");
    expect(out(sh, "stat -c %A /tmp/a")).toBe("-rwxr-xr-x\n");
    expect(run(sh, "chmod zz /tmp/a").err).toContain("invalid mode: ‘zz’");
  });

  it("ls: quotes odd names on a terminal and lists in columns", () => {
    const sh = open();
    run(sh, "mkdir /tmp/w; cd /tmp/w; touch 'a b' c");
    expect(out(sh, "ls")).toBe("'a b'   c\n");
    expect(out(sh, "ls | cat")).toBe("a b\nc\n");
  });

  it("env -i and -u hide variables from the command they run", () => {
    const sh = open();
    expect(out(sh, "env -i A=1 env")).toBe("A=1\n");
    expect(out(sh, "env -u HOME printenv HOME")).toBe("");
  });
});

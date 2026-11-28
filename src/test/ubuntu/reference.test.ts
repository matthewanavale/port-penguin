// AC2: every reference case gives on the simulator what real Ubuntu 24.04
// gave in the fixture (D7, D8). Prompt cases compare the merged transcript;
// script cases compare stdout, stderr, and the exit code. Both sides pass
// through the one shared normalizer.
//
// Engine contract used here (src/engine/index.ts), new in this run:
//   createEngine({ storage, clock })    the width is 80 columns (D23)
//   engine.prompt(): Run[]              "> " while input is incomplete (AC1)
//   engine.isComplete(text): boolean
//   engine.cancelInput(): void          Ctrl-C at "> " (D6 of the Scope list)
//   (await engine.execute(text)).chunks ordered { stream, text } (D24); the
//                                       learner hints (D12) are not in them
//   engine.state.lastCode               the exit code after the input
import { afterEach, describe, expect, it, vi } from "vitest";
import { setClock } from "../../engine/clock";
import { createEngine, SAVE_KEY } from "../../engine/index";
import type { Engine } from "../../engine/index";
import { fresh } from "../../engine/state";
import type { DirNode, FileNode } from "../../engine/state";
import {
  drive,
  makeFakeClock,
  seededRandom,
  SEED,
  START_MS,
} from "../determinism";
import type { FakeEngineClock } from "../determinism";
import { openShell, restore } from "../engineHarness";
import { CASES, FEATURES, SCRIPT_PATH, promptStep } from "./cases";
import type { Case, PromptCase, ScriptCase } from "./cases";
import { HOME_FILES } from "./home";
import { normalize } from "./normalize";

interface FixtureCase {
  id: string;
  kind: "prompt" | "script";
  feature: string;
  input: string[];
  transcript?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}
interface FixtureFile {
  image: string;
  cases: FixtureCase[];
}

const files = import.meta.glob<FixtureFile>("./fixtures/*.json", {
  eager: true,
  import: "default",
});
const fixtures = new Map<string, FixtureCase>();
for (const file of Object.values(files))
  for (const c of file.cases) fixtures.set(c.id, c);

const file = (x: string, m = "rw-r--r--"): FileNode => ({ t: "f", x, m });

/** A save whose home holds only the D7 capture files, and whose /tmp is empty. */
function referenceSave(scriptText?: string): string {
  const s = fresh();
  const home = (s.fs.c.home as DirNode).c.cadet as DirNode;
  home.c = {};
  for (const h of HOME_FILES) home.c[h.path] = file(h.content);
  const tmp = s.fs.c.tmp as DirNode;
  tmp.c = {};
  if (scriptText !== undefined) tmp.c["case.sh"] = file(scriptText);
  // Tasks must not interfere: the game is at the last task.
  s.done = Array.from({ length: 70 }, (_, i) => i);
  s.cur = 70;
  return JSON.stringify(s);
}

async function open(scriptText?: string): Promise<[Engine, FakeEngineClock]> {
  const clock = makeFakeClock(START_MS);
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>([
    [SAVE_KEY, referenceSave(scriptText)],
  ]);
  const engine = createEngine({
    clock,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  await engine.start();
  return [engine, clock];
}

const promptText = (e: Engine): string =>
  e
    .prompt()
    .map((r) => r.text)
    .join("");

/** The simulator side of a prompt case, in the shape of the capture (D8). */
async function simulatePrompt(c: PromptCase): Promise<string> {
  const [e, clock] = await open();
  let t = promptText(e);
  let pending: string[] = [];
  for (const input of c.inputs) {
    if (input === "^C") {
      e.cancelInput();
      pending = [];
      t += "^C\n" + promptText(e);
      continue;
    }
    t += input + "\n";
    pending.push(input);
    const text = pending.join("\n");
    if (!e.isComplete(text)) {
      t += promptText(e);
      continue;
    }
    pending = [];
    t += (await drive(e.execute(text), clock)).chunks
      .map((k) => k.text)
      .join("");
    t += promptText(e);
  }
  return t;
}

/**
 * The simulator side of a prompt case that types or waits (B20). A line step
 * starts an input. A command that still runs when the next line step comes ends
 * first, on the fake clock, as the capture waits for the prompt. `@type` and
 * `@raw` go to the tty, `@key` is a signal or Ctrl-D, `@wait` moves the clock.
 */
async function simulateAsyncPrompt(c: PromptCase): Promise<string> {
  const sh = await openShell({ saved: referenceSave() });
  // The capture pty has no width, so a `select` menu is one item a row.
  sh.engine.setColumns(1);
  const prompt = (): string =>
    sh.engine
      .prompt()
      .map((r) => r.text)
      .join("");
  const noticeText = (): string =>
    sh.engine
      .notices()
      .filter((n) => n.text)
      .map((n) => n.text + "\n")
      .join("");
  let t = prompt();
  let pending: string[] = [];
  let running: ReturnType<typeof sh.start> | null = null;
  let seenOut = 0;
  let seenEcho = 0;
  /** The text of the running input, where its output starts in `t`, and the depth of nested shells. */
  let lastInput = "";
  let mark = 0;
  let depth = 0;
  let exited = false;
  /**
   * Adds what the running input wrote and what the tty echoed since the last
   * call. A key press echoes before the command reacts, so the echo goes first.
   */
  const flow = (): void => {
    const echo = sh.echoed();
    t += echo.slice(seenEcho);
    seenEcho = echo.length;
    if (!running) return;
    const out = sh.sofar();
    t += out.slice(seenOut);
    seenOut = out.length;
  };
  /** Ends the running input: moves the clock until it is done. */
  const finish = async (): Promise<void> => {
    if (!running) return;
    for (let i = 0; i < 400 && !running.done(); i++) await sh.advance(50);
    if (!running.done()) throw new Error(`${c.id}: the command does not end`);
    flow();
    const r = await running.result;
    // `sofar` ends with the input; the rest of the foreground text is in the result.
    t += r.both.slice(seenOut);
    running = null;
    // The game keeps its prompt after the last `exit`; the capture ends there.
    const word = lastInput.trim();
    if (word === "bash" || word === "sh") depth++;
    else if (/^exit(\s|$)/.test(word)) {
      if (depth > 0) depth--;
      else if (!t.slice(mark).includes("There are stopped jobs."))
        exited = true;
    }
    if (!exited) t += noticeText() + prompt();
  };
  for (const raw of c.inputs) {
    const step = promptStep(raw);
    if (step.kind === "line" || step.kind === "ctrl-c-at-prompt") {
      await finish();
      if (step.kind === "ctrl-c-at-prompt") {
        sh.engine.cancelInput();
        pending = [];
        t += "^C\n" + prompt();
        continue;
      }
      t += step.text + "\n";
      pending.push(step.text);
      const text = pending.join("\n");
      if (!sh.engine.isComplete(text)) {
        t += prompt();
        continue;
      }
      pending = [];
      seenEcho = sh.echoed().length;
      seenOut = 0;
      lastInput = text;
      mark = t.length;
      running = sh.start(text);
      await sh.advance(0);
      if (running.done()) await finish();
      else flow();
    } else if (step.kind === "type" || step.kind === "raw") {
      flow();
      await sh.keys(step.kind === "type" ? step.text + "\n" : step.text);
      flow();
    } else if (step.kind === "key") {
      flow();
      await sh.keys(step.byte);
      flow();
      if (running?.done()) await finish();
    } else {
      flow();
      await sh.advance(step.ms);
      flow();
      if (running?.done()) await finish();
    }
  }
  await finish();
  restore();
  return t;
}

async function simulateScript(c: ScriptCase) {
  const [e, clock] = await open(c.lines.join("\n") + "\n");
  const r = await drive(e.execute(`bash ${SCRIPT_PATH} < /dev/null`), clock);
  const part = (stream: "stdout" | "stderr") =>
    r.chunks
      .filter((k) => k.stream === stream)
      .map((k) => k.text)
      .join("");
  return {
    stdout: part("stdout"),
    stderr: part("stderr"),
    code: e.state.lastCode,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setClock();
});

describe("reference case list (AC2)", () => {
  it("has a case for every AC3 and AC4 item", () => {
    const covered = new Set(CASES.map((c) => c.feature));
    expect(FEATURES.filter((f) => !covered.has(f))).toEqual([]);
  });

  it("names only features from the list", () => {
    const known = new Set(FEATURES);
    expect(CASES.filter((c) => !known.has(c.feature)).map((c) => c.id)).toEqual(
      [],
    );
  });

  it("has unique case ids", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a fixture for every case, recorded against the pinned image", () => {
    expect(CASES.filter((c) => !fixtures.has(c.id)).map((c) => c.id)).toEqual(
      [],
    );
    for (const file of Object.values(files))
      expect(file.image).toMatch(/^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
  });

  it("keeps the fixtures in step with the case inputs", () => {
    for (const c of CASES) {
      const fx = fixtures.get(c.id);
      if (!fx) continue;
      const input = c.kind === "prompt" ? c.inputs : c.lines;
      expect(fx.input, c.id).toEqual(input);
    }
  });
});

describe("shared normalizer (AC2)", () => {
  it("removes carriage returns and ANSI sequences", () => {
    expect(normalize("a\r\n\x1b[31mred\x1b[0m\x1b]0;t\x07")).toBe("a\nred");
  });

  it("replaces times, dates, and the host name with fixed tokens", () => {
    expect(normalize("Tue Nov 24 09:00:00 UTC 2026")).toBe("<DATE>");
    expect(normalize("-rw-r--r-- 1 cadet cadet 5 Nov 24 09:00 f")).toBe(
      "-rw-r--r-- 1 cadet cadet 5 <LSTIME> f",
    );
    expect(normalize("2026-11-24 09:00:00.123456789 +0000")).toBe("<ISOTIME>");
    expect(normalize("cadet@port-penguin:~$ ")).toBe("cadet@<HOST>:~$ ");
  });

  it("drops the env lines the simulator does not print, and keeps others", () => {
    expect(
      normalize("TERM=dumb\nHOME=/h\nSHLVL=1\n_=/x\nTZ=UTC\nCOLUMNS=80"),
    ).toBe("HOME=/h");
  });

  it("normalizes df rows and header widths", () => {
    expect(
      normalize(
        "Filesystem      Size  Used Avail Use% Mounted on\noverlay          59G   12G   44G  22% /",
      ),
    ).toBe(
      "Filesystem Size Used Avail Use% Mounted on\noverlay <SIZE> <SIZE> <SIZE> <PCT> /",
    );
  });
});

describe("simulator against Ubuntu 24.04 (AC2)", () => {
  for (const c of CASES as Case[]) {
    it(`${c.id} (${c.feature})`, async () => {
      const fx = fixtures.get(c.id);
      expect(fx, `no fixture for ${c.id}`).toBeDefined();
      if (!fx) return;
      if (c.kind === "prompt") {
        const usesSteps =
          c.group === "async" || c.inputs.some((i) => i.startsWith("@"));
        expect(
          normalize(
            await (usesSteps ? simulateAsyncPrompt(c) : simulatePrompt(c)),
          ),
        ).toBe(normalize(fx.transcript as string));
      } else {
        const got = await simulateScript(c);
        expect({
          stdout: normalize(got.stdout),
          stderr: normalize(got.stderr),
          code: got.code,
        }).toEqual({
          stdout: normalize(fx.stdout as string),
          stderr: normalize(fx.stderr as string),
          code: fx.code,
        });
      }
    });
  }
});

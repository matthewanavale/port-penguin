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
import { CASES, FEATURES, SCRIPT_PATH } from "./cases";
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

async function simulateScript(c: ScriptCase) {
  const [e, clock] = await open(c.lines.join("\n") + "\n");
  const r = await drive(e.execute(`bash ${SCRIPT_PATH}`), clock);
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
        expect(normalize(await simulatePrompt(c))).toBe(
          normalize(fx.transcript as string),
        );
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

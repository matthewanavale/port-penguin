// A small helper for the unit tests of the shell: a fresh engine on an
// in-memory save, a fake clock, and `run()` that gives the ordered stdout
// and stderr chunks (D24), the plain terminal text, and the exit code.
// The engine contract it relies on is listed in src/test/ubuntu/reference.test.ts.
import { vi } from "vitest";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { Chunk, Engine, ExecResult } from "../engine/index";
import type { OutLine } from "../engine/output";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";

export const plainText = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

export interface RunResult {
  /** stdout that reached the terminal. */
  out: string;
  /** stderr that reached the terminal. */
  err: string;
  /** stdout and stderr in the order written. */
  both: string;
  /** Plain text of the terminal lines, with the learner hints (D12). */
  text: string;
  code: number;
  result: ExecResult;
}

export interface Shell {
  engine: Engine;
  store: Map<string, string>;
  /** Runs one complete input and returns what it wrote. */
  run(input: string): RunResult;
  /** Runs several inputs; returns the last result. */
  runAll(...inputs: string[]): RunResult;
  advance(ms: number): void;
  /** Plain text of what `engine.start()` printed (the setup alert, the D19 line). */
  startText: string;
}

export interface ShellOptions {
  saved?: string;
  /** Other storage keys that exist before the start (for example the rc marker). */
  keys?: Record<string, string>;
  /** Replaces `setItem`, for the save-failure tests. */
  setItem?: (key: string, value: string) => void;
}

/** Opens a fresh game. Call `restore()` from `afterEach`. */
export function openShell(opts: ShellOptions = {}): Shell {
  const clock = makeFakeDate(START_MS);
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now() });
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  if (opts.saved !== undefined) store.set(SAVE_KEY, opts.saved);
  for (const [k, v] of Object.entries(opts.keys ?? {})) store.set(k, v);
  const engine = createEngine({
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (opts.setItem) opts.setItem(k, v);
        else store.set(k, v);
      },
    },
  });
  const startText = plainText(engine.start());
  const part = (cs: Chunk[], stream: Chunk["stream"]) =>
    cs
      .filter((c) => c.stream === stream)
      .map((c) => c.text)
      .join("");
  const run = (input: string): RunResult => {
    const result = engine.execute(input);
    // Until the engine writes chunks (D24) a result has none; the tests then
    // fail on their assertions, not on a missing field.
    const chunks: Chunk[] = (result as { chunks?: Chunk[] }).chunks ?? [];
    return {
      out: part(chunks, "stdout"),
      err: part(chunks, "stderr"),
      both: chunks.map((c) => c.text).join(""),
      text: plainText(result.lines),
      code: engine.state.lastCode,
      result,
    };
  };
  return {
    engine,
    store,
    startText,
    run,
    runAll(...inputs: string[]) {
      let r = run("true");
      for (const i of inputs) r = run(i);
      return r;
    },
    advance(ms: number) {
      clock.advance(ms);
      vi.setSystemTime(clock.now());
    },
  };
}

export function restore(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
}

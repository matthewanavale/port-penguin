// A small helper for the unit tests of the shell: a fresh engine on an
// in-memory save, a fake engine clock (B5), and `run()` that gives the ordered
// stdout and stderr chunks (D24), the plain terminal text, and the exit code.
// The engine streams its output through `onOutput` (B15); the harness collects
// the events of each input and builds the terminal text from them.
// The engine contract it relies on is listed in src/test/ubuntu/reference.test.ts.
import { vi } from "vitest";
import { setClock } from "../engine/clock";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { Chunk, Engine, ExecResult, OutputEvent } from "../engine/index";
import { chunkLines } from "../engine/output";
import type { OutLine } from "../engine/output";
import { makeFakeClock, seededRandom, SEED, START_MS } from "./determinism";
import type { FakeEngineClock } from "./determinism";

export const plainText = (lines: OutLine[]): string =>
  lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

/**
 * Collects the `onOutput` events of one input, and builds what the old
 * synchronous engine gave in `lines`: the output after the last `clear`, then
 * the game lines.
 */
export function collector() {
  let events: OutputEvent[] = [];
  return {
    onOutput: (e: OutputEvent): void => void events.push(e),
    /** Call before each input. */
    reset(): void {
      events = [];
    },
    /** The plain terminal text and the `clear` flag of the input that ended. */
    take(result: ExecResult): {
      text: string;
      cleared: boolean;
      lines: OutLine[];
    } {
      let screen: Chunk[] = [];
      let cleared = false;
      for (const e of events) {
        if (e.kind === "clear") {
          screen = [];
          cleared = true;
        } else screen.push(e.chunk);
      }
      const lines = chunkLines(screen).concat(result.lines);
      return { text: plainText(lines), cleared, lines };
    },
  };
}

export interface RunResult {
  /** stdout that reached the terminal. */
  out: string;
  /** stderr that reached the terminal. */
  err: string;
  /** stdout and stderr in the order written. */
  both: string;
  /**
   * Plain text of the terminal, with the learner hints (D12): the output
   * after the last `clear`, then the game lines.
   */
  text: string;
  /** The terminal lines of `text`, with their styles. */
  lines: OutLine[];
  /** True when the input ran `clear`. */
  cleared: boolean;
  code: number;
  result: ExecResult;
}

export interface Shell {
  engine: Engine;
  store: Map<string, string>;
  /** Runs one complete input and returns what it wrote. */
  run(input: string): Promise<RunResult>;
  /** Runs several inputs; returns the last result. */
  runAll(...inputs: string[]): Promise<RunResult>;
  /** Moves the fake engine clock, runs the due timers, and lets the engine settle. */
  advance(ms: number): Promise<void>;
  /** The fake engine clock. */
  clock: FakeEngineClock;
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
export async function openShell(opts: ShellOptions = {}): Promise<Shell> {
  const clock = makeFakeClock(START_MS);
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  if (opts.saved !== undefined) store.set(SAVE_KEY, opts.saved);
  for (const [k, v] of Object.entries(opts.keys ?? {})) store.set(k, v);
  const col = collector();
  const engine = createEngine({
    clock,
    onOutput: col.onOutput,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (opts.setItem) opts.setItem(k, v);
        else store.set(k, v);
      },
    },
  });
  const startText = plainText(await engine.start());
  const part = (cs: Chunk[], stream: Chunk["stream"]) =>
    cs
      .filter((c) => c.stream === stream)
      .map((c) => c.text)
      .join("");
  const run = async (input: string): Promise<RunResult> => {
    col.reset();
    const result = await engine.execute(input);
    const chunks: Chunk[] = result.chunks;
    const { text, cleared, lines } = col.take(result);
    return {
      out: part(chunks, "stdout"),
      err: part(chunks, "stderr"),
      both: chunks.map((c) => c.text).join(""),
      text,
      lines,
      cleared,
      code: engine.state.lastCode,
      result,
    };
  };
  return {
    engine,
    store,
    startText,
    run,
    clock,
    async runAll(...inputs: string[]) {
      let r = await run("true");
      for (const i of inputs) r = await run(i);
      return r;
    },
    async advance(ms: number) {
      return await clock.advance(ms);
    },
  };
}

export function restore(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setClock();
}

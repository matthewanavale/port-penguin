// B21: one engine session for the golden scripts, shared by the recorder
// (golden.record.ts) and the comparison (engine.golden.test.ts). A line step
// starts an input and does not wait for it. When the input ends at once, the
// step has its result. When it waits (for the keyboard, a timer), the steps
// after it (`{ keys }`, `{ signal }`, `{ advanceMs }`) act on it, and its result
// is filled in when it ends. A step that is still waiting at the next line or
// at the end of the script is an error, so a golden never hangs silently.
import { vi } from "vitest";
import { setClock } from "../engine/clock";
import { createEngine, SAVE_KEY } from "../engine/index";
import type { Engine, ReadRequest } from "../engine/index";
import { Tty } from "../term/tty";
import {
  makeFakeClock,
  seededRandom,
  SEED,
  START_MS,
  settle,
} from "./determinism";
import type { FakeEngineClock } from "./determinism";
import { collector } from "./engineHarness";

/** The signals a `{ signal }` step can send, with the keys they stand for. */
export const SIGNAL_KEYS = { INT: "\x03", TSTP: "\x1a", QUIT: "\x1c" } as const;
export type StepSignal = keyof typeof SIGNAL_KEYS;

/** What an input gave back, in the shape of a golden step. */
export interface Outcome {
  text: string;
  cleared: boolean;
  code: number;
  cwd: string;
  cur: number;
}

/** An input that was started. */
export interface Running {
  /** The index of its step in the script. */
  index: number;
  done(): boolean;
  result: Promise<Outcome>;
}

export interface Session {
  engine: Engine;
  clock: FakeEngineClock;
  /** The JSON saved under port-penguin-v2, or null. */
  saved(): string | null;
  /** Starts an input; `mayWait` lets its keyboard reads wait for `keys` steps. */
  begin(index: number, line: string, mayWait: boolean): Promise<Running>;
  /** Waits for an input that no later step acts on; fails when it waits for more than 10 s of real time. */
  wait(r: Running): Promise<Outcome>;
  keys(data: string): Promise<void>;
  signal(sig: StepSignal): Promise<void>;
  advance(ms: number): Promise<void>;
}

/** A fresh engine with the fake clock and the seeded random source (D15b). */
export async function openSession(saved?: string): Promise<Session> {
  const clock = makeFakeClock(START_MS);
  vi.spyOn(Math, "random").mockImplementation(seededRandom(SEED));
  const store = new Map<string, string>();
  if (saved !== undefined) store.set(SAVE_KEY, saved);
  const col = collector();
  const tty = new Tty();
  let waiting = 0;
  const engine = createEngine({
    clock,
    onOutput: col.onOutput,
    // A read waits only while a step can type; otherwise the keyboard is empty (end of input).
    onRead: (req: ReadRequest) =>
      waiting > 0 || tty.hasAhead ? tty.read(req) : Promise.resolve(null),
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  await engine.start();
  const signalFor: Record<string, StepSignal> = {
    "\x03": "INT",
    "\x1a": "TSTP",
    "\x1c": "QUIT",
  };
  const send = async (sig: StepSignal): Promise<void> => {
    await settle();
    tty.flush();
    engine.signal(sig);
    await settle();
  };
  return {
    engine,
    clock,
    saved: () => store.get(SAVE_KEY) ?? null,
    async begin(index, line, mayWait) {
      col.reset();
      if (mayWait) waiting++;
      let ended = false;
      const result = engine.execute(line).then((r) => {
        const s = engine.state;
        const shown = col.take(r);
        return {
          text: shown.text,
          cleared: shown.cleared,
          code: s.lastCode,
          cwd: s.cwd,
          cur: s.cur,
        };
      });
      const guarded = result.finally(() => {
        ended = true;
        if (mayWait) waiting--;
      });
      void guarded.catch(() => undefined);
      await settle();
      return { index, done: () => ended, result: guarded };
    },
    async wait(r) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`step ${r.index} is still waiting`)),
          10_000,
        );
      });
      try {
        return await Promise.race([r.result, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async keys(data) {
      await settle();
      const sig = signalFor[data];
      if (engine.busy() && sig) await send(sig);
      else tty.feed(data);
      await settle();
    },
    signal: send,
    async advance(ms) {
      await clock.advance(ms);
    },
  };
}

/** Puts the real timers and `Math.random` back. */
export function closeSession(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setClock();
}

/** True when the step after step `i` acts on a running input: keys, a signal, or a clock move. */
export function acts(steps: readonly unknown[], i: number): boolean {
  const s = steps[i + 1] as object | string | undefined;
  return (
    typeof s === "object" && ("keys" in s || "signal" in s || "advanceMs" in s)
  );
}

/** True when a step after line `i`, up to the next line step, types keys or sends a signal. */
export function mayWait(steps: readonly unknown[], i: number): boolean {
  for (let k = i + 1; k < steps.length; k++) {
    const s = steps[k] as object | string;
    if (typeof s === "string" || "input" in s) return false;
    if ("keys" in s || "signal" in s) return true;
  }
  return false;
}

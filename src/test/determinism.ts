// D15b: the fake clock and the seeded random source of the golden scripts, the
// walkthrough, and the reference cases. The engine gets the clock through
// Vitest fake timers (`vi.setSystemTime(clock.now())`) and the random function
// through a `Math.random` spy. The run-1 recordings were made with the same
// clock and seed (src/test/golden-run1/).

import type { Clock } from "../engine/clock";

/** Fixed start time for every golden script: 2026-11-24 09:00:00 UTC. */
export const START_MS = Date.UTC(2026, 10, 24, 9, 0, 0);

/** Seed for `Math.random` before every golden script. */
export const SEED = 0x5eed;

export interface FakeClock {
  /** A `Date` constructor whose "now" is the fake time. */
  readonly Date: DateConstructor;
  /** The current fake time in milliseconds. */
  now(): number;
  /** Moves the fake time forward. Time never moves on its own. */
  advance(ms: number): void;
}

/**
 * Makes a fake clock that starts at `startMs` and moves only when
 * `advance` is called. `new Date()` and `Date.now()` read the fake time;
 * `new Date(value)` and the other statics behave as the real `Date`.
 */
export function makeFakeDate(startMs: number): FakeClock {
  let current = startMs;
  const RealDate = Date;

  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(current);
      } else {
        super(...(args as ConstructorParameters<DateConstructor>));
      }
    }

    static override now(): number {
      return current;
    }
  }

  return {
    Date: FakeDate as unknown as DateConstructor,
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

/** mulberry32: a small, fast, seeded PRNG that returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The engine clock of B5 with a timer queue, for tests. */
export interface FakeEngineClock extends Clock {
  /**
   * Moves the time by `ms`, runs the timers that fall due in time order (a
   * timer that a timer sets runs too, when it falls due), and lets the engine
   * run until it waits again.
   */
  advance(ms: number): Promise<void>;
  /** How many timers wait. */
  pending(): number;
  /** The time of the earliest waiting timer, or null when none waits. */
  next(): number | null;
}

/** Lets promise work and one macrotask run (the engine waits on promises). */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Makes an engine clock that starts at `startMs` and moves only in `advance`.
 * Vitest fake timers are not used for engine time (B5).
 */
export function makeFakeClock(startMs: number = START_MS): FakeEngineClock {
  let current = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const due = (limit: number) => {
    let best: [number, { at: number; fn: () => void }] | null = null;
    for (const t of timers) {
      if (t[1].at > limit) continue;
      if (
        !best ||
        t[1].at < best[1].at ||
        (t[1].at === best[1].at && t[0] < best[0])
      )
        best = t;
    }
    return best;
  };
  return {
    now: () => current,
    setTimer(ms, fn) {
      const id = ++seq;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    next() {
      let at: number | null = null;
      for (const t of timers.values()) if (at === null || t.at < at) at = t.at;
      return at;
    },
    async advance(ms: number) {
      const limit = current + ms;
      await settle();
      for (let t = due(limit); t; t = due(limit)) {
        timers.delete(t[0]);
        current = Math.max(current, t[1].at);
        t[1].fn();
        await settle();
      }
      current = limit;
      await settle();
    },
  };
}

/**
 * Runs `p` (an input of the engine) to its end: whenever the engine waits and a
 * timer is set, moves the clock to that timer. For tests whose command only
 * sleeps (a `sleep` between two steps). It fails when the engine waits with no
 * timer (a command that waits for the keyboard, or a deadlock), so a test never
 * hangs.
 */
export async function drive<T>(
  p: Promise<T>,
  clock: FakeEngineClock,
): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 100_000; i++) {
    await settle();
    if (done) return await p;
    const at = clock.next();
    if (at === null) {
      // The engine may still run (a yield); give it a few turns before failing.
      for (let k = 0; k < 20 && !done && clock.next() === null; k++)
        await settle();
      if (done) return await p;
      if (clock.next() === null)
        throw new Error("the engine waits and no timer is set");
      continue;
    }
    await clock.advance(Math.max(0, at - clock.now()));
  }
  throw new Error("the engine did not finish");
}

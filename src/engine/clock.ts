// B5: the engine clock. Every engine site that reads the time reads it here,
// so a test can give a fake clock and move it by hand. The default clock is
// `Date.now()` and `setTimeout`. This is the only engine module that reads
// the real time (src/engine/clock.test.ts checks it).

export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): number;
  clearTimer(id: number): void;
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) =>
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
};

let current: Clock = defaultClock;

/** Sets the clock of the engine (`createEngine` calls this). No argument: the default. */
export function setClock(c?: Clock): void {
  current = c ?? defaultClock;
}

export const getClock = (): Clock => current;

/** The engine time in ms since the epoch. */
export const clockNow = (): number => current.now();

/** A `Date` for the engine time. */
export const clockDate = (): Date => new Date(current.now());

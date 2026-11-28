// B7, B6, B10: what the processes share to run side by side. The yield check
// gives the browser a turn every 16 ms of work; the process counter gives the
// ids; signal delivery sends a signal to the processes of one input.
import type { Proc, Run } from "./proc";

/** The budget of work between two yields, in real milliseconds (B7). */
export const YIELD_MS = 16;

/** The signals of B6 with their Linux numbers. */
export const SIGNALS: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  KILL: 9,
  USR1: 10,
  PIPE: 13,
  ALRM: 14,
  USR2: 12,
  TERM: 15,
  CHLD: 17,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
  TTIN: 21,
  URG: 23,
  WINCH: 28,
};

/** Signals that a process ignores when it has no trap (B6). */
const DEFAULT_IGNORED = new Set(["CONT", "CHLD", "URG", "WINCH"]);

/** One real macrotask (B7): a `MessageChannel` message; `setTimeout(0)` where there is none. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      setTimeout(resolve, 0);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      ch.port2.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export class Sched {
  private last = performance.now();
  private n = 0;
  /** The next process id (B10): the host sets the start value with `startPids`. */
  private nextPid = 1;

  /**
   * The baton. Processes run side by side, but only one runs at a time: a
   * process holds the baton until it waits (a pipe, a timer, the keyboard, a
   * yield) or ends, then the next process in line takes it. So the order of
   * the effects of the processes is fixed, as the risk table of the spec asks.
   */
  private held = false;
  private line: (() => void)[] = [];

  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.line.push(resolve));
  }

  release(): void {
    const next = this.line.shift();
    if (next) next();
    else this.held = false;
  }

  /** Runs a wait with the baton given away; takes it back when the wait ends. */
  async blocked<T>(wait: () => Promise<T>): Promise<T> {
    this.release();
    try {
      return await wait();
    } finally {
      await this.acquire();
    }
  }

  /** The ids start above `max` (the largest id in `S.procs`). */
  startPids(max: number): void {
    if (max >= this.nextPid) this.nextPid = max + 1;
  }

  allocPid(): number {
    return this.nextPid++;
  }

  /**
   * True when the running input has worked for at least 16 ms of real time
   * since its last turn. It looks at the clock once in 16 calls, so the check
   * is cheap in a hot loop.
   */
  due(): boolean {
    if ((++this.n & 15) !== 0) return false;
    return performance.now() - this.last >= YIELD_MS;
  }

  /** Gives the browser a turn, then starts a new budget. */
  async yield(): Promise<void> {
    await this.blocked(macrotask);
    this.last = performance.now();
  }

  /** Starts a new budget (an input starts, or a wait ended). */
  reset(): void {
    this.last = performance.now();
  }

  /**
   * Sends `sig` to `p`. A trap of `''` ignores it. A process that waits on a
   * child leaves a default signal to the child, whose end comes back to it
   * (SIGKILL needs no such help). The signal that stays pending wakes the wait
   * of the process.
   */
  deliver(p: Proc, sig: string): void {
    const trap = p.ctx.traps[sig];
    // B9: SIGCONT lets a stopped process go on, with or without a trap.
    if (sig === "CONT") p.cont();
    // B9: SIGSTOP, and SIGTSTP with no trap, stop the process (they do not end it).
    if (sig === "STOP" || (sig === "TSTP" && trap === undefined)) {
      p.stop();
      return;
    }
    if (sig === "KILL") p.cont();
    if (trap === "" && sig !== "KILL" && sig !== "STOP") return;
    if (trap === undefined && sig !== "KILL") {
      if (DEFAULT_IGNORED.has(sig)) return;
      if (p.kids > 0) return;
    }
    p.signals.push(sig);
    p.wake();
  }

  /** Sends `sig` to every process of the input `run` (the foreground job, B6). */
  signalRun(run: Run, sig: string): void {
    for (const p of [...run.procs]) this.deliver(p, sig);
    // B9: a job that `fg` brought to the foreground gets the signal too.
    if (run.fgJob) for (const p of run.fgJob.live()) this.deliver(p, sig);
  }
}

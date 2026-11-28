// B9, B10, B12: the job table. A job is a set of processes that start with `&`,
// or that Ctrl-Z took from the foreground. The table keeps the job numbers, the
// states, the notices for the next prompt, and `$!`. The scheduler (sched.ts)
// sends the signals; the builtins (builtins.ts) read and change the table.
import type { Proc, Run } from "./proc";

export type JobState = "running" | "stopped" | "done";

/** Bash names for the signals that end a job, as `jobs` shows them. */
const SIG_TEXT: Record<string, string> = {
  HUP: "Hangup",
  INT: "Interrupt",
  QUIT: "Quit (core dumped)",
  KILL: "Killed",
  USR1: "User defined signal 1",
  USR2: "User defined signal 2",
  TERM: "Terminated",
  ALRM: "Alarm clock",
  PIPE: "Broken pipe",
};

/** One line of a notice or of `jobs`: `[N]+  State                 CMD`. */
export function jobLine(
  j: Job,
  mark: string,
  opts: { pid?: boolean; text?: string } = {},
): string {
  const state = opts.text ?? j.stateText();
  // `jobs -l` as bash 5.2: one space after the mark, the PID in 5 columns.
  const gap = opts.pid ? " " + String(j.pid).padStart(5) + " " : "  ";
  const amp = j.state === "running" && opts.text === undefined ? " &" : "";
  return `[${j.n}]${mark}${gap}${state.padEnd(24)}${j.cmd}${amp}`;
}

/** What the next prompt shows for one job, and what a screen reader hears (B17). */
export interface JobNotice {
  text: string;
  say: string;
}

export class Job {
  n = 0;
  /** Every process of the job, the leader first. Ended ones stay until the job is gone. */
  procs: Proc[] = [];
  state: JobState = "running";
  /** The exit status once the job is done. */
  status = 0;
  /** The signal that ended the job, if one did. */
  sig: string | null = null;
  /** A change the player has not seen yet (a notice for the next prompt). */
  dirty = false;
  /** True while the shell waits for the job (`fg`). */
  fg = false;
  /** `disown` took the job from the table. */
  disowned = false;
  /** True for a job that prints its state changes (job control is on, B9). */
  notify: boolean;
  /** The table that holds the job: the table of the shell that started it (B9, B14). */
  table: JobTable | null = null;
  /** What waits for a change of state (`fg`, `wait`). */
  private waiters = new Set<() => void>();
  /** The state at the last change, for the order of `%+` and `%-`. */
  stamp = 0;
  /** The output run of the job (`fg` mirrors it into the input that waits). */
  run: Run | null = null;
  /** Called when the job is done (the engine saves, B12). */
  onDone: (() => void) | null = null;

  constructor(
    readonly cmd: string,
    notify: boolean,
  ) {
    this.notify = notify;
  }

  get pid(): number {
    return this.procs[0]?.pid ?? 0;
  }

  /** The processes that still run. */
  live(): Proc[] {
    return this.procs.filter((p) => !p.ended);
  }

  add(p: Proc): void {
    if (!this.procs.includes(p)) this.procs.push(p);
    p.job = this;
  }

  /** What the state column shows. */
  stateText(): string {
    if (this.state === "running") return "Running";
    if (this.state === "stopped") return "Stopped";
    if (this.sig) return SIG_TEXT[this.sig] ?? `Signal ${this.sig}`;
    return this.status === 0 ? "Done" : `Exit ${this.status}`;
  }

  /** Calls `f` at the next change of state; gives the cancel function. */
  onChange(f: () => void): () => void {
    this.waiters.add(f);
    return () => this.waiters.delete(f);
  }

  private changed(): void {
    const list = [...this.waiters];
    this.waiters.clear();
    for (const w of list) w();
  }

  /** Stops every process at its next safe point (SIGSTOP, SIGTSTP, SIGTTIN). */
  stop(): void {
    if (this.state !== "running") return;
    this.state = "stopped";
    // A new stop gives `exit` a new warning (B9).
    if (this.table) this.table.warned = -1;
    for (const p of this.live()) p.stop();
    this.changed();
  }

  /** SIGCONT: the processes go on. */
  cont(): void {
    if (this.state === "done") return;
    this.state = "running";
    for (const p of this.live()) p.cont();
    this.changed();
  }

  /** The job ended with `status`; `sig` names the signal that ended it. */
  finish(status: number, sig: string | null): void {
    if (this.state === "done") return;
    this.state = "done";
    this.dirty = true;
    this.status = status;
    this.sig = sig;
    for (const p of this.procs) p.ended = true;
    this.changed();
    this.onDone?.();
  }
}

/** The jobs of one shell: the prompt shell, a nested shell, a subshell, or a script (B9, B14). */
export class JobTable {
  jobs: Job[] = [];
  /** Jobs that `disown` took away: they still end with the shell (B11). */
  away: Job[] = [];
  private clock = 0;
  /** The set of tables that hold a live job; `add` puts this table in it (B10). */
  registry: Set<JobTable> | null = null;
  /** The input number at which `exit` warned about stopped jobs (B9). */
  warned = -1;
  /** A number for each input, so a second `exit` follows the first. */
  inputSeq = 0;
  /** Notices that the engine adds (a job that Ctrl-Z stopped): they are heard, not printed again. */
  extra: JobNotice[] = [];

  add(job: Job): Job {
    // The lowest number that is free, as bash does.
    let n = 1;
    while (this.jobs.some((j) => j.n === n)) n++;
    job.n = n;
    job.table = this;
    this.registry?.add(this);
    job.stamp = ++this.clock;
    this.jobs.push(job);
    return job;
  }

  touch(job: Job): void {
    job.stamp = ++this.clock;
  }

  /** Forgets every job and starts the numbers again at 1. */
  clear(): void {
    this.jobs = [];
    this.away = [];
    this.warned = -1;
    this.extra = [];
  }

  /** The current job (`%+`) and the previous one (`%-`): stopped jobs first, then by recency. */
  order(): Job[] {
    const live = this.jobs.filter((j) => j.state !== "done" || j.dirty);
    const rank = (j: Job) => (j.state === "stopped" ? 1e9 : 0) + j.stamp;
    return live.sort((a, b) => rank(b) - rank(a));
  }

  mark(j: Job): string {
    const o = this.order();
    if (o[0] === j) return "+";
    if (o[1] === j) return "-";
    return " ";
  }

  /**
   * Finds a job by its spec: `%N`, `%%`, `%+`, `%`, `%-`, `%NAME`, `%?TEXT`.
   * Gives the job, or an error text for `bash: CMD: SPEC: ...`.
   */
  find(spec: string): Job | string {
    const s = spec.startsWith("%") ? spec.slice(1) : spec;
    const all = this.jobs;
    if (s === "" || s === "%" || s === "+") {
      return this.order()[0] ?? "current: no such job";
    }
    if (s === "-") return this.order()[1] ?? "previous: no such job";
    if (/^[0-9]+$/.test(s)) {
      const j = all.find((x) => x.n === Number(s));
      return j ?? `${spec}: no such job`;
    }
    const hit = (f: (j: Job) => boolean): Job | string => {
      const m = all.filter(f);
      if (m.length === 0) return `${spec}: no such job`;
      if (m.length > 1) return `${s}: ambiguous job spec`;
      return m[0];
    };
    if (s.startsWith("?")) return hit((j) => j.cmd.includes(s.slice(1)));
    return hit((j) => j.cmd.startsWith(s));
  }

  /** The job that owns `pid`, if one does. */
  byPid(pid: number): Job | null {
    for (const j of [...this.jobs, ...this.away])
      if (j.state !== "done" && j.live().some((p) => p.pid === pid)) return j;
    return null;
  }

  /** Every live process of every job, in PID order (B10). */
  liveProcs(): { pid: number; name: string; cmdline: string; job: Job }[] {
    const out: { pid: number; name: string; cmdline: string; job: Job }[] = [];
    for (const j of [...this.jobs, ...this.away]) {
      if (j.state === "done") continue;
      for (const p of j.live())
        out.push({
          pid: p.pid,
          name: p.cmd || "bash",
          cmdline: p.cmdline || j.cmd,
          job: j,
        });
    }
    return out.sort((a, b) => a.pid - b.pid);
  }

  /**
   * The lines for the next prompt (B9): each job whose state changed since the
   * last prompt. A done job is removed after its notice.
   */
  notices(): JobNotice[] {
    const out: JobNotice[] = this.extra.splice(0);
    for (const j of [...this.jobs].sort((a, b) => a.n - b.n)) {
      if (j.dirty && j.notify) {
        const mark = this.mark(j);
        // Bash starts a `Stopped` notice with a newline (the capture: `kill -STOP`, `^Z`).
        const lead = j.state === "stopped" ? "\n" : "";
        out.push({
          text: lead + jobLine(j, mark),
          say: `Job ${j.n} ${j.state === "stopped" ? "stopped" : "done"}`,
        });
      }
      j.dirty = false;
    }
    this.jobs = this.jobs.filter((j) => j.state !== "done" || j.dirty);
    return out;
  }

  /** Jobs that still run or wait (not done). */
  active(): Job[] {
    return [...this.jobs, ...this.away].filter((j) => j.state !== "done");
  }

  stopped(): Job[] {
    return this.jobs.filter((j) => j.state === "stopped");
  }
}

// B2: what the processes share. `Interp` keeps the host (the command table),
// the parser cache for function bodies, and the scheduler. The scheduler
// is in sched.ts. The processes themselves are in proc.ts.
import type { Node } from "./ast";
import type { Context } from "./context";
import { JobTable } from "./jobs";
import type { Job } from "./jobs";
import type { Host, OutputSink, ReadRequest, TaskCtx } from "./io";
import { Proc, Run } from "./proc";
import { Sched } from "./sched";

export {
  AbortLine,
  BreakSig,
  ContinueSig,
  ExitSig,
  Proc,
  ReturnSig,
  Run,
  SignalStop,
} from "./proc";
export type { HintEvent, Note } from "./proc";

export class Interp {
  readonly host: Host;
  /** Parsed function bodies, by source text. */
  readonly fnCache = new Map<string, Node>();
  /** The yield check, the process ids, and signal delivery (B6, B7, B10). */
  readonly sched = new Sched();
  /**
   * Asks the keyboard (B4). The engine sets it. `who` says which command waits
   * and whether it was typed at the prompt (the B16 hint). Resolves to the typed
   * text, or null at end of input. Unset: the terminal is empty (end of input).
   */
  reader:
    | ((
        req: ReadRequest,
        who: { cmd: string; prompt: boolean },
      ) => Promise<string | null>)
    | null = null;

  /** The job table of the top prompt shell (B9). Each other shell has its own (B14). */
  readonly jobs = new JobTable();
  /**
   * Every job table that can hold a live job (B10): `ps`, `top`, `kill PID`, and
   * the panel actions look through all of them. A table with no live job is dropped.
   */
  readonly tables = new Set<JobTable>();
  /** How many nested prompt shells run (B14); the engine keeps it. */
  shellDepth = 0;
  /** Where the output of a background job goes (B15); the engine sets it. */
  output: OutputSink | undefined;
  /**
   * The task data of background jobs (B12): the engine points it at the input
   * that runs, or at what waits for the next input.
   */
  bgTask: TaskCtx = { line: "", segs: [], ranExec: null, allOut: "" };
  /** Called when a job is done (the engine saves, B12). */
  onJobEnd: (() => void) | undefined;

  constructor(host: Host) {
    this.host = host;
    this.jobs.registry = this.tables;
  }

  /** A new job table for a shell that has none yet (a subshell, a script, a nested shell). */
  newTable(): JobTable {
    const t = new JobTable();
    t.registry = this.tables;
    return t;
  }

  /** Drops the tables that hold no live job; `add` puts a table back. */
  private prune(): JobTable[] {
    for (const t of [...this.tables])
      if (!t.active().length) this.tables.delete(t);
    return [...this.tables];
  }

  /** Every live process of every shell, in PID order (B10). */
  liveProcs(): ReturnType<JobTable["liveProcs"]> {
    return this.prune()
      .flatMap((t) => t.liveProcs())
      .sort((a, b) => a.pid - b.pid);
  }

  /** The live job that owns `pid`, in any shell. */
  byPid(pid: number): Job | null {
    for (const t of this.tables) {
      const j = t.byPid(pid);
      if (j) return j;
    }
    return null;
  }

  /** A root process on `ctx`: the terminal is its standard input and output. */
  proc(ctx: Context, run?: Run): Proc {
    const task: TaskCtx = { line: "", segs: [], ranExec: null, allOut: "" };
    // The prompt shell takes no process id: only the processes of jobs have one (B10).
    const p = new Proc(this, run ?? new Run(task), ctx, 0);
    p.attach(p.run);
    return p;
  }
}

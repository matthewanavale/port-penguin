// B2: what the processes share. `Interp` keeps the host (the command table),
// the parser cache for function bodies, and the scheduler. The scheduler
// is in sched.ts. The processes themselves are in proc.ts.
import type { Node } from "./ast";
import type { Context } from "./context";
import type { Host, TaskCtx } from "./io";
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

  constructor(host: Host) {
    this.host = host;
  }

  /** A root process on `ctx`: the terminal is its standard input and output. */
  proc(ctx: Context, run?: Run): Proc {
    const task: TaskCtx = { line: "", segs: [], ranExec: null, allOut: "" };
    const p = new Proc(this, run ?? new Run(task), ctx);
    p.attach(p.run);
    return p;
  }
}

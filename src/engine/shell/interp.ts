// B2: what the processes share. `Interp` keeps the host (the command table),
// the parser cache for function bodies, and the process counter. The scheduler
// of the next phase goes here. The processes themselves are in proc.ts.
import type { Node } from "./ast";
import type { Context } from "./context";
import type { Host, TaskCtx } from "./io";
import { Proc, Run } from "./proc";

export {
  AbortLine,
  BreakSig,
  ContinueSig,
  ExitSig,
  Proc,
  ReturnSig,
  Run,
} from "./proc";
export type { HintEvent, Note } from "./proc";

export class Interp {
  readonly host: Host;
  /** Parsed function bodies, by source text. */
  readonly fnCache = new Map<string, Node>();
  /** The next process id (B10 gives the visible numbers in a later phase). */
  nextPid = 1;

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

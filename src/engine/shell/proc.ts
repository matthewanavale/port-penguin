// B1, B2: the process. A `Proc` is one running unit: the foreground input, a
// pipeline stage, a subshell, `$( )`, `<( )`, `>( )`, a script. Each one has a
// context of its own; no code assigns the context of another process. The
// parts that one input shares go in a `Run`. The interpreter walks the syntax
// tree of parser.ts, expands words (expand.ts), applies redirects
// (redirect.ts), and runs builtins (builtins.ts) or the commands of the host
// table. Every method that can run code returns a `Promise` (B1).
import { nul } from "../nullmap";
import { get } from "../paths";
import type {
  Assign,
  Case,
  CondExpr,
  FunctionDef,
  Node,
  Script,
  Simple,
  Word,
} from "./ast";
import { BUILTINS, KEYWORDS, unaryTest, intCompare } from "./builtins";
import { getClock } from "../clock";
import { Context } from "./context";
import type { SrcInfo } from "./context";
import { ExpError, Expander } from "./expand";
import { matchPattern } from "./glob";
import { resolvePath } from "./glob";
import { BufWriter, Input, TermWriter } from "./io";
import type {
  Chunk,
  Host,
  IO,
  OutputEvent,
  OutSink,
  TaskCtx,
  Writer,
} from "./io";
import {
  LIM,
  LimitStop,
  NestStop,
  isStackOverflow,
  limitFromError,
  nestMessage,
  stopMessage,
} from "./limits";
import { SIGNALS } from "./sched";
import type { Interp } from "./interp";
import { parse, parseFull, parseUnits } from "./parser";
import type { UnitResult } from "./parser";
import { applyRedirs, readText, writeText } from "./redirect";
import type { Applied } from "./redirect";

/* ---------- control flow ---------- */

export class BreakSig {
  constructor(readonly n: number) {}
}
export class ContinueSig {
  constructor(readonly n: number) {}
}
export class ReturnSig {
  constructor(readonly code: number) {}
}
/** `exit`, or a fatal error in a non-interactive shell. */
export class ExitSig {
  constructor(readonly code: number) {}
}
/** A fatal error at the prompt: the rest of the input does not run. */
export class AbortLine {
  constructor(readonly code: number) {}
}

/**
 * A signal ended the process (B6): it had no trap for it. The status is
 * 128 plus the signal number (130, 143, ...). It unwinds like `exit`, up to the
 * process that has a trap for the signal, or to the end of the input.
 */
export class SignalStop {
  readonly code: number;
  constructor(readonly sig: string) {
    this.code = 128 + (SIGNALS[sig] ?? 0);
  }
}

/** A line the game prints itself: a stop notice, a hint. Never stdout or stderr. */
export interface Note {
  text: string;
  dim?: boolean;
}

export type HintEvent = { kind: "notfound"; name: string } | { kind: "stdin" };

const ASSIGN_BUILTINS = new Set([
  "declare",
  "typeset",
  "local",
  "export",
  "readonly",
]);

const xq = (s: string): string =>
  s === ""
    ? "''"
    : /^[A-Za-z0-9_%+,\-./:=@]+$/.test(s)
      ? s
      : "'" + s.replace(/'/g, "'\\''") + "'";

/** A `>( )` consumer that waits for the end of its writer. */
interface ProcFile {
  path: string;
  dir: "<" | ">";
  script: Script;
  ctx: Context;
}

/** What a foreground chunk list keeps of one input (B15). */
const CHUNK_CAP = 1_048_576;

/**
 * One input as the processes of that input share it (B2): the task data, the
 * output, the notes, the meter, and the step count.
 */
export class Run implements OutSink {
  chunks: Chunk[] = [];
  notes: Note[] = [];
  events: HintEvent[] = [];
  /** Every live process of the input: the foreground job gets its signals (B6). */
  procs = new Set<Proc>();
  /** Set when `exit` ran at the prompt. */
  exited: number | null = null;
  steps = 0;
  /** B8: the shell has no step limit; only `~/.bashrc` sets one (D19). */
  stepLimit: number;
  stepName: string;
  /** The process that runs now (for the D12 "typed at the prompt" check). */
  cur: Proc | null = null;
  /** `>( )` consumers of the input, for all its processes (they run at its end or at `sleep`). */
  procFiles: ProcFile[] = [];
  private chunkBytes = 0;
  private capped = false;
  constructor(
    public task: TaskCtx,
    readonly onOutput?: (e: OutputEvent) => void,
    stepLimit = Infinity,
  ) {
    this.stepLimit = stepLimit;
    this.stepName = `${stepLimit} steps`;
  }

  /** One piece of terminal output: kept (up to 1 MB of text) and sent on. */
  emit(chunk: Chunk): void {
    if (!this.capped) {
      if (this.chunkBytes + chunk.text.length > CHUNK_CAP) this.capped = true;
      else {
        this.chunkBytes += chunk.text.length;
        this.chunks.push(chunk);
      }
    }
    this.onOutput?.({ kind: "chunk", chunk });
  }

  /** The `clear` command (or Ctrl-L) from any process. */
  clear(): void {
    this.onOutput?.({ kind: "clear" });
  }

  /** Counts one step against the step limit (only `~/.bashrc` has one, B8). */
  tick(): void {
    if (++this.steps > this.stepLimit) throw new LimitStop(this.stepName);
  }
}

export class Proc {
  /** The process id (B10 gives the visible ones; this phase only counts). */
  readonly pid: number;
  ctx: Context;
  run: Run;
  /** Depth of functions, `eval`, and `source` (D6). */
  depth = 0;
  /** Name of the innermost function that a JavaScript stack overflow went through. */
  overflowName: string | null = null;
  scripts = 0;
  /**
   * How many processes are above this one (a D6 counter, B18). An `await`
   * chain does not overflow the JavaScript stack, so this counter ends a
   * recursion through `$( )`, pipelines, and subshells.
   */
  chain = 0;
  /** Depth of things that make a command not "typed at the prompt" (D12). */
  nest = 0;
  /** The status of the last command substitution (for `x=$(false)`). */
  substCode: number | null = null;
  /** Array words of `declare a=(1 2)`, by argument index. */
  arrArgs = new Map<
    number,
    { items: { key?: string; value: string }[]; assoc: boolean }
  >();
  /** A trap runs with the line of the command that triggered it (`LINENO`). */
  lineOverride: number | null = null;
  /** The job this process belongs to (job control comes in a later phase). */
  job: unknown = null;
  /** Pending signals (B6): they run or end the process at the next safe point. */
  signals: string[] = [];
  /** How many child processes this process waits on now. */
  kids = 0;
  /** Set while the process waits (B6): a signal calls it to end the wait. */
  private waiter: (() => void) | null = null;
  ex: Expander;
  rootIn: Input;
  /** The list of its input (shared by all the processes of the input). */
  procFiles: ProcFile[];
  procSeq = 0;
  aliasing = new Set<string>();

  constructor(
    readonly interp: Interp,
    run: Run,
    ctx: Context,
  ) {
    this.pid = interp.sched.allocPid();
    this.run = run;
    run.procs.add(this);
    this.procFiles = run.procFiles;
    this.ctx = ctx;
    this.ex = new Expander(this);
    this.rootIn = new Input("", true);
  }

  get host(): Host {
    return this.interp.host;
  }
  /** The standard streams of this process (they live in its context). */
  get io(): IO {
    return this.ctx.io;
  }
  /** Where its terminal output goes (B15). */
  get out(): OutSink {
    return this.run;
  }
  get task(): TaskCtx {
    return this.run.task;
  }
  get chunks(): Chunk[] {
    return this.run.chunks;
  }
  get notes(): Note[] {
    return this.run.notes;
  }
  get events(): HintEvent[] {
    return this.run.events;
  }
  get exited(): number | null {
    return this.run.exited;
  }
  set exited(v: number | null) {
    this.run.exited = v;
  }

  /* ---------- child processes ---------- */

  /**
   * A child process on `ctx`. It starts with the counters of this process
   * (the D6 limits go on through the chain) and it shares the `Run`.
   */
  spawn(ctx: Context): Proc {
    if (this.chain >= LIM.depth) {
      const frames = this.ctx.frames;
      const name = frames.length
        ? frames[frames.length - 1].name
        : "command substitution";
      throw new NestStop(name, LIM.depth);
    }
    // As in bash, a subshell resets the traps for signals; `trap ''` stays (B6).
    for (const sig of Object.keys(SIGNALS))
      if (ctx.traps[sig]) delete ctx.traps[sig];
    const c = new Proc(this.interp, this.run, ctx);
    c.chain = this.chain + 1;
    c.depth = this.depth;
    c.nest = this.nest;
    c.scripts = this.scripts;
    c.overflowName = this.overflowName;
    c.procSeq = this.procSeq;
    c.lineOverride = this.lineOverride;
    c.job = this.job;
    c.rootIn = this.rootIn;
    return c;
  }

  /** Runs `f` as the running process, and takes back what a child leaves. */
  async within<T>(c: Proc, f: () => Promise<T>): Promise<T> {
    const prev = this.run.cur;
    this.run.cur = c;
    this.kids++;
    try {
      return await f();
    } finally {
      this.kids--;
      this.run.procs.delete(c);
      this.run.cur = prev;
      if (this.overflowName === null) this.overflowName = c.overflowName;
      if (c.procSeq > this.procSeq) this.procSeq = c.procSeq;
    }
  }

  /* ---------- one input ---------- */

  /** Starts an input: new run (output list, steps), and task data. */
  begin(task: TaskCtx, stepLimit = Infinity): void {
    this.attach(new Run(task, this.run.onOutput, stepLimit));
  }

  /** Makes this process the root of `run`: the terminal is its standard input and output. */
  attach(run: Run): void {
    this.run = run;
    this.procFiles = run.procFiles;
    const task = run.task;
    run.cur = this;
    run.procs.add(this);
    this.signals = [];
    this.kids = 0;
    this.waiter = null;
    this.depth = 0;
    this.overflowName = null;
    this.scripts = 0;
    this.nest = 0;
    this.rootIn = new Input("", true);
    this.rootIn.counts = () => (this.run.cur ?? this).promptLevel();
    this.ctx.io = {
      in: this.rootIn,
      out: new TermWriter("stdout", this.run, task),
      err: new TermWriter("stderr", this.run, null),
    };
  }

  /** True while a command was typed at the prompt itself (D12). */
  promptLevel(): boolean {
    return this.nest === 0 && this.ctx.src.kind === "prompt";
  }

  /** Parses and runs one complete input at the prompt. Returns `$?`. */
  async runLine(text: string): Promise<number> {
    const ctx = this.ctx;
    const r = parseFull(text, { extglob: !!ctx.options.extglob });
    let code: number;
    if (r.status === "incomplete") {
      this.fail("syntax error: unexpected end of file");
      code = 2;
    } else if (r.status === "error") {
      if (r.nest) this.note(r.message, true);
      else this.errLine(r.message);
      code = 2;
    } else code = await this.execTop(() => this.runList(r.ast.items));
    ctx.lastCode = code;
    if (this.rootIn.used) this.run.events.push({ kind: "stdin" });
    return code;
  }

  /** Runs `~/.bashrc` text under the D19 guard. Returns an error reason, or null. */
  async runRc(text: string, limit = LIM.rcSteps): Promise<string | null> {
    const run = this.run;
    const saved = {
      limit: run.stepLimit,
      name: run.stepName,
      steps: run.steps,
    };
    run.stepLimit = limit;
    run.stepName = `${limit} steps`;
    run.steps = 0;
    const ctx = this.ctx;
    const src = ctx.src;
    ctx.src = { kind: "file", path: "~/.bashrc" };
    let reason: string | null = null;
    try {
      const r = parseFull(text, { extglob: false, eof: true });
      if (r.status !== "ok") reason = "syntax error";
      else {
        this.nest++;
        try {
          await this.runList(r.ast.items);
        } finally {
          this.nest--;
        }
      }
    } catch (e) {
      if (
        e instanceof ExitSig ||
        e instanceof ReturnSig ||
        e instanceof AbortLine
      )
        reason = null;
      else if (e instanceof SignalStop) reason = "interrupted";
      else if (e instanceof LimitStop) reason = e.limit;
      else if (e instanceof NestStop) reason = e.message;
      else if (limitFromError(e) === "nest") reason = "nesting too deep";
      else if (limitFromError(e)) reason = "1 MB string";
      else reason = e instanceof Error ? e.message : "error";
    } finally {
      ctx.src = src;
      run.stepLimit = saved.limit;
      run.stepName = saved.name;
      run.steps = saved.steps;
    }
    return reason;
  }

  /** Runs a body at top level and turns limits and exits into notes. */
  private async execTop(body: () => Promise<number>): Promise<number> {
    try {
      return await body();
    } catch (e) {
      return this.topError(e);
    } finally {
      await this.cleanProcs();
    }
  }

  private topError(e: unknown): number {
    if (e instanceof LimitStop) {
      this.note("^C", false);
      this.note(stopMessage(e.limit), true);
      return 130;
    }
    if (e instanceof NestStop) {
      this.note(nestMessage(e.name_, e.limit), true);
      return e.code;
    }
    if (e instanceof SignalStop) {
      // The terminal shows `^C` itself; bash names a core dump for SIGQUIT.
      if (e.sig === "QUIT") this.ctx.io.err.write("Quit (core dumped)\n");
      return e.code;
    }
    const lim = limitFromError(e);
    if (lim === "nest") {
      this.note(nestMessage(this.overflowName ?? "function", LIM.depth), true);
      return 1;
    }
    if (lim) return this.topError(lim);
    if (e instanceof ExitSig) {
      if (this.ctx.src.kind === "prompt") this.run.exited = e.code;
      return e.code;
    }
    if (e instanceof AbortLine) return e.code;
    if (e instanceof ReturnSig) return e.code;
    if (e instanceof BreakSig || e instanceof ContinueSig) return 0;
    throw e;
  }

  note(text: string, dim: boolean): void {
    this.run.notes.push({ text, dim });
  }

  /* ---------- messages ---------- */

  /** `bash: ` at the prompt; `PATH: line N: ` in a script; `bash: line N: ` for -c. */
  prefix(): string {
    const c = this.ctx;
    if (c.src.kind === "file") return `${c.src.path}: line ${c.line}: `;
    if (c.src.kind === "c") return `bash: line ${c.line}: `;
    return "bash: ";
  }

  /** One error line with the script prefix, to the current stderr. */
  fail(msg: string): void {
    this.ctx.io.err.write(this.prefix() + msg + "\n");
  }

  /** A line that already holds its own prefix (a parse error). */
  private errLine(msg: string): void {
    this.ctx.io.err.write(msg + "\n");
  }

  /* ---------- environment for the expander ---------- */

  async cmdSubst(script: Script): Promise<string> {
    const buf = new BufWriter();
    const sub = this.ctx.copy();
    const io: IO = { in: this.ctx.io.in, out: buf, err: this.ctx.io.err };
    sub.io = io;
    const child = this.spawn(sub);
    child.nest++;
    let code: number;
    try {
      code = await this.within(child, async () => {
        const c = await child.runList(script.items);
        return await child.runExitTrap(sub, c);
      });
    } catch (e) {
      if (e instanceof ExitSig) code = e.code;
      else if (e instanceof ReturnSig) code = e.code;
      else if (e instanceof AbortLine) code = e.code;
      else if (e instanceof BreakSig || e instanceof ContinueSig) code = 0;
      else throw e;
    }
    this.substCode = code;
    return buf.text;
  }

  async procSubst(dir: "<" | ">", script: Script): Promise<string> {
    const n = 60 + (this.procSeq++ % 4);
    const path = `/dev/fd/${n}`;
    // The file lives in the game's file system until the command ends.
    const root = this.fsRoot();
    const dev = (root.c.dev ??= { t: "d", c: nul(), m: "rwxr-xr-x" });
    if (dev.t === "d") {
      const fd = (dev.c.fd ??= { t: "d", c: nul(), m: "rwxr-xr-x" });
      if (fd.t === "d") fd.c[String(n)] = { t: "f", x: "", m: "rw-------" };
    }
    if (dir === "<") {
      const buf = new BufWriter();
      const sub = this.ctx.copy();
      sub.io = { in: this.ctx.io.in, out: buf, err: this.ctx.io.err };
      const child = this.spawn(sub);
      child.nest++;
      try {
        await this.within(child, () => child.runList(script.items));
      } catch (e) {
        if (!(e instanceof ExitSig || e instanceof ReturnSig)) throw e;
      }
      const node = get(path);
      if (node && node.t === "f") node.x = buf.text;
    } else this.procFiles.push({ path, dir, script, ctx: this.ctx.copy() });
    return path;
  }

  private fsRoot() {
    const n = get("/");
    return n as import("../state").DirNode;
  }

  /** Runs `>( )` consumers and removes the /dev/fd files. */
  async cleanProcs(): Promise<void> {
    const list = this.procFiles.splice(0);
    for (const p of list) {
      if (p.dir === ">") {
        const node = get(p.path);
        const text = node && node.t === "f" ? node.x : "";
        const c = p.ctx;
        c.io = {
          in: new Input(text),
          out: this.ctx.io.out,
          err: this.ctx.io.err,
        };
        const child = this.spawn(c);
        try {
          await this.within(child, () => child.runList(p.script.items));
        } catch (e) {
          if (!(
            e instanceof ExitSig ||
            e instanceof ReturnSig ||
            e instanceof LimitStop
          ))
            throw e;
        }
      }
    }
    const root = this.fsRoot();
    const dev = root.c.dev;
    if (dev && dev.t === "d") {
      delete dev.c.fd;
      if (!Object.keys(dev.c).length) delete root.c.dev;
    }
  }

  get cwd(): string {
    return this.ctx.cwd;
  }
  expandTarget = (w: Word): Promise<string | null> => this.ex.target(w);
  expandHeredoc = (w: Word): Promise<string> => this.ex.heredoc(w);
  expandText = (w: Word): Promise<string> => this.ex.text(w);

  /** Resolves a path against the cwd of the current context. */
  abs(p: string): string {
    if (p === "~" || p.startsWith("~/"))
      p = (this.ctx.get("HOME") ?? "/home/cadet") + p.slice(1);
    return resolvePath(this.ctx.cwd, p);
  }

  /* ---------- running nodes ---------- */

  async runList(nodes: Node[]): Promise<number> {
    let code = this.ctx.lastCode;
    for (const n of nodes) code = await this.runNode(n);
    return code;
  }

  /** Counts one step against the D5 meter (also used by awk and sed). */
  tick(): void {
    this.run.tick();
  }

  async runNode(n: Node): Promise<number> {
    this.tick();
    const due = this.interp.sched.due();
    if (due || this.signals.length) await this.pause(due);
    const ctx = this.ctx;
    ctx.line = this.lineOverride ?? n.line;
    let code: number;
    try {
      code = await this.exec(n);
    } catch (e) {
      if (e instanceof ExpError) {
        code = e.code;
        ctx.lastCode = code;
        if (e.fatal) {
          if (ctx.src.kind === "prompt" && this.nest === 0)
            throw new AbortLine(code);
          throw new ExitSig(code);
        }
      } else if (e instanceof SignalStop && this.ctx.traps[e.sig]) {
        // A child ended by the signal, and this process has a trap for it.
        code = e.code;
      } else throw e;
    }
    this.ctx.lastCode = code;
    if (n.type !== "pipeline") this.ctx.pipestatus = [code];
    if (this.signals.length) await this.dispatchSignals();
    return code;
  }

  /* ---------- signals and waiting (B6, B7) ---------- */

  /** Called by the scheduler: ends the wait of this process, if it waits. */
  wake(): void {
    this.waiter?.();
  }

  /** The yield check (B7), then the pending signals (B6). */
  async pause(due?: boolean): Promise<void> {
    const sched = this.interp.sched;
    if (due ?? sched.due()) await sched.yield();
    if (this.signals.length) await this.dispatchSignals();
  }

  /**
   * Handles the pending signals: a trap runs its command; `''` ignores; no
   * trap ends the process (`SignalStop`).
   */
  async dispatchSignals(): Promise<void> {
    while (this.signals.length) {
      const sig = this.signals.shift() as string;
      const trap = this.ctx.traps[sig];
      if (trap === undefined || sig === "KILL") throw new SignalStop(sig);
      if (trap === "") continue;
      await this.runTrap(sig, trap, this.ctx.lastCode);
    }
  }

  /**
   * A wait that a signal ends at once. `arm` starts the wait and gives the
   * function that cancels it; it calls `wake` when the wait is over. Gives
   * null when the wait was over, or the name of the signal that ended it. A
   * signal with no trap ends the process (`SignalStop`); a trapped one stays
   * pending and runs when the command ends.
   */
  async interruptible(
    arm: (wake: () => void) => () => void,
  ): Promise<string | null> {
    this.ending();
    if (this.signals.length) return this.signals[0];
    let over = false;
    await new Promise<void>((resolve) => {
      const cancel = arm(() => {
        over = true;
        resolve();
      });
      this.waiter = () => {
        cancel();
        resolve();
      };
    });
    this.waiter = null;
    if (over) return null;
    this.ending();
    return this.signals[0] ?? null;
  }

  /** Ends the process with `SignalStop` when a pending signal has no trap. */
  private ending(): void {
    for (const sig of this.signals)
      if (this.ctx.traps[sig] === undefined || sig === "KILL")
        throw new SignalStop(sig);
  }

  /** Waits `ms` on the engine clock (B5). Gives the signal that ended it early, or null. */
  waitTime(ms: number): Promise<string | null> {
    return this.interruptible((wake) => {
      const clock = getClock();
      const id = clock.setTimer(ms, wake);
      return () => clock.clearTimer(id);
    });
  }

  private async exec(n: Node): Promise<number> {
    switch (n.type) {
      case "simple":
        return await this.simple(n);
      case "pipeline":
        return await this.pipeline(n);
      case "andor":
        return await this.andor(n);
      case "if":
        return await this.withRedirects(n.redirs, () => this.ifNode(n));
      case "case":
        return await this.withRedirects(n.redirs, () => this.caseNode(n));
      case "for":
        return await this.withRedirects(n.redirs, () => this.forNode(n));
      case "cfor":
        return await this.withRedirects(n.redirs, () => this.cforNode(n));
      case "while":
      case "until":
        return await this.withRedirects(n.redirs, () => this.whileNode(n));
      case "group":
        return await this.withRedirects(n.redirs, () => this.runList(n.body));
      case "subshell":
        return await this.withRedirects(n.redirs, () => this.subshell(n.body));
      case "function":
        return Promise.resolve(this.defineFunction(n));
      case "arith":
        return await this.withRedirects(n.redirs, async () => {
          const v = await this.ex.arithWord(n.expr);
          return v === "0" ? 1 : 0;
        });
      case "cond":
        return await this.withRedirects(n.redirs, async () =>
          (await this.cond(n.expr)) ? 0 : 1,
        );
    }
  }

  private async withRedirects(
    redirs: Node["redirs"],
    f: () => Promise<number>,
  ): Promise<number> {
    if (!redirs || !redirs.length) return await f();
    const ap = await applyRedirs(redirs, this.ctx.io, this);
    if (!ap) return 1;
    const saved = this.ctx.io;
    this.ctx.io = ap.io;
    let code: number;
    try {
      code = await f();
    } finally {
      this.ctx.io = saved;
    }
    const err = ap.close();
    if (err) {
      this.fail(err);
      return 1;
    }
    return code;
  }

  /* ---------- lists and pipelines ---------- */

  private async andor(n: Extract<Node, { type: "andor" }>): Promise<number> {
    const ctx = this.ctx;
    ctx.noErr++;
    let code: number;
    try {
      code = await this.runNode(n.first);
    } finally {
      ctx.noErr--;
    }
    for (let i = 0; i < n.rest.length; i++) {
      const { op, node } = n.rest[i];
      if (op === "&&" ? code !== 0 : code === 0) continue;
      const last = i === n.rest.length - 1;
      if (!last) ctx.noErr++;
      try {
        code = await this.runNode(node);
      } finally {
        if (!last) ctx.noErr--;
      }
    }
    return code;
  }

  private async pipeline(
    n: Extract<Node, { type: "pipeline" }>,
  ): Promise<number> {
    const ctx = this.ctx;
    if (n.negate) ctx.noErr++;
    let code: number;
    try {
      if (n.cmds.length === 1) code = await this.runNode(n.cmds[0]);
      else code = await this.stages(n);
    } finally {
      if (n.negate) ctx.noErr--;
    }
    if (n.negate) code = code === 0 ? 1 : 0;
    return code;
  }

  private async stages(
    n: Extract<Node, { type: "pipeline" }>,
  ): Promise<number> {
    const parent = this.ctx;
    let input = parent.io.in;
    const statuses: number[] = [];
    for (let i = 0; i < n.cmds.length; i++) {
      const last = i === n.cmds.length - 1;
      const buf = last ? null : new BufWriter();
      const stage = parent.copy();
      stage.io = {
        in: input,
        out: buf ?? parent.io.out,
        err: parent.io.err,
        fds: parent.io.fds,
      };
      const child = this.spawn(stage);
      let code: number;
      try {
        code = await this.within(child, () => child.runNode(n.cmds[i]));
      } catch (e) {
        if (e instanceof ExitSig) code = e.code;
        else if (e instanceof ReturnSig) code = e.code;
        else throw e;
      }
      statuses.push(code);
      if (buf) input = new Input(buf.text);
    }
    parent.pipestatus = statuses;
    if (parent.options.pipefail) {
      for (let i = statuses.length - 1; i >= 0; i--)
        if (statuses[i] !== 0) return statuses[i];
      return 0;
    }
    return statuses[statuses.length - 1];
  }

  private async subshell(body: Node[]): Promise<number> {
    const sub = this.ctx.copy();
    const child = this.spawn(sub);
    let code: number;
    try {
      code = await this.within(child, () => child.runList(body));
    } catch (e) {
      if (e instanceof ExitSig) code = e.code;
      else throw e;
    }
    code = await this.runExitTrap(sub, code);
    return code;
  }

  /* ---------- compound commands ---------- */

  private async cond_(list: Node[]): Promise<number> {
    this.ctx.noErr++;
    try {
      return await this.runList(list);
    } finally {
      this.ctx.noErr--;
    }
  }

  private async ifNode(n: Extract<Node, { type: "if" }>): Promise<number> {
    for (const c of n.clauses) {
      if ((await this.cond_(c.cond)) === 0) return await this.runList(c.body);
    }
    if (n.else) return await this.runList(n.else);
    return 0;
  }

  /** Runs a loop body; returns true to leave the loop. */
  private async loopBody(
    body: Node[],
    state: { code: number },
  ): Promise<boolean> {
    this.ctx.loopDepth++;
    try {
      state.code = await this.runList(body);
    } catch (e) {
      if (e instanceof BreakSig) {
        if (e.n > 1) throw new BreakSig(e.n - 1);
        state.code = 0;
        return true;
      }
      if (e instanceof ContinueSig) {
        if (e.n > 1) throw new ContinueSig(e.n - 1);
        state.code = 0;
        return false;
      }
      throw e;
    } finally {
      this.ctx.loopDepth--;
    }
    return false;
  }

  private async forNode(n: Extract<Node, { type: "for" }>): Promise<number> {
    const items = n.words
      ? await this.ex.words(n.words)
      : this.ctx.params.slice();
    const st = { code: 0 };
    for (const it of items) {
      this.tick();
      const err = this.ctx.set(n.name, it);
      if (err) {
        this.fail(err);
        return 1;
      }
      if (await this.loopBody(n.body, st)) break;
    }
    return st.code;
  }

  private async cforNode(n: Extract<Node, { type: "cfor" }>): Promise<number> {
    const st = { code: 0 };
    if (n.init.length) await this.ex.arithWord(n.init);
    for (;;) {
      this.tick();
      if (n.cond.length && (await this.ex.arithWord(n.cond)) === "0") break;
      if (await this.loopBody(n.body, st)) break;
      if (n.step.length) await this.ex.arithWord(n.step);
    }
    return st.code;
  }

  private async whileNode(
    n: Extract<Node, { type: "while" | "until" }>,
  ): Promise<number> {
    const st = { code: 0 };
    for (;;) {
      this.tick();
      const c = await this.cond_(n.cond);
      if (n.type === "while" ? c !== 0 : c === 0) break;
      if (await this.loopBody(n.body, st)) break;
    }
    return st.code;
  }

  private async caseNode(n: Case): Promise<number> {
    const word = await this.ex.text(n.word);
    const ext = !!this.ctx.options.extglob;
    let code = 0;
    let fall = false;
    for (const cl of n.clauses) {
      let hit = fall;
      if (!hit)
        for (const p of cl.patterns) {
          if (matchPattern(word, await this.ex.pattern(p), ext)) {
            hit = true;
            break;
          }
        }
      if (!hit) continue;
      code = await this.runList(cl.body);
      if (cl.term === ";;") return code;
      fall = cl.term === ";&";
      if (cl.term === ";;&") fall = false;
    }
    return code;
  }

  /* ---------- [[ ]] ---------- */

  async cond(e: CondExpr): Promise<boolean> {
    switch (e.op) {
      case "&&":
        return (await this.cond(e.l)) && (await this.cond(e.r));
      case "||":
        return (await this.cond(e.l)) || (await this.cond(e.r));
      case "!":
        return !(await this.cond(e.e));
      case "word":
        return (await this.ex.text(e.w)) !== "";
      case "unary":
        return unaryTest(this, e.flag, await this.ex.text(e.w));
      case "binary": {
        const cmp = e.cmp;
        if (cmp === "=~") {
          const s = await this.ex.text(e.l);
          let re: RegExp;
          try {
            re = new RegExp(await this.ex.regex(e.r));
          } catch {
            this.fail(
              "syntax error in conditional expression: invalid regular expression",
            );
            throw new ExpError(2, false);
          }
          const m = re.exec(s);
          const items = m ? Array.from(m, (x) => ({ value: x ?? "" })) : [];
          this.ctx.setArray("BASH_REMATCH", items, "array", false);
          return m !== null;
        }
        if (cmp === "==" || cmp === "=" || cmp === "!=") {
          const s = await this.ex.text(e.l);
          const hit = matchPattern(
            s,
            await this.ex.pattern(e.r),
            !!this.ctx.options.extglob,
          );
          return cmp === "!=" ? !hit : hit;
        }
        const l = await this.ex.text(e.l);
        const r = await this.ex.text(e.r);
        if (cmp === "<") return l < r;
        if (cmp === ">") return l > r;
        if (cmp === "-nt" || cmp === "-ot" || cmp === "-ef")
          return unaryTest(this, cmp, l + "\0" + r);
        const v = intCompare(this, cmp, l, r);
        return v;
      }
    }
  }

  /* ---------- functions ---------- */

  private defineFunction(n: FunctionDef): number {
    this.ctx.functions[n.name] = n.src;
    this.interp.fnCache.set(n.src, n.body);
    return 0;
  }

  private functionBody(name: string): Node | null {
    const src = this.ctx.functions[name];
    if (src === undefined) return null;
    let b = this.interp.fnCache.get(src);
    if (!b) {
      // A saved function is its body text (`{ ...; }`); a whole definition also works.
      const r = parse(src);
      const first = r.status === "ok" ? r.ast.items[0] : undefined;
      if (!first) return null;
      b = first.type === "function" ? (first as FunctionDef).body : first;
      this.interp.fnCache.set(src, b);
    }
    return b;
  }

  /** Source text of a function, for `declare -f` and `type`. */
  functionSource(name: string): string | undefined {
    return this.ctx.functions[name];
  }

  async callFunction(
    name: string,
    args: string[],
    body: Node,
  ): Promise<number> {
    if (this.depth >= LIM.depth) throw new NestStop(name, LIM.depth);
    this.depth++;
    this.nest++;
    const ctx = this.ctx;
    const savedParams = ctx.params;
    const savedLine = ctx.line;
    ctx.params = args;
    ctx.frames.push({ name, saved: new Map() });
    let code: number;
    try {
      code = await this.runNode(body);
    } catch (e) {
      if (e instanceof ReturnSig) code = e.code;
      else {
        if (isStackOverflow(e) && this.overflowName === null)
          this.overflowName = name;
        throw e;
      }
    } finally {
      ctx.popFrame();
      ctx.params = savedParams;
      ctx.line = savedLine;
      this.depth--;
      this.nest--;
    }
    return code;
  }

  /* ---------- simple commands ---------- */

  private async expandArgv(words: Word[]): Promise<string[]> {
    const out: string[] = [];
    this.arrArgs = new Map();
    let assignMode = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (i === 0) {
        out.push(...(await this.ex.word(w)));
        const first = out[0];
        assignMode = first !== undefined && ASSIGN_BUILTINS.has(first);
        continue;
      }
      const f = w[0];
      const last = w[w.length - 1];
      if (
        last &&
        last.k === "arr" &&
        f &&
        f.k === "lit" &&
        /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(f.v)
      ) {
        const items: { key?: string; value: string; vals: string[] }[] = [];
        for (const it of last.items) {
          const vals = await this.ex.word(it.value);
          items.push({
            key: it.key ? await this.ex.text(it.key) : undefined,
            value: vals.join(" "),
            vals,
          });
        }
        // `a=(x y)` expands each item as a word list; items without a key can split.
        const flat: { key?: string; value: string }[] = [];
        for (const it of items) {
          if (it.key !== undefined) flat.push({ key: it.key, value: it.value });
          else if (it.vals.length === 0) continue;
          else for (const v of it.vals) flat.push({ value: v });
        }
        this.arrArgs.set(out.length, { items: flat, assoc: false });
        out.push(f.v);
        continue;
      }
      if (
        assignMode &&
        f &&
        f.k === "lit" &&
        /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(f.v)
      ) {
        out.push(await this.ex.assignText(w));
        continue;
      }
      out.push(...(await this.ex.word(w)));
    }
    return out;
  }

  private async simple(n: Simple): Promise<number> {
    const ctx = this.ctx;
    this.substCode = null;
    // Alias (D8): only the first word, only when it is plain text.
    let node = n;
    if ((ctx.interactive || ctx.options.expand_aliases) && n.words.length) {
      const al = this.aliasExpand(n);
      if (al) node = al;
    }
    const argv = await this.expandArgv(node.words);
    // Prefix assignments: `A=1 cmd`.
    const temps: {
      name: string;
      had: boolean;
      env?: string;
      meta?: unknown;
      exp: boolean;
    }[] = [];
    const undoTemps = () => {
      for (const t of temps.reverse()) {
        ctx.unset(t.name);
        if (t.had && t.env !== undefined) ctx.env[t.name] = t.env;
        if (t.exp) ctx.exported.add(t.name);
      }
    };
    if (!argv.length) {
      return await this.assignOnly(node);
    }
    try {
      for (const a of node.assigns) {
        const had = ctx.env[a.name] !== undefined;
        temps.push({
          name: a.name,
          had,
          env: ctx.env[a.name],
          exp: ctx.exported.has(a.name),
        });
        const v = a.value ? await this.ex.assignText(a.value) : "";
        const err = ctx.set(a.name, v);
        if (err) {
          this.fail(err);
          return 1;
        }
        ctx.exported.add(a.name);
      }
      return await this.runWithRedirs(node, argv);
    } finally {
      undoTemps();
    }
  }

  private async runWithRedirs(node: Simple, argv: string[]): Promise<number> {
    const ctx = this.ctx;
    if (ctx.options.xtrace) {
      const ps4 = ctx.get("PS4") ?? "+ ";
      ctx.io.err.write(ps4 + argv.map(xq).join(" ") + "\n");
    }
    // `exec` without a command: the redirects stay (D3, AC3).
    if (argv[0] === "exec" && argv.length === 1 && node.redirs?.length) {
      const ap = await applyRedirs(node.redirs, ctx.io, this, true);
      if (!ap) return 1;
      ctx.io = ap.io;
      return 0;
    }
    let ap: Applied | null = null;
    let io = ctx.io;
    if (node.redirs && node.redirs.length) {
      ap = await applyRedirs(node.redirs, ctx.io, this);
      if (!ap) return 1;
      io = ap.io;
    }
    let code: number;
    const saved = ctx.io;
    ctx.io = io;
    try {
      code = await this.runCommand(argv, io, {});
    } finally {
      this.ctx.io = saved;
    }
    if (ap) {
      const err = ap.close();
      if (err) {
        this.fail(err);
        code = 1;
      }
    }
    ctx.lastArg = argv[argv.length - 1];
    if (code === 0) this.run.task.segs.push(argv);
    await this.afterCommand(code);
    return code;
  }

  /** `set -e` and the ERR trap, at the end of a simple command. */
  private async afterCommand(code: number): Promise<void> {
    const ctx = this.ctx;
    if (code === 0 || ctx.noErr > 0) return;
    const trap = ctx.traps.ERR;
    // Functions do not inherit the ERR trap unless `set -E` is on.
    const inherits = ctx.frames.length === 0 || ctx.options.errtrace;
    if (trap && !ctx.inTrap && inherits) await this.runTrap("ERR", trap, code);
    if (ctx.options.errexit) throw new ExitSig(code);
  }

  private async assignOnly(n: Simple): Promise<number> {
    const ctx = this.ctx;
    // Redirects still create their files.
    let ap: Applied | null = null;
    if (n.redirs && n.redirs.length) {
      ap = await applyRedirs(n.redirs, ctx.io, this);
      if (!ap) return 1;
    }
    let code = 0;
    const seg: string[] = [];
    for (const a of n.assigns) {
      const err = await this.doAssign(a);
      if (err) {
        this.fail(err);
        code = 1;
        break;
      }
      seg.push(`${a.name}=${ctx.get(a.name) ?? ""}`);
      if (ctx.options.xtrace)
        ctx.io.err.write(
          `${ctx.get("PS4") ?? "+ "}${a.name}=${xq(ctx.get(a.name) ?? "")}\n`,
        );
    }
    if (code === 0 && this.substCode !== null) code = this.substCode;
    if (ap) {
      const e = ap.close();
      if (e) {
        this.fail(e);
        code = 1;
      }
    }
    if (code === 0 && seg.length) this.run.task.segs.push(seg);
    await this.afterCommand(code);
    return code;
  }

  /** `name=value`, `name+=value`, `name[i]=value`, `name=(...)`. Returns an error text or null. */
  async doAssign(a: Assign): Promise<string | null> {
    const ctx = this.ctx;
    if (ctx.options.allexport) ctx.exported.add(a.name);
    if (a.array) {
      const assoc = ctx.array(a.name)?.type === "assoc";
      const items: { key?: string; value: string }[] = [];
      for (const it of a.array) {
        const vals = await this.ex.word(it.value);
        if (it.key)
          items.push({
            key: await this.ex.text(it.key),
            value: vals.join(" "),
          });
        else for (const v of vals) items.push({ value: v });
      }
      return ctx.setArray(a.name, items, assoc ? "assoc" : "array", a.append);
    }
    let v = a.value ? await this.ex.assignText(a.value) : "";
    if (ctx.attrs(a.name).includes("i")) v = this.ex.arith(v);
    if (a.idx) {
      const m = ctx.array(a.name);
      const key =
        m?.type === "assoc"
          ? await this.ex.text(a.idx)
          : this.ex.arith(await this.ex.text(a.idx));
      return ctx.setElem(a.name, key, v, a.append);
    }
    return ctx.set(a.name, v, a.append);
  }

  private aliasExpand(n: Simple): Simple | null {
    const w = n.words[0];
    if (w.length !== 1 || w[0].k !== "lit") return null;
    const name = w[0].v;
    const body = this.ctx.aliases[name];
    if (body === undefined || this.aliasing.has(name)) return null;
    const r = parse(body);
    if (
      r.status !== "ok" ||
      r.ast.items.length !== 1 ||
      r.ast.items[0].type !== "simple"
    )
      return null;
    const inner = r.ast.items[0] as Simple;
    this.aliasing.add(name);
    try {
      const merged: Simple = {
        ...n,
        assigns: [...inner.assigns, ...n.assigns],
        words: [...inner.words, ...n.words.slice(1)],
        redirs: [...(inner.redirs ?? []), ...(n.redirs ?? [])],
      };
      // The new first word may itself be an alias.
      if (merged.words.length) {
        const again = this.aliasExpand(merged);
        if (again) return again;
      }
      return merged;
    } finally {
      this.aliasing.delete(name);
    }
  }

  /* ---------- finding and running a command ---------- */

  /** What a name means: for `type`, `command -v`, and `which`. */
  lookup(name: string): {
    kind: "alias" | "keyword" | "function" | "builtin" | "file";
    path?: string;
  } | null {
    const ctx = this.ctx;
    if (ctx.aliases[name] !== undefined) return { kind: "alias" };
    if (KEYWORDS.has(name)) return { kind: "keyword" };
    if (ctx.functions[name] !== undefined) return { kind: "function" };
    // `bash` and `sh` are programs in Ubuntu, though the table runs them as builtins.
    if (Object.hasOwn(BUILTINS, name) && name !== "bash" && name !== "sh")
      return { kind: "builtin" };
    if (Object.hasOwn(this.host.commands, name))
      return { kind: "file", path: "/usr/bin/" + name };
    return null;
  }

  /** Runs a command by name. `skip` bypasses functions or the table (`command`, `builtin`). */
  async runCommand(
    argv: string[],
    io: IO,
    o: { noFunc?: boolean; builtinOnly?: boolean; noBuiltin?: boolean },
  ): Promise<number> {
    const name = argv[0];
    const ctx = this.ctx;
    if (!o.noFunc && !o.builtinOnly && ctx.functions[name] !== undefined) {
      const body = this.functionBody(name);
      if (body) return await this.callFunction(name, argv.slice(1), body);
    }
    const b = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
    if (b && !o.noBuiltin) return await b(this, argv, io);
    if (o.builtinOnly) {
      this.fail(`${name}: not a shell builtin`);
      return 1;
    }
    const cmd = Object.hasOwn(this.host.commands, name)
      ? this.host.commands[name]
      : undefined;
    if (cmd) return await cmd(argv, this, io);
    if (name.includes("/")) return await this.runPath(argv, io);
    this.fail(`${name}: command not found`);
    if (this.promptLevel()) this.run.events.push({ kind: "notfound", name });
    return 127;
  }

  /** `./script` or `/path/script`. */
  private async runPath(argv: string[], io: IO): Promise<number> {
    const path = argv[0];
    const abs = this.abs(path);
    const node = get(abs);
    if (!node) {
      this.fail(`${path}: No such file or directory`);
      return 127;
    }
    if (node.t === "d") {
      this.fail(`${path}: Is a directory`);
      return 126;
    }
    if (!node.m.includes("x")) {
      this.fail(`${path}: Permission denied`);
      return 126;
    }
    this.run.task.ranExec = abs.slice(abs.lastIndexOf("/") + 1);
    const first = readText(abs);
    if ("text" in first && first.text.startsWith("#!")) {
      const line = first.text
        .split(String.fromCharCode(10), 1)[0]
        .slice(2)
        .trim();
      if (!/^(\/usr)?\/bin\/(env\s+)?(ba)?sh(\s|$)/.test(line)) {
        this.fail(`${path}: cannot execute: required file not found`);
        return 127;
      }
    }
    return await this.runScriptFile(path, abs, argv.slice(1), io);
  }

  /** Runs a script file in a context of its own (D13). */
  async runScriptFile(
    path: string,
    abs: string,
    args: string[],
    io: IO,
  ): Promise<number> {
    const t = readText(abs);
    if ("err" in t) {
      this.fail(`${path}: ${t.err}`);
      return t.err === "Permission denied" ? 126 : 127;
    }
    const child = this.ctx.child();
    child.arg0 = path;
    child.params = args;
    child.src = { kind: "file", path };
    child.io = io;
    return await this.runInChild(child, t.text, path);
  }

  /** Runs `text` in a fresh child process as a script. Returns the exit code. */
  async runInChild(
    child: Context,
    text: string,
    name: string,
  ): Promise<number> {
    if (this.scripts >= LIM.scripts) throw new NestStop(name, LIM.scripts);
    const proc = this.spawn(child);
    proc.scripts = this.scripts + 1;
    proc.nest = this.nest + 1;
    return await this.within(proc, async () => {
      let code: number;
      try {
        code = await proc.runSourceText(text, child.src);
        code = await proc.runExitTrap(child, code);
      } catch (e) {
        if (e instanceof ExitSig) code = await proc.runExitTrap(child, e.code);
        else if (e instanceof ReturnSig) code = e.code;
        else if (e instanceof AbortLine) code = e.code;
        else throw e;
      }
      return code;
    });
  }

  /** Parses and runs text in the current context; the units before a syntax error run first. */
  async runSourceText(text: string, src: SrcInfo): Promise<number> {
    const ctx = this.ctx;
    const opts = { extglob: !!ctx.options.extglob, eof: true };
    const it = parseUnits(text, opts);
    let code = 0;
    let r: UnitResult;
    for (;;) {
      // One unit at a time: `shopt -s extglob` on one line works on the next.
      opts.extglob = !!ctx.options.extglob;
      r = it.next();
      if (r.status !== "unit") break;
      code = await this.runList(r.nodes);
    }
    if (r.status === "end") return code;
    const where = src.kind === "file" ? `${src.path}: line ` : "bash: line ";
    if (r.status === "incomplete") {
      if (r.kind === "quote") {
        this.errLine(
          `${where}${r.line}: unexpected EOF while looking for matching \`${r.ch}'`,
        );
      } else {
        const last = text.split("\n").length;
        this.errLine(`${where}${last}: syntax error: unexpected end of file`);
      }
      return 2;
    }
    if (r.nest) {
      this.note(r.message, true);
      return 2;
    }
    const msg = r.message.replace(/^bash: /, "");
    this.errLine(`${where}${r.line}: ${msg}`);
    if (r.text) this.errLine(`${where}${r.line}: \`${r.text}'`);
    return 2;
  }

  /* ---------- traps ---------- */

  async runTrap(sig: string, cmd: string, code: number): Promise<void> {
    const ctx = this.ctx;
    ctx.inTrap = true;
    const keep = ctx.lastCode;
    const prevLine = this.lineOverride;
    this.lineOverride = ctx.line;
    ctx.lastCode = code;
    try {
      const r = parse(cmd);
      if (r.status === "ok") await this.runList(r.ast.items);
    } finally {
      this.lineOverride = prevLine;
      ctx.inTrap = false;
      ctx.lastCode = keep;
    }
    void sig;
  }

  /** Runs the EXIT trap of a context that ends, in a child process. Returns the final code. */
  async runExitTrap(c: Context, code: number): Promise<number> {
    const trap = c.traps.EXIT;
    if (!trap) return code;
    delete c.traps.EXIT;
    const child = this.spawn(c);
    c.lastCode = code;
    const r = parse(trap);
    if (r.status === "ok") {
      try {
        await this.within(child, () => child.runList(r.ast.items));
      } catch (e) {
        if (e instanceof ExitSig) return e.code;
        throw e;
      }
    }
    return code;
  }

  /** Runs the EXIT trap of the prompt shell (the `exit` builtin). */
  runPromptExit(): void {
    void writeText;
  }

  /** Output helpers for builtins. */
  get err(): Writer {
    return this.ctx.io.err;
  }
}

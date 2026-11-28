// The game engine: run an input, check tasks, complete a word, and the panel
// actions. No DOM access (D9). The shell is the bash interpreter of
// src/engine/shell (D3); the prompt shell is backed by the saved state (D13).
import { imgName, REG } from "./docker";
import { esc } from "./helpers";
import { setClock } from "./clock";
import type { Clock } from "./clock";
import { createHost } from "./linux";
import { CH, M, rankFor } from "./missions";
import { htmlLine, textLine } from "./output";
import type { OutLine, Run } from "./output";
import { disp, get } from "./paths";
import { sha256 } from "./sha256";
import { BUILTINS } from "./shell/builtins";
import { analyze, variableNames } from "./shell/complete";
import {
  cloneVars,
  Context,
  HOME,
  HOST,
  reviveVars,
  termCols,
} from "./shell/context";
import { Interp } from "./shell/interp";
import { Job, jobLine } from "./shell/jobs";
import type { JobTable } from "./shell/jobs";
import type { JobNotice } from "./shell/jobs";
import { Run as InputRun, SignalStop } from "./shell/proc";
import type { Proc, ShellReq } from "./shell/proc";
import type { UnitKind } from "./shell/proc";
import type { ReadRequest, Chunk, Ctx, OutputSink } from "./shell/io";
import { parseFull } from "./shell/parser";
import { readText } from "./shell/redirect";
import { nul } from "./nullmap";
import { RC_KEY, fresh, load, save, setState } from "./state";
import type { SaveStorage, State } from "./state";

export { CH, M, RANKS, rankFor } from "./missions";
export type { Chapter, Mission } from "./missions";
export { sha256 } from "./sha256";
export { RC_KEY, SAVE_KEY } from "./state";
export type { SaveStorage, State } from "./state";
export type { Chunk, OutputEvent, OutputSink, ReadRequest } from "./shell/io";
export type { Clock } from "./clock";
export type { JobNotice } from "./shell/jobs";

/* ============================================================
   INSTRUCTOR PASSWORD for hints, skipping and jumping.
   This is the SHA-256 of the password (default: ahoy-captain).
   To change it, run:  echo -n 'your-new-password' | sha256sum
   and paste the result between the quotes below.
   ============================================================ */
const HINT_HASH =
  "daa65e53e654c24789be703e527937e31d28b4c814524f0f10a020e050f154b6";

/** Something the panel or the terminal reacts to. */
export type EngineEvent =
  | { type: "task"; index: number }
  | { type: "promotion"; rank: string }
  | { type: "chapter"; ch: number }
  | { type: "finished" };

export interface ExecResult {
  /**
   * The game's own lines after the command (learner hints, limit and nesting
   * notes, `.bashrc` notes, task, promotion, and chapter lines). Command
   * output is not here: it comes through `onOutput` (B15).
   */
  lines: OutLine[];
  /**
   * What the foreground of the input wrote, in order, each piece marked stdout
   * or stderr (D24), up to the first 1 MB of text. The learner hints and the
   * game notes (D12) are not in it.
   */
  chunks: Chunk[];
  events: EngineEvent[];
}

export interface EngineOptions {
  storage: SaveStorage;
  /** The engine clock (B5). The default reads `Date.now()` and `setTimeout`. */
  clock?: Clock;
  /** Command output reaches the terminal only through this (B15). */
  onOutput?: OutputSink;
  /** Asks for keyboard input; resolves to the typed text, or null at end of input (B15). */
  onRead?: (req: ReadRequest) => Promise<string | null>;
}

export interface Completion {
  value: string;
  cursor: number;
  /** Candidates to show when Tab cannot pick one; empty otherwise. */
  listing: string[];
}

export interface Engine {
  /** The live game state. */
  readonly state: State;
  /** True when the state came from a save. */
  readonly resumed: boolean;
  /** Sets up the current task, then saves. Gives the setup alert, if any. */
  start(): Promise<OutLine[]>;
  /** Runs one complete input. An incomplete input runs nothing and keeps the `> ` prompt. */
  execute(line: string): Promise<ExecResult>;
  /**
   * Sends a signal to the foreground job while an input runs (B6): `INT` for
   * Ctrl-C, `TSTP` for Ctrl-Z, `QUIT` for Ctrl-\\. It does nothing when no input runs.
   */
  signal(sig: string): void;
  /** True while a foreground job runs, and while `~/.bashrc` runs in `start()` (B15). */
  busy(): boolean;
  /**
   * The job lines for the next prompt (B9, B15): each job whose state changed
   * since the last prompt. Reading them clears them.
   */
  notices(): JobNotice[];
  /** True when `text` is a whole input; false when bash would show `> ` (AC1). */
  isComplete(text: string): boolean;
  /** Ctrl-C at the prompt or at `> `: drops the kept input and sets `$?` to 130. */
  cancelInput(): void;
  /** The terminal width in columns, for `COLUMNS` and `ls` (D23). */
  setColumns(cols: number): void;
  complete(value: string, cursor: number): Completion;
  /** The prompt, as runs: `> ` while an input is incomplete. */
  prompt(): Run[];
  skip(): Promise<OutLine[]>;
  jump(index: number): Promise<OutLine[]>;
  /** Unlocks hints when the password is right; null when it is wrong. */
  unlock(password: string): Promise<OutLine[] | null>;
  lock(): Promise<OutLine[]>;
  /** Starts a fresh game and saves it. */
  reset(): Promise<void>;
}

const DSUB = [
  "run",
  "ps",
  "images",
  "pull",
  "build",
  "tag",
  "stop",
  "start",
  "restart",
  "rm",
  "rmi",
  "logs",
  "exec",
  "inspect",
  "stats",
  "volume",
  "network",
  "system",
  "compose",
  "help",
  "version",
];

/** B16 (a): shown once per page load, before the first keyboard wait of a prompt command. */
const keyboardHint = (cmd: string): string =>
  `port-penguin: ${cmd || "the command"} is reading the keyboard. Type input and press Enter; Ctrl-D ends the input, Ctrl-C stops ${cmd || "it"}.`;
const NOT_FOUND_HINT = "Type help to see what this terminal knows.";

/** The prompt shell: cwd, `oldpwd`, and `$?` live in the saved state (D13). */
class PromptContext extends Context {
  constructor(private readonly st: () => State) {
    super();
  }
  override get cwd(): string {
    return this.st().cwd;
  }
  override set cwd(v: string) {
    this.st().cwd = v;
  }
  override get oldpwd(): string {
    return this.st().oldpwd;
  }
  override set oldpwd(v: string) {
    this.st().oldpwd = v;
  }
  override get lastCode(): number {
    return this.st().lastCode;
  }
  override set lastCode(v: number) {
    this.st().lastCode = v;
  }
}

/** What a nested shell keeps of its parent, to give back at `exit` (B14). */
interface ShellSnap {
  cwd: string;
  oldpwd: string;
  lastCode: number;
  env: Record<string, string>;
  exported: Set<string>;
  vars: Context["vars"];
  functions: Context["functions"];
  aliases: Context["aliases"];
  options: Context["options"];
  traps: Context["traps"];
  /** The variables `~/.bashrc` set in the parent (not saved). */
  rcOwned: Record<string, string>;
  /** The job table of the parent shell. */
  jobs: JobTable;
}

/** A word after which bash joins the next history line with a space, not `; `. */
const OPENER = /(^|[\s;&|({])(then|do|else|elif|if|while|until|\{|\()$|[;&|]$/;

/** Joins the lines of one input for the history, as bash `cmdhist` does. */
function historyText(text: string): string {
  const lines = text.split("\n");
  let out = lines[0].trim();
  for (let i = 1; i < lines.length; i++) {
    const next = lines[i];
    const slashes = /\\*$/.exec(out)?.[0].length ?? 0;
    if (slashes % 2 === 1) {
      out = out.slice(0, -1) + next;
      continue;
    }
    const r = parseFull(out);
    const open = r.status === "incomplete" && r.kind === "quote";
    const heredoc =
      r.status === "incomplete" && r.kind === "eof" && /<<-?\s*\S/.test(out);
    if (open || heredoc) out += "\n" + next;
    else if (OPENER.test(out)) out += " " + next.trim();
    else out += "; " + next.trim();
  }
  return out;
}

export function createEngine(opts: EngineOptions): Engine {
  const storage = opts.storage;
  setClock(opts.clock);
  const loaded = load(storage);
  let s: State = loaded || fresh();
  const use = () => setState(s);
  use();
  termCols.cols = 80;

  const host = createHost({
    history: () => s.hist,
    clearHistory: () => {
      s.hist.length = 0;
    },
  });
  const pctx = new PromptContext(() => s);
  const blank = (): Ctx => ({ line: "", segs: [], ranExec: null, allOut: "" });
  const interp = new Interp(host);
  interp.output = opts.onOutput;
  // B4, B16: a read of the keyboard goes to the terminal. The first one of a
  // command typed at the prompt carries the hint (once per page load).
  let keyboardHintShown = false;
  interp.reader = (req, who) => {
    if (!opts.onRead) return Promise.resolve(null);
    if (who.prompt && !keyboardHintShown) {
      keyboardHintShown = true;
      req = { ...req, hint: keyboardHint(who.cmd) };
    }
    return opts.onRead({ ...req, cmd: who.cmd });
  };
  // B10: the ids of the processes start above the largest id of `S.procs`.
  interp.sched.startPids(s.procs.reduce((m, p) => Math.max(m, p.pid), 0));
  /** The input that runs now (B6): the foreground job. */
  let fg: InputRun | null = null;
  /** The prompt shell: the root process. Its output run changes with each input. */
  let shell = interp.proc(pctx, new InputRun(blank()));
  /** B14: the parents of the active nested shells, outermost first. */
  const nested: ShellSnap[] = [];
  /** A new root process for the prompt shell; it keeps the job table of the shell. */
  const newRoot = (): Proc => {
    const p = interp.proc(pctx, new InputRun(blank()));
    p.jobs = shell.jobs;
    return p;
  };
  // B12: what a background job does goes into the check of the input that runs
  // when it happens, or into the check after the next input.
  const pendingTask: Ctx = blank();
  let curTask: Ctx | null = null;
  const bgTarget = (): Ctx => {
    if (curTask) return curTask;
    // A job that runs for ever at an idle prompt must not grow the list without a bound.
    if (pendingTask.segs.length > 5000)
      pendingTask.segs.splice(0, pendingTask.segs.length - 5000);
    return pendingTask;
  };
  interp.bgTask = {
    get line() {
      return bgTarget().line;
    },
    set line(v: string) {
      bgTarget().line = v;
    },
    get segs() {
      return bgTarget().segs;
    },
    set segs(v: string[][]) {
      bgTarget().segs = v;
    },
    get ranExec() {
      return bgTarget().ranExec;
    },
    set ranExec(v: string | null) {
      bgTarget().ranExec = v;
    },
    get allOut() {
      return bgTarget().allOut;
    },
    set allOut(v: string) {
      bgTarget().allOut = v;
    },
  };
  /** Moves what jobs did since the last input into the check of the input that starts. */
  function takePending(task: Ctx): void {
    if (pendingTask.segs.length) {
      task.segs.push(...pendingTask.segs);
      pendingTask.segs = [];
    }
    if (pendingTask.allOut) {
      task.allOut = (pendingTask.allOut + task.allOut).slice(0, 1_048_576);
      pendingTask.allOut = "";
    }
    if (pendingTask.ranExec && !task.ranExec)
      task.ranExec = pendingTask.ranExec;
    pendingTask.ranExec = null;
    curTask = task;
  }
  // B12: the game saves when a background job ends (an input saves at its own end).
  interp.onJobEnd = () => {
    if (fg === null) {
      use();
      persist();
    }
  };
  /** Settles when the input that runs now has ended (for the panel actions, B15). */
  let fgDone: Promise<void> = Promise.resolve();

  /** Tells the player a job stopped, as bash does at once (B9). */
  function announceStopped(run: InputRun, job: Job): void {
    run.emit({
      stream: "stderr",
      // Bash starts the line with a newline: the tty echoes `^Z` without one.
      text: "\n" + jobLine(job, shell.jobs.mark(job)) + "\n",
    });
    shell.jobs.extra.push({ text: "", say: `Job ${job.n} stopped` });
  }

  /** The status and the signal of a unit that ended well (a number, or the stages of a pipeline). */
  function unitCode(v: unknown, kind: UnitKind): [number, string | null] {
    if (kind !== "stages") return [typeof v === "number" ? v : 0, null];
    const list = Array.isArray(v)
      ? (v as ({ code: number } | { err: unknown })[])
      : [];
    for (const d of list)
      if ("err" in d && d.err instanceof SignalStop)
        return [d.err.code, d.err.sig];
    const last = list[list.length - 1];
    return [last && "code" in last ? last.code : 0, null];
  }

  /**
   * Ctrl-Z (B9): the unit that the input waits on goes on as a stopped job, and
   * the rest of the input does not run. Does nothing when a builtin waits.
   */
  function stopForeground(): void {
    const run = fg;
    if (!run) return;
    const table = shell.jobs;
    if (run.fgJob) {
      const j = run.fgJob;
      j.stop();
      table.touch(j);
      announceStopped(run, j);
      return;
    }
    const root = run.root;
    if (!root || !root.detach) return;
    const { p, kind } = root.detach();
    const rest = [...run.procs].filter((x) => x !== root);
    const members = kind === "cmd" ? [root, ...rest] : rest;
    // The job is the stopped unit, not the whole input: `echo a; sleep 100` stops `sleep 100`.
    const job = new Job(root.unitText || run.task.line.trim(), true);
    if (kind === "cmd") root.pid = interp.sched.allocPid();
    for (const m of members) job.add(m);
    job.run = run;
    job.onDone = interp.onJobEnd ?? null;
    // What the unit writes from now on belongs to the next check (B12).
    run.task = interp.bgTask;
    table.add(job);
    job.stop();
    announceStopped(run, job);
    // The next input needs a root process of its own; this one belongs to the job.
    if (kind === "cmd") shell = newRoot();
    const end = (code: number, sig: string | null): void => {
      // A unit that ran on the baton of the root gives it back when it ends.
      if (kind !== "stages") interp.sched.release();
      job.finish(code, sig);
    };
    p.then(
      (v) => {
        const [code, sig] = unitCode(v, kind);
        end(code, sig);
      },
      (e: unknown) => {
        if (e instanceof SignalStop) end(e.code, e.sig);
        else if (e && typeof e === "object" && "code" in e)
          end(Number((e as { code: unknown }).code), null);
        else end(1, null);
      },
    );
  }

  /**
   * Ends jobs and forgets them (B11, B15). KILL runs no trap and prints no
   * notice; HUP is what `exit` sends. `all` ends the jobs of every shell, the
   * foreground one too (a panel action, B15); `current` ends only the jobs of
   * the shell that leaves (`exit` of a nested shell, B14).
   */
  async function endJobs(
    sig: "KILL" | "HUP",
    scope: "all" | "current" = "all",
  ): Promise<void> {
    const sched = interp.sched;
    const tables: JobTable[] =
      scope === "all" ? [...interp.tables, shell.jobs] : [shell.jobs];
    const all = [...new Set(tables.flatMap((t) => t.active()))];
    if (scope === "all" && fg) sched.signalRun(fg, sig);
    for (const j of all)
      for (const p of j.live()) {
        sched.deliver(p, sig);
        p.cont();
      }
    if (scope === "all") await fgDone;
    for (const j of all)
      while (j.state !== "done")
        await new Promise<void>((resolve) => {
          const off = j.onChange(resolve);
          // A job that ended in between never calls back.
          if (j.state === "done") {
            off();
            resolve();
          }
        });
    for (const t of new Set(tables)) t.clear();
    if (scope === "all") {
      pendingTask.segs = [];
      pendingTask.allOut = "";
    }
  }

  /**
   * B14, B15: a panel action closes every nested shell and keeps the current
   * values of the top shell. The snapshots are dropped, none is restored.
   */
  function closeNested(): void {
    if (!nested.length) return;
    const top = nested[0].jobs;
    nested.length = 0;
    interp.shellDepth = 0;
    shell.jobs = top;
  }

  /** Variables that `~/.bashrc` set. They are not saved: it sets them again at start. */
  let rcOwned: Record<string, string> = nul();
  let rcDone = false;
  let pending = false;
  let saveFailed = false;

  /** Fills the prompt context from the saved state (D13). */
  function hydrate(c: Context): void {
    c.env = nul(s.env);
    c.exported = new Set(
      Array.isArray(s.exported) ? s.exported : Object.keys(s.env),
    );
    c.vars = reviveVars((s.vars ?? {}) as Record<string, unknown>);
    c.functions = nul(s.functions);
    c.aliases = nul(s.aliases);
    c.options = nul(s.options);
    c.interactive = true;
    c.src = { kind: "prompt" };
    c.arg0 = "bash";
    c.params = [];
    c.frames = [];
    c.traps = nul();
  }

  /** Writes the shell variables back to the state, which task checks read. */
  function syncOut(): void {
    const c = pctx;
    const env: Record<string, string> = nul();
    for (const [k, v] of Object.entries(c.env))
      if (rcOwned[k] !== v) env[k] = v;
    s.env = env;
    s.exported = [...c.exported];
    s.vars = cloneVars(c.vars);
    s.functions = nul(c.functions);
    s.aliases = nul(c.aliases);
    s.options = nul(c.options);
  }

  /** Runs `~/.bashrc` silently under the D19 guard. Gives the dim line, if any. */
  async function runRc(): Promise<OutLine[]> {
    rcDone = true;
    // Its output is discarded: this run has no `onOutput`. Ctrl-C stops it (B15).
    const rcRun = new InputRun(blank());
    shell.attach(rcRun, false);
    fg = rcRun;
    const before = nul(pctx.env);
    const text = readText(HOME + "/.bashrc");
    let reason: string | null = null;
    let marked: boolean;
    try {
      marked = !!storage.getItem(RC_KEY);
    } catch {
      marked = false;
    }
    const setMark = (on: boolean): void => {
      try {
        if (on) storage.setItem(RC_KEY, "1");
        else if (storage.removeItem) storage.removeItem(RC_KEY);
        else storage.setItem(RC_KEY, "");
      } catch {
        /* storage blocked: the guard cannot help, the game goes on */
      }
    };
    if (marked) {
      // The last start did not finish (a freeze that no limit could stop).
      setMark(false);
      reason = "the last start did not finish";
    } else if ("text" in text) {
      setMark(true);
      try {
        reason = await shell.runRc(text.text);
      } catch (e) {
        reason = e instanceof Error ? e.message : "error";
      }
      setMark(false);
    }
    fg = null;
    rcOwned = nul();
    for (const [k, v] of Object.entries(pctx.env))
      if (before[k] === undefined) rcOwned[k] = v;
    shell.attach(new InputRun(blank()));
    return reason === null
      ? []
      : [
          textLine(
            `port-penguin: ~/.bashrc failed (${reason}); the shell started without it`,
            "dim",
          ),
        ];
  }

  /** Builds the prompt shell again from the state, then runs `~/.bashrc`. */
  async function newShell(keep?: Set<string>): Promise<OutLine[]> {
    const old = pctx.env;
    hydrate(pctx);
    if (keep) {
      // `exit`: only exported variables stay (D13).
      pctx.env = nul();
      for (const k of keep) if (old[k] !== undefined) pctx.env[k] = old[k];
      pctx.exported = new Set(keep);
      pctx.vars = nul();
      pctx.functions = nul();
      pctx.aliases = nul();
      pctx.options = nul();
      pctx.oldpwd = HOME;
      pctx.cwd = HOME;
    }
    pending = false;
    return await runRc();
  }

  /**
   * B14: starts a child prompt shell. The parent's values go into a snapshot;
   * the child is the prompt context backed by `S` (D13) with the exported
   * variables, `SHLVL` plus 1, `$?` 0, and a job table of its own.
   */
  async function enterShell(req: ShellReq): Promise<OutLine[]> {
    nested.push({
      cwd: pctx.cwd,
      oldpwd: pctx.oldpwd,
      lastCode: pctx.lastCode,
      env: nul(pctx.env),
      exported: new Set(pctx.exported),
      vars: cloneVars(pctx.vars),
      functions: nul(pctx.functions),
      aliases: nul(pctx.aliases),
      options: nul(pctx.options),
      traps: nul(pctx.traps),
      rcOwned,
      jobs: shell.jobs,
    });
    interp.shellDepth = nested.length;
    const level = Math.floor(Number(pctx.get("SHLVL")));
    const env: Record<string, string> = nul();
    for (const k of pctx.exported)
      if (pctx.env[k] !== undefined) env[k] = pctx.env[k];
    env.SHLVL = String((Number.isFinite(level) && level >= 0 ? level : 0) + 1);
    pctx.env = env;
    pctx.exported = new Set(Object.keys(env));
    pctx.vars = nul();
    pctx.functions = nul();
    pctx.aliases = nul();
    pctx.options = nul();
    for (const [k, v] of Object.entries(req.opts)) pctx.options[k] = v;
    pctx.interactive = true;
    pctx.src = { kind: "prompt" };
    pctx.arg0 = "bash";
    pctx.params = [];
    pctx.frames = [];
    pctx.traps = nul();
    pctx.lastCode = 0;
    shell.jobs = interp.newTable();
    pending = false;
    rcOwned = nul();
    return req.norc ? [] : await runRc();
  }

  /** B14: `exit` in a nested shell ends its jobs (SIGHUP), restores the parent, and sets its `$?`. */
  async function leaveShell(code: number): Promise<void> {
    await endJobs("HUP", "current");
    const snap = nested.pop();
    interp.shellDepth = nested.length;
    if (!snap) return;
    pctx.cwd = snap.cwd;
    pctx.oldpwd = snap.oldpwd;
    pctx.env = snap.env;
    pctx.exported = snap.exported;
    pctx.vars = snap.vars;
    pctx.functions = snap.functions;
    pctx.aliases = snap.aliases;
    pctx.options = snap.options;
    pctx.traps = snap.traps;
    pctx.frames = [];
    pctx.params = [];
    rcOwned = snap.rcOwned;
    shell.jobs = snap.jobs;
    pending = false;
    pctx.lastCode = code;
  }

  const persist = (): string | null => {
    syncOut();
    return save(storage, s);
  };

  hydrate(pctx);

  function activate(out: OutLine[]): void {
    const m = M[s.cur];
    if (m && m.setup && !s.setup[s.cur]) {
      m.setup();
      s.setup[s.cur] = true;
      if (m.alert) out.push(htmlLine(esc(m.alert), "sys alert"));
    }
  }

  function checkMissions(ctx: Ctx, out: OutLine[], events: EngineEvent[]) {
    let guard = 0;
    while (s.cur < M.length && guard++ < 5) {
      const m = M[s.cur];
      let ok = false;
      try {
        ok = m.check(ctx);
      } catch {
        // A check that throws counts as not done, as before.
      }
      if (!ok) break;
      const before = rankFor(s.done.length);
      if (!s.done.includes(s.cur)) s.done.push(s.cur);
      events.push({ type: "task", index: s.cur });
      out.push(
        htmlLine(
          `<span class="ok">✓ ${esc(m.title)}</span>  <span class="dim">+10 XP</span>\n<span class="dim">${esc(m.after)}</span>`,
          "sys",
        ),
      );
      const after = rankFor(s.done.length);
      if (after !== before) {
        events.push({ type: "promotion", rank: after });
        out.push(
          htmlLine(
            `<span class="pu">Promoted to ${esc(after)}!</span>`,
            "sys big",
          ),
        );
      }
      const prevCh = m.ch;
      s.cur++;
      while (s.cur < M.length && s.done.includes(s.cur)) s.cur++;
      if (s.cur < M.length) {
        if (M[s.cur].ch !== prevCh) {
          events.push({ type: "chapter", ch: M[s.cur].ch });
          out.push(
            htmlLine(
              `<span class="pu">New chapter: ${esc(CH[M[s.cur].ch].name)}</span>`,
              "sys big",
            ),
          );
        }
        out.push(
          htmlLine(
            `<span class="dim">Next task:</span> ${esc(M[s.cur].title)}`,
          ),
        );
        activate(out);
      } else if (s.done.length >= M.length) {
        events.push({ type: "finished" });
        out.push(
          htmlLine(
            `<span class="pu">🚢 All 70 containers are in the yard. You’re the harbor master!</span>\n<span class="dim">Keep exploring freely: everything still works.</span>`,
            "sys big",
          ),
        );
      }
    }
  }

  /** Names a command word can complete to: the table, builtins, aliases, functions. */
  const commandNames = (): string[] => {
    const names = new Set<string>();
    for (const k of Object.keys(host.commands))
      if (!k.includes("/")) names.add(k);
    for (const k of Object.keys(BUILTINS)) if (/^[a-z]/.test(k)) names.add(k);
    for (const k of Object.keys(pctx.aliases)) names.add(k);
    for (const k of Object.keys(pctx.functions)) names.add(k);
    return [...names];
  };

  const isComplete = (text: string): boolean => {
    const r = parseFull(text, { extglob: !!pctx.options.extglob });
    pending = r.status === "incomplete";
    return !pending;
  };

  return {
    get state() {
      return s;
    },
    resumed: loaded !== null,

    async start() {
      use();
      const out: OutLine[] = [];
      activate(out);
      if (!rcDone) out.push(...(await runRc()));
      // A failed save is reported by the first command, not here.
      persist();
      return out;
    },

    isComplete,

    signal(sig: string) {
      if (!fg) return;
      if (sig === "TSTP" && fg.root?.ctx.traps.TSTP === undefined) {
        stopForeground();
        return;
      }
      // The tty echoes `^C` with no newline. Bash ends the line when the job dies,
      // unless the shell ignores the signal (`trap '' INT`: the capture, B6).
      if (sig === "INT" && fg.root?.ctx.traps.INT !== "")
        fg.emit({ stream: "stderr", text: "\n" });
      interp.sched.signalRun(fg, sig);
    },

    notices() {
      return shell.jobs.notices();
    },

    busy() {
      return fg !== null;
    },

    cancelInput() {
      use();
      pending = false;
      pctx.lastCode = 130;
    },

    setColumns(cols: number) {
      termCols.cols = Math.max(1, Math.floor(cols) || 80);
    },

    async execute(lineText: string): Promise<ExecResult> {
      use();
      shell.jobs.inputSeq++;
      const events: EngineEvent[] = [];
      const lines: OutLine[] = [];
      if (!rcDone) lines.push(...(await runRc()));
      if (!lineText.trim()) {
        pending = false;
        return { lines, chunks: [], events };
      }
      if (!isComplete(lineText)) {
        // Nothing runs; the terminal draws `> ` and waits for more.
        return { lines, chunks: [], events };
      }
      const control = String(pctx.get("HISTCONTROL") ?? "");
      const entry = historyText(lineText);
      const skip =
        (/ignorespace|ignoreboth/.test(control) && /^[ \t]/.test(lineText)) ||
        (/ignoredups|ignoreboth/.test(control) &&
          s.hist[s.hist.length - 1] === entry);
      if (!skip) {
        s.hist.push(entry);
        if (s.hist.length > 300) s.hist.shift();
      }
      const task: Ctx = {
        line: lineText,
        segs: [],
        ranExec: null,
        allOut: "",
      };
      const run = new InputRun(task, opts.onOutput);
      run.jobControl = true;
      shell.attach(run);
      fg = run;
      takePending(task);
      let release!: () => void;
      fgDone = new Promise<void>((resolve) => (release = resolve));
      let crashed: string | null = null;
      /** The runs of this input: Ctrl-Z in a list starts a new one for the rest of the list (B9). */
      const runs: InputRun[] = [run];
      try {
        await shell.runLine(lineText);
        for (let cur = run; cur.rest; cur = runs[runs.length - 1]) {
          const items = cur.rest;
          cur.rest = null;
          // The stopped unit went on as a job; the list goes on with a new root, as bash does.
          const next = new InputRun(task, opts.onOutput);
          next.jobControl = true;
          shell.attach(next);
          runs.push(next);
          fg = next;
          pctx.lastCode = 148;
          await shell.runRest(items);
        }
      } catch (e) {
        crashed = e instanceof Error ? e.message : "error";
        // The detail goes to the browser console, not to the learner.
        console.error("port-penguin: simulator error:", e);
        pctx.lastCode = 1;
      }
      fg = null;
      curTask = null;
      release();
      const chunks = runs.flatMap((r) => r.chunks);
      if (crashed !== null)
        lines.push(
          textLine(
            "That command hit a problem in the simulator. Try it again, or type help.",
            "err",
          ),
        );
      for (const r of runs)
        for (const n of r.notes)
          lines.push(textLine(n.text, n.dim ? "dim" : undefined));
      const seen = runs.flatMap((r) => r.events);
      if (seen.some((e) => e.kind === "notfound"))
        lines.push(textLine(NOT_FOUND_HINT, "dim"));
      const last = runs[runs.length - 1];
      const exited = last.exited ?? run.exited;
      const shellReq = last.shellReq ?? run.shellReq;
      if (exited !== null) {
        const code = exited;
        if (nested.length) await leaveShell(code);
        else {
          await endJobs("HUP");
          syncOut();
          lines.push(...(await newShell(new Set(pctx.exported))));
          pctx.lastCode = code;
        }
      } else if (shellReq) lines.push(...(await enterShell(shellReq)));
      syncOut();
      checkMissions(task, lines, events);
      const failure = persist();
      if (failure === null) saveFailed = false;
      else if (!saveFailed) {
        saveFailed = true;
        lines.push(
          textLine(
            `port-penguin: progress could not be saved (${failure})`,
            "dim",
          ),
        );
      }
      return { lines, chunks, events };
    },

    complete(v: string, pos: number): Completion {
      use();
      const before = v.slice(0, pos);
      const spot = analyze(before);
      let cands: string[] = [];
      let dirPart = "";
      let word: string;
      let start: number;
      const files = (w: string) => {
        const sl = w.lastIndexOf("/");
        dirPart = sl >= 0 ? w.slice(0, sl + 1) : "";
        const pre = w.slice(sl + 1);
        const dn = get(dirPart || ".");
        if (dn && dn.t === "d")
          cands = Object.keys(dn.c)
            .filter(
              (n) => n.startsWith(pre) && (pre.startsWith(".") || n[0] !== "."),
            )
            .sort()
            .map((n) => dirPart + n + (dn.c[n].t === "d" ? "/" : " "));
      };
      if (spot.kind === "var") {
        word = spot.prefix;
        start = spot.start;
        const braced = before.slice(0, start).endsWith("{");
        const quoted = (before.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
        const tail = braced ? "}" : quoted ? "" : " ";
        cands = variableNames(pctx, word).map((n) => n + tail);
      } else {
        word = spot.word;
        start = spot.start;
        const words = spot.kind === "command" ? [] : spot.words;
        const pick = (list: string[]) =>
          list.filter((c) => c.startsWith(word)).map((c) => c + " ");
        if (words.length === 0) {
          if (word.includes("/")) files(word);
          else
            cands = commandNames()
              .filter((c) => c.startsWith(word))
              .sort()
              .map((c) => c + " ");
        } else if (words[0] === "docker" && words.length === 1)
          cands = pick(DSUB);
        else if (
          words[0] === "docker" &&
          words[1] === "compose" &&
          words.length === 2
        )
          cands = pick(["up", "ps", "logs", "down", "stop", "start"]);
        else if (
          words[0] === "docker" &&
          words[1] === "volume" &&
          words.length === 2
        )
          cands = pick(["create", "ls", "rm", "inspect"]);
        else if (
          words[0] === "docker" &&
          words[1] === "network" &&
          words.length === 2
        )
          cands = pick([
            "create",
            "ls",
            "rm",
            "inspect",
            "connect",
            "disconnect",
          ]);
        else if (
          words[0] === "docker" &&
          [
            "stop",
            "start",
            "restart",
            "rm",
            "logs",
            "exec",
            "inspect",
            "kill",
          ].includes(words[1]) &&
          !word.includes("/")
        )
          cands = pick(s.dk.containers.map((c) => c.name));
        else if (
          words[0] === "docker" &&
          ["rmi", "run", "tag"].includes(words[1]) &&
          !word.includes("/") &&
          word[0] !== "-"
        )
          cands = pick(
            Array.from(
              new Set(
                s.dk.images
                  .map(imgName)
                  .concat(words[1] === "run" ? Object.keys(REG) : []),
              ),
            ),
          );
        else if (words[0] === "kill")
          cands = pick(
            [
              ...new Set([
                ...interp.liveProcs().map((p) => p.pid),
                ...s.procs.map((p) => p.pid),
              ]),
            ].map(String),
          );
        else files(word);
      }
      const none: Completion = { value: v, cursor: pos, listing: [] };
      if (!cands.length) return none;
      const put = (x: string): Completion => ({
        value: v.slice(0, start) + x + v.slice(pos),
        cursor: start + x.length,
        listing: [],
      });
      if (cands.length === 1) return put(cands[0]);
      let lcp = cands[0];
      for (const c of cands) while (!c.startsWith(lcp)) lcp = lcp.slice(0, -1);
      if (lcp.length > word.length) return put(lcp);
      return {
        ...none,
        listing: cands.map((c) => c.slice(dirPart.length).trim()),
      };
    },

    prompt(): Run[] {
      if (pending) return [{ text: "> " }];
      return [
        { text: `cadet@${HOST}`, style: "pu" },
        { text: ":" },
        { text: disp(s.cwd), style: "pp" },
        { text: "$ " },
      ];
    },

    async skip() {
      await endJobs("KILL");
      closeNested();
      use();
      const out: OutLine[] = [];
      s.cur++;
      activate(out);
      persist();
      out.push(
        textLine(
          `Skipped. Next: ${M[s.cur] ? M[s.cur].title : "end of the logbook"}`,
          "dim",
        ),
      );
      return out;
    },

    async jump(index: number) {
      await endJobs("KILL");
      closeNested();
      use();
      const out: OutLine[] = [];
      s.cur = index;
      activate(out);
      persist();
      out.push(
        textLine(`Jumped to task ${s.cur + 1}: ${M[s.cur].title}`, "dim"),
      );
      return out;
    },

    async unlock(password: string) {
      await endJobs("KILL");
      closeNested();
      use();
      if (sha256(password) !== HINT_HASH) return null;
      s.unlocked = true;
      persist();
      return [
        textLine(
          "Hints unlocked. You can also skip tasks and jump between them now.",
          "ok",
        ),
      ];
    },

    async lock() {
      await endJobs("KILL");
      closeNested();
      use();
      s.unlocked = false;
      persist();
      return [textLine("Hints locked again.", "dim")];
    },

    async reset() {
      await endJobs("KILL");
      closeNested();
      s = fresh();
      use();
      await newShell();
      persist();
    },
  };
}

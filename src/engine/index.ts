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
import { Run as InputRun } from "./shell/proc";
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
  const shell = interp.proc(pctx, new InputRun(blank()));
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
      if (fg) interp.sched.signalRun(fg, sig);
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
      shell.attach(run);
      fg = run;
      let crashed: string | null = null;
      try {
        await shell.runLine(lineText);
      } catch (e) {
        crashed = e instanceof Error ? e.message : "error";
        // The detail goes to the browser console, not to the learner.
        console.error("port-penguin: simulator error:", e);
        pctx.lastCode = 1;
      }
      fg = null;
      const chunks = run.chunks.slice();
      if (crashed !== null)
        lines.push(
          textLine(
            "That command hit a problem in the simulator. Try it again, or type help.",
            "err",
          ),
        );
      for (const n of run.notes)
        lines.push(textLine(n.text, n.dim ? "dim" : undefined));
      const seen = run.events;
      if (seen.some((e) => e.kind === "notfound"))
        lines.push(textLine(NOT_FOUND_HINT, "dim"));
      if (run.exited !== null) {
        const code = run.exited;
        syncOut();
        lines.push(...(await newShell(new Set(pctx.exported))));
        pctx.lastCode = code;
      }
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
          cands = pick(s.procs.map((p) => String(p.pid)));
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
      use();
      s.unlocked = false;
      persist();
      return [textLine("Hints locked again.", "dim")];
    },

    async reset() {
      s = fresh();
      use();
      await newShell();
      persist();
    },
  };
}

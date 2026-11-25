// The game engine: run an input, check tasks, complete a word, and the panel
// actions. No DOM access (D9). The shell is the bash interpreter of
// src/engine/shell (D3); the prompt shell is backed by the saved state (D13).
import { imgName, REG } from "./docker";
import { esc } from "./helpers";
import { CMDS, createHost, screen } from "./linux";
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
import type { Chunk, CmdFn, Ctx } from "./shell/io";
import { parseFull } from "./shell/parser";
import { readText } from "./shell/redirect";
import { fresh, load, save, setState } from "./state";
import type { SaveStorage, State } from "./state";

export { CH, M, RANKS, rankFor } from "./missions";
export type { Chapter, Mission } from "./missions";
export { sha256 } from "./sha256";
export { SAVE_KEY } from "./state";
export type { SaveStorage, State } from "./state";
export type { Chunk } from "./shell/io";

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
  /** Output after the command, without the echoed prompt line. */
  lines: OutLine[];
  /**
   * What the input wrote, in order, each piece marked stdout or stderr
   * (D24). The learner hints and the game notes (D12) are not in it.
   */
  chunks: Chunk[];
  /** True when the command cleared the screen; `lines` is then only what came after. */
  cleared: boolean;
  events: EngineEvent[];
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
  start(): OutLine[];
  /** Runs one complete input. An incomplete input runs nothing and keeps the `> ` prompt. */
  execute(line: string): ExecResult;
  /** True when `text` is a whole input; false when bash would show `> ` (AC1). */
  isComplete(text: string): boolean;
  /** Ctrl-C at the prompt or at `> `: drops the kept input and sets `$?` to 130. */
  cancelInput(): void;
  /** The terminal width in columns, for `COLUMNS` and `ls` (D23). */
  setColumns(cols: number): void;
  complete(value: string, cursor: number): Completion;
  /** The prompt, as runs: `> ` while an input is incomplete. */
  prompt(): Run[];
  skip(): OutLine[];
  jump(index: number): OutLine[];
  /** Unlocks hints when the password is right; null when it is wrong. */
  unlock(password: string): OutLine[] | null;
  lock(): OutLine[];
  /** Starts a fresh game and saves it. */
  reset(): void;
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

const KEYBOARD_HINT =
  "port-penguin: keyboard input comes in a later update; use a pipe or < FILE";
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

/** Output lines: one for each run of same-stream text (D24); engine HTML stays styled. */
function chunkLines(chunks: Chunk[]): OutLine[] {
  const out: OutLine[] = [];
  let buf = "";
  let stream: Chunk["stream"] | null = null;
  const flush = () => {
    if (stream !== null)
      out.push(textLine(buf, stream === "stderr" ? "err" : undefined));
    buf = "";
    stream = null;
  };
  for (const c of chunks) {
    if (c.html !== undefined) {
      flush();
      out.push(
        htmlLine(
          c.html.replace(/\n$/, ""),
          c.stream === "stderr" ? "err" : undefined,
        ),
      );
      continue;
    }
    if (stream !== c.stream) {
      flush();
      stream = c.stream;
    }
    buf += c.text;
  }
  flush();
  return out;
}

export function createEngine(opts: { storage: SaveStorage }): Engine {
  const storage = opts.storage;
  const loaded = load(storage);
  let s: State = loaded || fresh();
  const use = () => setState(s);
  use();
  termCols.cols = 80;

  /** Where the last `clear` stood in the chunk list of the input. */
  let clearAt = 0;
  const host = createHost({
    history: () => s.hist,
    clearHistory: () => {
      s.hist.length = 0;
    },
  });
  const clearCmd: CmdFn = (argv, sh, io) => {
    const code = CMDS.clear(argv, sh, io);
    clearAt = sh.chunks.length;
    return code;
  };
  for (const k of ["clear", "/usr/bin/clear", "/bin/clear"])
    host.commands[k] = clearCmd;

  const pctx = new PromptContext(() => s);
  const interp = new Interp(host, pctx);
  /** Variables that `~/.bashrc` set. They are not saved: it sets them again at start. */
  let rcOwned: Record<string, string> = {};
  let rcDone = false;
  let pending = false;
  let saveFailed = false;

  /** Fills the prompt context from the saved state (D13). */
  function hydrate(c: Context): void {
    c.env = { ...s.env };
    c.exported = new Set(
      Array.isArray(s.exported) ? s.exported : Object.keys(s.env),
    );
    c.vars = reviveVars((s.vars ?? {}) as Record<string, unknown>);
    c.functions = { ...(s.functions ?? {}) };
    c.aliases = { ...(s.aliases ?? {}) };
    c.options = { ...(s.options ?? {}) };
    c.interactive = true;
    c.src = { kind: "prompt" };
    c.arg0 = "bash";
    c.params = [];
    c.frames = [];
    c.traps = {};
  }

  /** Writes the shell variables back to the state, which task checks read. */
  function syncOut(): void {
    const c = interp.ctx;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env))
      if (rcOwned[k] !== v) env[k] = v;
    s.env = env;
    s.exported = [...c.exported];
    s.vars = cloneVars(c.vars);
    s.functions = { ...c.functions };
    s.aliases = { ...c.aliases };
    s.options = { ...c.options };
  }

  const blank = (): Ctx => ({ line: "", segs: [], ranExec: null, allOut: "" });

  /** Runs `~/.bashrc` silently under the D19 guard. Gives the dim line, if any. */
  function runRc(): OutLine[] {
    rcDone = true;
    interp.ctx = pctx;
    interp.begin(blank());
    const before = { ...pctx.env };
    const text = readText(HOME + "/.bashrc");
    let reason: string | null = null;
    if ("text" in text) {
      try {
        reason = interp.runRc(text.text);
      } catch (e) {
        reason = e instanceof Error ? e.message : "error";
      }
    }
    interp.ctx = pctx;
    rcOwned = {};
    for (const [k, v] of Object.entries(pctx.env))
      if (before[k] === undefined) rcOwned[k] = v;
    interp.begin(blank());
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
  function newShell(keep?: Set<string>): OutLine[] {
    const old = pctx.env;
    hydrate(pctx);
    if (keep) {
      // `exit`: only exported variables stay (D13).
      pctx.env = {};
      for (const k of keep) if (old[k] !== undefined) pctx.env[k] = old[k];
      pctx.exported = new Set(keep);
      pctx.vars = {};
      pctx.functions = {};
      pctx.aliases = {};
      pctx.options = {};
      pctx.oldpwd = HOME;
      pctx.cwd = HOME;
    }
    pending = false;
    return runRc();
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

    start() {
      use();
      const out: OutLine[] = [];
      activate(out);
      if (!rcDone) out.push(...runRc());
      // A failed save is reported by the first command, not here.
      persist();
      return out;
    },

    isComplete,

    cancelInput() {
      use();
      pending = false;
      pctx.lastCode = 130;
    },

    setColumns(cols: number) {
      termCols.cols = Math.max(1, Math.floor(cols) || 80);
    },

    execute(lineText: string): ExecResult {
      use();
      const events: EngineEvent[] = [];
      let lines: OutLine[] = [];
      if (!rcDone) lines.push(...runRc());
      if (!lineText.trim()) {
        pending = false;
        return { lines, chunks: [], cleared: false, events };
      }
      if (!isComplete(lineText)) {
        // Nothing runs; the terminal draws `> ` and waits for more.
        return { lines, chunks: [], cleared: false, events };
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
      interp.ctx = pctx;
      interp.begin(task);
      screen.cleared = false;
      clearAt = 0;
      let crashed: string | null = null;
      try {
        interp.runLine(lineText);
      } catch (e) {
        crashed = e instanceof Error ? e.message : "error";
        pctx.lastCode = 1;
      }
      interp.ctx = pctx;
      const chunks = interp.chunks.slice();
      const cleared = screen.cleared;
      screen.cleared = false;
      lines = chunkLines(cleared ? chunks.slice(clearAt) : chunks).concat(
        lines,
      );
      if (crashed !== null)
        lines.push(
          textLine("Something went wrong running that: " + crashed, "err"),
        );
      for (const n of interp.notes)
        lines.push(textLine(n.text, n.dim ? "dim" : undefined));
      const seen = interp.events;
      if (seen.some((e) => e.kind === "notfound"))
        lines.push(textLine(NOT_FOUND_HINT, "dim"));
      if (seen.some((e) => e.kind === "stdin"))
        lines.push(textLine(KEYBOARD_HINT, "dim"));
      if (interp.exited !== null) {
        const code = interp.exited;
        syncOut();
        lines.push(...newShell(new Set(pctx.exported)));
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
      return { lines, chunks, cleared, events };
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

    skip() {
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

    jump(index: number) {
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

    unlock(password: string) {
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

    lock() {
      use();
      s.unlocked = false;
      persist();
      return [textLine("Hints locked again.", "dim")];
    },

    reset() {
      s = fresh();
      use();
      newShell();
      persist();
    },
  };
}

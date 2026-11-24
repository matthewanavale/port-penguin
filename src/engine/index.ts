// The game engine: run a command line, check tasks, complete a word, and
// the panel actions. No DOM access (D9). Ported from index.html:1405-1408,
// :1448-1495, :1520-1547, :1563-1568 at 5e96ce5.
import { imgName, REG } from "./docker";
import { E, esc } from "./helpers";
import type { Ctx, Res } from "./helpers";
import { CMDS } from "./linux";
import { CH, M, rankFor } from "./missions";
import { htmlLine, textLine } from "./output";
import type { OutLine, Run } from "./output";
import { get, disp } from "./paths";
import { runPipeline } from "./pipeline";
import { sha256 } from "./sha256";
import { fresh, HOST, load, save, setState } from "./state";
import type { SaveStorage, State } from "./state";
import { tokenize, tokenizeChains } from "./tokenizer";

export { CH, M, RANKS, rankFor } from "./missions";
export type { Chapter, Mission } from "./missions";
export { sha256 } from "./sha256";
export { SAVE_KEY } from "./state";
export type { SaveStorage, State } from "./state";

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
  execute(line: string): ExecResult;
  complete(value: string, cursor: number): Completion;
  /** The prompt, as runs. */
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

export function createEngine(opts: { storage: SaveStorage }): Engine {
  const storage = opts.storage;
  const loaded = load(storage);
  let s: State = loaded || fresh();
  const use = () => setState(s);
  use();

  const persist = () => save(storage, s);

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

  return {
    get state() {
      return s;
    },
    resumed: loaded !== null,

    start() {
      use();
      const out: OutLine[] = [];
      activate(out);
      persist();
      return out;
    },

    execute(lineText: string): ExecResult {
      use();
      let out: OutLine[] = [];
      let cleared = false;
      const events: EngineEvent[] = [];
      const print = (t: string | undefined, cls?: string) => {
        if (t === undefined || t === null || t === "") return;
        out.push(textLine(String(t), cls));
      };
      const t = lineText.trim();
      if (!t) return { lines: out, cleared, events };
      s.hist.push(t);
      if (s.hist.length > 300) s.hist.shift();
      const ctx: Ctx = {
        line: t,
        segs: [],
        ranExec: null,
        depth: 0,
        allOut: "",
      };
      const toks = tokenizeChains(t);
      if (toks.err !== undefined) {
        print("syntax error: " + toks.err, "err");
        s.lastCode = 2;
      } else {
        for (const ch of toks.chains) {
          if (ch.cond && s.lastCode !== 0) break;
          const tk = tokenize(ch.text);
          if (!Array.isArray(tk)) {
            print("syntax error: " + tk.err, "err");
            s.lastCode = 2;
            break;
          }
          if (!tk.length) continue;
          let res: Res;
          try {
            res = runPipeline(tk, ctx);
          } catch (e) {
            res = E(
              "Something went wrong running that: " + (e as Error).message,
            );
          }
          if (res.clear) {
            out = [];
            cleared = true;
          }
          if (res.html !== undefined && res.html !== "")
            out.push(htmlLine(res.html));
          else print(res.out);
          print(res.err, "err");
          ctx.allOut += (res.out || "") + "\n";
          s.lastCode = res.code || 0;
        }
      }
      checkMissions(ctx, out, events);
      persist();
      return { lines: out, cleared, events };
    },

    complete(v: string, pos: number): Completion {
      use();
      const before = v.slice(0, pos);
      const word = (before.match(/(\S*)$/) || ["", ""])[1];
      const start = pos - word.length;
      const prev = before.slice(0, start).trim().split(/\s+/).filter(Boolean);
      let lastSep = -1;
      prev.forEach((w, i) => {
        if (w === "|" || w === "&&" || w === ";") lastSep = i;
      });
      const words = prev.slice(lastSep + 1);
      let cands: string[] = [],
        dirPart = "";
      const pick = (list: string[]) =>
        list.filter((c) => c.startsWith(word)).map((c) => c + " ");
      if (words.length === 0)
        cands = Object.keys(CMDS)
          .filter((c) => c.startsWith(word))
          .sort()
          .map((c) => c + " ");
      else if (words[0] === "docker" && words.length === 1) cands = pick(DSUB);
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
      else {
        const sl = word.lastIndexOf("/");
        dirPart = sl >= 0 ? word.slice(0, sl + 1) : "";
        const pre = word.slice(sl + 1);
        const dn = get(dirPart || ".");
        if (dn && dn.t === "d")
          cands = Object.keys(dn.c)
            .filter(
              (n) => n.startsWith(pre) && (pre.startsWith(".") || n[0] !== "."),
            )
            .sort()
            .map((n) => dirPart + n + (dn.c[n].t === "d" ? "/" : " "));
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
      persist();
    },
  };
}

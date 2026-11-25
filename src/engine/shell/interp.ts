// D3, D5, D6, D13: the interpreter. It walks the syntax tree of parser.ts,
// expands words (expand.ts), applies redirects (redirect.ts), and runs
// builtins (builtins.ts) or the commands of the host table. The engine stays
// synchronous in 2a (D4).
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
import { Context } from "./context";
import type { SrcInfo } from "./context";
import { ExpError, Expander } from "./expand";
import { matchPattern } from "./glob";
import { resolvePath } from "./glob";
import { BufWriter, Input, Meter, TermWriter } from "./io";
import type { Chunk, Host, IO, TaskCtx, Writer } from "./io";
import { LIM, LimitStop, NestStop, nestMessage, stopMessage } from "./limits";
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

export class Interp {
  ctx: Context;
  readonly host: Host;
  task: TaskCtx = { line: "", segs: [], ranExec: null, allOut: "" };
  chunks: Chunk[] = [];
  notes: Note[] = [];
  events: HintEvent[] = [];
  meter = new Meter();
  ex: Expander;
  steps = 0;
  stepLimit = LIM.steps;
  stepName = `${LIM.steps} steps`;
  /** Depth of functions, `eval`, and `source` (D6). */
  depth = 0;
  scripts = 0;
  /** Depth of things that make a command not "typed at the prompt" (D12). */
  nest = 0;
  /** Set when `exit` ran at the prompt. */
  exited: number | null = null;
  /** The status of the last command substitution (for `x=$(false)`). */
  substCode: number | null = null;
  /** Array words of `declare a=(1 2)`, by argument index. */
  arrArgs = new Map<
    number,
    { items: { key?: string; value: string }[]; assoc: boolean }
  >();
  /** A trap runs with the line of the command that triggered it (`LINENO`). */
  private lineOverride: number | null = null;
  private fnCache = new Map<string, Node>();
  private rootIn = new Input("", true);
  private procFiles: {
    path: string;
    dir: "<" | ">";
    script: Script;
    ctx: Context;
  }[] = [];
  private procSeq = 0;
  private aliasing = new Set<string>();

  constructor(host: Host, ctx: Context) {
    this.host = host;
    this.ctx = ctx;
    this.ex = new Expander(this);
    this.begin(this.task);
  }

  /* ---------- one input ---------- */

  /** Starts an input: new output list, meter, steps, and task data. */
  begin(task: TaskCtx, stepLimit = LIM.steps): void {
    this.task = task;
    this.chunks = [];
    this.notes = [];
    this.events = [];
    this.meter = new Meter();
    this.steps = 0;
    this.stepLimit = stepLimit;
    this.stepName = `${stepLimit} steps`;
    this.depth = 0;
    this.scripts = 0;
    this.nest = 0;
    this.exited = null;
    this.rootIn = new Input("", true);
    this.ctx.io = {
      in: this.rootIn,
      out: new TermWriter("stdout", this.chunks, this.meter, task),
      err: new TermWriter("stderr", this.chunks, this.meter, null),
    };
  }

  /** True while a command was typed at the prompt itself (D12). */
  promptLevel(): boolean {
    return this.nest === 0 && this.ctx.src.kind === "prompt";
  }

  /** Parses and runs one complete input at the prompt. Returns `$?`. */
  runLine(text: string): number {
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
    } else code = this.execTop(() => this.runList(r.ast.items));
    ctx.lastCode = code;
    if (this.rootIn.used) this.events.push({ kind: "stdin" });
    return code;
  }

  /** Runs `~/.bashrc` text under the D19 guard. Returns an error reason, or null. */
  runRc(text: string, limit = LIM.rcSteps): string | null {
    const saved = {
      limit: this.stepLimit,
      name: this.stepName,
      steps: this.steps,
    };
    this.stepLimit = limit;
    this.stepName = `${limit} steps`;
    this.steps = 0;
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
          this.runList(r.ast.items);
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
      else if (e instanceof LimitStop) reason = e.limit;
      else if (e instanceof NestStop) reason = e.message;
      else if (e instanceof RangeError) reason = "nesting too deep";
      else reason = e instanceof Error ? e.message : "error";
    } finally {
      ctx.src = src;
      this.stepLimit = saved.limit;
      this.stepName = saved.name;
      this.steps = saved.steps;
    }
    return reason;
  }

  /** Runs a body at top level and turns limits and exits into notes. */
  private execTop(body: () => number): number {
    try {
      return body();
    } catch (e) {
      return this.topError(e);
    } finally {
      this.cleanProcs();
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
    if (e instanceof RangeError) {
      this.note(nestMessage("function calls", LIM.depth), true);
      return 1;
    }
    if (e instanceof ExitSig) {
      if (this.ctx.src.kind === "prompt") this.exited = e.code;
      return e.code;
    }
    if (e instanceof AbortLine) return e.code;
    if (e instanceof ReturnSig) return e.code;
    if (e instanceof BreakSig || e instanceof ContinueSig) return 0;
    throw e;
  }

  note(text: string, dim: boolean): void {
    this.notes.push({ text, dim });
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

  cmdSubst(script: Script): string {
    const buf = new BufWriter();
    const sub = this.ctx.copy();
    const io: IO = { in: this.ctx.io.in, out: buf, err: this.ctx.io.err };
    sub.io = io;
    const saved = this.ctx;
    this.ctx = sub;
    this.nest++;
    let code: number;
    try {
      code = this.runList(script.items);
      code = this.runExitTrap(sub, code);
    } catch (e) {
      if (e instanceof ExitSig) code = e.code;
      else if (e instanceof ReturnSig) code = e.code;
      else if (e instanceof AbortLine) code = e.code;
      else if (e instanceof BreakSig || e instanceof ContinueSig) code = 0;
      else throw e;
    } finally {
      this.nest--;
      this.ctx = saved;
    }
    this.substCode = code;
    return buf.text;
  }

  procSubst(dir: "<" | ">", script: Script): string {
    const n = 60 + (this.procSeq++ % 4);
    const path = `/dev/fd/${n}`;
    // The file lives in the game's file system until the command ends.
    const root = this.fsRoot();
    const dev = (root.c.dev ??= { t: "d", c: {}, m: "rwxr-xr-x" });
    if (dev.t === "d") {
      const fd = (dev.c.fd ??= { t: "d", c: {}, m: "rwxr-xr-x" });
      if (fd.t === "d") fd.c[String(n)] = { t: "f", x: "", m: "rw-------" };
    }
    if (dir === "<") {
      const buf = new BufWriter();
      const sub = this.ctx.copy();
      sub.io = { in: this.ctx.io.in, out: buf, err: this.ctx.io.err };
      const saved = this.ctx;
      this.ctx = sub;
      this.nest++;
      try {
        this.runList(script.items);
      } catch (e) {
        if (!(e instanceof ExitSig || e instanceof ReturnSig)) throw e;
      } finally {
        this.nest--;
        this.ctx = saved;
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
  private cleanProcs(): void {
    const list = this.procFiles;
    this.procFiles = [];
    for (const p of list) {
      if (p.dir === ">") {
        const node = get(p.path);
        const text = node && node.t === "f" ? node.x : "";
        const saved = this.ctx;
        const c = p.ctx;
        c.io = { in: new Input(text), out: saved.io.out, err: saved.io.err };
        this.ctx = c;
        try {
          this.runList(p.script.items);
        } catch (e) {
          if (!(
            e instanceof ExitSig ||
            e instanceof ReturnSig ||
            e instanceof LimitStop
          ))
            throw e;
        } finally {
          this.ctx = saved;
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
  expandTarget = (w: Word): string | null => this.ex.target(w);
  expandHeredoc = (w: Word): string => this.ex.heredoc(w);
  expandText = (w: Word): string => this.ex.text(w);

  /** Resolves a path against the cwd of the current context. */
  abs(p: string): string {
    if (p === "~" || p.startsWith("~/"))
      p = (this.ctx.get("HOME") ?? "/home/cadet") + p.slice(1);
    return resolvePath(this.ctx.cwd, p);
  }

  /* ---------- running nodes ---------- */

  runList(nodes: Node[]): number {
    let code = this.ctx.lastCode;
    for (const n of nodes) code = this.runNode(n);
    return code;
  }

  private tick(): void {
    if (++this.steps > this.stepLimit) throw new LimitStop(this.stepName);
  }

  runNode(n: Node): number {
    this.tick();
    const ctx = this.ctx;
    ctx.line = this.lineOverride ?? n.line;
    let code: number;
    try {
      code = this.exec(n);
    } catch (e) {
      if (e instanceof ExpError) {
        code = e.code;
        ctx.lastCode = code;
        if (e.fatal) {
          if (ctx.src.kind === "prompt" && this.nest === 0)
            throw new AbortLine(code);
          throw new ExitSig(code);
        }
      } else throw e;
    }
    this.ctx.lastCode = code;
    if (n.type !== "pipeline") this.ctx.pipestatus = [code];
    return code;
  }

  private exec(n: Node): number {
    switch (n.type) {
      case "simple":
        return this.withRedirectsFor(n, () => this.simple(n));
      case "pipeline":
        return this.pipeline(n);
      case "andor":
        return this.andor(n);
      case "if":
        return this.withRedirects(n.redirs, () => this.ifNode(n));
      case "case":
        return this.withRedirects(n.redirs, () => this.caseNode(n));
      case "for":
        return this.withRedirects(n.redirs, () => this.forNode(n));
      case "cfor":
        return this.withRedirects(n.redirs, () => this.cforNode(n));
      case "while":
      case "until":
        return this.withRedirects(n.redirs, () => this.whileNode(n));
      case "group":
        return this.withRedirects(n.redirs, () => this.runList(n.body));
      case "subshell":
        return this.withRedirects(n.redirs, () => this.subshell(n.body));
      case "function":
        return this.defineFunction(n);
      case "arith":
        return this.withRedirects(n.redirs, () => {
          const v = this.ex.arithWord(n.expr);
          return v === "0" ? 1 : 0;
        });
      case "cond":
        return this.withRedirects(n.redirs, () => (this.cond(n.expr) ? 0 : 1));
    }
  }

  /** Simple commands apply their own redirects (the builtin `exec` needs them raw). */
  private withRedirectsFor(n: Simple, f: () => number): number {
    return f();
  }

  private withRedirects(redirs: Node["redirs"], f: () => number): number {
    if (!redirs || !redirs.length) return f();
    const ap = applyRedirs(redirs, this.ctx.io, this);
    if (!ap) return 1;
    const saved = this.ctx.io;
    this.ctx.io = ap.io;
    let code: number;
    try {
      code = f();
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

  private andor(n: Extract<Node, { type: "andor" }>): number {
    const ctx = this.ctx;
    ctx.noErr++;
    let code: number;
    try {
      code = this.runNode(n.first);
    } finally {
      ctx.noErr--;
    }
    for (let i = 0; i < n.rest.length; i++) {
      const { op, node } = n.rest[i];
      if (op === "&&" ? code !== 0 : code === 0) continue;
      const last = i === n.rest.length - 1;
      if (!last) ctx.noErr++;
      try {
        code = this.runNode(node);
      } finally {
        if (!last) ctx.noErr--;
      }
    }
    return code;
  }

  private pipeline(n: Extract<Node, { type: "pipeline" }>): number {
    const ctx = this.ctx;
    if (n.negate) ctx.noErr++;
    let code: number;
    try {
      if (n.cmds.length === 1) code = this.runNode(n.cmds[0]);
      else code = this.stages(n);
    } finally {
      if (n.negate) ctx.noErr--;
    }
    if (n.negate) code = code === 0 ? 1 : 0;
    return code;
  }

  private stages(n: Extract<Node, { type: "pipeline" }>): number {
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
      this.ctx = stage;
      let code: number;
      try {
        code = this.runNode(n.cmds[i]);
      } catch (e) {
        if (e instanceof ExitSig) code = e.code;
        else if (e instanceof ReturnSig) code = e.code;
        else throw e;
      } finally {
        this.ctx = parent;
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

  private subshell(body: Node[]): number {
    const parent = this.ctx;
    const sub = parent.copy();
    this.ctx = sub;
    let code: number;
    try {
      code = this.runList(body);
    } catch (e) {
      if (e instanceof ExitSig) code = e.code;
      else throw e;
    } finally {
      this.ctx = parent;
    }
    code = this.runExitTrap(sub, code, parent);
    return code;
  }

  /* ---------- compound commands ---------- */

  private cond_(list: Node[]): number {
    this.ctx.noErr++;
    try {
      return this.runList(list);
    } finally {
      this.ctx.noErr--;
    }
  }

  private ifNode(n: Extract<Node, { type: "if" }>): number {
    for (const c of n.clauses) {
      if (this.cond_(c.cond) === 0) return this.runList(c.body);
    }
    if (n.else) return this.runList(n.else);
    return 0;
  }

  /** Runs a loop body; returns true to leave the loop. */
  private loopBody(body: Node[], state: { code: number }): boolean {
    this.ctx.loopDepth++;
    try {
      state.code = this.runList(body);
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

  private forNode(n: Extract<Node, { type: "for" }>): number {
    const items = n.words ? this.ex.words(n.words) : this.ctx.params.slice();
    const st = { code: 0 };
    for (const it of items) {
      this.tick();
      const err = this.ctx.set(n.name, it);
      if (err) {
        this.fail(err);
        return 1;
      }
      if (this.loopBody(n.body, st)) break;
    }
    return st.code;
  }

  private cforNode(n: Extract<Node, { type: "cfor" }>): number {
    const st = { code: 0 };
    if (n.init.length) this.ex.arithWord(n.init);
    for (;;) {
      this.tick();
      if (n.cond.length && this.ex.arithWord(n.cond) === "0") break;
      if (this.loopBody(n.body, st)) break;
      if (n.step.length) this.ex.arithWord(n.step);
    }
    return st.code;
  }

  private whileNode(n: Extract<Node, { type: "while" | "until" }>): number {
    const st = { code: 0 };
    for (;;) {
      this.tick();
      const c = this.cond_(n.cond);
      if (n.type === "while" ? c !== 0 : c === 0) break;
      if (this.loopBody(n.body, st)) break;
    }
    return st.code;
  }

  private caseNode(n: Case): number {
    const word = this.ex.text(n.word);
    const ext = !!this.ctx.options.extglob;
    let code = 0;
    let fall = false;
    for (const cl of n.clauses) {
      let hit = fall;
      if (!hit)
        for (const p of cl.patterns) {
          if (matchPattern(word, this.ex.pattern(p), ext)) {
            hit = true;
            break;
          }
        }
      if (!hit) continue;
      code = this.runList(cl.body);
      if (cl.term === ";;") return code;
      fall = cl.term === ";&";
      if (cl.term === ";;&") fall = false;
    }
    return code;
  }

  /* ---------- [[ ]] ---------- */

  cond(e: CondExpr): boolean {
    switch (e.op) {
      case "&&":
        return this.cond(e.l) && this.cond(e.r);
      case "||":
        return this.cond(e.l) || this.cond(e.r);
      case "!":
        return !this.cond(e.e);
      case "word":
        return this.ex.text(e.w) !== "";
      case "unary":
        return unaryTest(this, e.flag, this.ex.text(e.w));
      case "binary": {
        const cmp = e.cmp;
        if (cmp === "=~") {
          const s = this.ex.text(e.l);
          let re: RegExp;
          try {
            re = new RegExp(this.ex.regex(e.r));
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
          const s = this.ex.text(e.l);
          const hit = matchPattern(
            s,
            this.ex.pattern(e.r),
            !!this.ctx.options.extglob,
          );
          return cmp === "!=" ? !hit : hit;
        }
        const l = this.ex.text(e.l);
        const r = this.ex.text(e.r);
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
    this.fnCache.set(n.src, n.body);
    return 0;
  }

  private functionBody(name: string): Node | null {
    const src = this.ctx.functions[name];
    if (src === undefined) return null;
    let b = this.fnCache.get(src);
    if (!b) {
      const r = parse(src);
      if (r.status !== "ok" || r.ast.items[0]?.type !== "function") return null;
      b = (r.ast.items[0] as FunctionDef).body;
      this.fnCache.set(src, b);
    }
    return b;
  }

  /** Source text of a function, for `declare -f` and `type`. */
  functionSource(name: string): string | undefined {
    return this.ctx.functions[name];
  }

  callFunction(name: string, args: string[], body: Node): number {
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
      code = this.runNode(body);
    } catch (e) {
      if (e instanceof ReturnSig) code = e.code;
      else throw e;
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

  private expandArgv(words: Word[]): string[] {
    const out: string[] = [];
    this.arrArgs = new Map();
    let assignMode = false;
    words.forEach((w, i) => {
      if (i === 0) {
        out.push(...this.ex.word(w));
        const first = out[0];
        assignMode = first !== undefined && ASSIGN_BUILTINS.has(first);
        return;
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
        const items = last.items.map((it) => {
          const vals = this.ex.word(it.value);
          return {
            key: it.key ? this.ex.text(it.key) : undefined,
            value: vals.join(" "),
            vals,
          };
        });
        // `a=(x y)` expands each item as a word list; items without a key can split.
        const flat: { key?: string; value: string }[] = [];
        for (const it of items) {
          if (it.key !== undefined) flat.push({ key: it.key, value: it.value });
          else if (it.vals.length === 0) continue;
          else for (const v of it.vals) flat.push({ value: v });
        }
        this.arrArgs.set(out.length, { items: flat, assoc: false });
        out.push(f.v);
        return;
      }
      if (
        assignMode &&
        f &&
        f.k === "lit" &&
        /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(f.v)
      ) {
        out.push(this.ex.assignText(w));
        return;
      }
      out.push(...this.ex.word(w));
    });
    return out;
  }

  private simple(n: Simple): number {
    const ctx = this.ctx;
    this.substCode = null;
    // Alias (D8): only the first word, only when it is plain text.
    let node = n;
    if ((ctx.interactive || ctx.options.expand_aliases) && n.words.length) {
      const al = this.aliasExpand(n);
      if (al) node = al;
    }
    const argv = this.expandArgv(node.words);
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
      return this.assignOnly(node);
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
        const v = a.value ? this.ex.assignText(a.value) : "";
        const err = ctx.set(a.name, v);
        if (err) {
          this.fail(err);
          return 1;
        }
        ctx.exported.add(a.name);
      }
      return this.runWithRedirs(node, argv);
    } finally {
      undoTemps();
    }
  }

  private runWithRedirs(node: Simple, argv: string[]): number {
    const ctx = this.ctx;
    if (ctx.options.xtrace) {
      const ps4 = ctx.get("PS4") ?? "+ ";
      ctx.io.err.write(ps4 + argv.map(xq).join(" ") + "\n");
    }
    // `exec` without a command: the redirects stay (D3, AC3).
    if (argv[0] === "exec" && argv.length === 1 && node.redirs?.length) {
      const ap = applyRedirs(node.redirs, ctx.io, this, true);
      if (!ap) return 1;
      ctx.io = ap.io;
      return 0;
    }
    let ap: Applied | null = null;
    let io = ctx.io;
    if (node.redirs && node.redirs.length) {
      ap = applyRedirs(node.redirs, ctx.io, this);
      if (!ap) return 1;
      io = ap.io;
    }
    let code: number;
    const saved = ctx.io;
    ctx.io = io;
    try {
      code = this.dispatch(argv, io);
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
    if (code === 0) this.task.segs.push(argv);
    this.afterCommand(code);
    return code;
  }

  /** `set -e` and the ERR trap, at the end of a simple command. */
  private afterCommand(code: number): void {
    const ctx = this.ctx;
    if (code === 0 || ctx.noErr > 0) return;
    const trap = ctx.traps.ERR;
    // Functions do not inherit the ERR trap unless `set -E` is on.
    const inherits = ctx.frames.length === 0 || ctx.options.errtrace;
    if (trap && !ctx.inTrap && inherits) this.runTrap("ERR", trap, code);
    if (ctx.options.errexit) throw new ExitSig(code);
  }

  private assignOnly(n: Simple): number {
    const ctx = this.ctx;
    // Redirects still create their files.
    let ap: Applied | null = null;
    if (n.redirs && n.redirs.length) {
      ap = applyRedirs(n.redirs, ctx.io, this);
      if (!ap) return 1;
    }
    let code = 0;
    const seg: string[] = [];
    for (const a of n.assigns) {
      const err = this.doAssign(a);
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
    if (code === 0 && seg.length) this.task.segs.push(seg);
    this.afterCommand(code);
    return code;
  }

  /** `name=value`, `name+=value`, `name[i]=value`, `name=(...)`. Returns an error text or null. */
  doAssign(a: Assign): string | null {
    const ctx = this.ctx;
    if (ctx.options.allexport) ctx.exported.add(a.name);
    if (a.array) {
      const assoc = ctx.array(a.name)?.type === "assoc";
      const items: { key?: string; value: string }[] = [];
      for (const it of a.array) {
        const vals = this.ex.word(it.value);
        if (it.key)
          items.push({ key: this.ex.text(it.key), value: vals.join(" ") });
        else for (const v of vals) items.push({ value: v });
      }
      return ctx.setArray(a.name, items, assoc ? "assoc" : "array", a.append);
    }
    let v = a.value ? this.ex.assignText(a.value) : "";
    if (ctx.attrs(a.name).includes("i")) v = this.ex.arith(v);
    if (a.idx) {
      const m = ctx.array(a.name);
      const key =
        m?.type === "assoc"
          ? this.ex.text(a.idx)
          : this.ex.arith(this.ex.text(a.idx));
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
    if (BUILTINS[name]) return { kind: "builtin" };
    if (this.host.commands[name])
      return { kind: "file", path: "/usr/bin/" + name };
    return null;
  }

  private dispatch(argv: string[], io: IO): number {
    return this.runCommand(argv, io, {});
  }

  /** Runs a command by name. `skip` bypasses functions or the table (`command`, `builtin`). */
  runCommand(
    argv: string[],
    io: IO,
    o: { noFunc?: boolean; builtinOnly?: boolean; noBuiltin?: boolean },
  ): number {
    const name = argv[0];
    const ctx = this.ctx;
    if (!o.noFunc && !o.builtinOnly && ctx.functions[name] !== undefined) {
      const body = this.functionBody(name);
      if (body) return this.callFunction(name, argv.slice(1), body);
    }
    const b = BUILTINS[name];
    if (b && !o.noBuiltin) return b(this, argv, io);
    if (o.builtinOnly) {
      this.fail(`${name}: not a shell builtin`);
      return 1;
    }
    const cmd = this.host.commands[name];
    if (cmd) return cmd(argv, this, io);
    if (name.includes("/")) return this.runPath(argv, io);
    this.fail(`${name}: command not found`);
    if (this.promptLevel()) this.events.push({ kind: "notfound", name });
    return 127;
  }

  /** `./script` or `/path/script`. */
  private runPath(argv: string[], io: IO): number {
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
    this.task.ranExec = abs.slice(abs.lastIndexOf("/") + 1);
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
    return this.runScriptFile(path, abs, argv.slice(1), io);
  }

  /** Runs a script file in a context of its own (D13). */
  runScriptFile(path: string, abs: string, args: string[], io: IO): number {
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
    return this.runInChild(child, t.text, path);
  }

  /** Runs `text` in a fresh child context as a script. Returns the exit code. */
  runInChild(child: Context, text: string, name: string): number {
    if (this.scripts >= LIM.scripts) throw new NestStop(name, LIM.scripts);
    this.scripts++;
    this.nest++;
    const parent = this.ctx;
    this.ctx = child;
    let code: number;
    try {
      code = this.runSourceText(text, child.src);
      code = this.runExitTrap(child, code, parent);
    } catch (e) {
      if (e instanceof ExitSig) code = this.runExitTrap(child, e.code, parent);
      else if (e instanceof ReturnSig) code = e.code;
      else if (e instanceof AbortLine) code = e.code;
      else throw e;
    } finally {
      this.ctx = parent;
      this.scripts--;
      this.nest--;
    }
    return code;
  }

  /** Parses and runs text in the current context; the units before a syntax error run first. */
  runSourceText(text: string, src: SrcInfo): number {
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
      code = this.runList(r.nodes);
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

  runTrap(sig: string, cmd: string, code: number): void {
    const ctx = this.ctx;
    ctx.inTrap = true;
    const keep = ctx.lastCode;
    const prevLine = this.lineOverride;
    this.lineOverride = ctx.line;
    ctx.lastCode = code;
    try {
      const r = parse(cmd);
      if (r.status === "ok") this.runList(r.ast.items);
    } finally {
      this.lineOverride = prevLine;
      ctx.inTrap = false;
      ctx.lastCode = keep;
    }
    void sig;
  }

  /** Runs the EXIT trap of a context that ends. Returns the final code. */
  runExitTrap(c: Context, code: number, back?: Context): number {
    const trap = c.traps.EXIT;
    if (!trap) return code;
    delete c.traps.EXIT;
    const saved = this.ctx;
    this.ctx = c;
    try {
      c.lastCode = code;
      const r = parse(trap);
      if (r.status === "ok") {
        try {
          this.runList(r.ast.items);
        } catch (e) {
          if (e instanceof ExitSig) return e.code;
          throw e;
        }
      }
    } finally {
      this.ctx = back ?? saved;
      if (!back) this.ctx = saved;
    }
    return code;
  }

  /** Runs the EXIT trap of the prompt shell (the `exit` builtin). */
  runPromptExit(): void {
    void writeText;
  }

  /** Output helpers for builtins. */
  get out(): Writer {
    return this.ctx.io.out;
  }
  get err(): Writer {
    return this.ctx.io.err;
  }
}

// D3: the expansions, in the bash order: brace, tilde, parameter and variable,
// arithmetic, command substitution, word splitting, filename (glob), quote
// removal. A word is a list of parts (parser.ts); quoting is kept as a flag on
// each piece of text until the last step.
import type { Context } from "./context";
import { ArithError, evalArith } from "./arith";
import type { ArithHost } from "./arith";
import type { ParamPart, Script, Word, WordPart } from "./ast";
import {
  globPaths,
  hasGlob,
  matchPattern,
  prefixMatch,
  quotePattern,
  suffixMatch,
} from "./glob";
import { LIM, LimitStop } from "./limits";

/** An expansion that stops the command. `fatal` ends a non-interactive shell. */
export class ExpError extends Error {
  constructor(
    readonly code: number,
    readonly fatal: boolean,
  ) {
    super("expansion error");
  }
}

/** What the expander needs from the interpreter. */
export interface ExpEnv {
  ctx: Context;
  /** Runs a command substitution and returns its stdout. */
  cmdSubst(script: Script): Promise<string>;
  /** Runs `<( )` or `>( )` and returns the path of the file. */
  procSubst(dir: "<" | ">", script: Script): Promise<string>;
  /** Prints an error line with the script prefix. */
  fail(msg: string): void;
  /** Counts one step against the D5 meter (long pattern work). */
  tick?(): void;
}

interface Seg {
  t: string;
  q: boolean;
}
interface Fld {
  segs: Seg[];
  forced: boolean;
}

class Fields {
  list: Fld[] = [{ segs: [], forced: false }];
  constructor(readonly flat: boolean) {}
  get cur(): Fld {
    return this.list[this.list.length - 1];
  }
  add(t: string, q: boolean): void {
    const c = this.cur;
    if (q) c.forced = true;
    if (t === "") return;
    const last = c.segs[c.segs.length - 1];
    if (last && last.q === q) last.t += t;
    else c.segs.push({ t, q });
  }
  /** Ends the field if it holds something. */
  close(): void {
    const c = this.cur;
    if (c.segs.length || c.forced) this.list.push({ segs: [], forced: false });
  }
  /** Ends the field even when it is empty (between "$@" items). */
  split(): void {
    this.list.push({ segs: [], forced: false });
  }
}

const IFS_WS = " \t\n";

export class Expander {
  constructor(private env: ExpEnv) {}

  private get ctx(): Context {
    return this.env.ctx;
  }
  private opt(n: string): boolean {
    return !!this.ctx.options[n];
  }

  /* ---------- entry points ---------- */

  /** Full expansion of command words: the list of arguments. */
  async words(ws: Word[]): Promise<string[]> {
    const out: string[] = [];
    for (const w of ws) for (const s of await this.word(w)) out.push(s);
    return out;
  }

  /** One word to its fields. */
  async word(w: Word): Promise<string[]> {
    const out: string[] = [];
    for (const b of this.braces(w)) {
      const F = new Fields(false);
      await this.partsInto(this.tilde(b), false, F);
      for (const fld of F.list) {
        if (!fld.segs.length && !fld.forced) continue;
        const raw = fld.segs.map((s) => s.t).join("");
        if (fld.segs.length) {
          const pat = fld.segs
            .map((s) => (s.q ? quotePattern(s.t) : s.t))
            .join("");
          const ext = this.opt("extglob");
          if (!this.opt("noglob") && hasGlob(pat, ext)) {
            const m = globPaths(pat, this.ctx.cwd, {
              extglob: ext,
              dotglob: this.opt("dotglob"),
              nocaseglob: this.opt("nocaseglob"),
            });
            if (m.length) {
              for (const x of m) out.push(x);
              continue;
            }
            if (this.opt("nullglob")) continue;
          }
        }
        out.push(raw);
      }
    }
    return out;
  }

  /** An assignment value, a here-string, a `case` word: no split, no glob. */
  async text(w: Word): Promise<string> {
    const F = new Fields(true);
    await this.partsInto(this.tilde(w), true, F);
    return F.list[0].segs.map((s) => s.t).join("");
  }

  /** The value of an assignment: tilde also after `:`. */
  async assignText(w: Word): Promise<string> {
    return await this.text(this.assignTilde(w));
  }

  /** A pattern (`case`, `[[ == ]]`, `${x#p}`): quoted text is escaped. */
  async pattern(w: Word): Promise<string> {
    const F = new Fields(true);
    await this.partsInto(this.tilde(w), false, F);
    return F.list[0].segs.map((s) => (s.q ? quotePattern(s.t) : s.t)).join("");
  }

  /** A regular expression of `[[ x =~ re ]]`: quoted text is escaped. */
  async regex(w: Word): Promise<string> {
    const F = new Fields(true);
    await this.partsInto(this.tilde(w), false, F);
    return F.list[0].segs
      .map((s) => (s.q ? s.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : s.t))
      .join("");
  }

  /** An arithmetic word: `(( ))`, `for ((;;))`. */
  async arithWord(w: Word): Promise<string> {
    return this.arith(await this.partsText(w));
  }

  /** A here-document body (unquoted delimiter). */
  async heredoc(w: Word): Promise<string> {
    const F = new Fields(true);
    await this.partsInto(w, true, F);
    return F.list[0].segs.map((s) => s.t).join("");
  }

  /** A redirect target: exactly one word, or null. */
  async target(w: Word): Promise<string | null> {
    const r = await this.word(w);
    return r.length === 1 ? r[0] : null;
  }

  /* ---------- brace expansion ---------- */

  braces(w: Word): Word[] {
    if (!w.some((p) => p.k === "lit" && p.v.includes("{"))) return [w];
    const items: (string | WordPart)[] = [];
    for (const p of w) {
      if (p.k === "lit") for (const c of p.v) items.push(c);
      else items.push(p);
    }
    const res = this.braceItems(items, { n: 0 });
    return res.map((it) => {
      const out: Word = [];
      let lit = "";
      for (const x of it) {
        if (typeof x === "string") lit += x;
        else {
          if (lit) out.push({ k: "lit", v: lit });
          lit = "";
          out.push(x);
        }
      }
      if (lit) out.push({ k: "lit", v: lit });
      return out;
    });
  }

  private braceItems(
    items: (string | WordPart)[],
    budget: { n: number },
  ): (string | WordPart)[][] {
    for (let i = 0; i < items.length; i++) {
      if (items[i] !== "{") continue;
      // find the matching close and the top-level commas
      let depth = 0;
      let close = -1;
      const commas: number[] = [];
      for (let j = i; j < items.length; j++) {
        const c = items[j];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            close = j;
            break;
          }
        } else if (c === "," && depth === 1) commas.push(j);
      }
      if (close < 0) continue;
      const pre = items.slice(0, i);
      const post = items.slice(close + 1);
      if (commas.length) {
        const alts: (string | WordPart)[][] = [];
        let from = i + 1;
        for (const c of commas) {
          alts.push(items.slice(from, c));
          from = c + 1;
        }
        alts.push(items.slice(from, close));
        const out: (string | WordPart)[][] = [];
        for (const a of alts)
          for (const r of this.braceItems([...pre, ...a, ...post], budget))
            out.push(r);
        if (out.length > LIM.brace) throw new LimitStop("100000 brace words");
        return out;
      }
      const body = items.slice(i + 1, close);
      if (body.every((x) => typeof x === "string")) {
        const seq = this.sequence((body as string[]).join(""));
        if (seq) {
          if (seq.length > LIM.brace) throw new LimitStop("100000 brace words");
          const out: (string | WordPart)[][] = [];
          for (const s of seq)
            for (const r of this.braceItems(
              [...pre, ...s.split(""), ...post],
              budget,
            ))
              out.push(r);
          if (out.length > LIM.brace) throw new LimitStop("100000 brace words");
          return out;
        }
      }
    }
    return [items];
  }

  /** `1..5`, `a..e`, `01..10`, `1..10..2`: the words, or null. */
  private sequence(body: string): string[] | null {
    let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      let step = m[3] === undefined ? 1 : Math.abs(Number(m[3]));
      if (step === 0) step = 1;
      const count = Math.floor(Math.abs(b - a) / step) + 1;
      if (count > LIM.brace) throw new LimitStop("100000 brace words");
      const pad =
        /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2])
          ? Math.max(m[1].replace("-", "").length, m[2].replace("-", "").length)
          : 0;
      const out: string[] = [];
      const dir = a <= b ? 1 : -1;
      for (let v = a, k = 0; k < count; k++, v += dir * step) {
        let s = String(Math.abs(v));
        if (pad) s = s.padStart(pad, "0");
        out.push(v < 0 ? "-" + s : s);
      }
      return out;
    }
    m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
    if (m) {
      const a = m[1].charCodeAt(0);
      const b = m[2].charCodeAt(0);
      let step = m[3] === undefined ? 1 : Math.abs(Number(m[3]));
      if (step === 0) step = 1;
      const out: string[] = [];
      const dir = a <= b ? 1 : -1;
      for (let v = a; dir > 0 ? v <= b : v >= b; v += dir * step)
        out.push(String.fromCharCode(v));
      return out;
    }
    return null;
  }

  /* ---------- tilde ---------- */

  private tildeValue(user: string): string | null {
    if (user === "") return this.ctx.get("HOME") ?? "";
    if (user === "+") return this.ctx.get("PWD") ?? this.ctx.cwd;
    if (user === "-") return this.ctx.get("OLDPWD") ?? null;
    if (user === "cadet") return "/home/cadet";
    if (user === "root") return "/root";
    return null;
  }

  private tilde(w: Word): Word {
    const first = w[0];
    if (!first || first.k !== "lit" || first.v[0] !== "~") return w;
    const slash = first.v.indexOf("/");
    if (slash < 0 && w.length > 1) return w;
    const user = first.v.slice(1, slash < 0 ? undefined : slash);
    if (!/^[A-Za-z0-9_+-]*$/.test(user)) return w;
    const v = this.tildeValue(user);
    if (v === null) return w;
    const rest = slash < 0 ? "" : first.v.slice(slash);
    const out: Word = [{ k: "sq", v }];
    if (rest) out.push({ k: "lit", v: rest });
    return out.concat(w.slice(1));
  }

  private assignTilde(w: Word): Word {
    const out: Word = [];
    let atStart = true;
    for (const p of w) {
      if (p.k !== "lit") {
        out.push(p);
        atStart = false;
        continue;
      }
      const pieces = p.v.split(/(:)/);
      for (const piece of pieces) {
        if (piece === ":") {
          out.push({ k: "lit", v: ":" });
          atStart = true;
          continue;
        }
        if (atStart && piece[0] === "~") {
          const slash = piece.indexOf("/");
          const user = piece.slice(1, slash < 0 ? undefined : slash);
          const v = /^[A-Za-z0-9_+-]*$/.test(user)
            ? this.tildeValue(user)
            : null;
          if (v !== null) {
            out.push({ k: "sq", v });
            if (slash >= 0) out.push({ k: "lit", v: piece.slice(slash) });
            atStart = false;
            continue;
          }
        }
        if (piece) out.push({ k: "lit", v: piece });
        atStart = false;
      }
    }
    return out;
  }

  /* ---------- parts ---------- */

  private async partsInto(parts: Word, dq: boolean, F: Fields): Promise<void> {
    for (const p of parts) {
      switch (p.k) {
        case "lit":
          F.add(p.v, dq);
          break;
        case "sq":
          F.add(p.v, true);
          break;
        case "dq": {
          // "$@" with no parameters makes no word at all.
          const only = p.parts.length === 1 ? p.parts[0] : null;
          if (
            only &&
            only.k === "param" &&
            !F.flat &&
            (only.name === "@" || only.idx === "@") &&
            !only.op &&
            !only.len &&
            !only.bang &&
            this.baseList(only).length === 0
          )
            break;
          F.add("", true);
          await this.partsInto(p.parts, true, F);
          break;
        }
        case "param":
          await this.paramInto(p, dq, F);
          break;
        case "cmd": {
          const out = (await this.env.cmdSubst(p.script)).replace(/\n+$/, "");
          this.valueInto(out, dq, F);
          break;
        }
        case "arith":
          this.valueInto(this.arith(await this.partsText(p.expr)), dq, F);
          break;
        case "proc":
          this.valueInto(await this.env.procSubst(p.dir, p.script), true, F);
          break;
        case "arr":
          break;
      }
    }
  }

  private async partsText(w: Word): Promise<string> {
    const F = new Fields(true);
    await this.partsInto(w, true, F);
    return F.list[0].segs.map((s) => s.t).join("");
  }

  /** Splits an unquoted value by IFS into the fields; a quoted one stays whole. */
  private valueInto(v: string, dq: boolean, F: Fields): void {
    if (dq || F.flat) {
      F.add(v, dq);
      return;
    }
    const ifs = this.ctx.ifs();
    if (ifs === "") {
      F.add(v, false);
      return;
    }
    const isWs = (c: string) => ifs.includes(c) && IFS_WS.includes(c);
    const isNws = (c: string) => ifs.includes(c) && !IFS_WS.includes(c);
    let i = 0;
    const n = v.length;
    while (i < n) {
      const c = v[i];
      if (isWs(c) || isNws(c)) {
        let j = i;
        while (j < n && isWs(v[j])) j++;
        let nws = false;
        if (j < n && isNws(v[j])) {
          nws = true;
          j++;
          while (j < n && isWs(v[j])) j++;
        }
        const cur = F.cur;
        if (cur.segs.length || cur.forced) F.split();
        else if (nws) {
          cur.forced = true;
          F.split();
        }
        i = j;
      } else {
        let j = i;
        while (j < n && !isWs(v[j]) && !isNws(v[j])) j++;
        F.add(v.slice(i, j), false);
        i = j;
      }
    }
  }

  /* ---------- arithmetic ---------- */

  arithHost(): ArithHost {
    const c = this.ctx;
    return {
      getVar: (n) => c.get(n),
      getElem: (n, i) => c.elem(n, i),
      setVar: (n, v) => c.set(n, v),
      setElem: (n, i, v) => c.setElem(n, i, v),
    };
  }

  arith(src: string): string {
    try {
      return evalArith(src, this.arithHost()).toString();
    } catch (e) {
      if (e instanceof ArithError) {
        this.env.fail(e.message);
        throw new ExpError(1, false);
      }
      throw e;
    }
  }

  private async arithNum(w: Word): Promise<number> {
    return Number(this.arith(await this.partsText(w)));
  }

  /* ---------- parameters ---------- */

  /** The values of `@`, `*`, `a[@]`, `a[*]`; empty for a scalar. */
  private baseList(p: ParamPart): string[] {
    const c = this.ctx;
    if (p.name === "@" || p.name === "*") return c.params;
    if (p.idx === "@" || p.idx === "*")
      return p.name === "PIPESTATUS"
        ? c.pipestatus.map(String)
        : c.list(p.name);
    return [];
  }

  private isListRef(p: ParamPart): boolean {
    return p.name === "@" || p.name === "*" || p.idx === "@" || p.idx === "*";
  }

  private async subscript(p: ParamPart, w: Word): Promise<string> {
    const c = this.ctx;
    const m = c.array(p.name);
    const text = await this.partsText(w);
    if (m && m.type === "assoc") return text;
    return this.arith(text);
  }

  /** The scalar value of a reference, or undefined when unset. */
  private async scalar(p: ParamPart): Promise<string | undefined> {
    const c = this.ctx;
    const n = p.name;
    if (n === "PIPESTATUS") {
      const k =
        p.idx !== undefined && p.idx !== "@" && p.idx !== "*"
          ? Number(await this.subscript(p, p.idx))
          : 0;
      const v = c.pipestatus[k < 0 ? c.pipestatus.length + k : k];
      return v === undefined ? undefined : String(v);
    }
    if (p.idx !== undefined && p.idx !== "@" && p.idx !== "*")
      return c.elem(n, await this.subscript(p, p.idx));
    if (/^[0-9]+$/.test(n)) {
      const k = Number(n);
      return k === 0 ? c.arg0 : c.params[k - 1];
    }
    switch (n) {
      case "#":
        return String(c.params.length);
      case "?":
        return String(c.lastCode);
      case "-":
        return c.flags();
      case "$":
        return "5150";
      case "!":
        return undefined;
      case "_":
        return c.lastArg;
      default:
        return c.get(n);
    }
  }

  private unbound(p: ParamPart): never {
    this.env.fail(`${p.name}: unbound variable`);
    throw new ExpError(1, true);
  }

  private async paramInto(p: ParamPart, dq: boolean, F: Fields): Promise<void> {
    const c = this.ctx;
    const star = p.name === "*" || p.idx === "*";
    // ${!name}: the name is in the value; ${!a[@]}: the keys.
    if (p.bang && !p.op && !p.len) {
      if (this.isListRef(p) && p.name !== "@" && p.name !== "*") {
        this.listInto(c.keys(p.name), star, dq, F);
        return;
      }
      const ref = await this.scalar({ ...p, bang: false });
      if (ref === undefined) {
        if (this.opt("nounset")) this.unbound(p);
        return;
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(ref);
      let v: string | undefined;
      if (m) v = m[2] !== undefined ? c.elem(m[1], m[2]) : c.get(m[1]);
      else if (/^[0-9]+$/.test(ref)) v = c.params[Number(ref) - 1];
      if (v === undefined) {
        this.env.fail(`${ref}: invalid variable name`);
        throw new ExpError(1, false);
      }
      this.valueInto(v, dq, F);
      return;
    }
    if (p.len) {
      let n: number;
      if (this.isListRef(p)) n = this.baseList(p).length;
      else n = [...((await this.scalar(p)) ?? "")].length;
      if (
        (await this.scalar(p)) === undefined &&
        !this.isListRef(p) &&
        this.opt("nounset")
      )
        this.unbound(p);
      this.valueInto(String(n), dq, F);
      return;
    }
    const op = p.op;
    const isList = this.isListRef(p);
    const items = isList ? this.baseList(p) : null;
    const sc = isList ? undefined : await this.scalar(p);
    const unset = isList ? items!.length === 0 : sc === undefined;
    const colon = op !== undefined && op.startsWith(":") && op.length === 2;
    const isNull = isList
      ? items!.length === 0 || (items!.length === 1 && items![0] === "")
      : sc === undefined || sc === "";
    const missing = colon ? isNull : unset;
    const arg = p.arg ?? [];

    switch (op) {
      case undefined: {
        if (unset && !isList && this.opt("nounset")) this.unbound(p);
        break;
      }
      case "-":
      case ":-":
        if (missing) {
          await this.partsInto(arg, dq, F);
          return;
        }
        break;
      case "=":
      case ":=":
        if (missing) {
          if (isList || /^[0-9@*#?$!_-]/.test(p.name)) {
            this.env.fail(`$${p.name}: cannot assign in this way`);
            throw new ExpError(1, false);
          }
          const v = await this.partsText(arg);
          const err =
            p.idx !== undefined && p.idx !== "@" && p.idx !== "*"
              ? c.setElem(p.name, await this.subscript(p, p.idx), v)
              : c.set(p.name, v);
          if (err) {
            this.env.fail(err);
            throw new ExpError(1, false);
          }
          this.valueInto(v, dq, F);
          return;
        }
        break;
      case "?":
      case ":?":
        if (missing) {
          const m = await this.partsText(arg);
          this.env.fail(
            `${p.name}: ${m || (colon ? "parameter null or not set" : "parameter not set")}`,
          );
          throw new ExpError(1, true);
        }
        break;
      case "+":
      case ":+":
        if (!missing) await this.partsInto(arg, dq, F);
        return;
      default:
        break;
    }
    if (
      !op ||
      op === "-" ||
      op === ":-" ||
      op === "=" ||
      op === ":=" ||
      op === "?" ||
      op === ":?"
    ) {
      if (isList) this.listInto(items!, star, dq, F);
      else if (sc !== undefined) this.valueInto(sc, dq, F);
      return;
    }
    // Transformations: on each item of a list, or on the scalar.
    const run = (s: string): Promise<string> => this.transform(p, s);
    if (op === ":") {
      if (isList) {
        const start = p.name === "@" || p.name === "*" ? 1 : 0;
        const all = start === 1 ? [c.arg0, ...items!] : items!;
        const off = await this.arithNum(arg);
        const len = p.arg2 ? await this.arithNum(p.arg2) : undefined;
        let from = off < 0 ? all.length + off : off;
        if (from < 0) from = 0;
        const to =
          len === undefined
            ? all.length
            : len < 0
              ? all.length + len
              : from + len;
        this.listInto(all.slice(from, Math.max(from, to)), star, dq, F);
        return;
      }
      const s = sc ?? "";
      const chars = [...s];
      const off = await this.arithNum(arg);
      const len = p.arg2 ? await this.arithNum(p.arg2) : undefined;
      const from = off < 0 ? chars.length + off : off;
      if (from < 0 || from > chars.length) {
        this.valueInto("", dq, F);
        return;
      }
      let to =
        len === undefined
          ? chars.length
          : len < 0
            ? chars.length + len
            : from + len;
      if (to < from) {
        if (len !== undefined && len < 0) {
          this.env.fail(
            `${chars.slice(to < 0 ? 0 : to).join("")}: substring expression < 0`,
          );
          throw new ExpError(1, false);
        }
        to = from;
      }
      this.valueInto(chars.slice(from, to).join(""), dq, F);
      return;
    }
    if (isList) {
      const done: string[] = [];
      for (const it of items!) done.push(await run(it));
      this.listInto(done, star, dq, F);
    } else this.valueInto(await run(sc ?? ""), dq, F);
  }

  private listInto(
    items: string[],
    star: boolean,
    dq: boolean,
    F: Fields,
  ): void {
    if (F.flat) {
      const sep = star ? this.ifsJoin() : " ";
      F.add(items.join(sep), dq);
      return;
    }
    if (dq) {
      if (star) {
        F.add(items.join(this.ifsJoin()), true);
        return;
      }
      items.forEach((it, k) => {
        if (k > 0) F.split();
        F.add(it, true);
      });
      return;
    }
    items.forEach((it, k) => {
      if (k > 0) F.close();
      this.valueInto(it, false, F);
    });
  }

  private ifsJoin(): string {
    const v = this.ctx.get("IFS");
    return v === undefined ? " " : v.slice(0, 1);
  }

  /** `# ## % %% / // /# /% ^ ^^ , ,, @` on one string. */
  private async transform(p: ParamPart, s: string): Promise<string> {
    const op = p.op as string;
    const ext = this.opt("extglob");
    const arg = p.arg ?? [];
    switch (op) {
      case "#":
      case "##": {
        const n = prefixMatch(s, await this.pattern(arg), op === "##", ext);
        return n < 0 ? s : s.slice(n);
      }
      case "%":
      case "%%": {
        const n = suffixMatch(s, await this.pattern(arg), op === "%%", ext);
        return n < 0 ? s : s.slice(0, n);
      }
      case "/":
      case "//":
      case "/#":
      case "/%": {
        const pat = await this.pattern(arg);
        const F = new Fields(true);
        if (p.arg2) await this.partsInto(p.arg2, false, F);
        // bash 5.2 `patsub_replacement`: an unquoted `&` stands for the matched text.
        const rep: (string | null)[] = [];
        for (const g of F.list[0].segs) {
          if (g.q) rep.push(g.t);
          else
            g.t.split("&").forEach((piece, i) => {
              if (i > 0) rep.push(null);
              if (piece) rep.push(piece);
            });
        }
        return this.replace(s, pat, rep, op, ext);
      }
      case "^":
      case "^^":
      case ",":
      case ",,": {
        const pat = p.arg && p.arg.length ? await this.pattern(arg) : "";
        const up = op[0] === "^";
        const all = op.length === 2;
        let done = false;
        let out = "";
        for (const ch of s) {
          if (!all && done) {
            out += ch;
            continue;
          }
          if (!pat || matchPattern(ch, pat, ext)) {
            out += up ? ch.toUpperCase() : ch.toLowerCase();
            done = true;
          } else {
            out += ch;
            if (!all) done = true;
          }
        }
        return out;
      }
      case "@": {
        const k = await this.partsText(arg);
        switch (k) {
          case "U":
            return s.toUpperCase();
          case "L":
            return s.toLowerCase();
          case "u":
            return s.charAt(0).toUpperCase() + s.slice(1);
          case "Q":
            return "'" + s.replace(/'/g, "'\\''") + "'";
          default:
            return s;
        }
      }
      default:
        return s;
    }
  }

  private replace(
    s: string,
    pat: string,
    repParts: (string | null)[],
    op: string,
    ext: boolean,
  ): string {
    if (pat === "") return s;
    const fill = (m: string): string =>
      repParts.map((x) => (x === null ? m : x)).join("");
    if (!hasGlob(pat, ext)) {
      const lit = pat.replace(/\\(.)/g, "$1");
      const r = fill(lit);
      if (op === "/#") return s.startsWith(lit) ? r + s.slice(lit.length) : s;
      if (op === "/%")
        return s.endsWith(lit) ? s.slice(0, s.length - lit.length) + r : s;
      if (op === "//") return s.split(lit).join(r);
      const i = s.indexOf(lit);
      return i < 0 ? s : s.slice(0, i) + r + s.slice(i + lit.length);
    }
    const longestAt = (i: number): number => {
      for (let j = s.length; j > i; j--) {
        this.env.tick?.();
        if (matchPattern(s.slice(i, j), pat, ext)) return j;
      }
      return -1;
    };
    if (op === "/#") {
      const j = longestAt(0);
      return j < 0 ? s : fill(s.slice(0, j)) + s.slice(j);
    }
    if (op === "/%") {
      for (let i = 0; i < s.length; i++) {
        this.env.tick?.();
        if (matchPattern(s.slice(i), pat, ext))
          return s.slice(0, i) + fill(s.slice(i));
      }
      return s;
    }
    let out = "";
    let i = 0;
    while (i < s.length) {
      const j = longestAt(i);
      if (j > i) {
        out += fill(s.slice(i, j));
        i = j;
        if (op === "/") return out + s.slice(i);
      } else out += s[i++];
    }
    return out;
  }
}

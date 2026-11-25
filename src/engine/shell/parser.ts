// The bash parser (D3, AC1): text to a syntax tree. One class does the
// lexing and the grammar, because a word can hold a command substitution.
//
//   parse(text)  ->  { status: "ok", ast } | { status: "incomplete" }
//                    | { status: "error", message }
//   parseFull    ->  the same, with the line and the units that came before
//                    an error (a script runs the lines before a syntax error).
import type {
  ArithCmd,
  ArrayItem,
  Assign,
  CondExpr,
  Node,
  ParamPart,
  Redir,
  RedirOp,
  Script,
  Simple,
  Word,
  WordPart,
} from "./ast";
import { ansiC, isNameChar, isNameStart, isSpace, NAME_RE, OPS } from "./lexer";
import type { Tok } from "./lexer";
import { LIM } from "./limits";

export interface ParseOptions {
  /** `shopt -s extglob` is on: `!(a)` and friends are one word. */
  extglob?: boolean;
  /** Script mode: an open here-document ends at the end of the file. */
  eof?: boolean;
}

export type ParseFull =
  | { status: "ok"; ast: Script }
  | { status: "incomplete"; kind: "quote" | "eof"; line: number; ch: string }
  | {
      status: "error";
      message: string;
      line: number;
      text: string;
      /** The units (lines) that parsed before the error. */
      done: Node[];
      /** True when the error is the nesting limit, not a syntax error. */
      nest?: boolean;
    };

export type ParseResult =
  | { status: "ok"; ast: Script }
  | { status: "incomplete" }
  | { status: "error"; message: string };

interface CondTok {
  t: "]]" | "&&" | "||" | "(" | ")" | "<" | ">" | "word";
  w?: Word;
  raw?: string;
  pos: number;
}

class Incomplete extends Error {
  constructor(
    readonly kind: "quote" | "eof",
    readonly pos: number,
    readonly ch = "",
  ) {
    super("incomplete");
  }
}
class SyntaxErr extends Error {
  constructor(
    msg: string,
    readonly pos: number,
    readonly detail = true,
  ) {
    super(msg);
  }
}
class DepthErr extends Error {}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "until",
  "for",
  "in",
  "function",
  "{",
  "}",
  "[[",
  "]]",
  "!",
  "time",
  "select",
]);
const REDIR_OPS = new Set([
  ">",
  ">>",
  "<",
  ">&",
  "<&",
  "<>",
  ">|",
  "&>",
  "&>>",
  "<<",
  "<<-",
  "<<<",
]);
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[([^\]]*)\])?(\+?)=/;
const COND_UNARY = new Set(
  "-n -z -f -d -e -r -w -x -s -L -h -b -c -p -S -t -O -G -N -k -u -g -v -o".split(
    " ",
  ),
);
const COND_BIN = new Set([
  "==",
  "=",
  "!=",
  "=~",
  "-eq",
  "-ne",
  "-lt",
  "-le",
  "-gt",
  "-ge",
  "-nt",
  "-ot",
  "-ef",
]);

interface Pending {
  redir: Redir;
  delim: string;
  strip: boolean;
  quoted: boolean;
}

class P {
  pos = 0;
  buf: Tok | null = null;
  lastEnd = 0;
  depth = 0;
  pending: Pending[] = [];
  private lineStarts: number[] = [0];

  constructor(
    readonly src: string,
    readonly opts: ParseOptions,
    depth = 0,
  ) {
    this.depth = depth;
    for (let i = 0; i < src.length; i++)
      if (src[i] === "\n") this.lineStarts.push(i + 1);
  }

  lineAt(pos: number): number {
    let lo = 0,
      hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  lineText(line: number): string {
    const s = this.lineStarts[line - 1] ?? 0;
    const e = this.src.indexOf("\n", s);
    return this.src.slice(s, e < 0 ? this.src.length : e);
  }
  totalLines(): number {
    return this.lineStarts.length;
  }

  enter(): void {
    if (++this.depth > LIM.parse) throw new DepthErr();
  }
  leave(): void {
    this.depth--;
  }

  /* ---------- tokens ---------- */

  peek(): Tok {
    if (!this.buf) this.buf = this.lex();
    return this.buf;
  }
  next(): Tok {
    const t = this.peek();
    this.buf = null;
    this.lastEnd = this.pos;
    return t;
  }
  isNewline(t: Tok): boolean {
    return t.t === "op" && t.v === "\n";
  }
  isOp(t: Tok, v: string): boolean {
    return t.t === "op" && t.v === v;
  }
  isWord(t: Tok, w: string): boolean {
    return t.t === "word" && t.raw === w;
  }

  skipWs(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (isSpace(c)) this.pos++;
      else if (c === "\\" && s[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "\\" && this.pos + 1 >= s.length)
        throw new Incomplete("eof", this.pos);
      else if (c === "#") {
        while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
      } else break;
    }
  }

  lex(): Tok {
    this.skipWs();
    const s = this.src;
    if (this.pos >= s.length) {
      if (this.pending.length && !this.opts.eof)
        throw new Incomplete("eof", this.pos);
      return { t: "eof", pos: this.pos };
    }
    const c = s[this.pos];
    const start = this.pos;
    if (c === "\n") {
      this.pos++;
      if (this.pending.length) this.readHeredocs();
      return { t: "op", v: "\n", pos: start };
    }
    if ((c === "<" || c === ">") && s[this.pos + 1] === "(")
      return this.wordTok();
    for (const op of OPS) {
      if (s.startsWith(op, this.pos)) {
        this.pos += op.length;
        return { t: "op", v: op, pos: start };
      }
    }
    const m = /^\d+(?=[<>])/.exec(s.slice(this.pos, this.pos + 12));
    if (m) {
      this.pos += m[0].length;
      return { t: "io", n: Number(m[0]), pos: start };
    }
    return this.wordTok();
  }

  wordTok(): Tok {
    const start = this.pos;
    const w = this.readParts("word", "");
    if (this.pos === start) throw new SyntaxErr("", start);
    const raw = this.src.slice(start, this.pos);
    const last = w[w.length - 1];
    return {
      t: "word",
      w,
      raw,
      pos: start,
      arr: last?.k === "arr" ? last.items : undefined,
    };
  }

  /* ---------- words ---------- */

  /**
   * Reads word parts. mode "word": until an unquoted metacharacter.
   * "dq": inside "...", until the closing quote. "hd": to the end of the
   * text (here-documents and arithmetic). "arg": until a char of `stops`.
   */
  readParts(mode: "word" | "dq" | "hd" | "arg", stops: string): Word {
    const s = this.src;
    const parts: Word = [];
    let lit = "";
    const flush = () => {
      if (lit) {
        parts.push({ k: "lit", v: lit });
        lit = "";
      }
    };
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (mode === "dq" && c === '"') {
        this.pos++;
        flush();
        return parts;
      }
      if (mode === "word") {
        if (isSpace(c) || c === "\n" || ";&|)".includes(c)) break;
        if (c === "<" || c === ">") {
          if (s[this.pos + 1] === "(") {
            flush();
            parts.push(this.procSubst(c));
            continue;
          }
          break;
        }
        if (c === "(") {
          const arrOk =
            parts.length === 0 &&
            lit.endsWith("=") &&
            /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(lit);
          if (arrOk) {
            const items = this.readArray();
            flush();
            parts.push({ k: "arr", items });
            break;
          }
          const prev = lit[lit.length - 1];
          if (this.opts.extglob && prev && "?*+@!".includes(prev)) {
            lit += this.readBalanced();
            continue;
          }
          break;
        }
      }
      if (mode === "arg" && stops.includes(c)) break;
      if (c === "\\") {
        const n = s[this.pos + 1];
        if (n === undefined) {
          if (mode === "dq" || mode === "hd") {
            lit += "\\";
            this.pos++;
            continue;
          }
          throw new Incomplete("eof", this.pos);
        }
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        if (mode === "dq" || mode === "hd") {
          if ('$`"\\'.includes(n) && (n !== '"' || mode === "dq")) {
            lit += n;
            this.pos += 2;
          } else {
            lit += "\\";
            this.pos++;
          }
          continue;
        }
        flush();
        parts.push({ k: "sq", v: n });
        this.pos += 2;
        continue;
      }
      if (c === "'" && mode !== "dq" && mode !== "hd") {
        const e = s.indexOf("'", this.pos + 1);
        if (e < 0) throw new Incomplete("quote", this.pos, "'");
        flush();
        parts.push({ k: "sq", v: s.slice(this.pos + 1, e) });
        this.pos = e + 1;
        continue;
      }
      if (c === '"' && mode !== "hd") {
        flush();
        this.pos++;
        this.enter();
        const inner = this.readParts("dq", "");
        this.leave();
        parts.push({ k: "dq", parts: inner });
        continue;
      }
      if (c === "`") {
        flush();
        parts.push(this.backtick());
        continue;
      }
      if (c === "$") {
        const n = s[this.pos + 1];
        if (n === "'" && mode !== "dq" && mode !== "hd") {
          let i = this.pos + 2;
          while (i < s.length && s[i] !== "'") i += s[i] === "\\" ? 2 : 1;
          if (i >= s.length) throw new Incomplete("quote", this.pos, "'");
          flush();
          parts.push({ k: "sq", v: ansiC(s.slice(this.pos + 2, i)) });
          this.pos = i + 1;
          continue;
        }
        if (n === '"' && mode !== "dq" && mode !== "hd") {
          this.pos++;
          continue;
        }
        const d = this.dollar();
        if (d) {
          flush();
          parts.push(d);
        } else {
          lit += "$";
          this.pos++;
        }
        continue;
      }
      lit += c;
      this.pos++;
    }
    if (mode === "dq") throw new Incomplete("quote", this.pos, '"');
    flush();
    return parts;
  }

  /** `?(`, `*(`, `!(`: reads the balanced group as literal text. */
  readBalanced(): string {
    const s = this.src;
    let depth = 0;
    const start = this.pos;
    for (let i = this.pos; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) {
        this.pos = i + 1;
        return s.slice(start, i + 1);
      }
    }
    throw new Incomplete("eof", this.pos);
  }

  /** `name=(a b [2]=c)`: the position is at the `(`. */
  readArray(): ArrayItem[] {
    const s = this.src;
    this.pos++;
    const items: ArrayItem[] = [];
    for (;;) {
      while (this.pos < s.length) {
        const c = s[this.pos];
        if (isSpace(c) || c === "\n") this.pos++;
        else if (c === "\\" && s[this.pos + 1] === "\n") this.pos += 2;
        else if (c === "#") {
          while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
        } else break;
      }
      if (this.pos >= s.length) throw new Incomplete("eof", this.pos);
      if (s[this.pos] === ")") {
        this.pos++;
        return items;
      }
      const w = this.readParts("word", "");
      if (!w.length) throw new SyntaxErr("", this.pos);
      const f = w[0];
      const m = f.k === "lit" ? /^\[([^\]]*)\]=/.exec(f.v) : null;
      if (m && f.k === "lit") {
        const rest = f.v.slice(m[0].length);
        const value: Word = rest
          ? [{ k: "lit", v: rest }, ...w.slice(1)]
          : w.slice(1);
        items.push({ key: this.parseText(m[1], "hd"), value });
      } else items.push({ value: w });
    }
  }

  procSubst(dir: string): WordPart {
    this.pos += 2;
    const script = this.subScript();
    return { k: "proc", dir: dir as "<" | ">", script };
  }

  /** Parses commands until `)`, which it consumes. */
  subScript(): Script {
    this.enter();
    const saved = this.buf;
    this.buf = null;
    const items = this.parseList((t) => this.isOp(t, ")"));
    const t = this.peek();
    if (!this.isOp(t, ")")) {
      if (t.t === "eof") throw new Incomplete("eof", this.pos);
      throw this.unexpected(t);
    }
    this.buf = null;
    this.lastEnd = this.pos;
    this.buf = saved;
    this.leave();
    return { type: "script", items };
  }

  backtick(): WordPart {
    const s = this.src;
    const open = this.pos;
    let i = this.pos + 1;
    let body = "";
    while (i < s.length && s[i] !== "`") {
      if (s[i] === "\\" && i + 1 < s.length && "`\\$".includes(s[i + 1])) {
        body += s[i + 1];
        i += 2;
      } else body += s[i++];
    }
    if (i >= s.length) throw new Incomplete("quote", open, "`");
    this.pos = i + 1;
    const inner = new P(body, this.opts, this.depth + 1);
    try {
      return { k: "cmd", script: inner.script(), src: body };
    } catch (e) {
      if (e instanceof Incomplete) throw new Incomplete("eof", open);
      if (e instanceof SyntaxErr) throw new SyntaxErr(e.message, open);
      throw e;
    }
  }

  /** A `$` expansion at the position; null when the `$` is plain text. */
  dollar(): WordPart | null {
    const s = this.src;
    const n = s[this.pos + 1];
    if (n === "(") {
      if (s[this.pos + 2] === "(") {
        let depth = 0;
        let i = this.pos + 3;
        let found = -1;
        for (; i < s.length; i++) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")") {
            if (depth === 0) {
              if (s[i + 1] === ")") found = i;
              break;
            }
            depth--;
          }
        }
        if (found >= 0) {
          const inner = s.slice(this.pos + 3, found);
          this.pos = found + 2;
          return { k: "arith", expr: this.parseText(inner, "hd") };
        }
        if (i >= s.length) throw new Incomplete("eof", this.pos);
      }
      const startSrc = this.pos + 2;
      this.pos += 2;
      const script = this.subScript();
      return { k: "cmd", script, src: s.slice(startSrc, this.lastEnd - 1) };
    }
    if (n === "{") return this.paramBrace();
    if (n !== undefined && isNameStart(n)) {
      let i = this.pos + 1;
      while (i < s.length && isNameChar(s[i])) i++;
      const name = s.slice(this.pos + 1, i);
      this.pos = i;
      return { k: "param", name };
    }
    if (n !== undefined && /[0-9]/.test(n)) {
      this.pos += 2;
      return { k: "param", name: n };
    }
    if (n !== undefined && "@*#?-$!".includes(n)) {
      this.pos += 2;
      return { k: "param", name: n };
    }
    return null;
  }

  paramBrace(): WordPart {
    const s = this.src;
    const open = this.pos;
    this.pos += 2;
    this.enter();
    const bad = () =>
      new SyntaxErr(
        `${s.slice(open, Math.min(s.length, this.pos + 1)).split("\n")[0]}: bad substitution`,
        open,
        false,
      );
    const p: ParamPart = { k: "param", name: "" };
    if (s[this.pos] === "!" && s[this.pos + 1] !== "}") {
      p.bang = true;
      this.pos++;
    } else if (
      s[this.pos] === "#" &&
      s[this.pos + 1] !== "}" &&
      s[this.pos + 1] !== undefined
    ) {
      p.len = true;
      this.pos++;
    }
    const c = s[this.pos];
    if (c === undefined) throw new Incomplete("eof", open);
    if (isNameStart(c)) {
      let i = this.pos;
      while (i < s.length && isNameChar(s[i])) i++;
      p.name = s.slice(this.pos, i);
      this.pos = i;
    } else if (/[0-9]/.test(c)) {
      let i = this.pos;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
      p.name = s.slice(this.pos, i);
      this.pos = i;
    } else if ("@*#?-$!".includes(c)) {
      p.name = c;
      this.pos++;
    } else throw bad();
    if (s[this.pos] === "[") {
      let depth = 0;
      let i = this.pos;
      for (; i < s.length; i++) {
        if (s[i] === "[") depth++;
        else if (s[i] === "]" && --depth === 0) break;
      }
      if (i >= s.length) throw new Incomplete("eof", open);
      const inner = s.slice(this.pos + 1, i);
      p.idx =
        inner === "@" || inner === "*" ? inner : this.parseText(inner, "hd");
      this.pos = i + 1;
    }
    const o = s[this.pos];
    if (o === undefined) throw new Incomplete("eof", open);
    if (o !== "}") {
      const n = s[this.pos + 1];
      if (o === ":") {
        if (n !== undefined && "-=?+".includes(n)) {
          p.op = ":" + n;
          this.pos += 2;
        } else {
          p.op = ":";
          this.pos++;
        }
      } else if ("-=?+".includes(o)) {
        p.op = o;
        this.pos++;
      } else if (o === "#" || o === "%" || o === "^" || o === ",") {
        if (n === o) {
          p.op = o + o;
          this.pos += 2;
        } else {
          p.op = o;
          this.pos++;
        }
      } else if (o === "/") {
        if (n === "/") {
          p.op = "//";
          this.pos += 2;
        } else if (n === "#" || n === "%") {
          p.op = "/" + n;
          this.pos += 2;
        } else {
          p.op = "/";
          this.pos++;
        }
      } else if (o === "@") {
        p.op = "@";
        this.pos++;
      } else throw bad();
      if (p.op === "/" || p.op === "//" || p.op === "/#" || p.op === "/%") {
        p.arg = this.readParts("arg", "/}");
        if (s[this.pos] === "/") {
          this.pos++;
          p.arg2 = this.readParts("arg", "}");
        }
      } else if (p.op === ":") {
        p.arg = this.readParts("arg", ":}");
        if (s[this.pos] === ":") {
          this.pos++;
          p.arg2 = this.readParts("arg", "}");
        }
      } else p.arg = this.readParts("arg", "}");
    }
    if (this.pos >= s.length) throw new Incomplete("eof", open);
    if (s[this.pos] !== "}") throw bad();
    this.pos++;
    this.leave();
    return p;
  }

  /** Parses a piece of text as word parts (arithmetic, index, heredoc). */
  parseText(text: string, mode: "hd"): Word {
    const sub = new P(text, this.opts, this.depth + 1);
    try {
      return sub.readParts(mode, "");
    } catch (e) {
      if (e instanceof Incomplete) throw new Incomplete("eof", this.pos);
      throw e;
    }
  }

  readHeredocs(): void {
    const s = this.src;
    for (const hd of this.pending) {
      let body = "";
      let closed = false;
      while (this.pos < s.length) {
        let e = s.indexOf("\n", this.pos);
        const last = e < 0;
        if (last) e = s.length;
        const raw = s.slice(this.pos, e);
        const line = hd.strip ? raw.replace(/^\t+/, "") : raw;
        this.pos = last ? e : e + 1;
        if (line === hd.delim) {
          closed = true;
          break;
        }
        body += line + "\n";
      }
      if (!closed && !this.opts.eof) throw new Incomplete("eof", this.pos);
      hd.redir.heredoc = {
        body: hd.quoted ? [{ k: "sq", v: body }] : this.parseText(body, "hd"),
        strip: hd.strip,
        quoted: hd.quoted,
      };
    }
    this.pending = [];
  }

  /* ---------- grammar ---------- */

  unexpected(t: Tok): SyntaxErr {
    const text =
      t.t === "eof" || this.isNewline(t)
        ? "newline"
        : t.t === "op"
          ? t.v
          : t.t === "io"
            ? String(t.n)
            : t.raw;
    return new SyntaxErr(
      `syntax error near unexpected token \`${text}'`,
      t.pos,
    );
  }

  skipNewlines(): void {
    while (this.isNewline(this.peek())) this.next();
  }

  /** Skips newlines; at the end of the input the command is incomplete. */
  skipNewlinesNeed(): void {
    this.skipNewlines();
    if (this.peek().t === "eof") throw new Incomplete("eof", this.pos);
  }

  script(): Script {
    const items: Node[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.peek().t === "eof") break;
      items.push(...this.unit());
    }
    return { type: "script", items };
  }

  /** One input line: a list that ends at a newline or the end of the input. */
  unit(): Node[] {
    const out: Node[] = [];
    for (;;) {
      const node = this.andOr();
      const t = this.peek();
      if (this.isOp(t, "&")) {
        node.bg = true;
        this.next();
        out.push(node);
        const n = this.peek();
        if (n.t === "eof" || this.isNewline(n)) break;
        continue;
      }
      if (this.isOp(t, ";")) {
        this.next();
        out.push(node);
        const n = this.peek();
        if (n.t === "eof" || this.isNewline(n)) break;
        continue;
      }
      if (t.t === "eof" || this.isNewline(t)) {
        out.push(node);
        break;
      }
      throw this.unexpected(t);
    }
    return out;
  }

  /** A compound list: commands up to a token for which `isEnd` is true. */
  parseList(isEnd: (t: Tok) => boolean): Node[] {
    const items: Node[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.t === "eof") throw new Incomplete("eof", this.pos);
      if (isEnd(t)) break;
      const node = this.andOr();
      const n = this.peek();
      if (this.isOp(n, "&")) {
        node.bg = true;
        this.next();
      } else if (this.isOp(n, ";") || this.isNewline(n)) this.next();
      else if (!isEnd(n)) {
        if (n.t === "eof") throw new Incomplete("eof", this.pos);
        throw this.unexpected(n);
      }
      items.push(node);
    }
    return items;
  }

  /** A non-empty compound list, or a syntax error at the end token. */
  body(isEnd: (t: Tok) => boolean): Node[] {
    const items = this.parseList(isEnd);
    if (!items.length) throw this.unexpected(this.peek());
    return items;
  }

  andOr(): Node {
    const first = this.pipeline();
    const rest: { op: "&&" | "||"; node: Node }[] = [];
    for (;;) {
      const t = this.peek();
      if (!(this.isOp(t, "&&") || this.isOp(t, "||"))) break;
      this.next();
      this.skipNewlinesNeed();
      rest.push({
        op: (t as { v: string }).v as "&&" | "||",
        node: this.pipeline(),
      });
    }
    if (!rest.length) return first;
    return { type: "andor", line: first.line, first, rest };
  }

  pipeline(): Node {
    let negate = false;
    const line = this.lineAt(this.peek().pos);
    while (this.isWord(this.peek(), "!")) {
      this.next();
      negate = !negate;
      if (this.peek().t === "eof") throw new Incomplete("eof", this.pos);
    }
    const cmds: Node[] = [this.command()];
    for (;;) {
      const t = this.peek();
      if (!(this.isOp(t, "|") || this.isOp(t, "|&"))) break;
      this.next();
      this.skipNewlinesNeed();
      if (t.t === "op" && t.v === "|&") {
        const left = cmds[cmds.length - 1];
        (left.redirs ??= []).push({
          fd: 2,
          op: ">&",
          target: [{ k: "lit", v: "1" }],
        });
      }
      cmds.push(this.command());
    }
    if (!negate && cmds.length === 1) return cmds[0];
    return { type: "pipeline", negate, cmds, line };
  }

  expectWord(w: string): void {
    const t = this.peek();
    if (t.t === "eof") throw new Incomplete("eof", this.pos);
    if (!this.isWord(t, w)) throw this.unexpected(t);
    this.next();
  }
  expectOp(v: string): void {
    const t = this.peek();
    if (t.t === "eof") throw new Incomplete("eof", this.pos);
    if (!this.isOp(t, v)) throw this.unexpected(t);
    this.next();
  }

  command(): Node {
    const t = this.peek();
    if (t.t === "eof") throw new Incomplete("eof", this.pos);
    const line = this.lineAt(t.pos);
    let node: Node;
    if (t.t === "op") {
      if (t.v !== "(") throw this.unexpected(t);
      if (this.src[t.pos + 1] === "(") {
        const a = this.tryArith(t.pos);
        if (a) node = a;
        else node = this.subshell(line);
      } else node = this.subshell(line);
    } else if (t.t === "word") {
      const w = t.raw;
      const isEndWord = (x: Tok, ...ws: string[]) =>
        x.t === "word" && ws.includes(x.raw);
      if (w === "if") {
        this.next();
        this.enter();
        const clauses: { cond: Node[]; body: Node[] }[] = [];
        let els: Node[] | null = null;
        let cond = this.body((x) => isEndWord(x, "then"));
        this.expectWord("then");
        let body = this.body((x) => isEndWord(x, "elif", "else", "fi"));
        clauses.push({ cond, body });
        for (;;) {
          const n = this.peek();
          if (this.isWord(n, "elif")) {
            this.next();
            cond = this.body((x) => isEndWord(x, "then"));
            this.expectWord("then");
            body = this.body((x) => isEndWord(x, "elif", "else", "fi"));
            clauses.push({ cond, body });
          } else if (this.isWord(n, "else")) {
            this.next();
            els = this.body((x) => isEndWord(x, "fi"));
          } else break;
        }
        this.expectWord("fi");
        this.leave();
        node = { type: "if", line, clauses, else: els };
      } else if (w === "while" || w === "until") {
        this.next();
        this.enter();
        const cond = this.body((x) => isEndWord(x, "do"));
        this.expectWord("do");
        const body = this.body((x) => isEndWord(x, "done"));
        this.expectWord("done");
        this.leave();
        node = { type: w, line, cond, body };
      } else if (w === "for") node = this.forLoop(line);
      else if (w === "case") node = this.caseCmd(line);
      else if (w === "{") {
        this.next();
        this.enter();
        const body = this.body((x) => isEndWord(x, "}"));
        this.expectWord("}");
        this.leave();
        node = { type: "group", line, body };
      } else if (w === "[[") node = this.condCmd(line);
      else if (w === "function") node = this.functionKw(line);
      else if (KEYWORDS.has(w) && w !== "time" && w !== "select" && w !== "!")
        throw this.unexpected(t);
      else return this.simple();
    } else throw this.unexpected(t);
    this.trailingRedirs(node);
    return node;
  }

  trailingRedirs(node: Node): void {
    for (;;) {
      const t = this.peek();
      if (t.t === "io" || (t.t === "op" && REDIR_OPS.has(t.v)))
        (node.redirs ??= []).push(this.redir());
      else break;
    }
  }

  subshell(line: number): Node {
    this.next();
    this.enter();
    const body = this.body((x) => this.isOp(x, ")"));
    this.expectOp(")");
    this.leave();
    return { type: "subshell", line, body };
  }

  /** `(( ... ))` as a command, or null when it is two nested subshells. */
  tryArith(at: number): ArithCmd | null {
    const s = this.src;
    let depth = 0;
    let end = -1;
    let i = at + 2;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") {
        if (depth === 0) {
          if (s[i + 1] === ")") end = i;
          break;
        }
        depth--;
      }
    }
    if (end < 0) {
      if (i >= s.length) throw new Incomplete("eof", this.pos);
      return null;
    }
    const line = this.lineAt(at);
    const expr = this.parseText(s.slice(at + 2, end), "hd");
    this.buf = null;
    this.pos = end + 2;
    this.lastEnd = this.pos;
    return { type: "arith", line, expr };
  }

  forLoop(line: number): Node {
    this.next();
    this.enter();
    const t = this.peek();
    if (t.t === "eof") throw new Incomplete("eof", this.pos);
    if (this.isOp(t, "(") && this.src[t.pos + 1] === "(") {
      const s = this.src;
      let depth = 0;
      let end = -1;
      let i = t.pos + 2;
      for (; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") {
          if (depth === 0) {
            if (s[i + 1] === ")") end = i;
            break;
          }
          depth--;
        }
      }
      if (end < 0) {
        if (i >= s.length) throw new Incomplete("eof", this.pos);
        throw this.unexpected(t);
      }
      const inner = s.slice(t.pos + 2, end);
      const segs: string[] = [];
      let cur = "";
      let d = 0;
      for (const ch of inner) {
        if (ch === "(") d++;
        if (ch === ")") d--;
        if (ch === ";" && d === 0) {
          segs.push(cur);
          cur = "";
        } else cur += ch;
      }
      segs.push(cur);
      this.buf = null;
      this.pos = end + 2;
      this.lastEnd = this.pos;
      const [a = "", b = "", c = ""] = segs;
      this.skipSeps();
      this.expectWord("do");
      const body = this.body((x) => this.isWord(x, "done"));
      this.expectWord("done");
      this.leave();
      return {
        type: "cfor",
        line,
        init: this.parseText(a, "hd"),
        cond: this.parseText(b, "hd"),
        step: this.parseText(c, "hd"),
        body,
      };
    }
    if (t.t !== "word") throw this.unexpected(t);
    this.next();
    const name = t.raw;
    if (!NAME_RE.test(name))
      throw new SyntaxErr(`\`${name}': not a valid identifier`, t.pos, false);
    this.skipNewlines();
    let words: Word[] | null = null;
    if (this.isWord(this.peek(), "in")) {
      this.next();
      words = [];
      for (;;) {
        const n = this.peek();
        if (n.t === "word") {
          this.next();
          words.push(n.w);
        } else if (this.isOp(n, ";") || this.isNewline(n)) break;
        else if (n.t === "eof") throw new Incomplete("eof", this.pos);
        else throw this.unexpected(n);
      }
    }
    this.skipSeps();
    this.expectWord("do");
    const body = this.body((x) => this.isWord(x, "done"));
    this.expectWord("done");
    this.leave();
    return { type: "for", line, name, words, body };
  }

  skipSeps(): void {
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, ";") || this.isNewline(t)) this.next();
      else break;
    }
  }

  caseCmd(line: number): Node {
    this.next();
    this.enter();
    const wt = this.peek();
    if (wt.t === "eof") throw new Incomplete("eof", this.pos);
    if (wt.t !== "word") throw this.unexpected(wt);
    this.next();
    this.skipNewlines();
    this.expectWord("in");
    const clauses: {
      patterns: Word[];
      body: Node[];
      term: ";;" | ";&" | ";;&";
    }[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.t === "eof") throw new Incomplete("eof", this.pos);
      if (this.isWord(t, "esac")) break;
      if (this.isOp(t, "(")) this.next();
      const patterns: Word[] = [];
      for (;;) {
        const p = this.peek();
        if (p.t === "eof") throw new Incomplete("eof", this.pos);
        if (p.t !== "word") throw this.unexpected(p);
        this.next();
        patterns.push(p.w);
        if (this.isOp(this.peek(), "|")) this.next();
        else break;
      }
      this.expectOp(")");
      const isEnd = (x: Tok) =>
        this.isWord(x, "esac") ||
        this.isOp(x, ";;") ||
        this.isOp(x, ";&") ||
        this.isOp(x, ";;&");
      const body = this.parseList(isEnd);
      let term: ";;" | ";&" | ";;&" = ";;";
      const e = this.peek();
      if (e.t === "op" && (e.v === ";;" || e.v === ";&" || e.v === ";;&")) {
        term = e.v;
        this.next();
      }
      clauses.push({ patterns, body, term });
    }
    this.expectWord("esac");
    this.leave();
    return { type: "case", line, word: wt.w, clauses };
  }

  functionKw(line: number): Node {
    this.next();
    const t = this.peek();
    if (t.t === "eof") throw new Incomplete("eof", this.pos);
    if (t.t !== "word") throw this.unexpected(t);
    this.next();
    if (this.isOp(this.peek(), "(")) {
      this.next();
      this.expectOp(")");
    }
    return this.functionBody(t.raw, line);
  }

  functionBody(name: string, line: number): Node {
    this.skipNewlinesNeed();
    const start = this.peek().pos;
    this.enter();
    const body = this.command();
    this.leave();
    return {
      type: "function",
      line,
      name,
      body,
      src: this.src.slice(start, this.lastEnd),
    };
  }

  /* ---------- [[ ]] ---------- */

  private cbuf: CondTok | null = null;

  condTok() {
    if (this.cbuf) return this.cbuf;
    const s = this.src;
    for (;;) {
      while (
        this.pos < s.length &&
        (isSpace(s[this.pos]) || s[this.pos] === "\n")
      )
        this.pos++;
      if (s[this.pos] === "\\" && s[this.pos + 1] === "\n") this.pos += 2;
      else break;
    }
    if (this.pos >= s.length) throw new Incomplete("eof", this.pos);
    const pos = this.pos;
    const c = s[pos];
    const set = (t: CondTok): CondTok => (this.cbuf = t);
    if (
      s.startsWith("]]", pos) &&
      (pos + 2 >= s.length || /[\s;&|()<>]/.test(s[pos + 2]))
    ) {
      this.pos += 2;
      return set({ t: "]]", pos });
    }
    if (s.startsWith("&&", pos)) {
      this.pos += 2;
      return set({ t: "&&", pos });
    }
    if (s.startsWith("||", pos)) {
      this.pos += 2;
      return set({ t: "||", pos });
    }
    if (c === "(" || c === ")") {
      this.pos++;
      return set({ t: c, pos });
    }
    if ((c === "<" || c === ">") && s[pos + 1] !== "(") {
      this.pos++;
      return set({ t: c, pos });
    }
    const w = this.readParts("word", "");
    if (this.pos === pos) throw new SyntaxErr("", pos);
    return set({ t: "word", w, raw: s.slice(pos, this.pos), pos });
  }
  condNext() {
    const t = this.condTok();
    this.cbuf = null;
    return t;
  }

  readRegexWord(): Word {
    const s = this.src;
    while (this.pos < s.length && isSpace(s[this.pos])) this.pos++;
    const parts: Word = [];
    let lit = "";
    let depth = 0;
    const flush = () => {
      if (lit) parts.push({ k: "lit", v: lit });
      lit = "";
    };
    while (this.pos < s.length) {
      const c = s[this.pos];
      if ((isSpace(c) || c === "\n") && depth === 0) break;
      if (c === "(") depth++;
      if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (c === "\\" && this.pos + 1 < s.length) {
        lit += c + s[this.pos + 1];
        this.pos += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "$" || c === "`") {
        flush();
        const save = this.pos;
        this.pos = save;
        const w = this.readQuotedOrDollar();
        parts.push(...w);
        continue;
      }
      lit += c;
      this.pos++;
    }
    flush();
    return parts;
  }

  /** One quoted string or expansion at the position, as parts. */
  readQuotedOrDollar(): Word {
    const s = this.src;
    const c = s[this.pos];
    if (c === "'") {
      const e = s.indexOf("'", this.pos + 1);
      if (e < 0) throw new Incomplete("quote", this.pos, "'");
      const v = s.slice(this.pos + 1, e);
      this.pos = e + 1;
      return [{ k: "sq", v }];
    }
    if (c === '"') {
      this.pos++;
      return [{ k: "dq", parts: this.readParts("dq", "") }];
    }
    if (c === "`") return [this.backtick()];
    const d = this.dollar();
    if (d) return [d];
    this.pos++;
    return [{ k: "lit", v: "$" }];
  }

  condCmd(line: number): Node {
    this.next();
    this.buf = null;
    this.enter();
    const expr = this.condOr();
    const t = this.condNext();
    if (t.t !== "]]")
      throw new SyntaxErr(
        `syntax error in conditional expression: unexpected token \`${t.raw ?? t.t}'`,
        t.pos,
      );
    this.lastEnd = this.pos;
    this.leave();
    return { type: "cond", line, expr };
  }
  condOr(): CondExpr {
    let l = this.condAnd();
    while (this.condTok().t === "||") {
      this.condNext();
      l = { op: "||", l, r: this.condAnd() };
    }
    return l;
  }
  condAnd(): CondExpr {
    let l = this.condPrimary();
    while (this.condTok().t === "&&") {
      this.condNext();
      l = { op: "&&", l, r: this.condPrimary() };
    }
    return l;
  }
  condPrimary(): CondExpr {
    const t = this.condTok();
    if (t.t === "(") {
      this.condNext();
      const e = this.condOr();
      const c = this.condNext();
      if (c.t !== ")")
        throw new SyntaxErr("syntax error in conditional expression", c.pos);
      return e;
    }
    if (t.t === "word" && t.raw === "!") {
      this.condNext();
      return { op: "!", e: this.condPrimary() };
    }
    if (t.t !== "word")
      throw new SyntaxErr(
        `syntax error in conditional expression: unexpected token \`${t.t}'`,
        t.pos,
      );
    this.condNext();
    const nx = this.condTok();
    if (
      COND_UNARY.has(t.raw as string) &&
      nx.t === "word" &&
      !COND_BIN.has(nx.raw as string)
    ) {
      this.condNext();
      return { op: "unary", flag: t.raw as string, w: nx.w as Word };
    }
    if (
      (nx.t === "word" && COND_BIN.has(nx.raw as string)) ||
      nx.t === "<" ||
      nx.t === ">"
    ) {
      this.condNext();
      const cmp = nx.t === "word" ? (nx.raw as string) : nx.t;
      let r: Word;
      if (cmp === "=~") r = this.readRegexWord();
      else {
        const rt = this.condNext();
        if (rt.t !== "word")
          throw new SyntaxErr("syntax error in conditional expression", rt.pos);
        r = rt.w as Word;
      }
      return { op: "binary", cmp, l: t.w as Word, r };
    }
    return { op: "word", w: t.w as Word };
  }

  /* ---------- simple commands and redirections ---------- */

  redir(): Redir {
    let fd: number | undefined;
    let t = this.peek();
    if (t.t === "io") {
      fd = t.n;
      this.next();
      t = this.peek();
    }
    if (t.t !== "op" || !REDIR_OPS.has(t.v)) throw this.unexpected(t);
    this.next();
    const target = this.peek();
    if (target.t !== "word") throw this.unexpected(target);
    this.next();
    if (t.v === "<<" || t.v === "<<-") {
      const delim = target.raw.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
      const r: Redir = {
        fd,
        op: "<<",
        target: target.w,
        heredoc: {
          body: [],
          strip: t.v === "<<-",
          quoted: /['"\\]/.test(target.raw),
        },
      };
      this.pending.push({
        redir: r,
        delim,
        strip: t.v === "<<-",
        quoted: /['"\\]/.test(target.raw),
      });
      return r;
    }
    return { fd, op: t.v as RedirOp, target: target.w };
  }

  simple(): Node {
    const first = this.peek();
    const line = this.lineAt(first.pos);
    const assigns: Assign[] = [];
    const words: Word[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "eof") break;
      if (t.t === "io" || (t.t === "op" && REDIR_OPS.has(t.v))) {
        redirs.push(this.redir());
        continue;
      }
      if (t.t === "op") {
        if (t.v === "(" && words.length === 1 && !assigns.length) {
          const f = first;
          if (f.t === "word" && !redirs.length) {
            this.next();
            const close = this.peek();
            if (!this.isOp(close, ")")) throw this.unexpected(close);
            this.next();
            return this.functionBody(f.raw, line);
          }
        }
        if (t.v === "(") throw this.unexpected(t);
        break;
      }
      if (t.t !== "word") break;
      if (!words.length) {
        const a = this.asAssign(t);
        if (a) {
          this.next();
          assigns.push(a);
          continue;
        }
      }
      this.next();
      words.push(t.w);
    }
    if (!assigns.length && !words.length && !redirs.length)
      throw this.unexpected(first);
    const node: Simple = { type: "simple", line, assigns, words };
    if (redirs.length) node.redirs = redirs;
    return node;
  }

  asAssign(t: Extract<Tok, { t: "word" }>): Assign | null {
    const f = t.w[0];
    if (!f || f.k !== "lit") return null;
    const m = ASSIGN_RE.exec(f.v);
    if (!m) return null;
    const rest = f.v.slice(m[0].length);
    let value: Word | null = rest
      ? [{ k: "lit", v: rest }, ...t.w.slice(1)]
      : t.w.slice(1);
    const a: Assign = {
      name: m[1],
      append: m[3] === "+",
      value: null,
    };
    if (m[2] !== undefined) a.idx = this.parseText(m[2], "hd");
    if (t.arr) {
      a.array = t.arr;
      value = null;
    } else if (value.length === 0) value = [];
    a.value = value;
    return a;
  }
}

export type UnitResult =
  | { status: "unit"; nodes: Node[] }
  | { status: "end" }
  | Exclude<ParseFull, { status: "ok" }>;

/**
 * Parses one unit (one line, or one compound command) at a time, so a script
 * can run `shopt -s extglob` before the next line is read, as bash does. The
 * caller may change `opts.extglob` between two calls.
 */
export function parseUnits(
  text: string,
  opts: ParseOptions = {},
): { next(): UnitResult } {
  const p = new P(text, opts);
  const done: Node[] = [];
  let finished = false;
  return {
    next(): UnitResult {
      if (finished) return { status: "end" };
      try {
        p.skipNewlines();
        if (p.peek().t === "eof") {
          finished = true;
          return { status: "end" };
        }
        const u = p.unit();
        done.push(...u);
        return { status: "unit", nodes: u };
      } catch (e) {
        finished = true;
        if (e instanceof Incomplete) {
          return {
            status: "incomplete",
            kind: e.kind,
            line: p.lineAt(Math.min(e.pos, Math.max(0, text.length - 1))),
            ch: e.ch,
          };
        }
        if (e instanceof SyntaxErr) {
          const line = p.lineAt(Math.min(e.pos, Math.max(0, text.length - 1)));
          const m = e.message;
          return {
            status: "error",
            message: `bash: ${m || "syntax error"}`,
            line,
            text: e.detail ? p.lineText(line) : "",
            done,
          };
        }
        if (e instanceof DepthErr || e instanceof RangeError)
          return {
            status: "error",
            message: `port-penguin: parser: nesting too deep (${LIM.parse})`,
            line: 1,
            text: "",
            done: [],
            nest: true,
          };
        throw e;
      }
    },
  };
}

/** Parses text with the details a script needs. In script mode the units before an error are in `done`. */
export function parseFull(text: string, opts: ParseOptions = {}): ParseFull {
  const it = parseUnits(text, opts);
  const items: Node[] = [];
  for (;;) {
    const r = it.next();
    if (r.status === "unit") items.push(...r.nodes);
    else if (r.status === "end")
      return { status: "ok", ast: { type: "script", items } };
    else return r;
  }
}

/** Parses an input. The message of an error is the bash text, without a line number. */
export function parse(text: string, opts: ParseOptions = {}): ParseResult {
  const r = parseFull(text, opts);
  if (r.status === "ok") return { status: "ok", ast: r.ast };
  if (r.status === "incomplete") return { status: "incomplete" };
  return { status: "error", message: r.message };
}

// AC4: `awk` (mawk 1.3.4 behavior, the awk of Ubuntu 24.04). A lexer, a
// parser, and a tree-walking interpreter. Not supported: `| getline`,
// `system()`, and pipes to commands that are not in the command table.
import { clockNow } from "../clock";
import { get } from "../paths";
import { writeText } from "../shell/redirect";
import { Input } from "../shell/io";
import { CallSteps, checkWidth } from "../shell/limits";
import type { CmdFn, IO, Writer } from "../shell/io";
import type { Proc } from "../shell/proc";
import { toJsRegex } from "./sed";
import { readOperand } from "./text";

class AwkError extends Error {}
class SyntaxErr extends AwkError {}
class BreakSig {}
class ContinueSig {}
class NextSig {
  constructor(readonly file = false) {}
}
class ExitSig {
  constructor(readonly code: number | null) {}
}
class ReturnSig {
  constructor(readonly value: Val) {}
}

/** A value: number, string, undefined (never set), or a numeric-looking input string. */
type Val = number | string | undefined | { sn: string };

const NUMRE = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const mkStrnum = (s: string): Val => (NUMRE.test(s) ? { sn: s } : s);
const isSn = (v: Val): v is { sn: string } =>
  typeof v === "object" && v !== null;

function strtod(s: string): number {
  const m = /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(s);
  return m ? parseFloat(m[0]) : 0;
}

/* ---------- number formatting ---------- */

function fmtE(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, "e$10$2");
  return upper ? s.toUpperCase() : s;
}

function fmtG(n: number, prec: number, alt: boolean, upper: boolean): string {
  if (!isFinite(n)) return n !== n ? "nan" : n < 0 ? "-inf" : "inf";
  if (prec === 0) prec = 1;
  if (n === 0) return alt ? (0).toFixed(prec - 1) : "0";
  const x = parseInt(n.toExponential(prec - 1).split("e")[1], 10);
  let s: string;
  if (x < -4 || x >= prec) {
    s = fmtE(n, prec - 1, false);
    if (!alt) s = s.replace(/\.?0+e/, "e");
  } else {
    s = n.toFixed(Math.max(0, prec - 1 - x));
    if (!alt && s.includes(".")) s = s.replace(/\.?0+$/, "");
  }
  return upper ? s.toUpperCase() : s;
}

function sprintf(
  fmt: string,
  args: Val[],
  str: (v: Val) => string,
  num: (v: Val) => number,
): string {
  let out = "";
  let ai = 0;
  const next = (): Val => args[ai++];
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    if (fmt[i + 1] === "%") {
      out += "%";
      i++;
      continue;
    }
    let j = i + 1;
    let flags = "";
    while ("-+ #0".includes(fmt[j] ?? "x")) flags += fmt[j++];
    let width = "";
    if (fmt[j] === "*") {
      width = String(num(next()));
      j++;
    } else while (/\d/.test(fmt[j] ?? "")) width += fmt[j++];
    let prec = -1;
    if (fmt[j] === ".") {
      j++;
      let p = "";
      if (fmt[j] === "*") {
        p = String(num(next()));
        j++;
      } else while (/\d/.test(fmt[j] ?? "")) p += fmt[j++];
      prec = p === "" ? 0 : parseInt(p, 10);
    }
    while ("lhLqjzt".includes(fmt[j] ?? "x")) j++;
    const conv = fmt[j];
    if (conv === undefined) {
      out += fmt.slice(i);
      break;
    }
    let w = width === "" ? 0 : parseInt(width, 10);
    checkWidth(w);
    checkWidth(prec);
    if (w < 0) {
      flags += "-";
      w = -w;
    }
    let body: string;
    let sign = "";
    const left = flags.includes("-");
    let zero = flags.includes("0") && !left;
    switch (conv) {
      case "d":
      case "i": {
        const v = Math.trunc(num(next()));
        const a = Math.abs(v);
        body = String(a);
        if (prec >= 0) {
          body = body.padStart(prec, "0");
          zero = false;
        }
        sign =
          v < 0
            ? "-"
            : flags.includes("+")
              ? "+"
              : flags.includes(" ")
                ? " "
                : "";
        break;
      }
      case "o":
      case "x":
      case "X":
      case "u": {
        let v = Math.trunc(num(next()));
        if (v < 0) v += 2 ** 64;
        body = v.toString(conv === "o" ? 8 : conv === "u" ? 10 : 16);
        if (conv === "X") body = body.toUpperCase();
        if (prec >= 0) {
          body = body.padStart(prec, "0");
          zero = false;
        }
        if (flags.includes("#") && v !== 0)
          sign = conv === "x" ? "0x" : conv === "X" ? "0X" : "";
        if (flags.includes("#") && conv === "o") body = "0" + body;
        break;
      }
      case "e":
      case "E":
      case "f":
      case "F":
      case "g":
      case "G": {
        const v = num(next());
        const a = Math.abs(v);
        const p = prec < 0 ? 6 : prec;
        if (!isFinite(v)) {
          body = v !== v ? "nan" : "inf";
          zero = false;
        } else if (conv === "f" || conv === "F") body = a.toFixed(p);
        else if (conv === "e" || conv === "E") body = fmtE(a, p, conv === "E");
        else body = fmtG(a, p, flags.includes("#"), conv === "G");
        sign =
          v < 0 || Object.is(v, -0)
            ? "-"
            : flags.includes("+")
              ? "+"
              : flags.includes(" ")
                ? " "
                : "";
        break;
      }
      case "c": {
        const v = next();
        body =
          typeof v === "number" ? String.fromCharCode(v) : (str(v)[0] ?? "");
        zero = false;
        break;
      }
      case "s": {
        body = str(next());
        if (prec >= 0) body = body.slice(0, prec);
        zero = false;
        break;
      }
      default:
        out += fmt.slice(i, j + 1);
        i = j;
        continue;
    }
    const len = sign.length + body.length;
    if (len >= w) out += sign + body;
    else if (left) out += sign + body + " ".repeat(w - len);
    else if (zero) out += sign + "0".repeat(w - len) + body;
    else out += " ".repeat(w - len) + sign + body;
    i = j;
  }
  return out;
}

/* ---------- lexer ---------- */

type Tok = { t: string; v: string; line: number };

const KEYWORDS = new Set([
  "BEGIN",
  "END",
  "function",
  "func",
  "if",
  "else",
  "while",
  "for",
  "do",
  "break",
  "continue",
  "next",
  "nextfile",
  "exit",
  "return",
  "delete",
  "in",
  "getline",
  "print",
  "printf",
]);
const BUILTINS = new Set([
  "length",
  "substr",
  "index",
  "split",
  "sub",
  "gsub",
  "match",
  "sprintf",
  "sin",
  "cos",
  "atan2",
  "exp",
  "log",
  "sqrt",
  "int",
  "rand",
  "srand",
  "tolower",
  "toupper",
  "system",
  "close",
  "fflush",
]);

const ESC: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "/": "/",
};

/** Awk escape processing for `-v` values and `-F`. */
const unescape = (s: string): string =>
  s.replace(/\\(?:([0-7]{1,3})|(.))/g, (_m, o: string, c: string) =>
    o ? String.fromCharCode(parseInt(o, 8)) : (ESC[c] ?? "\\" + c),
  );

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const push = (t: string, v: string) => toks.push({ t, v, line });
  const regexOk = (): boolean => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (["num", "str", "name", "builtin", "ere"].includes(p.t)) return false;
    if (p.t === "p" && [")", "]", "$", "++", "--"].includes(p.v)) return false;
    return true;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      line++;
    } else if (c === "\\" && src[i + 1] === "\r" && src[i + 2] === "\n") {
      i += 3;
      line++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "\n") {
      push("nl", "\n");
      line++;
      i++;
    } else if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d*([eE][+-]?\d+)?)/.exec(
        src.slice(i),
      ) as RegExpExecArray;
      push("num", m[0]);
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (KEYWORDS.has(w)) push("kw", w === "func" ? "function" : w);
      else if (BUILTINS.has(w)) push("builtin", w);
      else if (src[j] === "(") push("fname", w);
      else push("name", w);
      i = j;
    } else if (c === '"') {
      let s = "";
      i++;
      for (; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\n")
          throw new SyntaxErr(`runaway string constant "${s.slice(0, 10)} ...`);
        if (src[i] === "\\" && i + 1 < src.length) {
          const o = /^[0-7]{1,3}/.exec(src.slice(i + 1));
          if (o) {
            s += String.fromCharCode(parseInt(o[0], 8));
            i += o[0].length;
          } else if (src[i + 1] === "\n") {
            i++;
            line++;
          } else {
            s += ESC[src[i + 1]] ?? "\\" + src[i + 1];
            i++;
          }
        } else s += src[i];
      }
      if (i >= src.length) throw new SyntaxErr("runaway string constant");
      i++;
      push("str", s);
    } else if (c === "/" && regexOk()) {
      let s = "";
      i++;
      let inBr = false;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\n") throw new SyntaxErr("runaway regular expression");
        if (ch === "\\" && i + 1 < src.length) {
          if (src[i + 1] === "/") s += "/";
          else s += ch + src[i + 1];
          i++;
          continue;
        }
        if (ch === "[") inBr = true;
        else if (ch === "]") inBr = false;
        else if (ch === "/" && !inBr) break;
        s += ch;
      }
      if (i >= src.length) throw new SyntaxErr("runaway regular expression");
      i++;
      push("ere", s);
    } else {
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      let p: string;
      if (three === "**=") p = "^=";
      else if (
        [
          "+=",
          "-=",
          "*=",
          "/=",
          "%=",
          "^=",
          "==",
          "<=",
          ">=",
          "!=",
          "++",
          "--",
          "&&",
          "||",
          ">>",
          "!~",
          "**",
        ].includes(two)
      )
        p = two === "**" ? "^" : two;
      else p = c;
      if (!"{}()[];,+-*/%^!><|?:~$=&".includes(c))
        throw new SyntaxErr(`syntax error at or near ${c}`);
      push("p", p);
      i +=
        three === "**="
          ? 3
          : two === "**" || (p.length === 2 && p === two)
            ? 2
            : 1;
    }
  }
  push("nl", "\n");
  push("eof", "");
  return toks;
}

/* ---------- parser ---------- */

type Expr =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "re"; v: string }
  | { t: "var"; n: string }
  | { t: "idx"; n: string; s: Expr[] }
  | { t: "field"; e: Expr }
  | { t: "assign"; op: string; l: Expr; r: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "bin"; op: string; a: Expr; b: Expr }
  | { t: "un"; op: string; a: Expr }
  | { t: "incr"; op: string; pre: boolean; l: Expr }
  | { t: "in"; s: Expr[]; n: string }
  | { t: "call"; n: string; a: Expr[] }
  | { t: "bi"; n: string; a: Expr[] }
  | { t: "group"; e: Expr[] }
  | { t: "getline"; l: Expr | null; file: Expr | null };

type Stmt =
  | { t: "expr"; e: Expr }
  | { t: "print"; a: Expr[]; dest: { op: string; e: Expr } | null; f: boolean }
  | { t: "if"; c: Expr; a: Stmt; b: Stmt | null }
  | { t: "while"; c: Expr; b: Stmt }
  | { t: "do"; b: Stmt; c: Expr }
  | { t: "for"; i: Stmt | null; c: Expr | null; s: Stmt | null; b: Stmt }
  | { t: "forin"; v: Expr; n: string; b: Stmt }
  | { t: "block"; b: Stmt[] }
  | { t: "simple"; k: "break" | "continue" | "next" | "nextfile" }
  | { t: "exit"; e: Expr | null }
  | { t: "return"; e: Expr | null }
  | { t: "delete"; n: string; s: Expr[] | null };

interface Rule {
  kind: "begin" | "end" | "main";
  p1?: Expr;
  p2?: Expr;
  body: Stmt | null;
  on?: boolean;
}
interface Func {
  params: string[];
  body: Stmt;
}

class Parser {
  i = 0;
  funcs = new Map<string, Func>();
  rules: Rule[] = [];
  constructor(private toks: Tok[]) {}
  get tok(): Tok {
    return this.toks[this.i];
  }
  fail(): never {
    const t = this.tok;
    const near =
      t.t === "eof" ? "end of file" : t.t === "nl" ? "end of line" : t.v;
    throw new SyntaxErr(`line ${t.line}: syntax error at or near ${near}`);
  }
  isP(v: string): boolean {
    return this.tok.t === "p" && this.tok.v === v;
  }
  isKw(v: string): boolean {
    return this.tok.t === "kw" && this.tok.v === v;
  }
  eatP(v: string): boolean {
    if (this.isP(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  expectP(v: string): void {
    if (!this.eatP(v)) this.fail();
  }
  nls(): void {
    while (this.tok.t === "nl") this.i++;
  }
  terms(): void {
    while (this.tok.t === "nl" || this.isP(";")) this.i++;
  }

  program(): void {
    this.terms();
    while (this.tok.t !== "eof") {
      this.item();
      this.terms();
    }
  }

  item(): void {
    if (this.isKw("function")) {
      this.i++;
      const nm = this.tok;
      if (nm.t !== "name" && nm.t !== "fname") this.fail();
      this.i++;
      this.expectP("(");
      const params: string[] = [];
      while (!this.isP(")")) {
        if (this.tok.t !== "name") this.fail();
        params.push(this.tok.v);
        this.i++;
        if (!this.eatP(",")) break;
        this.nls();
      }
      this.expectP(")");
      this.nls();
      const body = this.block();
      this.funcs.set(nm.v, { params, body });
      return;
    }
    if (this.isKw("BEGIN") || this.isKw("END")) {
      const kind = this.tok.v === "BEGIN" ? "begin" : "end";
      this.i++;
      if (!this.isP("{")) this.fail();
      this.rules.push({ kind, body: this.block() });
      return;
    }
    const rule: Rule = { kind: "main", body: null };
    if (!this.isP("{")) {
      rule.p1 = this.expr();
      if (this.eatP(",")) {
        this.nls();
        rule.p2 = this.expr();
      }
    }
    if (this.isP("{")) rule.body = this.block();
    this.rules.push(rule);
  }

  block(): Stmt {
    this.expectP("{");
    const b: Stmt[] = [];
    this.terms();
    while (!this.isP("}")) {
      if (this.tok.t === "eof") this.fail();
      b.push(this.stmt());
      this.terms();
    }
    this.i++;
    return { t: "block", b };
  }

  endSimple(): void {
    if (this.tok.t === "nl" || this.isP(";")) {
      this.i++;
      return;
    }
    if (this.isP("}") || this.tok.t === "eof") return;
    this.fail();
  }

  body(): Stmt {
    this.nls();
    if (this.isP(";")) {
      this.i++;
      return { t: "block", b: [] };
    }
    return this.stmt();
  }

  stmt(): Stmt {
    const t = this.tok;
    if (this.isP("{")) return this.block();
    if (t.t === "kw") {
      switch (t.v) {
        case "if": {
          this.i++;
          this.expectP("(");
          const c = this.expr();
          this.expectP(")");
          const a = this.body();
          const save = this.i;
          this.terms();
          if (this.isKw("else")) {
            this.i++;
            return { t: "if", c, a, b: this.body() };
          }
          this.i = save;
          return { t: "if", c, a, b: null };
        }
        case "while": {
          this.i++;
          this.expectP("(");
          const c = this.expr();
          this.expectP(")");
          if (this.isP(";")) {
            this.i++;
            return { t: "while", c, b: { t: "block", b: [] } };
          }
          return { t: "while", c, b: this.body() };
        }
        case "do": {
          this.i++;
          const b = this.body();
          this.terms();
          if (!this.isKw("while")) this.fail();
          this.i++;
          this.expectP("(");
          const c = this.expr();
          this.expectP(")");
          this.endSimple();
          return { t: "do", b, c };
        }
        case "for": {
          this.i++;
          this.expectP("(");
          if (
            this.tok.t === "name" &&
            this.toks[this.i + 1].v === "in" &&
            this.toks[this.i + 2].t === "name" &&
            this.toks[this.i + 3].v === ")"
          ) {
            const v: Expr = { t: "var", n: this.tok.v };
            const n = this.toks[this.i + 2].v;
            this.i += 4;
            return { t: "forin", v, n, b: this.body() };
          }
          const init = this.isP(";") ? null : this.simple();
          this.expectP(";");
          this.nls();
          const c = this.isP(";") ? null : this.expr();
          this.expectP(";");
          this.nls();
          const s = this.isP(")") ? null : this.simple();
          this.expectP(")");
          if (this.isP(";")) {
            this.i++;
            return { t: "for", i: init, c, s, b: { t: "block", b: [] } };
          }
          return { t: "for", i: init, c, s, b: this.body() };
        }
        default:
      }
    }
    const s = this.simple();
    this.endSimple();
    return s;
  }

  simple(): Stmt {
    const t = this.tok;
    if (t.t === "kw") {
      switch (t.v) {
        case "break":
        case "continue":
        case "next":
        case "nextfile":
          this.i++;
          return { t: "simple", k: t.v };
        case "exit":
        case "return": {
          this.i++;
          const e = this.endOfExpr() ? null : this.expr();
          return t.v === "exit" ? { t: "exit", e } : { t: "return", e };
        }
        case "delete": {
          this.i++;
          if (this.tok.t !== "name") this.fail();
          const n = this.tok.v;
          this.i++;
          if (this.eatP("[")) {
            const s = this.exprList("]");
            return { t: "delete", n, s };
          }
          return { t: "delete", n, s: null };
        }
        case "print":
        case "printf": {
          this.i++;
          let a: Expr[] = [];
          if (
            !this.endOfExpr() &&
            !this.isP(">") &&
            !this.isP(">>") &&
            !this.isP("|")
          ) {
            a = this.exprListNoGt();
            if (a.length === 1 && a[0].t === "group") a = a[0].e;
          }
          let dest: { op: string; e: Expr } | null = null;
          if (this.isP(">") || this.isP(">>") || this.isP("|")) {
            const op = this.tok.v;
            this.i++;
            dest = { op, e: this.concat(true) };
          }
          if (t.v === "printf" && a.length === 0) this.fail();
          return { t: "print", a, dest, f: t.v === "printf" };
        }
        default:
      }
    }
    return { t: "expr", e: this.expr() };
  }

  endOfExpr(): boolean {
    return (
      this.tok.t === "nl" ||
      this.tok.t === "eof" ||
      this.isP(";") ||
      this.isP("}")
    );
  }

  exprList(close: string): Expr[] {
    const r: Expr[] = [];
    this.nls();
    while (!this.isP(close)) {
      r.push(this.expr());
      this.nls();
      if (!this.eatP(",")) break;
      this.nls();
    }
    this.expectP(close);
    return r;
  }

  noGt = false;
  exprListNoGt(): Expr[] {
    const save = this.noGt;
    this.noGt = true;
    const r: Expr[] = [this.expr()];
    while (this.eatP(",")) {
      this.nls();
      r.push(this.expr());
    }
    this.noGt = save;
    return r;
  }

  expr(): Expr {
    return this.ternary();
  }

  isLvalue(e: Expr): boolean {
    return e.t === "var" || e.t === "idx" || e.t === "field";
  }

  ternary(): Expr {
    const c = this.or();
    if (this.isP("?")) {
      this.i++;
      this.nls();
      const a = this.ternary();
      this.nls();
      this.expectP(":");
      this.nls();
      const b = this.ternary();
      return { t: "cond", c, a, b };
    }
    if (
      this.isLvalue(c) &&
      this.tok.t === "p" &&
      ["=", "+=", "-=", "*=", "/=", "%=", "^="].includes(this.tok.v)
    ) {
      const op = this.tok.v;
      this.i++;
      this.nls();
      return { t: "assign", op, l: c, r: this.ternary() };
    }
    return c;
  }

  or(): Expr {
    let l = this.and();
    while (this.isP("||")) {
      this.i++;
      this.nls();
      l = { t: "bin", op: "||", a: l, b: this.and() };
    }
    return l;
  }
  and(): Expr {
    let l = this.inExpr();
    while (this.isP("&&")) {
      this.i++;
      this.nls();
      l = { t: "bin", op: "&&", a: l, b: this.inExpr() };
    }
    return l;
  }
  inExpr(): Expr {
    let l = this.match();
    while (this.isKw("in")) {
      this.i++;
      if (this.tok.t !== "name") this.fail();
      const n = this.tok.v;
      this.i++;
      l = { t: "in", s: l.t === "group" ? l.e : [l], n };
    }
    return l;
  }
  match(): Expr {
    let l = this.compare();
    while (this.isP("~") || this.isP("!~")) {
      const op = this.tok.v;
      this.i++;
      l = { t: "bin", op, a: l, b: this.compare() };
    }
    return l;
  }
  compare(): Expr {
    const l = this.concat(false);
    const ops = ["<", "<=", "==", "!=", ">=", ">"];
    if (
      this.tok.t === "p" &&
      ops.includes(this.tok.v) &&
      !(this.noGt && this.tok.v === ">")
    ) {
      const op = this.tok.v;
      this.i++;
      return { t: "bin", op, a: l, b: this.concat(false) };
    }
    return l;
  }
  startsOperand(): boolean {
    const t = this.tok;
    if (["num", "str", "ere", "name", "fname", "builtin"].includes(t.t))
      return true;
    if (t.t === "p") return ["$", "(", "++", "--"].includes(t.v);
    return false;
  }
  concat(noIn: boolean): Expr {
    void noIn;
    let l = this.additive();
    while (this.startsOperand()) {
      l = { t: "bin", op: "cat", a: l, b: this.additive() };
    }
    return l;
  }
  additive(): Expr {
    let l = this.mul();
    while (this.isP("+") || this.isP("-")) {
      const op = this.tok.v;
      this.i++;
      l = { t: "bin", op, a: l, b: this.mul() };
    }
    return l;
  }
  mul(): Expr {
    let l = this.unary();
    while (this.isP("*") || this.isP("/") || this.isP("%")) {
      const op = this.tok.v;
      this.i++;
      l = { t: "bin", op, a: l, b: this.unary() };
    }
    return l;
  }
  unary(): Expr {
    if (this.isP("!")) {
      this.i++;
      return { t: "un", op: "!", a: this.unary() };
    }
    if (this.isP("-") || this.isP("+")) {
      const op = this.tok.v;
      this.i++;
      return { t: "un", op, a: this.unary() };
    }
    return this.power();
  }
  power(): Expr {
    const b = this.postfix();
    if (this.isP("^")) {
      this.i++;
      // right associative; the exponent may carry a unary sign
      let e: Expr;
      if (this.isP("-") || this.isP("+") || this.isP("!")) {
        const op = this.tok.v;
        this.i++;
        e = { t: "un", op, a: this.powerOperand() };
      } else e = this.powerOperand();
      return { t: "bin", op: "^", a: b, b: e };
    }
    return b;
  }
  powerOperand(): Expr {
    return this.power();
  }
  postfix(): Expr {
    if (this.isP("++") || this.isP("--")) {
      const op = this.tok.v;
      this.i++;
      const l = this.postfix();
      if (!this.isLvalue(l)) this.fail();
      return { t: "incr", op, pre: true, l };
    }
    const p = this.primary();
    if ((this.isP("++") || this.isP("--")) && this.isLvalue(p)) {
      const op = this.tok.v;
      this.i++;
      return { t: "incr", op, pre: false, l: p };
    }
    return p;
  }
  primary(): Expr {
    const t = this.tok;
    switch (t.t) {
      case "num":
        this.i++;
        return { t: "num", v: Number(t.v) };
      case "str":
        this.i++;
        return { t: "str", v: t.v };
      case "ere":
        this.i++;
        return { t: "re", v: t.v };
      case "name": {
        this.i++;
        if (this.eatP("[")) return { t: "idx", n: t.v, s: this.exprList("]") };
        return { t: "var", n: t.v };
      }
      case "fname": {
        this.i++;
        this.expectP("(");
        return { t: "call", n: t.v, a: this.exprList(")") };
      }
      case "builtin": {
        this.i++;
        if (this.isP("(")) {
          this.i++;
          return { t: "bi", n: t.v, a: this.exprList(")") };
        }
        if (t.v === "length") return { t: "bi", n: "length", a: [] };
        this.fail();
        break;
      }
      case "kw":
        if (t.v === "getline") {
          this.i++;
          let l: Expr | null = null;
          if (this.tok.t === "name" || this.isP("$")) l = this.postfixNoIncr();
          let file: Expr | null = null;
          if (this.eatP("<")) file = this.postfixNoIncr();
          return { t: "getline", l, file };
        }
        this.fail();
        break;
      case "p":
        if (t.v === "$") {
          this.i++;
          if (this.isP("++") || this.isP("--")) {
            const op = this.tok.v;
            this.i++;
            const l = this.primary();
            return { t: "field", e: { t: "incr", op, pre: true, l } };
          }
          if (this.isP("-") || this.isP("+")) {
            const op = this.tok.v;
            this.i++;
            return { t: "field", e: { t: "un", op, a: this.primary() } };
          }
          return { t: "field", e: this.primary() };
        }
        if (t.v === "(") {
          this.i++;
          const save = this.noGt;
          this.noGt = false;
          this.nls();
          const first = this.expr();
          this.nls();
          if (this.isP(",")) {
            const all = [first];
            while (this.eatP(",")) {
              this.nls();
              all.push(this.expr());
              this.nls();
            }
            this.expectP(")");
            this.noGt = save;
            return { t: "group", e: all };
          }
          this.expectP(")");
          this.noGt = save;
          return { t: "bin", op: "grp", a: first, b: first };
        }
        break;
      default:
    }
    return this.fail();
  }
  postfixNoIncr(): Expr {
    const t = this.tok;
    if (t.t === "name") {
      this.i++;
      if (this.eatP("[")) return { t: "idx", n: t.v, s: this.exprList("]") };
      return { t: "var", n: t.v };
    }
    this.expectP("$");
    return { t: "field", e: this.primary() };
  }
}

/* ---------- interpreter ---------- */

type AwkArray = Map<string, Val>;
type Frame = Map<string, Val | AwkArray>;

/** B19: one step that the engine replays after the program ends. */
type AwkStep =
  | { k: "out"; text: string }
  | { k: "err"; text: string }
  | { k: "pipe"; argv: string[]; text: string };

/** A writer that records its text as steps, in the order of writing. */
class StepWriter implements Writer {
  readonly tty = false;
  constructor(
    private steps: AwkStep[],
    private k: "out" | "err",
  ) {}
  write(text: string): void {
    if (text === "") return;
    const last = this.steps[this.steps.length - 1];
    if (last && last.k === this.k) last.text += text;
    else
      this.steps.push(
        this.k === "out" ? { k: "out", text } : { k: "err", text },
      );
  }
}

class Runtime {
  /** B8: the steps of this one call (it cannot yield). */
  budget = new CallSteps();
  globals = new Map<string, Val>();
  arrays = new Map<string, AwkArray>();
  frames: Frame[] = [];
  rec = "";
  fields: string[] = [];
  nf = 0;
  splitDone = true;
  files: string[] = [];
  fileIdx = 0;
  cur: { lines: string[]; pos: number; text: string } | null = null;
  outFiles = new Map<
    string,
    { text: string; append: boolean; pipe: boolean }
  >();
  getFiles = new Map<string, { text: string; pos: number } | null>();
  reCache = new Map<string, RegExp>();
  seed = 0;
  prevSeed = 0;
  exitCode = 0;
  stdinUsed = false;
  depth = 0;
  /** B19: what the program wrote, and the pipe commands it closed, in order. */
  steps: AwkStep[] = [];

  constructor(
    readonly prog: Parser,
    readonly sh: Proc,
    readonly io: IO,
  ) {
    for (const [k, v] of Object.entries({
      FS: " ",
      OFS: " ",
      ORS: "\n",
      RS: "\n",
      NR: 0,
      FNR: 0,
      SUBSEP: "\x1c",
      CONVFMT: "%.6g",
      OFMT: "%.6g",
      FILENAME: "",
      RSTART: 0,
      RLENGTH: -1,
    }))
      this.globals.set(k, v);
    this.seed = 1;
    this.srandInit();
  }
  srandInit(): void {
    this.rngState = this.seed >>> 0 || 1;
  }
  rngState = 1;
  rand(): number {
    // xorshift32; the values differ from mawk's, as the seed does in real awk
    let x = this.rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x;
    return x / 4294967296;
  }

  /* ----- values ----- */
  num(v: Val): number {
    if (typeof v === "number") return v;
    if (v === undefined) return 0;
    return strtod(isSn(v) ? v.sn : v);
  }
  str(v: Val, fmtName = "CONVFMT"): string {
    if (typeof v === "string") return v;
    if (v === undefined) return "";
    if (isSn(v)) return v.sn;
    if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
    if (!isFinite(v)) return v !== v ? "nan" : v < 0 ? "-inf" : "inf";
    return sprintf(
      this.str(this.globals.get(fmtName)),
      [v],
      (x) => this.str(x),
      (x) => this.num(x),
    );
  }
  bool(v: Val): boolean {
    if (typeof v === "number") return v !== 0;
    if (v === undefined) return false;
    if (isSn(v)) return strtod(v.sn) !== 0;
    return v !== "";
  }
  numeric(v: Val): boolean {
    return typeof v === "number" || v === undefined || isSn(v);
  }
  re(src: string): RegExp {
    let r = this.reCache.get(src);
    if (!r) {
      try {
        r = new RegExp(toJsRegex(src, true), "s");
      } catch {
        throw new AwkError(
          `regular expression compile failed (bad regex)\n${src}`,
        );
      }
      this.reCache.set(src, r);
    }
    return r;
  }
  reOf(e: Expr): RegExp {
    if (e.t === "re") return this.re(e.v);
    return this.re(this.str(this.eval(e)));
  }

  /* ----- records and fields ----- */
  setRecord(s: string): void {
    this.rec = s;
    this.splitDone = false;
  }
  splitFields(): void {
    if (this.splitDone) return;
    this.splitDone = true;
    this.fields = this.splitStr(this.rec, this.str(this.globals.get("FS")));
    this.nf = this.fields.length;
  }
  splitStr(s: string, fs: string): string[] {
    if (s === "") return [];
    if (fs === " ")
      return s
        .split(/[ \t\n]+/)
        .filter((x, i, a) => !(x === "" && (i === 0 || i === a.length - 1)));
    if (fs === "") return s.split("");
    if (fs.length === 1 && fs !== "\\") return s.split(fs);
    if (fs === "\t") return s.split("\t");
    return s.split(this.re(fs));
  }
  getField(n: number): Val {
    if (n === 0) return mkStrnum(this.rec);
    if (n < 0) throw new AwkError(`negative field index $${n}`);
    this.splitFields();
    return n <= this.nf ? mkStrnum(this.fields[n - 1]) : undefined;
  }
  rebuild(): void {
    this.rec = this.fields
      .slice(0, this.nf)
      .join(this.str(this.globals.get("OFS")));
  }
  setField(n: number, s: string): void {
    if (n === 0) {
      this.setRecord(s);
      return;
    }
    this.splitFields();
    while (this.nf < n) this.fields[this.nf++] = "";
    this.fields[n - 1] = s;
    this.rebuild();
  }
  setNF(n: number): void {
    this.splitFields();
    while (this.nf < n) this.fields[this.nf++] = "";
    this.nf = Math.max(0, n);
    this.fields.length = this.nf;
    this.rebuild();
  }

  /* ----- variables ----- */
  getVar(n: string): Val {
    const fr = this.frames[this.frames.length - 1];
    if (fr && fr.has(n)) {
      const v = fr.get(n);
      if (v instanceof Map)
        throw new AwkError(`can't use array ${n} in scalar context`);
      return v;
    }
    if (n === "NF") {
      this.splitFields();
      return this.nf;
    }
    return this.globals.get(n);
  }
  setVar(n: string, v: Val): void {
    const fr = this.frames[this.frames.length - 1];
    if (fr && fr.has(n)) {
      fr.set(n, v);
      return;
    }
    if (n === "NF") {
      this.setNF(Math.trunc(this.num(v)));
      return;
    }
    this.globals.set(n, v);
  }
  arr(n: string): AwkArray {
    const fr = this.frames[this.frames.length - 1];
    if (fr && fr.has(n)) {
      let a = fr.get(n);
      if (a === undefined) {
        a = new Map();
        fr.set(n, a);
      }
      if (!(a instanceof Map))
        throw new AwkError(`can't use scalar ${n} as array`);
      return a;
    }
    let a = this.arrays.get(n);
    if (!a) {
      a = new Map();
      this.arrays.set(n, a);
    }
    return a;
  }
  key(s: Expr[]): string {
    return s
      .map((e) => this.str(this.eval(e)))
      .join(this.str(this.globals.get("SUBSEP")));
  }
  assignTo(l: Expr, v: Val): void {
    if (l.t === "var") this.setVar(l.n, v);
    else if (l.t === "idx") this.arr(l.n).set(this.key(l.s), v);
    else if (l.t === "field") {
      const n = Math.trunc(this.num(this.eval(l.e)));
      this.setField(n, this.str(v));
    }
  }

  /* ----- expressions ----- */
  eval(e: Expr): Val {
    switch (e.t) {
      case "num":
        return e.v;
      case "str":
        return e.v;
      case "re": {
        this.splitFields();
        return this.re(e.v).test(this.rec) ? 1 : 0;
      }
      case "var":
        return this.getVar(e.n);
      case "idx": {
        const a = this.arr(e.n);
        const k = this.key(e.s);
        if (!a.has(k)) a.set(k, undefined);
        return a.get(k);
      }
      case "field":
        return this.getField(Math.trunc(this.num(this.eval(e.e))));
      case "group":
        return this.eval(e.e[e.e.length - 1]);
      case "assign": {
        let v: Val;
        if (e.op === "=") {
          v = this.eval(e.r);
        } else {
          const cur = this.num(this.eval(e.l));
          const r = this.num(this.eval(e.r));
          v = this.arith(e.op[0], cur, r);
        }
        this.assignTo(e.l, v);
        return v;
      }
      case "cond":
        return this.bool(this.eval(e.c)) ? this.eval(e.a) : this.eval(e.b);
      case "un": {
        const v = this.eval(e.a);
        if (e.op === "!") return this.bool(v) ? 0 : 1;
        return e.op === "-" ? -this.num(v) : this.num(v);
      }
      case "incr": {
        const old = this.num(this.eval(e.l));
        const nv = e.op === "++" ? old + 1 : old - 1;
        this.assignTo(e.l, nv);
        return e.pre ? nv : old;
      }
      case "in":
        return this.arr(e.n).has(this.key(e.s)) ? 1 : 0;
      case "bin":
        return this.binary(e);
      case "call":
        return this.callUser(e);
      case "bi":
        return this.builtin(e);
      case "getline":
        return this.getline(e);
    }
  }
  arith(op: string, a: number, b: number): number {
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        if (b === 0) throw new AwkError("division by zero");
        return a / b;
      case "%":
        if (b === 0) throw new AwkError("division by zero in %");
        return a % b;
      default:
        return Math.pow(a, b);
    }
  }
  binary(e: Extract<Expr, { t: "bin" }>): Val {
    switch (e.op) {
      case "grp":
        return this.eval(e.a);
      case "||":
        return this.bool(this.eval(e.a)) || this.bool(this.eval(e.b)) ? 1 : 0;
      case "&&":
        return this.bool(this.eval(e.a)) && this.bool(this.eval(e.b)) ? 1 : 0;
      case "cat":
        return this.str(this.eval(e.a)) + this.str(this.eval(e.b));
      case "~":
      case "!~": {
        const s = this.str(this.eval(e.a));
        const r = this.reOf(e.b).test(s);
        return (e.op === "~") === r ? 1 : 0;
      }
      case "<":
      case "<=":
      case "==":
      case "!=":
      case ">=":
      case ">": {
        const a = this.eval(e.a);
        const b = this.eval(e.b);
        let c: number;
        if (this.numeric(a) && this.numeric(b)) {
          const x = this.num(a);
          const y = this.num(b);
          c = x < y ? -1 : x > y ? 1 : 0;
        } else {
          const x = this.str(a);
          const y = this.str(b);
          c = x < y ? -1 : x > y ? 1 : 0;
        }
        const r =
          e.op === "<"
            ? c < 0
            : e.op === "<="
              ? c <= 0
              : e.op === "=="
                ? c === 0
                : e.op === "!="
                  ? c !== 0
                  : e.op === ">="
                    ? c >= 0
                    : c > 0;
        return r ? 1 : 0;
      }
      default:
        return this.arith(
          e.op,
          this.num(this.eval(e.a)),
          this.num(this.eval(e.b)),
        );
    }
  }
  callUser(e: Extract<Expr, { t: "call" }>): Val {
    const f = this.prog.funcs.get(e.n);
    if (!f) throw new AwkError(`function ${e.n} never defined`);
    if (e.a.length > f.params.length)
      throw new AwkError(`too many arguments in call to ${e.n}`);
    if (++this.depth > 200)
      throw new AwkError("function call nesting too deep");
    const fr: Frame = new Map();
    f.params.forEach((p, i) => {
      if (i < e.a.length) {
        const a = e.a[i];
        if (a.t === "var") {
          const cur = this.frames[this.frames.length - 1];
          const local = cur?.get(a.n);
          if (local instanceof Map) {
            fr.set(p, local);
            return;
          }
          if (!(cur && cur.has(a.n)) && this.arrays.has(a.n)) {
            fr.set(p, this.arrays.get(a.n) as AwkArray);
            return;
          }
        }
        fr.set(p, this.eval(a));
      } else fr.set(p, undefined);
    });
    this.frames.push(fr);
    try {
      this.exec(f.body);
    } catch (x) {
      if (x instanceof ReturnSig) return x.value;
      throw x;
    } finally {
      this.frames.pop();
      this.depth--;
    }
    return undefined;
  }
  builtin(e: Extract<Expr, { t: "bi" }>): Val {
    const a = e.a;
    const n = (i: number) => this.num(this.eval(a[i]));
    const s = (i: number) => this.str(this.eval(a[i]));
    switch (e.n) {
      case "length": {
        if (a.length === 0) {
          this.splitFields();
          return this.rec.length;
        }
        if (a[0].t === "var") {
          const fr = this.frames[this.frames.length - 1];
          const loc = fr?.get(a[0].n);
          if (loc instanceof Map) return loc.size;
          if (!(fr && fr.has(a[0].n)) && this.arrays.has(a[0].n))
            return (this.arrays.get(a[0].n) as AwkArray).size;
        }
        return s(0).length;
      }
      case "substr": {
        const str = s(0);
        let m = n(1);
        m = Math.round(m);
        let end: number;
        if (a.length > 2) {
          const l = Math.round(n(2));
          end = m + l;
        } else end = Infinity;
        const from = Math.max(m, 1);
        const to = Math.min(end, str.length + 1);
        return to > from ? str.slice(from - 1, to - 1) : "";
      }
      case "index":
        return s(0).indexOf(s(1)) + 1;
      case "split": {
        const str = s(0);
        if (a[1].t !== "var")
          throw new AwkError("split: second argument must be an array");
        const arr = this.arr(a[1].n);
        const fs = this.str(this.globals.get("FS"));
        let parts: string[];
        if (a.length > 2) {
          parts =
            a[2].t === "re"
              ? str === ""
                ? []
                : str.split(this.re(a[2].v))
              : this.splitStr(str, s(2));
        } else parts = this.splitStr(str, fs);
        arr.clear();
        parts.forEach((p, i) => arr.set(String(i + 1), mkStrnum(p)));
        return parts.length;
      }
      case "sub":
      case "gsub":
        return this.subst(e);
      case "match": {
        const str = s(0);
        const m = this.reOf(a[1]).exec(str);
        this.globals.set("RSTART", m ? m.index + 1 : 0);
        this.globals.set("RLENGTH", m ? m[0].length : -1);
        return m ? m.index + 1 : 0;
      }
      case "sprintf": {
        const vals = a.slice(1).map((x) => this.eval(x));
        return sprintf(
          s(0),
          vals,
          (v) => this.str(v),
          (v) => this.num(v),
        );
      }
      case "sin":
        return Math.sin(n(0));
      case "cos":
        return Math.cos(n(0));
      case "atan2":
        return Math.atan2(n(0), n(1));
      case "exp":
        return Math.exp(n(0));
      case "log":
        return Math.log(n(0));
      case "sqrt":
        return Math.sqrt(n(0));
      case "int":
        return Math.trunc(n(0));
      case "rand":
        return this.rand();
      case "srand": {
        const prev = this.seed;
        this.seed = a.length ? n(0) : Math.floor(clockNow() / 1000);
        this.srandInit();
        return prev;
      }
      case "tolower":
        return s(0).toLowerCase();
      case "toupper":
        return s(0).toUpperCase();
      case "close": {
        const k = s(0);
        this.flushOut(k);
        this.getFiles.delete(k);
        return 0;
      }
      case "fflush":
        return 0;
      case "system":
        throw new AwkError("system() is not available");
    }
    return undefined;
  }
  subst(e: Extract<Expr, { t: "bi" }>): Val {
    const a = e.a;
    const global = e.n === "gsub";
    const re = this.reOf(a[0]);
    const repl = this.str(this.eval(a[1]));
    const target: Expr = a[2] ?? { t: "field", e: { t: "num", v: 0 } };
    const src = this.str(this.eval(target));
    const g = new RegExp(re.source, re.flags + "g");
    let out = "";
    let last = 0;
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = g.exec(src))) {
      count++;
      out += src.slice(last, m.index);
      out += repl.replace(/\\\\|\\&|&/g, (x) =>
        x === "&" ? m![0] : x === "\\&" ? "&" : "\\",
      );
      last = m.index + m[0].length;
      if (m[0] === "") {
        if (m.index < src.length) out += src[m.index];
        last = m.index + 1;
        g.lastIndex = m.index + 1;
      }
      if (!global) break;
      if (g.lastIndex > src.length) break;
    }
    if (count === 0) return 0;
    out += src.slice(Math.min(last, src.length));
    if (target.t === "var" || target.t === "idx" || target.t === "field")
      this.assignTo(target, out);
    return count;
  }
  getline(e: Extract<Expr, { t: "getline" }>): Val {
    let line: string | null;
    if (e.file) {
      const name = this.str(this.eval(e.file));
      let f = this.getFiles.get(name);
      if (f === undefined) {
        const r =
          name === "-" ? { text: this.io.in.takeAll() } : this.readFile(name);
        f = r ? { text: r.text, pos: 0 } : null;
        this.getFiles.set(name, f);
      }
      if (!f) return -1;
      if (f.pos >= f.text.length) return 0;
      const k = f.text.indexOf("\n", f.pos);
      line = k < 0 ? f.text.slice(f.pos) : f.text.slice(f.pos, k);
      f.pos = k < 0 ? f.text.length : k + 1;
      if (e.l) this.assignTo(e.l, mkStrnum(line));
      else this.setRecord(line);
      return 1;
    }
    line = this.nextRecord();
    if (line === null) return 0;
    if (e.l) this.assignTo(e.l, mkStrnum(line));
    else this.setRecord(line);
    this.bump();
    return 1;
  }
  readFile(name: string): { text: string } | null {
    const n = get(this.sh.abs(name));
    return n && n.t === "f" ? { text: n.x } : null;
  }
  bump(): void {
    this.globals.set("NR", this.num(this.globals.get("NR")) + 1);
    this.globals.set("FNR", this.num(this.globals.get("FNR")) + 1);
  }

  /* ----- input ----- */
  openNext(): boolean {
    while (
      this.fileIdx < this.files.length ||
      (this.fileIdx === 0 && this.files.length === 0 && !this.stdinUsed)
    ) {
      let name = "-";
      if (this.files.length) {
        name = this.files[this.fileIdx++];
        const as = /^([A-Za-z_]\w*)=(.*)$/.exec(name);
        if (as) {
          this.setVar(as[1], mkStrnum(unescape(as[2])));
          continue;
        }
      } else this.stdinUsed = true;
      let text: string;
      if (name === "-") text = this.io.in.takeAll();
      else {
        const n = get(this.sh.abs(name));
        if (!n) {
          this.io.err.write(
            `awk: cannot open ${name} (No such file or directory)\n`,
          );
          this.exitCode = 2;
          continue;
        }
        if (n.t === "d") {
          this.io.err.write(`awk: read error (Is a directory)\n`);
          this.exitCode = 2;
          continue;
        }
        if (n.m[0] !== "r") {
          this.io.err.write(`awk: cannot open ${name} (Permission denied)\n`);
          this.exitCode = 2;
          continue;
        }
        text = n.x;
      }
      const rs = this.str(this.globals.get("RS"));
      let lines: string[];
      if (rs === "\n")
        lines =
          text === ""
            ? []
            : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
      else if (rs === "")
        lines = text
          .replace(/^\n+|\n+$/g, "")
          .split(/\n\n+/)
          .filter((x) => x !== "");
      else if (rs.length === 1) {
        lines = text.split(rs);
        if (lines[lines.length - 1] === "" || lines[lines.length - 1] === "\n")
          lines.pop();
      } else
        lines = text
          .split(this.re(rs))
          .filter((x, i, a) => !(x === "" && i === a.length - 1));
      this.cur = { lines, pos: 0, text };
      this.globals.set("FILENAME", name === "-" ? "" : name);
      this.globals.set("FNR", 0);
      return true;
    }
    return false;
  }
  nextRecord(): string | null {
    for (;;) {
      if (!this.cur && !this.openNext()) return null;
      const c = this.cur as { lines: string[]; pos: number };
      if (c.pos < c.lines.length) return c.lines[c.pos++];
      this.cur = null;
    }
  }

  /* ----- statements ----- */
  out(dest: { op: string; e: Expr } | null, text: string): void {
    if (!dest) {
      this.io.out.write(text);
      return;
    }
    const name = this.str(this.eval(dest.e));
    if (dest.op !== "|" && name === "/dev/stdout") this.io.out.write(text);
    else if (dest.op !== "|" && name === "/dev/stderr") this.io.err.write(text);
    else {
      const key = (dest.op === "|" ? "|" : "") + name;
      let f = this.outFiles.get(key);
      if (!f) {
        f = { text: "", append: dest.op === ">>", pipe: dest.op === "|" };
        this.outFiles.set(key, f);
      }
      f.text += text;
    }
  }
  flushOut(name: string): void {
    for (const key of [name, "|" + name]) {
      const f = this.outFiles.get(key);
      if (!f) continue;
      this.outFiles.delete(key);
      if (f.pipe) {
        const argv = name.trim().split(/\s+/);
        if (!this.sh.lookup(argv[0])) {
          this.io.err.write(`sh: 1: ${argv[0]}: not found\n`);
          continue;
        }
        const child: IO = {
          in: new Input(f.text),
          out: this.io.out,
          err: this.io.err,
        };
        void child;
        this.steps.push({ k: "pipe", argv, text: f.text });
      } else {
        const err = writeText(this.sh.abs(name), f.text, f.append);
        if (err) this.io.err.write(`awk: cannot open "${name}" for output\n`);
      }
    }
  }
  flushAll(): void {
    for (const k of [...this.outFiles.keys()])
      this.flushOut(k.startsWith("|") ? k.slice(1) : k);
  }
  exec(s: Stmt): void {
    this.budget.tick();
    switch (s.t) {
      case "expr":
        this.eval(s.e);
        return;
      case "print": {
        let text: string;
        if (s.f) {
          const vals = s.a.map((x) => this.eval(x));
          text = sprintf(
            this.str(vals[0]),
            vals.slice(1),
            (v) => this.str(v),
            (v) => this.num(v),
          );
        } else if (s.a.length === 0) {
          text = this.rec + this.str(this.globals.get("ORS"));
        } else {
          const ofs = this.str(this.globals.get("OFS"));
          text =
            s.a.map((x) => this.str(this.eval(x), "OFMT")).join(ofs) +
            this.str(this.globals.get("ORS"));
        }
        this.out(s.dest, text);
        return;
      }
      case "if":
        if (this.bool(this.eval(s.c))) this.exec(s.a);
        else if (s.b) this.exec(s.b);
        return;
      case "while":
        while (this.bool(this.eval(s.c))) {
          try {
            this.exec(s.b);
          } catch (x) {
            if (x instanceof BreakSig) break;
            if (!(x instanceof ContinueSig)) throw x;
          }
        }
        return;
      case "do":
        do {
          try {
            this.exec(s.b);
          } catch (x) {
            if (x instanceof BreakSig) break;
            if (!(x instanceof ContinueSig)) throw x;
          }
        } while (this.bool(this.eval(s.c)));
        return;
      case "for":
        if (s.i) this.exec(s.i);
        while (!s.c || this.bool(this.eval(s.c))) {
          try {
            this.exec(s.b);
          } catch (x) {
            if (x instanceof BreakSig) break;
            if (!(x instanceof ContinueSig)) throw x;
          }
          if (s.s) this.exec(s.s);
        }
        return;
      case "forin": {
        const keys = [...this.arr(s.n).keys()];
        for (const k of keys) {
          if (!this.arr(s.n).has(k)) continue;
          this.assignTo(s.v, mkStrnum(k));
          try {
            this.exec(s.b);
          } catch (x) {
            if (x instanceof BreakSig) break;
            if (!(x instanceof ContinueSig)) throw x;
          }
        }
        return;
      }
      case "block":
        for (const x of s.b) this.exec(x);
        return;
      case "simple":
        if (s.k === "break") throw new BreakSig();
        if (s.k === "continue") throw new ContinueSig();
        throw new NextSig(s.k === "nextfile");
      case "exit":
        throw new ExitSig(s.e ? Math.trunc(this.num(this.eval(s.e))) : null);
      case "return":
        throw new ReturnSig(s.e ? this.eval(s.e) : undefined);
      case "delete":
        if (s.s) this.arr(s.n).delete(this.key(s.s));
        else this.arr(s.n).clear();
        return;
    }
  }

  run(): number {
    const p = this.prog;
    const begins = p.rules.filter((r) => r.kind === "begin");
    const ends = p.rules.filter((r) => r.kind === "end");
    const mains = p.rules.filter((r) => r.kind === "main");
    let exited = false;
    const guard = (f: () => void): void => {
      try {
        f();
      } catch (x) {
        if (x instanceof ExitSig) {
          if (x.code !== null) this.exitCode = x.code;
          exited = true;
        } else if (
          x instanceof NextSig ||
          x instanceof BreakSig ||
          x instanceof ContinueSig
        ) {
          /* outside its place: ignore */
        } else throw x;
      }
    };
    for (const b of begins) {
      guard(() => this.exec(b.body as Stmt));
      if (exited) break;
    }
    if (!exited && (mains.length || ends.length)) {
      guard(() => {
        for (;;) {
          const line = this.nextRecord();
          if (line === null) break;
          this.setRecord(line);
          this.bump();
          try {
            for (const r of mains) {
              let hit: boolean;
              if (!r.p1) hit = true;
              else if (!r.p2) hit = this.bool(this.eval(r.p1));
              else if (r.on) {
                hit = true;
                if (this.bool(this.eval(r.p2))) r.on = false;
              } else if (this.bool(this.eval(r.p1))) {
                hit = true;
                r.on = !this.bool(this.eval(r.p2));
              } else hit = false;
              if (!hit) continue;
              if (r.body) this.exec(r.body);
              else
                this.io.out.write(this.rec + this.str(this.globals.get("ORS")));
            }
          } catch (x) {
            if (x instanceof NextSig) {
              if (x.file) this.cur = null;
              continue;
            }
            throw x;
          }
        }
      });
    }
    // END runs after exit in BEGIN or in a main rule, but not after exit in END.
    for (const en of ends) {
      let stop = false;
      try {
        this.exec(en.body as Stmt);
      } catch (x) {
        if (x instanceof ExitSig) {
          if (x.code !== null) this.exitCode = x.code;
          stop = true;
        } else if (!(x instanceof NextSig)) throw x;
      }
      if (stop) break;
    }
    this.flushAll();
    return this.exitCode;
  }
}

/** B19: writes the recorded steps in order; a pipe step runs its command. */
async function replay(steps: AwkStep[], sh: Proc, io: IO): Promise<void> {
  for (const st of steps) {
    if (st.k === "out") io.out.write(st.text);
    else if (st.k === "err") io.err.write(st.text);
    else
      await sh.runCommand(
        st.argv,
        { in: new Input(st.text), out: io.out, err: io.err },
        {},
      );
  }
}

const awk: CmdFn = async (argv, sh, io) => {
  let fs: string | null = null;
  const assigns: [string, string][] = [];
  const progFiles: string[] = [];
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--version" || a === "-W") {
      io.out.write("awk version 20240728 (simulated)\n");
      return 0;
    }
    if (a.startsWith("-F")) fs = a.length > 2 ? a.slice(2) : (argv[++i] ?? "");
    else if (a.startsWith("-v")) {
      const v = a.length > 2 ? a.slice(2) : (argv[++i] ?? "");
      const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(v);
      if (!m) {
        io.err.write(`awk: improper assignment: -v ${v}\n`);
        return 2;
      }
      assigns.push([m[1], m[2]]);
    } else if (a.startsWith("-f"))
      progFiles.push(a.length > 2 ? a.slice(2) : (argv[++i] ?? ""));
    else if (a.startsWith("-") && a.length > 1) {
      io.err.write(`awk: not an option: ${a}\n`);
      return 2;
    } else break;
  }
  let src: string;
  if (progFiles.length) {
    const parts: string[] = [];
    for (const f of progFiles) {
      const t =
        f === "-"
          ? await io.in.readAll(sh)
          : await readOperand("awk", f, sh, io);
      if (t === null) return 2;
      parts.push(t);
    }
    src = parts.join("\n");
  } else {
    if (i >= argv.length) {
      io.err.write(
        "usage: awk [-F value] [-v var=value] [--version] [-f program-file | 'program text'] [file ...]\n",
      );
      return 2;
    }
    src = argv[i++];
  }
  const parser = new Parser([]);
  try {
    const p = new Parser(lex(src));
    p.program();
    parser.funcs = p.funcs;
    parser.rules = p.rules;
  } catch (e) {
    if (e instanceof AwkError) {
      io.err.write(
        `awk: ${e.message.startsWith("line") ? e.message : "line 1: " + e.message}\n`,
      );
      return 2;
    }
    throw e;
  }
  const files = argv.slice(i);
  // The core is synchronous (B19, B26): it gets the whole of stdin before it runs.
  const needsRecords = parser.rules.some(
    (r) => r.kind === "main" || r.kind === "end",
  );
  const readsStdin =
    (needsRecords && (files.length === 0 || files.includes("-"))) ||
    (/getline/.test(src) && src.includes('"-"'));
  const stdinText = readsStdin ? await io.in.readAll(sh) : "";
  const steps: AwkStep[] = [];
  const rio: IO = {
    in: new Input(stdinText),
    out: new StepWriter(steps, "out"),
    err: new StepWriter(steps, "err"),
  };
  const rt = new Runtime(parser, sh, rio);
  rt.steps = steps;
  rt.files = files;
  if (fs !== null) {
    rt.globals.set("FS", fs === "t" ? "\t" : unescape(fs));
  }
  for (const [k, v] of assigns) rt.globals.set(k, mkStrnum(unescape(v)));
  let code = 0;
  let thrown: unknown = null;
  try {
    code = rt.run();
  } catch (e) {
    if (e instanceof AwkError) {
      rt.flushAll();
      rio.err.write(`awk: run time error: ${e.message}\n`);
      code = 2;
    } else thrown = e;
  }
  // The visible order is the order of the steps (B19). A limit that the
  // replay hits (10 000 lines) comes before an error of the program.
  await replay(steps, sh, io);
  if (thrown !== null) throw thrown;
  return code;
};

export const AWK_CMDS: Record<string, CmdFn> = { awk };

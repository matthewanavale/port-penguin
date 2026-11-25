// AC3, D13-D16: the shell builtins. Each one is `(sh, argv, io) => code`; the
// interpreter has already expanded the words and applied the redirects.
// Error lines go through `sh.fail`, which adds the `bash:` or script prefix.
import { get } from "../paths";
import { ExpError } from "./expand";
import type { Context } from "./context";
import { ExitSig, BreakSig, ContinueSig, ReturnSig, AbortLine } from "./interp";
import type { Interp } from "./interp";
import type { CmdFn, IO } from "./io";
import { LIM, NestStop } from "./limits";
import { parseFull } from "./parser";
import { readText } from "./redirect";

type Builtin = (sh: Interp, argv: string[], io: IO) => number;

export const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "time",
  "{",
  "}",
  "!",
  "[[",
  "]]",
  "coproc",
]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const out = (io: IO, s: string) => io.out.write(s);

/* ---------- echo and printf ---------- */

/** Reads the backslash escapes of `echo -e` and `printf %b`. Returns the text and whether `\c` stopped it. */
function escapes(
  s: string,
  octalNeedsZero: boolean,
): { text: string; stop: boolean } {
  let r = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i === s.length - 1) {
      r += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case "a":
        r += "\x07";
        break;
      case "b":
        r += "\b";
        break;
      case "c":
        return { text: r, stop: true };
      case "e":
      case "E":
        r += "\x1b";
        break;
      case "f":
        r += "\f";
        break;
      case "n":
        r += "\n";
        break;
      case "r":
        r += "\r";
        break;
      case "t":
        r += "\t";
        break;
      case "v":
        r += "\v";
        break;
      case "\\":
        r += "\\";
        break;
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) {
          r += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else r += "\\x";
        break;
      }
      case "u":
      case "U": {
        const m = (n === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(
          s.slice(i + 1),
        );
        if (m) {
          r += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else r += "\\" + n;
        break;
      }
      case "0": {
        const m = /^[0-7]{0,3}/.exec(s.slice(i + 1)) as RegExpExecArray;
        r += String.fromCharCode(m[0] === "" ? 0 : parseInt(m[0], 8) & 255);
        i += m[0].length;
        break;
      }
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
        if (octalNeedsZero) {
          r += "\\" + n;
          break;
        }
        {
          const m = /^[0-7]{1,3}/.exec(s.slice(i)) as RegExpExecArray;
          r += String.fromCharCode(parseInt(m[0], 8) & 255);
          i += m[0].length - 1;
        }
        break;
      default:
        r += "\\" + n;
    }
  }
  return { text: r, stop: false };
}

const echo: Builtin = (sh, argv, io) => {
  let nl = true;
  let esc = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!/^-[neE]+$/.test(a)) break;
    for (const ch of a.slice(1)) {
      if (ch === "n") nl = false;
      else if (ch === "e") esc = true;
      else esc = false;
    }
  }
  let text = argv.slice(i).join(" ");
  if (esc) {
    const r = escapes(text, true);
    text = r.text;
    if (r.stop) nl = false;
  }
  out(io, text + (nl ? "\n" : ""));
  void sh;
  return 0;
};

function fmtExp(v: number, prec: number, upper: boolean): string {
  let s = v.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, "e$10$2");
  return upper ? s.toUpperCase() : s;
}

/* eslint-disable no-control-regex */
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return (
      "$'" +
      s.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, (c) => {
        const m: Record<string, string> = {
          "\n": "\\n",
          "\t": "\\t",
          "\r": "\\r",
        };
        return m[c] ?? "\\" + c.charCodeAt(0).toString(8).padStart(3, "0");
      }) +
      "'"
    );
  }
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
}

function numArg(
  sh: Interp,
  name: string,
  a: string | undefined,
  bad: { v: boolean },
): number {
  if (a === undefined || a === "") return 0;
  if (/^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(a))
    return Number(BigInt(a.replace(/^\+/, "")));
  if (/^[+-]?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?$/.test(a)) return Number(a);
  if (/^['"].$/.test(a)) return a.charCodeAt(1);
  sh.fail(`${name}: ${a}: invalid number`);
  bad.v = true;
  return 0;
}

/** The text that a printf format makes from its arguments; `used` says how many it took. */
function formatOnce(
  sh: Interp,
  fmt: string,
  args: string[],
  bad: { v: boolean },
): { text: string; used: number; stop: boolean } {
  let r = "";
  let used = 0;
  const next = (): string | undefined =>
    used < args.length ? args[used++] : undefined;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "\\") {
      // one escape, with printf's octal form (\NNN)
      let j = i + 1;
      let seq = "\\";
      if (/[0-7]/.test(fmt[j] ?? "")) {
        let k = 0;
        while (k < 3 && /[0-7]/.test(fmt[j] ?? "")) {
          seq += fmt[j++];
          k++;
        }
        r += String.fromCharCode(parseInt(seq.slice(1), 8) & 255);
        i = j - 1;
        continue;
      }
      const e = escapes("\\" + (fmt[i + 1] ?? "\\"), false);
      r += e.text;
      if (fmt[i + 1] === "x" || fmt[i + 1] === "u" || fmt[i + 1] === "U") {
        const m = /^[0-9a-fA-F]+/.exec(fmt.slice(i + 2));
        if (m) {
          const e2 = escapes(
            fmt.slice(
              i,
              i +
                2 +
                Math.min(
                  m[0].length,
                  fmt[i + 1] === "x" ? 2 : fmt[i + 1] === "u" ? 4 : 8,
                ),
            ),
            false,
          );
          r = r.slice(0, r.length - e.text.length) + e2.text;
          i += Math.min(
            m[0].length,
            fmt[i + 1] === "x" ? 2 : fmt[i + 1] === "u" ? 4 : 8,
          );
        }
      }
      i++;
      continue;
    }
    if (c !== "%") {
      r += c;
      continue;
    }
    const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+)?)?([a-zA-Z%])/.exec(
      fmt.slice(i),
    );
    if (!m) {
      r += c;
      continue;
    }
    i += m[0].length - 1;
    const flags = m[1];
    let width = m[2] === "*" ? Number(next() ?? 0) : m[2] ? Number(m[2]) : 0;
    const hasPrec = m[0].includes(".");
    let prec = m[3] === "*" ? Number(next() ?? 0) : m[3] ? Number(m[3]) : 0;
    let left = flags.includes("-");
    if (width < 0) {
      left = true;
      width = -width;
    }
    const conv = m[4];
    if (conv === "%") {
      r += "%";
      continue;
    }
    let body: string;
    const pad = (s: string, zero: boolean): string => {
      if (s.length >= width) return s;
      if (left) return s + " ".repeat(width - s.length);
      if (zero && flags.includes("0")) {
        const sign = /^[+-]/.test(s) ? s[0] : "";
        return sign + "0".repeat(width - s.length) + s.slice(sign.length);
      }
      return " ".repeat(width - s.length) + s;
    };
    switch (conv) {
      case "d":
      case "i":
      case "u": {
        const n = Math.trunc(numArg(sh, "printf", next(), bad));
        let s = String(Math.abs(n));
        if (hasPrec) s = s.padStart(prec, "0");
        s =
          (n < 0
            ? "-"
            : flags.includes("+")
              ? "+"
              : flags.includes(" ")
                ? " "
                : "") + s;
        body = pad(s, !hasPrec);
        break;
      }
      case "o":
      case "x":
      case "X": {
        const n = Math.trunc(numArg(sh, "printf", next(), bad));
        const v = n < 0 ? BigInt.asUintN(64, BigInt(n)) : BigInt(n);
        let s = v.toString(conv === "o" ? 8 : 16);
        if (conv === "X") s = s.toUpperCase();
        if (hasPrec) s = s.padStart(prec, "0");
        if (flags.includes("#") && v !== 0n)
          s = (conv === "o" ? "0" : conv === "x" ? "0x" : "0X") + s;
        body = pad(s, !hasPrec);
        break;
      }
      case "e":
      case "E":
      case "f":
      case "F":
      case "g":
      case "G": {
        const n = numArg(sh, "printf", next(), bad);
        if (!hasPrec) prec = 6;
        let s: string;
        if (conv === "f" || conv === "F") s = Math.abs(n).toFixed(prec);
        else if (conv === "e" || conv === "E")
          s = fmtExp(Math.abs(n), prec, conv === "E");
        else {
          const p = prec === 0 ? 1 : prec;
          const exp = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)));
          if (exp < -4 || exp >= p) {
            s = fmtExp(Math.abs(n), p - 1, conv === "G");
            s = s.replace(/\.?0+e/i, (x) =>
              x.slice(-1) === "e" || x.slice(-1) === "E" ? x.slice(-1) : x,
            );
            s = s.replace(/(\.\d*?)0+(e)/i, "$1$2").replace(/\.(e)/i, "$1");
          } else {
            s = Math.abs(n).toFixed(Math.max(0, p - 1 - exp));
            if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
          }
        }
        s =
          (n < 0 || Object.is(n, -0)
            ? "-"
            : flags.includes("+")
              ? "+"
              : flags.includes(" ")
                ? " "
                : "") + s;
        body = pad(s, true);
        break;
      }
      case "c": {
        const a = next() ?? "";
        body = pad([...a][0] ?? "", false);
        break;
      }
      case "s": {
        let a = next() ?? "";
        if (hasPrec) a = a.slice(0, prec);
        body = pad(a, false);
        break;
      }
      case "b": {
        const e = escapes(next() ?? "", false);
        body = pad(e.text, false);
        r += body;
        if (e.stop) return { text: r, used, stop: true };
        continue;
      }
      case "q":
        body = pad(shellQuote(next() ?? ""), false);
        break;
      default:
        sh.fail(`printf: \`${conv}': invalid format character`);
        bad.v = true;
        return { text: r, used, stop: true };
    }
    r += body;
  }
  return { text: r, used, stop: false };
}

const printf: Builtin = (sh, argv, io) => {
  let i = 1;
  let into: string | null = null;
  if (argv[i] === "-v") {
    into = argv[i + 1] ?? "";
    i += 2;
  } else if (argv[i] === "--") i++;
  if (i >= argv.length) {
    sh.fail("printf: usage: printf [-v var] format [arguments]");
    return 2;
  }
  const fmt = argv[i++];
  const args = argv.slice(i);
  const bad = { v: false };
  let text = "";
  let guard = 0;
  let rest = args;
  for (;;) {
    const r = formatOnce(sh, fmt, rest, bad);
    text += r.text;
    if (r.stop) break;
    rest = rest.slice(r.used);
    if (!rest.length || r.used === 0 || ++guard > 100000) break;
  }
  if (into !== null) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(into);
    if (!m) {
      sh.fail(`printf: \`${into}': not a valid identifier`);
      return 2;
    }
    const err =
      m[2] !== undefined
        ? sh.ctx.setElem(m[1], m[2], text)
        : sh.ctx.set(m[1], text);
    if (err) {
      sh.fail(err);
      return 1;
    }
  } else out(io, text);
  return bad.v ? 1 : 0;
};

/* ---------- test and [ ---------- */

export function unaryTest(sh: Interp, flag: string, a: string): boolean {
  if (flag === "-nt" || flag === "-ot" || flag === "-ef") {
    const [l, r] = a.split("\0");
    const x = get(sh.abs(l));
    const y = get(sh.abs(r));
    const t = (n: typeof x) =>
      n ? ((n as { mtime?: number }).mtime ?? 0) : -1;
    if (flag === "-ef") return !!x && !!y && sh.abs(l) === sh.abs(r);
    if (flag === "-nt") return !!x && (t(x) > t(y) || !y);
    return !!y && (t(y) > t(x) || !x);
  }
  switch (flag) {
    case "-z":
      return a === "";
    case "-n":
      return a !== "";
    case "-v":
      return sh.ctx.isSet(a);
    case "-t":
    case "-L":
    case "-h":
    case "-b":
    case "-c":
    case "-p":
    case "-S":
      return false;
    case "-o":
      return !!sh.ctx.options[a];
  }
  if (a === "") return false;
  const n = get(sh.abs(a));
  if (!n) return false;
  switch (flag) {
    case "-e":
    case "-a":
      return true;
    case "-f":
      return n.t === "f";
    case "-d":
      return n.t === "d";
    case "-s":
      return n.t === "d" ? true : n.x.length > 0 || (n.sz ?? 0) > 0;
    case "-r":
      return n.m[0] === "r";
    case "-w":
      return n.m[1] === "w";
    case "-x":
      return n.m[2] === "x";
    case "-O":
    case "-G":
      return true;
  }
  return false;
}

export function intCompare(
  sh: Interp,
  cmp: string,
  l: string,
  r: string,
): boolean {
  const a = BigInt(sh.ex.arith(l));
  const b = BigInt(sh.ex.arith(r));
  switch (cmp) {
    case "-eq":
      return a === b;
    case "-ne":
      return a !== b;
    case "-lt":
      return a < b;
    case "-le":
      return a <= b;
    case "-gt":
      return a > b;
    default:
      return a >= b;
  }
}

const UNARY = new Set(
  "-e -a -f -d -r -w -x -s -z -n -L -h -b -c -p -S -t -v -o -O -G".split(" "),
);
const BINARY = new Set([
  "=",
  "==",
  "!=",
  "<",
  ">",
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

class TestError extends Error {}

function evalTest(sh: Interp, name: string, args: string[]): boolean {
  let p = 0;
  const fail = (m: string): never => {
    sh.fail(`${name}: ${m}`);
    throw new TestError(m);
  };
  const orExpr = (): boolean => {
    let v = andExpr();
    while (args[p] === "-o") {
      p++;
      const r = andExpr();
      v = v || r;
    }
    return v;
  };
  const andExpr = (): boolean => {
    let v = notExpr();
    while (args[p] === "-a") {
      p++;
      const r = notExpr();
      v = v && r;
    }
    return v;
  };
  const notExpr = (): boolean => {
    if (args[p] === "!" && p + 1 < args.length) {
      p++;
      return !notExpr();
    }
    return primary();
  };
  const primary = (): boolean => {
    const t = args[p];
    if (t === undefined) return fail("argument expected");
    if (t === "(" && p + 1 < args.length) {
      p++;
      const v = orExpr();
      if (args[p] !== ")") return fail("`)' expected");
      p++;
      return v;
    }
    const nx = args[p + 1];
    if (nx !== undefined && BINARY.has(nx) && args[p + 2] !== undefined) {
      const l = t;
      const r = args[p + 2];
      p += 3;
      switch (nx) {
        case "=":
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case "<":
          return l < r;
        case ">":
          return l > r;
        case "-nt":
        case "-ot":
        case "-ef":
          return unaryTest(sh, nx, l + "\0" + r);
        default: {
          for (const x of [l, r])
            if (!/^\s*[+-]?[0-9]+\s*$/.test(x))
              return fail(`${x}: integer expression expected`);
          return intCompare(sh, nx, l, r);
        }
      }
    }
    if (
      UNARY.has(t) &&
      nx !== undefined &&
      (args[p + 2] === undefined || !BINARY.has(args[p + 2]) || true)
    ) {
      // `-n` alone is a string; with an operand it is a test.
      if (
        args.length - p >= 2 &&
        !(BINARY.has(nx) && args[p + 2] !== undefined)
      ) {
        p += 2;
        return unaryTest(sh, t, nx);
      }
    }
    p++;
    return t !== "";
  };
  if (args.length === 0) return false;
  const v = orExpr();
  if (p < args.length) return fail("too many arguments");
  return v;
}

const testCmd: Builtin = (sh, argv) => {
  try {
    return evalTest(sh, "test", argv.slice(1)) ? 0 : 1;
  } catch (e) {
    if (e instanceof TestError) return 2;
    throw e;
  }
};

const bracket: Builtin = (sh, argv) => {
  if (argv[argv.length - 1] !== "]") {
    sh.fail("[: missing `]'");
    return 2;
  }
  try {
    return evalTest(sh, "[", argv.slice(1, -1)) ? 0 : 1;
  } catch (e) {
    if (e instanceof TestError) return 2;
    throw e;
  }
};

/* ---------- directories ---------- */

const cd: Builtin = (sh, argv, io) => {
  const ctx = sh.ctx;
  let args = argv.slice(1);
  while (
    args[0] === "-L" ||
    args[0] === "-P" ||
    args[0] === "-e" ||
    args[0] === "-@"
  )
    args = args.slice(1);
  if (args[0] === "--") args = args.slice(1);
  if (args.length > 1) {
    sh.fail("cd: too many arguments");
    return 1;
  }
  let target = args[0];
  let show = false;
  if (target === undefined) {
    const h = ctx.get("HOME");
    if (h === undefined || h === "") {
      sh.fail("cd: HOME not set");
      return 1;
    }
    target = h;
  } else if (target === "-") {
    const o = ctx.get("OLDPWD");
    if (o === undefined) {
      sh.fail("cd: OLDPWD not set");
      return 1;
    }
    target = o;
    show = true;
  }
  if (target === "") return 0;
  const abs = sh.abs(target);
  const n = get(abs);
  if (!n) {
    sh.fail(`cd: ${target}: No such file or directory`);
    return 1;
  }
  if (n.t !== "d") {
    sh.fail(`cd: ${target}: Not a directory`);
    return 1;
  }
  ctx.oldpwd = ctx.cwd;
  ctx.cwd = abs;
  if (ctx.env.PWD !== undefined) ctx.env.PWD = abs;
  if (ctx.env.OLDPWD !== undefined) ctx.env.OLDPWD = ctx.oldpwd;
  if (show) out(io, abs + "\n");
  return 0;
};

const pwd: Builtin = (sh, argv, io) => {
  for (const a of argv.slice(1)) {
    if (a === "--") break;
    if (!/^-[LP]+$/.test(a)) {
      sh.fail(`pwd: ${a}: invalid option`);
      io.err.write("pwd: usage: pwd [-LP]\n");
      return 2;
    }
  }
  out(io, sh.ctx.cwd + "\n");
  return 0;
};

/* ---------- variables ---------- */

const dq = (v: string) => '"' + v.replace(/[\\"$`]/g, "\\$&") + '"';

const FLAG_ORDER = "aAfilnrtux";

function declLine(
  ctx: Context,
  name: string,
  forceExport = false,
): string | null {
  const m = ctx.vars[name];
  const exp = ctx.exported.has(name) || forceExport;
  let flags = "";
  const attrs = m?.attrs ?? "";
  const kind = m?.type === "array" ? "a" : m?.type === "assoc" ? "A" : "";
  const all = kind + attrs + (exp ? "x" : "");
  for (const f of FLAG_ORDER) if (all.includes(f)) flags += f;
  const fl = flags ? "-" + flags : "--";
  if (m && m.type === "array") {
    const a = m.value as (string | undefined)[];
    const parts: string[] = [];
    a.forEach((v, i) => {
      if (v !== undefined) parts.push(`[${i}]=${dq(v)}`);
    });
    return `declare ${fl} ${name}=(${parts.join(" ")})`.replace(
      "=()",
      a.length ? "=()" : "",
    );
  }
  if (m && m.type === "assoc") {
    const o = m.value as Record<string, string>;
    const parts = Object.keys(o).map((k) => `[${k}]=${dq(o[k])}`);
    return parts.length
      ? `declare ${fl} ${name}=(${parts.join(" ")} )`
      : `declare ${fl} ${name}`;
  }
  const v = ctx.get(name);
  if (v === undefined) {
    if (!(m || exp || ctx.exported.has(name))) return null;
    return `declare ${fl} ${name}`;
  }
  return `declare ${fl} ${name}=${dq(v)}`;
}

function allNames(ctx: Context): string[] {
  const s = new Set<string>([
    ...Object.keys(ctx.env),
    ...Object.keys(ctx.vars),
    ...ctx.exported,
  ]);
  return [...s].sort();
}

function declare(
  sh: Interp,
  argv: string[],
  io: IO,
  mode: "declare" | "local" | "export" | "readonly",
): number {
  const ctx = sh.ctx;
  const cmd = argv[0];
  let i = 1;
  const on = new Set<string>();
  const off = new Set<string>();
  let print = false;
  let fn = false;
  let fnNames = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!/^[-+][a-zA-Z]+$/.test(a)) break;
    const set = a[0] === "-" ? on : off;
    for (const ch of a.slice(1)) {
      if ("aAilrxu".includes(ch)) set.add(ch);
      else if (ch === "p") print = true;
      else if (ch === "f") fn = true;
      else if (ch === "F") fnNames = true;
      else if (ch === "n" && mode === "export") off.add("x");
      else if (ch === "g" || ch === "t" || ch === "n") continue;
      else {
        sh.fail(`${cmd}: ${a}: invalid option`);
        return 2;
      }
    }
  }
  if (mode === "export" && argv.slice(1).includes("-n")) {
    on.delete("x");
    off.add("x");
  }
  const names = argv.slice(i);
  if (mode === "local" && !ctx.frames.length) {
    sh.fail("local: can only be used in a function");
    return 1;
  }
  if (fn || fnNames) {
    let code = 0;
    const list = names.length ? names : Object.keys(ctx.functions).sort();
    for (const n of list) {
      const src = ctx.functions[n];
      if (src === undefined) {
        if (names.length) code = 1;
        continue;
      }
      out(
        io,
        fnNames ? `declare -f ${n}\n` : src.endsWith("\n") ? src : src + "\n",
      );
    }
    return code;
  }
  if (!names.length || print) {
    if (mode === "local" && !print) return 0;
    let code = 0;
    const list = names.length ? names : allNames(ctx);
    for (const n of list) {
      if (!names.length) {
        const has = ctx.vars[n]?.attrs ?? "";
        if (mode === "export" && !ctx.exported.has(n)) continue;
        if (mode === "readonly" && !has.includes("r")) continue;
        if (mode === "declare" && on.size) {
          let ok = true;
          for (const f of on) {
            const kind = ctx.vars[n]?.type;
            const hit =
              f === "x"
                ? ctx.exported.has(n)
                : f === "a"
                  ? kind === "array"
                  : f === "A"
                    ? kind === "assoc"
                    : has.includes(f);
            if (!hit) ok = false;
          }
          if (!ok) continue;
        }
      }
      const l = declLine(ctx, n);
      if (l === null) {
        sh.fail(`${cmd}: ${n}: not found`);
        code = 1;
      } else out(io, l + "\n");
    }
    return code;
  }
  let code = 0;
  names.forEach((arg, k) => {
    const idx = i + k;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)(=(.*))?$/s.exec(arg);
    if (!m || (m[2] && !m[4])) {
      sh.fail(`${cmd}: \`${arg}': not a valid identifier`);
      code = 1;
      return;
    }
    const name = m[1];
    const arr = sh.arrArgs.get(idx);
    if (mode === "local") ctx.declareLocal(name);
    if (on.has("A")) ctx.declareKind(name, "assoc");
    else if (on.has("a") || arr) ctx.declareKind(name, "array");
    for (const f of "ilu") if (on.has(f)) ctx.addAttr(name, f);
    for (const f of "ilu") if (off.has(f)) ctx.removeAttr(name, f);
    if (arr) {
      const kind = ctx.array(name)?.type === "assoc" ? "assoc" : "array";
      const err = ctx.setArray(name, arr.items, kind, m[3] === "+");
      if (err) {
        sh.fail(err);
        code = 1;
        return;
      }
    } else if (m[4] !== undefined) {
      let v = m[5] ?? "";
      if (ctx.attrs(name).includes("i")) v = sh.ex.arith(v);
      const err = m[2]
        ? ctx.setElem(name, m[2].slice(1, -1), v, m[3] === "+")
        : ctx.set(name, v, m[3] === "+");
      if (err) {
        sh.fail(err);
        code = 1;
        return;
      }
    }
    if (on.has("x") || mode === "export") {
      if (!off.has("x")) ctx.exported.add(name);
    }
    if (off.has("x")) ctx.exported.delete(name);
    if (on.has("r") || mode === "readonly") ctx.addAttr(name, "r");
  });
  return code;
}

const unset: Builtin = (sh, argv) => {
  const ctx = sh.ctx;
  let fn = false;
  let code = 0;
  for (const a of argv.slice(1)) {
    if (a === "-f") {
      fn = true;
      continue;
    }
    if (a === "-v" || a === "--") continue;
    if (fn) {
      delete ctx.functions[a];
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(a);
    if (m) {
      const key = ctx.array(m[1])?.type === "assoc" ? m[2] : sh.ex.arith(m[2]);
      ctx.unsetElem(m[1], key);
      continue;
    }
    if (!NAME.test(a)) {
      sh.fail(`unset: \`${a}': not a valid identifier`);
      code = 1;
      continue;
    }
    const err = ctx.unset(a);
    if (err) {
      sh.fail(`unset: ${err}`);
      code = 1;
    }
  }
  return code;
};

/* ---------- set and shopt ---------- */

const SET_FLAGS: Record<string, string> = {
  e: "errexit",
  u: "nounset",
  x: "xtrace",
  f: "noglob",
  a: "allexport",
  n: "noexec",
  v: "verbose",
  C: "noclobber",
  B: "braceexpand",
  b: "notify",
  h: "hashall",
  m: "monitor",
  H: "histexpand",
  t: "onecmd",
  T: "functrace",
  E: "errtrace",
  P: "physical",
};
const O_OPTIONS = [
  "allexport",
  "braceexpand",
  "emacs",
  "errexit",
  "errtrace",
  "functrace",
  "hashall",
  "histexpand",
  "history",
  "ignoreeof",
  "interactive-comments",
  "keyword",
  "monitor",
  "noclobber",
  "noexec",
  "noglob",
  "nolog",
  "notify",
  "nounset",
  "onecmd",
  "physical",
  "pipefail",
  "posix",
  "privileged",
  "verbose",
  "vi",
  "xtrace",
];
const O_DEFAULT_ON = new Set([
  "braceexpand",
  "emacs",
  "hashall",
  "histexpand",
  "history",
  "interactive-comments",
  "monitor",
]);

const setCmd: Builtin = (sh, argv, io) => {
  const ctx = sh.ctx;
  if (argv.length === 1) {
    const names = [
      ...new Set([...Object.keys(ctx.env), ...Object.keys(ctx.vars)]),
    ].sort();
    for (const n of names) {
      const m = ctx.vars[n];
      if (m && m.type !== "str") {
        const l = declLine(ctx, n);
        if (l) out(io, l.replace(/^declare -\S+ /, "") + "\n");
      } else out(io, `${n}=${shellQuote(ctx.env[n] ?? "")}\n`);
    }
    return 0;
  }
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      ctx.params = argv.slice(i + 1);
      return 0;
    }
    if (a === "-") {
      ctx.params = argv.slice(i + 1);
      ctx.options.xtrace = false;
      ctx.options.verbose = false;
      return 0;
    }
    if (!/^[-+][a-zA-Z]+$/.test(a)) break;
    const val = a[0] === "-";
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === "o") {
        const name = argv[i + 1];
        if (name === undefined) {
          for (const o of O_OPTIONS) {
            const on = ctx.options[o] ?? O_DEFAULT_ON.has(o);
            if (val) out(io, `${o.padEnd(15)}\t${on ? "on" : "off"}\n`);
            else out(io, `set ${on ? "-" : "+"}o ${o}\n`);
          }
        } else {
          if (!O_OPTIONS.includes(name)) {
            sh.fail(`set: ${name}: invalid option name`);
            return 1;
          }
          ctx.options[name] = val;
          i++;
        }
      } else if (SET_FLAGS[ch]) ctx.options[SET_FLAGS[ch]] = val;
      else {
        sh.fail(`set: ${a[0]}${ch}: invalid option`);
        io.err.write(
          "set: usage: set [-abefhkmnptuvxBCHP] [-o option-name] [--] [-] [arg ...]\n",
        );
        return 2;
      }
    }
  }
  if (i < argv.length) ctx.params = argv.slice(i);
  return 0;
};

const SHOPTS: Record<string, boolean> = {};
for (const n of "assoc_expand_once autocd cdable_vars cdspell checkhash checkjobs compat31 compat32 compat40 compat41 compat42 compat43 compat44 direxpand dirspell dotglob execfail extdebug extglob failglob globstar gnu_errfmt histappend histreedit histverify huponexit inherit_errexit lastpipe lithist localvar_inherit localvar_unset login_shell mailwarn no_empty_cmd_completion nocaseglob nocasematch noexpand_translation nullglob progcomp_alias restricted_shell shift_verbose varredir_close xpg_echo".split(
  " ",
))
  SHOPTS[n] = false;
for (const n of "checkwinsize cmdhist complete_fullquote extquote force_fignore globasciiranges globskipdots hostcomplete interactive_comments patsub_replacement progcomp promptvars sourcepath".split(
  " ",
))
  SHOPTS[n] = true;

function shoptOn(sh: Interp, n: string): boolean {
  const v = sh.ctx.options[n];
  if (v !== undefined) return v;
  if (n === "expand_aliases") return sh.ctx.interactive;
  return SHOPTS[n];
}

const shopt: Builtin = (sh, argv, io) => {
  let mode: "list" | "s" | "u" = "list";
  let q = false;
  let p = false;
  let o = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!/^-[supqo]+$/.test(a)) break;
    for (const ch of a.slice(1)) {
      if (ch === "s") mode = "s";
      else if (ch === "u") mode = "u";
      else if (ch === "q") q = true;
      else if (ch === "p") p = true;
      else o = true;
    }
  }
  const names = argv.slice(i);
  const all = [...Object.keys(SHOPTS), "expand_aliases"].sort();
  if (o) {
    for (const n of names) {
      if (!O_OPTIONS.includes(n)) {
        sh.fail(`shopt: ${n}: invalid shell option name`);
        return 1;
      }
      if (mode !== "list") sh.ctx.options[n] = mode === "s";
    }
    return 0;
  }
  let code = 0;
  if (mode !== "list") {
    for (const n of names) {
      if (!(n in SHOPTS) && n !== "expand_aliases") {
        sh.fail(`shopt: ${n}: invalid shell option name`);
        code = 1;
        continue;
      }
      sh.ctx.options[n] = mode === "s";
    }
    return code;
  }
  const list = names.length ? names : all;
  for (const n of list) {
    if (!(n in SHOPTS) && n !== "expand_aliases") {
      sh.fail(`shopt: ${n}: invalid shell option name`);
      code = 1;
      continue;
    }
    const on = shoptOn(sh, n);
    if (!on) code = code || 1;
    if (q) continue;
    if (p) out(io, `shopt -${on ? "s" : "u"} ${n}\n`);
    else out(io, `${n.padEnd(15)}\t${on ? "on" : "off"}\n`);
  }
  return q && names.length
    ? list.every((n) => shoptOn(sh, n))
      ? 0
      : 1
    : names.length
      ? code
      : 0;
};

/* ---------- running code ---------- */

const code255 = (n: number) => ((n % 256) + 256) % 256;

function parseCode(
  sh: Interp,
  name: string,
  a: string | undefined,
  dflt: number,
): { code: number; bad: boolean } {
  if (a === undefined) return { code: dflt, bad: false };
  if (!/^[+-]?[0-9]+$/.test(a)) {
    sh.fail(`${name}: ${a}: numeric argument required`);
    return { code: 2, bad: true };
  }
  return { code: code255(Number(a)), bad: false };
}

const exit: Builtin = (sh, argv, io) => {
  const r = parseCode(sh, "exit", argv[1], sh.ctx.lastCode);
  if (!r.bad && argv.length > 2) {
    sh.fail("exit: too many arguments");
    return 1;
  }
  if (sh.ctx.src.kind === "prompt" && sh.nest === 0 && sh.ctx.interactive)
    io.err.write("exit\n");
  throw new ExitSig(r.code);
};

const returnCmd: Builtin = (sh, argv) => {
  if (sh.ctx.frames.length === 0 && sh.ctx.sourceDepth === 0) {
    sh.fail("return: can only `return' from a function or sourced script");
    return 1;
  }
  const r = parseCode(sh, "return", argv[1], sh.ctx.lastCode);
  throw new ReturnSig(r.code);
};

const breakCmd =
  (name: "break" | "continue"): Builtin =>
  (sh, argv) => {
    let n = 1;
    if (argv[1] !== undefined) {
      if (!/^[0-9]+$/.test(argv[1])) {
        sh.fail(`${name}: ${argv[1]}: numeric argument required`);
        return 128;
      }
      n = Number(argv[1]);
      if (n === 0) {
        sh.fail(`${name}: ${argv[1]}: loop count out of range`);
        return 1;
      }
    }
    if (sh.ctx.loopDepth === 0) {
      sh.fail(
        `${name}: only meaningful in a \`for', \`while', or \`until' loop`,
      );
      return 0;
    }
    throw name === "break" ? new BreakSig(n) : new ContinueSig(n);
  };

const shift: Builtin = (sh, argv) => {
  const n = argv[1] === undefined ? 1 : Number(argv[1]);
  if (!Number.isInteger(n) || n < 0) {
    sh.fail(`shift: ${argv[1]}: numeric argument required`);
    return 1;
  }
  // No message: `shift_verbose` is off in bash.
  if (n > sh.ctx.params.length) return 1;
  sh.ctx.params = sh.ctx.params.slice(n);
  return 0;
};

const source: Builtin = (sh, argv) => {
  const name = argv[0];
  if (argv.length < 2) {
    sh.fail(`${name}: filename argument required`);
    sh.err.write(`${name}: usage: ${name} filename [arguments]\n`);
    return 2;
  }
  const path = argv[1];
  const t = readText(sh.abs(path));
  if ("err" in t) {
    sh.fail(`${path}: ${t.err}`);
    return 1;
  }
  if (sh.depth >= LIM.depth) throw new NestStop("source", LIM.depth);
  const ctx = sh.ctx;
  const savedParams = ctx.params;
  const savedSrc = ctx.src;
  const savedLine = ctx.line;
  if (argv.length > 2) ctx.params = argv.slice(2);
  ctx.src = { kind: "file", path };
  sh.depth++;
  sh.nest++;
  ctx.sourceDepth++;
  let code: number;
  try {
    code = sh.runSourceText(t.text, ctx.src);
  } catch (e) {
    if (e instanceof ReturnSig) code = e.code;
    else throw e;
  } finally {
    sh.depth--;
    sh.nest--;
    ctx.sourceDepth--;
    ctx.src = savedSrc;
    ctx.line = savedLine;
    if (argv.length > 2) ctx.params = savedParams;
  }
  return code;
};

const evalCmd: Builtin = (sh, argv) => {
  const text = argv.slice(1).join(" ");
  if (text.trim() === "") return 0;
  if (sh.depth >= LIM.depth) throw new NestStop("eval", LIM.depth);
  const ctx = sh.ctx;
  const r = parseFull(text, { extglob: !!ctx.options.extglob, eof: true });
  const base = ctx.src.kind === "file" ? `${ctx.src.path}: eval` : "bash: eval";
  const where = `${base}: line ${ctx.line}: `;
  if (r.status === "incomplete") {
    const msg =
      r.kind === "quote"
        ? `unexpected EOF while looking for matching \`${r.ch}'`
        : "syntax error: unexpected end of file";
    sh.err.write(where + msg + "\n");
    return 2;
  }
  if (r.status === "error") {
    sh.err.write(where + r.message.replace(/^bash: /, "") + "\n");
    if (r.text) sh.err.write(`${where}\`${r.text}'\n`);
    return 2;
  }
  sh.depth++;
  sh.nest++;
  try {
    return sh.runList(r.ast.items);
  } finally {
    sh.depth--;
    sh.nest--;
  }
};

const execCmd: Builtin = (sh, argv, io) => {
  let i = 1;
  while (argv[i] && /^-[cl]$/.test(argv[i])) i++;
  if (argv[i] === "-a") i += 2;
  if (i >= argv.length) return 0;
  const rest = argv.slice(i);
  const code = sh.runCommand(rest, io, {});
  throw new ExitSig(code);
};

/** `bash` and `sh`: run a script file or `-c` text in a context of its own (D13). */
const bash: Builtin = (sh, argv, io) => {
  const name = argv[0];
  const opts: Record<string, boolean> = {};
  let i = 1;
  let cText: string | null = null;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--version") {
      out(io, "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\n");
      return 0;
    }
    if (!/^[-+][a-zA-Z]+$/.test(a)) break;
    const val = a[0] === "-";
    for (const ch of a.slice(1)) {
      if (ch === "c") cText = "";
      else if (ch === "o") {
        const o = argv[++i];
        if (o) opts[o] = val;
      } else if (SET_FLAGS[ch]) opts[SET_FLAGS[ch]] = val;
    }
  }
  const mk = (): Context => {
    const c = sh.ctx.child();
    for (const [k, v] of Object.entries(opts)) c.options[k] = v;
    c.io = io;
    return c;
  };
  if (cText !== null) {
    if (argv[i] === undefined) {
      sh.err.write(`${name}: -c: option requires an argument\n`);
      return 2;
    }
    const text = argv[i++];
    const c = mk();
    c.src = { kind: "c" };
    c.arg0 = argv[i] ?? name;
    c.params = argv.slice(i + 1);
    return sh.runInChild(c, text, name);
  }
  if (i >= argv.length) {
    if (sh.ctx.src.kind !== "prompt") {
      // From a script, bash reads its script from the input: here it is empty.
      const c = mk();
      c.src = { kind: "c" };
      c.arg0 = name;
      return sh.runInChild(c, io.in.readAll(), name);
    }
    sh.err.write(
      "bash: this sandbox can’t open a nested shell. Try: bash script.sh\n",
    );
    return 1;
  }
  const path = argv[i++];
  const abs = sh.abs(path);
  const t = readText(abs);
  if ("err" in t) {
    sh.err.write(`${name}: ${path}: ${t.err}\n`);
    return t.err === "Permission denied"
      ? 126
      : t.err === "Is a directory"
        ? 126
        : 127;
  }
  const c = mk();
  c.arg0 = path;
  c.params = argv.slice(i);
  c.src = { kind: "file", path };
  return sh.runInChild(c, t.text, path);
};

/* ---------- read ---------- */

const read: Builtin = (sh, argv, io) => {
  const ctx = sh.ctx;
  let raw = false;
  let arr: string | null = null;
  let delim = "\n";
  let nchars = -1;
  let prompt = "";
  let fd = 0;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!/^-[a-zA-Z]/.test(a)) break;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      const arg = (): string => {
        const rest = a.slice(k + 1);
        k = a.length;
        return rest !== "" ? rest : (argv[++i] ?? "");
      };
      if (ch === "r") raw = true;
      else if (ch === "s") continue;
      else if (ch === "a") arr = arg();
      else if (ch === "d") delim = arg()[0] ?? "\0";
      else if (ch === "n" || ch === "N") nchars = Number(arg());
      else if (ch === "p") prompt = arg();
      else if (ch === "u") fd = Number(arg());
      else if (ch === "t") arg();
      else {
        sh.fail(`read: -${ch}: invalid option`);
        io.err.write(
          "read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n",
        );
        return 2;
      }
    }
  }
  const names = argv.slice(i);
  for (const n of names) {
    if (!NAME.test(n)) {
      sh.fail(`read: \`${n}': not a valid identifier`);
      return 1;
    }
  }
  const src = fd === 0 ? io.in : io.fds?.get(fd);
  if (!src || !("readLine" in src)) {
    sh.fail(`read: ${fd}: invalid file descriptor: Bad file descriptor`);
    return 1;
  }
  if (prompt && io.in.tty) io.err.write(prompt);
  // Read the text.
  let line = "";
  let eof = false;
  let gotAny = false;
  if (nchars >= 0) {
    const s = src.readChars(nchars);
    if (s === null) eof = true;
    else {
      line = s;
      gotAny = true;
      eof = s.length < nchars;
    }
  } else {
    for (;;) {
      if (delim === "\n") {
        const l = src.readLine();
        if (l === null) {
          eof = true;
          break;
        }
        gotAny = true;
        let t = l.line;
        if (!raw && t.endsWith("\\") && l.nl) {
          line += t.slice(0, -1);
          continue;
        }
        if (!raw && t.endsWith("\\") && !l.nl) t = t.slice(0, -1);
        line += t;
        if (!l.nl) eof = true;
        break;
      }
      const ch = src.readChars(1);
      if (ch === null) {
        eof = true;
        break;
      }
      gotAny = true;
      if (ch === delim) break;
      line += ch;
    }
  }
  // Remove backslashes unless -r.
  const unesc = (s: string) => (raw ? s : s.replace(/\\(.)/g, "$1"));
  const ifs = ctx.ifs();
  const isWs = (c: string) => ifs.includes(c) && " \t\n".includes(c);
  const isSep = (c: string) => ifs.includes(c);
  const fields: string[] = [];
  const maxFields = arr !== null ? Infinity : Math.max(names.length, 1);
  {
    let p = 0;
    const n = line.length;
    while (p < n && isWs(line[p])) p++;
    while (p < n && fields.length < maxFields) {
      if (fields.length === maxFields - 1 && arr === null) {
        // The last name gets the rest, with trailing white IFS removed.
        let rest = line.slice(p);
        let e = rest.length;
        while (e > 0 && isWs(rest[e - 1]) && !(rest[e - 2] === "\\" && !raw))
          e--;
        rest = rest.slice(0, e);
        // A single trailing non-white separator is also removed when it is the only one.
        fields.push(unesc(rest));
        break;
      }
      let q = p;
      let cur = "";
      while (q < n && !isSep(line[q])) {
        if (!raw && line[q] === "\\" && q + 1 < n) {
          cur += line[q + 1];
          q += 2;
        } else cur += line[q++];
      }
      fields.push(cur);
      p = q;
      if (p < n) {
        while (p < n && isWs(line[p])) p++;
        if (p < n && isSep(line[p]) && !isWs(line[p])) {
          p++;
          while (p < n && isWs(line[p])) p++;
        }
      }
    }
  }
  if (arr !== null) {
    const err = ctx.setArray(
      arr,
      fields.map((v) => ({ value: v })),
      "array",
      false,
    );
    if (err) {
      sh.fail(err);
      return 1;
    }
  } else if (names.length === 0) {
    ctx.set("REPLY", unesc(line));
  } else {
    names.forEach((n, k) => {
      const e = ctx.set(n, fields[k] ?? "");
      if (e) sh.fail(e);
    });
  }
  return eof || !gotAny ? 1 : 0;
};

const mapfile: Builtin = (sh, argv, io) => {
  let strip = false;
  let name = "MAPFILE";
  for (const a of argv.slice(1)) {
    if (a === "-t") strip = true;
    else if (!a.startsWith("-")) name = a;
  }
  const text = io.in.readAll();
  const lines = text === "" ? [] : text.split(/(?<=\n)/);
  const items = lines.map((l) => ({ value: strip ? l.replace(/\n$/, "") : l }));
  sh.ctx.setArray(name, items, "array", false);
  return 0;
};

/* ---------- type, command, alias ---------- */

function funcText(sh: Interp, name: string): string {
  const src = sh.functionSource(name) ?? "";
  return `${name} is a function\n${src.endsWith("\n") ? src : src + "\n"}`;
}

function describe(
  sh: Interp,
  name: string,
  io: IO,
  mode: "type" | "t" | "p" | "V",
): boolean {
  const l = sh.lookup(name);
  if (!l) {
    if (mode === "type" || mode === "V")
      sh.fail(`${mode === "V" ? "command" : "type"}: ${name}: not found`);
    return false;
  }
  if (mode === "t") out(io, (l.kind === "alias" ? "alias" : l.kind) + "\n");
  else if (mode === "p") {
    if (l.kind === "file") out(io, l.path + "\n");
  } else if (l.kind === "alias")
    out(io, `${name} is aliased to \`${sh.ctx.aliases[name]}'\n`);
  else if (l.kind === "keyword") out(io, `${name} is a shell keyword\n`);
  else if (l.kind === "builtin") out(io, `${name} is a shell builtin\n`);
  else if (l.kind === "function") out(io, funcText(sh, name));
  else out(io, `${name} is ${l.path}\n`);
  return true;
}

const typeCmd: Builtin = (sh, argv, io) => {
  let mode: "type" | "t" | "p" = "type";
  let i = 1;
  for (; i < argv.length && /^-[tpaf]+$/.test(argv[i]); i++) {
    if (argv[i].includes("t")) mode = "t";
    else if (argv[i].includes("p")) mode = "p";
  }
  let code = 0;
  for (const n of argv.slice(i)) if (!describe(sh, n, io, mode)) code = 1;
  return code;
};

const command: Builtin = (sh, argv, io) => {
  let i = 1;
  let v = false;
  let V = false;
  while (i < argv.length && /^-[pvV]+$/.test(argv[i])) {
    if (argv[i].includes("V")) V = true;
    else if (argv[i].includes("v")) v = true;
    i++;
  }
  if (argv[i] === "--") i++;
  const rest = argv.slice(i);
  if (!rest.length) return 0;
  if (v || V) {
    let code = 0;
    for (const n of rest) {
      const l = sh.lookup(n);
      if (!l) {
        if (V) sh.fail(`command: ${n}: not found`);
        code = 1;
        continue;
      }
      if (V) describe(sh, n, io, "V");
      else if (l.kind === "alias")
        out(io, `alias ${n}='${sh.ctx.aliases[n].replace(/'/g, "'\\''")}'\n`);
      else out(io, (l.kind === "file" ? l.path : n) + "\n");
    }
    return code;
  }
  return sh.runCommand(rest, io, { noFunc: true });
};

const builtinCmd: Builtin = (sh, argv, io) => {
  if (argv.length < 2) return 0;
  return sh.runCommand(argv.slice(1), io, { builtinOnly: true });
};

const aliasCmd: Builtin = (sh, argv, io) => {
  const ctx = sh.ctx;
  const args = argv.slice(1).filter((a) => a !== "-p");
  if (!args.length) {
    for (const k of Object.keys(ctx.aliases).sort())
      out(io, `alias ${k}='${ctx.aliases[k].replace(/'/g, "'\\''")}'\n`);
    return 0;
  }
  let code = 0;
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq < 0) {
      if (ctx.aliases[a] === undefined) {
        sh.fail(`alias: ${a}: not found`);
        code = 1;
      } else out(io, `alias ${a}='${ctx.aliases[a].replace(/'/g, "'\\''")}'\n`);
    } else ctx.aliases[a.slice(0, eq)] = a.slice(eq + 1);
  }
  return code;
};

const unalias: Builtin = (sh, argv) => {
  const ctx = sh.ctx;
  if (argv[1] === "-a") {
    ctx.aliases = {};
    return 0;
  }
  let code = 0;
  for (const a of argv.slice(1)) {
    if (ctx.aliases[a] === undefined) {
      sh.fail(`unalias: ${a}: not found`);
      code = 1;
    } else delete ctx.aliases[a];
  }
  return code;
};

const trap: Builtin = (sh, argv, io) => {
  const ctx = sh.ctx;
  const SIGS = [
    "EXIT",
    "ERR",
    "DEBUG",
    "RETURN",
    "INT",
    "TERM",
    "HUP",
    "QUIT",
    "USR1",
    "USR2",
  ];
  const norm = (s: string) => (s === "0" ? "EXIT" : s.replace(/^SIG/, ""));
  let args = argv.slice(1);
  if (args[0] === "--") args = args.slice(1);
  if (args[0] === "-l") {
    out(io, SIGS.join("\n") + "\n");
    return 0;
  }
  if (!args.length || args[0] === "-p") {
    const list =
      args.length > 1 ? args.slice(1).map(norm) : Object.keys(ctx.traps);
    for (const s of list)
      if (ctx.traps[s] !== undefined)
        out(io, `trap -- '${ctx.traps[s]}' ${s}\n`);
    return 0;
  }
  let code = 0;
  if (args.length === 1 || args[0] === "-") {
    for (const s of (args[0] === "-" ? args.slice(1) : args).map(norm))
      delete ctx.traps[s];
    return 0;
  }
  const cmd = args[0];
  for (const s of args.slice(1).map(norm)) {
    if (!SIGS.includes(s)) {
      sh.fail(`trap: ${s}: invalid signal specification`);
      code = 1;
      continue;
    }
    ctx.traps[s] = cmd;
  }
  return code;
};

const letCmd: Builtin = (sh, argv) => {
  if (argv.length < 2) {
    sh.fail("let: expression expected");
    return 1;
  }
  let last = "0";
  for (const e of argv.slice(1)) last = sh.ex.arith(e);
  return last === "0" ? 1 : 0;
};

const getopts: Builtin = (sh, argv) => {
  const ctx = sh.ctx;
  const optstring = argv[1];
  const name = argv[2];
  if (optstring === undefined || name === undefined) {
    sh.fail("getopts: usage: getopts optstring name [arg ...]");
    return 2;
  }
  const args = argv.length > 3 ? argv.slice(3) : ctx.params;
  const silent = optstring.startsWith(":");
  const spec = silent ? optstring.slice(1) : optstring;
  let optind = Number(ctx.get("OPTIND") ?? "1") || 1;
  const state = getoptsState.get(ctx) ?? { sub: 0 };
  getoptsState.set(ctx, state);
  if (optind === 1 && state.last !== 1) state.sub = 0;
  const done = (): number => {
    ctx.set(name, "?");
    ctx.set("OPTIND", String(optind));
    state.last = optind;
    return 1;
  };
  const arg = args[optind - 1];
  if (arg === undefined || arg === "-" || !arg.startsWith("-")) return done();
  if (arg === "--") {
    optind++;
    state.sub = 0;
    return done();
  }
  const ch = arg[state.sub + 1];
  const idx = spec.indexOf(ch);
  const advance = () => {
    state.sub++;
    if (state.sub + 1 >= arg.length) {
      state.sub = 0;
      optind++;
    }
  };
  if (idx < 0 || ch === ":") {
    ctx.set(name, "?");
    if (silent) ctx.set("OPTARG", ch);
    else {
      sh.err.write(`${ctx.arg0}: illegal option -- ${ch}\n`);
      ctx.unset("OPTARG");
    }
    advance();
  } else if (spec[idx + 1] === ":") {
    const rest = arg.slice(state.sub + 2);
    if (rest !== "") {
      ctx.set("OPTARG", rest);
      optind++;
      state.sub = 0;
      ctx.set(name, ch);
    } else if (args[optind] !== undefined) {
      ctx.set("OPTARG", args[optind]);
      optind += 2;
      state.sub = 0;
      ctx.set(name, ch);
    } else {
      if (silent) {
        ctx.set(name, ":");
        ctx.set("OPTARG", ch);
      } else {
        sh.err.write(`${ctx.arg0}: option requires an argument -- ${ch}\n`);
        ctx.set(name, "?");
        ctx.unset("OPTARG");
      }
      optind++;
      state.sub = 0;
    }
  } else {
    ctx.set(name, ch);
    ctx.unset("OPTARG");
    advance();
  }
  ctx.set("OPTIND", String(optind));
  state.last = optind;
  return 0;
};
const getoptsState = new WeakMap<Context, { sub: number; last?: number }>();

const history: Builtin = (sh, argv, io) => {
  const list = sh.host.history();
  if (argv[1] === "-c") {
    sh.host.clearHistory?.();
    return 0;
  }
  let from = 0;
  if (argv[1] !== undefined) {
    if (!/^[0-9]+$/.test(argv[1])) {
      sh.fail(`history: ${argv[1]}: numeric argument required`);
      return 1;
    }
    from = Math.max(0, list.length - Number(argv[1]));
  }
  for (let i = from; i < list.length; i++)
    out(io, `${String(i + 1).padStart(5)}  ${list[i]}\n`);
  return 0;
};

const HELP: Record<string, string> = {
  cd: "cd: cd [-L|[-P [-e]] [-@]] [dir]\n    Change the shell working directory.\n    \n    Change the current directory to DIR.  The default DIR is the value of the\n    HOME shell variable.\n",
  pwd: "pwd: pwd [-LP]\n    Print the name of the current working directory.\n",
  echo: "echo: echo [-neE] [arg ...]\n    Write arguments to the standard output.\n",
  exit: "exit: exit [n]\n    Exit the shell.\n    \n    Exits the shell with a status of N.  If N is omitted, the exit status\n    is that of the last command executed.\n",
  export:
    "export: export [-fn] [name[=value] ...] or export -p\n    Set export attribute for shell variables.\n",
  type: "type: type [-afptP] name [name ...]\n    Display information about command type.\n",
  read: "read: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n    Read a line from the standard input and split it into fields.\n",
  set: "set: set [-abefhkmnptuvxBCHP] [-o option-name] [--] [-] [arg ...]\n    Set or unset values of shell options and positional parameters.\n",
  source:
    "source: source filename [arguments]\n    Execute commands from a file in the current shell.\n",
  test: "test: test [expr]\n    Evaluate conditional expression.\n",
  true: "true: true\n    Return a successful result.\n",
  false: "false: false\n    Return an unsuccessful result.\n",
};

const help: Builtin = (sh, argv, io) => {
  const names = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (!names.length) {
    out(
      io,
      sh.host.helpText
        ? sh.host.helpText()
        : "Type a command and press Enter.\n",
    );
    return 0;
  }
  let code = 0;
  for (const n of names) {
    const t = HELP[n];
    if (t) out(io, t);
    else if (BUILTINS[n] || KEYWORDS.has(n))
      out(io, `${n}: ${n} [arguments]\n    Shell builtin command.\n`);
    else {
      sh.fail(
        `help: no help topics match \`${n}'.  Try \`help help' or \`man -k ${n}' or \`info ${n}'.`,
      );
      code = 1;
    }
  }
  return code;
};

const umask: Builtin = (_sh, _argv, io) => {
  out(io, "0022\n");
  return 0;
};

const ok: Builtin = () => 0;
const no: Builtin = () => 1;

export const BUILTINS: Record<string, Builtin> = {
  ":": ok,
  true: ok,
  false: no,
  echo,
  printf,
  test: testCmd,
  "[": bracket,
  cd,
  pwd,
  export: (sh, a, io) => declare(sh, a, io, "export"),
  readonly: (sh, a, io) => declare(sh, a, io, "readonly"),
  declare: (sh, a, io) => declare(sh, a, io, "declare"),
  typeset: (sh, a, io) => declare(sh, a, io, "declare"),
  local: (sh, a, io) => declare(sh, a, io, "local"),
  unset,
  set: setCmd,
  shopt,
  source,
  ".": source,
  eval: evalCmd,
  exec: execCmd,
  exit,
  logout: exit,
  return: returnCmd,
  break: breakCmd("break"),
  continue: breakCmd("continue"),
  shift,
  read,
  mapfile,
  readarray: mapfile,
  type: typeCmd,
  command,
  builtin: builtinCmd,
  alias: aliasCmd,
  unalias,
  trap,
  let: letCmd,
  getopts,
  history,
  help,
  hash: ok,
  umask,
  bash,
  sh: bash,
};

/** Re-exported so the host can build its table without a second import. */
export type { CmdFn };

void ExpError;
void AbortLine;

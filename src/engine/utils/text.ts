// AC4: text utilities with GNU coreutils 9.4 messages: cut, tr, paste, tee,
// seq, basename, dirname, xargs, diff, md5sum, sha256sum. Each one is a
// `CmdFn`: `(argv, sh, io) => code`. Error lines have the form `NAME: text`
// and go to `io.err`; they never go through `sh.fail` (that adds `bash:`).
import { clockNow } from "../clock";
import { get } from "../paths";
import { sha256 } from "../sha256";
import { readPath, writeText } from "../shell/redirect";
import type { CmdFn, IO } from "../shell/io";
import { Input } from "../shell/io";
import type { Proc } from "../shell/proc";
import { streamLines } from "../shell/stream";

/* ---------- shared helpers ---------- */

export const mtimeOf = (n: object): number =>
  (n as { mtime?: number }).mtime ?? 0;

export const errOut = (io: IO, cmd: string, msg: string): void =>
  io.err.write(`${cmd}: ${msg}\n`);

export const tryHelp = (cmd: string): string =>
  `Try '${cmd} --help' for more information.\n`;

/** `cmd: msg` and the "Try" line. */
export function usageError(io: IO, cmd: string, msg: string): void {
  io.err.write(`${cmd}: ${msg}\n${tryHelp(cmd)}`);
}

export interface Parsed {
  opts: { name: string; val?: string }[];
  rest: string[];
}

/**
 * A GNU-style option reader. `shorts` lists letters; a letter followed by `:`
 * takes a value. `longs` maps a long name to `[name, takesValue]`; `name` is
 * the short letter when there is one. Options may follow operands. Returns
 * the error text (with the "Try" line) for a bad option.
 */
export function getopt(
  cmd: string,
  argv: string[],
  shorts: string,
  longs: Record<string, [string, boolean]> = {},
): Parsed | string {
  const opts: Parsed["opts"] = [];
  const rest: string[] = [];
  const takes = (c: string): boolean | null => {
    const i = shorts.indexOf(c);
    if (i < 0 || c === ":") return null;
    return shorts[i + 1] === ":";
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let spec = longs[key];
      if (!spec) {
        const m = Object.keys(longs).filter((k) => k.startsWith(key));
        if (m.length === 1) spec = longs[m[0]];
      }
      if (!spec)
        return `${cmd}: unrecognized option '--${key}'\n${tryHelp(cmd)}`;
      if (spec[1]) {
        if (eq >= 0) opts.push({ name: spec[0], val: a.slice(eq + 1) });
        else if (i + 1 < argv.length)
          opts.push({ name: spec[0], val: argv[++i] });
        else
          return `${cmd}: option '--${key}' requires an argument\n${tryHelp(cmd)}`;
      } else {
        if (eq >= 0)
          return `${cmd}: option '--${key}' doesn't allow an argument\n${tryHelp(cmd)}`;
        opts.push({ name: spec[0] });
      }
      continue;
    }
    if (a.length > 1 && a[0] === "-") {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const t = takes(c);
        if (t === null)
          return `${cmd}: invalid option -- '${c}'\n${tryHelp(cmd)}`;
        if (!t) {
          opts.push({ name: c });
          continue;
        }
        if (j + 1 < a.length) opts.push({ name: c, val: a.slice(j + 1) });
        else if (i + 1 < argv.length) opts.push({ name: c, val: argv[++i] });
        else
          return `${cmd}: option requires an argument -- '${c}'\n${tryHelp(cmd)}`;
        break;
      }
      continue;
    }
    rest.push(a);
  }
  return { opts, rest };
}

/** Reads one operand: `-` is stdin. Writes the error line and returns null on failure. */
export async function readOperand(
  cmd: string,
  name: string,
  sh: Proc,
  io: IO,
): Promise<string | null> {
  if (name === "-") return await io.in.readAll(sh);
  const r = await readPath(sh.abs(name), io);
  if ("err" in r) {
    errOut(io, cmd, `${name}: ${r.err}`);
    return null;
  }
  return r.text;
}

/** The lines of a text without the last newline; empty text has none. */
export const splitLines = (t: string): string[] =>
  t === "" ? [] : (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");

/* ---------- cut ---------- */

type Range = [number, number];

function parseList(list: string): Range[] | null {
  const out: Range[] = [];
  for (const part of list.split(",")) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || part === "" || part === "-") return null;
    const lo = m[1] === "" ? 1 : parseInt(m[1], 10);
    let hi: number;
    if (m[2] === "") hi = lo;
    else hi = m[3] === "" ? Infinity : parseInt(m[3], 10);
    if (lo === 0 || hi === 0) return null;
    if (hi < lo) return null;
    out.push([lo, hi]);
  }
  return out;
}

const inRanges = (rs: Range[], n: number): boolean =>
  rs.some(([a, b]) => n >= a && n <= b);

const cut: CmdFn = async (argv, sh, io) => {
  const p = getopt("cut", argv, "b:c:f:d:sz", {
    bytes: ["b", true],
    characters: ["c", true],
    fields: ["f", true],
    delimiter: ["d", true],
    "only-delimited": ["s", false],
    complement: ["complement", false],
    "output-delimiter": ["output-delimiter", true],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  let mode: "b" | "c" | "f" | null = null;
  let list = "";
  let delim = "\t";
  let onlyDelim = false;
  let comp = false;
  let outDelim: string | null = null;
  for (const o of p.opts) {
    if (o.name === "b" || o.name === "c" || o.name === "f") {
      mode = o.name;
      list = o.val ?? "";
    } else if (o.name === "d") {
      if ((o.val ?? "").length !== 1) {
        usageError(io, "cut", "the delimiter must be a single character");
        return 1;
      }
      delim = o.val as string;
    } else if (o.name === "s") onlyDelim = true;
    else if (o.name === "complement") comp = true;
    else if (o.name === "output-delimiter") outDelim = o.val ?? "";
  }
  if (!mode) {
    usageError(
      io,
      "cut",
      "you must specify a list of bytes, characters, or fields",
    );
    return 1;
  }
  const ranges = parseList(list);
  if (!ranges) {
    usageError(
      io,
      "cut",
      mode === "f" ? "invalid field range" : "invalid byte/character position",
    );
    return 1;
  }
  const keep = (n: number) => inRanges(ranges, n) !== comp;
  const files = p.rest.length ? p.rest : ["-"];
  let code = 0;
  const cutLine = (line: string): string => {
    if (mode !== "f") {
      const sel: string[] = [];
      line.split("").forEach((c, i) => {
        if (keep(i + 1)) sel.push(c);
      });
      return sel.join("") + "\n";
    }
    if (!line.includes(delim)) return onlyDelim ? "" : line + "\n";
    const sel = line.split(delim).filter((_, i) => keep(i + 1));
    return sel.join(outDelim ?? delim) + "\n";
  };
  for (const name of files) {
    if (name === "-") {
      // B26: standard input is a stream, one line at a time.
      await streamLines(io.in, sh, (lines) => {
        io.out.write(lines.map(cutLine).join(""));
      });
      continue;
    }
    const text = await readOperand("cut", name, sh, io);
    if (text === null) {
      code = 1;
      continue;
    }
    io.out.write(splitLines(text).map(cutLine).join(""));
  }
  return code;
};

/* ---------- tr ---------- */

const CLASSES: Record<string, (c: string) => boolean> = {
  alpha: (c) => /[A-Za-z]/.test(c),
  digit: (c) => /[0-9]/.test(c),
  alnum: (c) => /[A-Za-z0-9]/.test(c),
  upper: (c) => /[A-Z]/.test(c),
  lower: (c) => /[a-z]/.test(c),
  space: (c) => /[ \t\n\v\f\r]/.test(c),
  blank: (c) => c === " " || c === "\t",
  punct: (c) => /[!-/:-@[-`{-~]/.test(c),
  print: (c) => c >= " " && c <= "~",
  graph: (c) => c > " " && c <= "~",
  cntrl: (c) => c < " " || c === "\x7f",
  xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

/** Expands a `tr` set: ranges, classes, and backslash escapes. Null on a bad range or class. */
function trSet(s: string): string[] | null {
  const items: string[] = [];
  const ESC: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    f: "\f",
    v: "\v",
    a: "\x07",
    b: "\b",
    "\\": "\\",
  };
  const toks: { c: string; lit: boolean }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const o = /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (o) {
        toks.push({ c: String.fromCharCode(parseInt(o[0], 8)), lit: true });
        i += o[0].length;
      } else {
        toks.push({ c: ESC[s[i + 1]] ?? s[i + 1], lit: true });
        i++;
      }
    } else toks.push({ c: s[i], lit: false });
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.lit && t.c === "[" && toks[i + 1]?.c === ":" && !toks[i + 1].lit) {
      let j = i + 2;
      let name = "";
      while (j < toks.length && toks[j].c !== ":") name += toks[j++].c;
      if (toks[j + 1]?.c === "]") {
        const fn = CLASSES[name];
        if (!fn) return null;
        for (let k = 0; k < 256; k++) {
          const ch = String.fromCharCode(k);
          if (fn(ch)) items.push(ch);
        }
        i = j + 1;
        continue;
      }
    }
    if (toks[i + 1]?.c === "-" && !toks[i + 1].lit && i + 2 < toks.length) {
      const a = t.c.charCodeAt(0);
      const b = toks[i + 2].c.charCodeAt(0);
      if (b < a) return null;
      for (let k = a; k <= b; k++) items.push(String.fromCharCode(k));
      i += 2;
      continue;
    }
    items.push(t.c);
  }
  return items;
}

const tr: CmdFn = async (argv, sh, io) => {
  const p = getopt("tr", argv, "cCdst", {
    complement: ["c", false],
    delete: ["d", false],
    "squeeze-repeats": ["s", false],
    "truncate-set1": ["t", false],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  const has = (n: string) => p.opts.some((o) => o.name === n);
  const comp = has("c") || has("C");
  const del = has("d");
  const squeeze = has("s");
  const trunc = has("t");
  const ops = p.rest;
  const wantTwo = !del && !squeeze ? 2 : del && squeeze ? 2 : 1;
  if (ops.length === 0) {
    usageError(io, "tr", "missing operand");
    return 1;
  }
  if (ops.length < wantTwo) {
    io.err.write(
      `tr: missing operand after ‘${ops[ops.length - 1]}’\nTwo strings must be given when ${del && squeeze ? "both deleting and squeezing repeats" : "translating"}.\n${tryHelp("tr")}`,
    );
    return 1;
  }
  if (ops.length > wantTwo) {
    usageError(io, "tr", `extra operand ‘${ops[wantTwo]}’`);
    return 1;
  }
  let s1 = trSet(ops[0]);
  const s2raw = ops.length > 1 ? trSet(ops[1]) : null;
  if (!s1 || (ops.length > 1 && !s2raw)) {
    errOut(io, "tr", "invalid character class or range");
    return 1;
  }
  if (comp) {
    const inSet = new Set(s1);
    s1 = [];
    for (let k = 0; k < 256; k++) {
      const ch = String.fromCharCode(k);
      if (!inSet.has(ch)) s1.push(ch);
    }
  }
  const set1 = new Set(s1);
  // B26: `tr` is a stream. `transform` keeps its state between chunks.
  const run = async (transform: (t: string) => string): Promise<number> => {
    for (;;) {
      const c = await io.in.readChunk(undefined, sh);
      if (c === null) return 0;
      const o = transform(c);
      if (o) io.out.write(o);
      await sh.drain();
    }
  };
  if (del && !squeeze)
    return await run((t) => {
      let o = "";
      for (const ch of t) if (!set1.has(ch)) o += ch;
      return o;
    });
  const map = new Map<string, string>();
  let sq: Set<string>;
  if (del && squeeze) {
    const sqd = new Set(s2raw as string[]);
    let lastD = "";
    return await run((t) => {
      let r = "";
      for (const ch of t) {
        if (set1.has(ch)) continue;
        if (ch === lastD && sqd.has(ch)) continue;
        r += ch;
        lastD = ch;
      }
      return r;
    });
  }
  if (s2raw) {
    let s2 = s2raw;
    if (trunc) s1 = s1.slice(0, s2.length);
    else if (s2.length > 0 && s2.length < s1.length)
      s2 = s2.concat(Array(s1.length - s2.length).fill(s2[s2.length - 1]));
    for (let i = 0; i < s1.length && i < s2.length; i++)
      if (!map.has(s1[i])) map.set(s1[i], s2[i]);
    sq = new Set(squeeze ? s2raw : []);
  } else sq = new Set(squeeze ? s1 : []);
  let last = "";
  let started = false;
  return await run((t) => {
    let o = "";
    for (const ch of t) {
      const m = map.get(ch) ?? ch;
      if (started && m === last && sq.has(m)) continue;
      o += m;
      last = m;
      started = true;
    }
    return o;
  });
};

/* ---------- paste ---------- */

const paste: CmdFn = async (argv, sh, io) => {
  const p = getopt("paste", argv, "d:sz", {
    delimiters: ["d", true],
    serial: ["s", false],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  let delims = ["\t"];
  let serial = false;
  for (const o of p.opts) {
    if (o.name === "s") serial = true;
    else if (o.name === "d") {
      const d: string[] = [];
      const v = o.val ?? "";
      for (let i = 0; i < v.length; i++) {
        if (v[i] === "\\" && i + 1 < v.length) {
          const n = v[++i];
          d.push(n === "n" ? "\n" : n === "t" ? "\t" : n === "0" ? "" : n);
        } else d.push(v[i]);
      }
      delims = d.length ? d : [""];
    }
  }
  const files = p.rest.length ? p.rest : ["-"];
  // B26: a file is read first (an error ends the command before any output);
  // `-` is standard input, read one line at a time. Every `-` takes the next
  // line of the same input, as in GNU paste.
  const data: (string[] | null)[] = [];
  for (const f of files) {
    if (f === "-") {
      data.push(null);
      continue;
    }
    const t = await readOperand("paste", f, sh, io);
    if (t === null) return 1;
    data.push(splitLines(t));
  }
  const nextLine = async (i: number, row: number): Promise<string | null> => {
    const d = data[i];
    if (d) return row < d.length ? d[row] : null;
    const l = await io.in.readLine(sh);
    return l === null ? null : l.line;
  };
  if (serial) {
    for (let i = 0; i < data.length; i++) {
      let line = "";
      for (let row = 0; ; row++) {
        const l = await nextLine(i, row);
        if (l === null) break;
        line += (row ? delims[(row - 1) % delims.length] : "") + l;
      }
      io.out.write(line + "\n");
    }
  } else {
    for (let row = 0; ; row++) {
      let line = "";
      let any = false;
      for (let i = 0; i < data.length; i++) {
        const l = await nextLine(i, row);
        if (l !== null) any = true;
        line += (i ? delims[(i - 1) % delims.length] : "") + (l ?? "");
      }
      if (!any) break;
      // One row goes out as soon as it is complete.
      io.out.write(line + "\n");
      await sh.drain();
    }
  }
  return 0;
};

/* ---------- tee ---------- */

const tee: CmdFn = async (argv, sh, io) => {
  const p = getopt("tee", argv, "aip", {
    append: ["a", false],
    "ignore-interrupts": ["i", false],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  const append = p.opts.some((o) => o.name === "a");
  let code = 0;
  // B26: `tee` is a stream. Every file is opened (or emptied) first, then each
  // chunk goes to the output and to the files as it comes.
  const files: { name: string; abs: string }[] = [];
  for (const name of p.rest) {
    if (
      name === "/dev/null" ||
      name === "/dev/stdout" ||
      name === "/dev/stderr"
    )
      continue;
    const abs = sh.abs(name);
    const e = writeText(abs, "", append);
    if (e) {
      errOut(io, "tee", `${name}: ${e}`);
      code = 1;
    } else files.push({ name, abs });
  }
  for (;;) {
    const text = await io.in.readChunk(undefined, sh);
    if (text === null) break;
    io.out.write(text);
    for (const name of p.rest) {
      if (name === "/dev/stdout") io.out.write(text);
      else if (name === "/dev/stderr") io.err.write(text);
    }
    for (let i = files.length - 1; i >= 0; i--) {
      const e = writeText(files[i].abs, text, true);
      if (e) {
        errOut(io, "tee", `${files[i].name}: ${e}`);
        code = 1;
        files.splice(i, 1);
      }
    }
    await sh.drain();
  }
  return code;
};

/* ---------- seq ---------- */

const decimals = (s: string): number => {
  const m = /\.(\d*)/.exec(s);
  return m ? m[1].length : 0;
};
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

const seq: CmdFn = (argv, sh, io) => {
  let sep = "\n";
  let equal = false;
  const nums: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-w" || a === "--equal-width") equal = true;
    else if (a === "-s" || a === "--separator") sep = argv[++i] ?? "";
    else if (a.startsWith("--separator=")) sep = a.slice(12);
    else if (a.startsWith("-s") && a.length > 2) sep = a.slice(2);
    else if (a === "--") nums.push(...argv.slice(i + 1));
    else if (/^-[\d.]/.test(a) || !a.startsWith("-") || a === "-") nums.push(a);
    else {
      io.err.write(
        a.startsWith("--")
          ? `seq: unrecognized option '${a}'\n${tryHelp("seq")}`
          : `seq: invalid option -- '${a[1]}'\n${tryHelp("seq")}`,
      );
      return 1;
    }
  }
  if (nums.length === 0) {
    usageError(io, "seq", "missing operand");
    return 1;
  }
  if (nums.length > 3) {
    usageError(io, "seq", `extra operand ‘${nums[3]}’`);
    return 1;
  }
  for (const n of nums)
    if (!NUM.test(n)) {
      usageError(io, "seq", `invalid floating point argument: ‘${n}’`);
      return 1;
    }
  const [first, incr, last] =
    nums.length === 1
      ? ["1", "1", nums[0]]
      : nums.length === 2
        ? [nums[0], "1", nums[1]]
        : nums;
  const f = parseFloat(first);
  const s = parseFloat(incr);
  const l = parseFloat(last);
  if (s === 0) {
    usageError(io, "seq", `invalid Zero increment value: ‘${incr}’`);
    return 1;
  }
  const prec = Math.max(decimals(first), decimals(incr));
  const fmt = (x: number) => (prec ? x.toFixed(prec) : String(Math.round(x)));
  const vals: string[] = [];
  const count = Math.floor((l - f) / s + 1e-9);
  for (let k = 0; k <= count && k < 1_000_000; k++) vals.push(fmt(f + k * s));
  if (equal) {
    const w = Math.max(...vals.map((v) => v.length), 0);
    for (let i = 0; i < vals.length; i++) {
      const neg = vals[i].startsWith("-");
      const body = neg ? vals[i].slice(1) : vals[i];
      vals[i] = (neg ? "-" : "") + body.padStart(w - (neg ? 1 : 0), "0");
    }
  }
  if (vals.length) io.out.write(vals.join(sep) + "\n");
  return 0;
};

/* ---------- basename and dirname ---------- */

function baseOf(name: string, suffix?: string): string {
  if (name === "") return "";
  let n = name.replace(/\/+$/, "");
  if (n === "") return "/";
  n = n.slice(n.lastIndexOf("/") + 1);
  if (suffix && n !== suffix && n.endsWith(suffix))
    n = n.slice(0, -suffix.length);
  return n;
}

const basename: CmdFn = (argv, sh, io) => {
  const p = getopt("basename", argv, "as:z", {
    multiple: ["a", false],
    suffix: ["s", true],
    zero: ["z", false],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  let multi = false;
  let suffix: string | undefined;
  const z = p.opts.some((o) => o.name === "z");
  for (const o of p.opts) {
    if (o.name === "a") multi = true;
    if (o.name === "s") {
      multi = true;
      suffix = o.val;
    }
  }
  if (p.rest.length === 0) {
    usageError(io, "basename", "missing operand");
    return 1;
  }
  let names = p.rest;
  if (!multi) {
    if (p.rest.length > 2) {
      usageError(io, "basename", `extra operand ‘${p.rest[2]}’`);
      return 1;
    }
    if (p.rest.length === 2) suffix = p.rest[1];
    names = [p.rest[0]];
  }
  io.out.write(
    names.map((n) => baseOf(n, suffix) + (z ? "\0" : "\n")).join(""),
  );
  return 0;
};

function dirOf(name: string): string {
  if (name === "") return ".";
  let n = name.replace(/\/+$/, "");
  if (n === "") return "/";
  const i = n.lastIndexOf("/");
  if (i < 0) return ".";
  n = n.slice(0, i).replace(/\/+$/, "");
  return n === "" ? "/" : n;
}

const dirname: CmdFn = (argv, sh, io) => {
  const p = getopt("dirname", argv, "z", { zero: ["z", false] });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  if (p.rest.length === 0) {
    usageError(io, "dirname", "missing operand");
    return 1;
  }
  const z = p.opts.some((o) => o.name === "z");
  io.out.write(p.rest.map((n) => dirOf(n) + (z ? "\0" : "\n")).join(""));
  return 0;
};

/* ---------- xargs ---------- */

/** The default xargs reader: blanks split, quotes and backslashes are special. */
function xargsWords(text: string): string[] | string {
  const words: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const e = text.indexOf(c, i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (e < 0 || (nl >= 0 && nl < e))
        return `unmatched ${c === '"' ? "double" : "single"} quote; by default quotes are special to xargs unless you use the -0 option`;
      cur += text.slice(i + 1, e);
      has = true;
      i = e;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

const xargs: CmdFn = async (argv, sh, io) => {
  // The command and its arguments start at the first operand.
  let i = 1;
  let perCall = 0;
  let repl: string | null = null;
  let delim: string | null = null;
  let noRun = false;
  let trace = false;
  let eof: string | null = null;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    const val = (short: string): string | null => {
      if (a.length > short.length + 1 && a.startsWith("-" + short))
        return a.slice(short.length + 1);
      return i + 1 < argv.length ? argv[++i] : null;
    };
    if (a === "-0" || a === "--null") delim = "\0";
    else if (a === "-r" || a === "--no-run-if-empty") noRun = true;
    else if (a === "-t" || a === "--verbose") trace = true;
    else if (a.startsWith("-n") || a.startsWith("--max-args")) {
      const v = a.startsWith("--") ? (a.split("=")[1] ?? argv[++i]) : val("n");
      const n = parseInt(v ?? "", 10);
      if (!(n > 0)) {
        errOut(io, "xargs", `invalid number "${v ?? ""}" for -n option`);
        io.err.write(tryHelp("xargs"));
        return 1;
      }
      perCall = n;
    } else if (a.startsWith("-I")) repl = val("I");
    else if (a.startsWith("-i")) repl = a.length > 2 ? a.slice(2) : "{}";
    else if (a.startsWith("-d")) {
      const v = val("d") ?? "";
      delim = v === "\\n" ? "\n" : v === "\\t" ? "\t" : v === "\\0" ? "\0" : v;
    } else if (a.startsWith("-E")) eof = val("E");
    else if (a.startsWith("-L")) {
      perCall = parseInt(val("L") ?? "1", 10) || 1;
    } else if (a.startsWith("-P") || a.startsWith("-s")) val(a[1]);
    else {
      io.err.write(`xargs: invalid option -- '${a[1]}'\n${tryHelp("xargs")}`);
      return 1;
    }
  }
  const cmd = argv.slice(i);
  if (cmd.length === 0) cmd.push("echo");
  // B26: standard input is read one chunk at a time. A batch runs as soon as
  // it is full (`-n`, `-L`, `-I`, or the size limit of a command line), so a
  // slow or endless writer gives output, and `-E` stops the read.
  const LIMIT = 131_072;
  let code = 0;
  let ran = false;
  let stop: number | null = null;
  let ended = false;
  const runBatch = async (b: string[]): Promise<void> => {
    const args =
      repl !== null
        ? cmd.map((c) => c.split(repl as string).join(b[0]))
        : cmd.concat(b);
    if (trace) io.err.write(args.join(" ") + "\n");
    if (!args[0].includes("/") && !sh.lookup(args[0])) {
      errOut(io, "xargs", `${args[0]}: No such file or directory`);
      stop = 127;
      return;
    }
    ran = true;
    const child: IO = { in: new Input(""), out: io.out, err: io.err };
    const r = await sh.runCommand(args, child, {});
    if (r === 255) stop = 124;
    else if (r === 127) code = Math.max(code, 127);
    else if (r !== 0 && code < 123) code = 123;
  };
  let pending: string[] = [];
  let pendingLen = 0;
  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const b = pending;
    pending = [];
    pendingLen = 0;
    await runBatch(b);
  };
  const take = async (list: string[]): Promise<void> => {
    let items = list;
    if (eof !== null) {
      const k = items.indexOf(eof);
      if (k >= 0) {
        items = items.slice(0, k);
        ended = true;
      }
    }
    for (const it of items) {
      if (repl !== null) {
        await runBatch([it]);
      } else {
        if (pending.length && pendingLen + it.length + 1 > LIMIT) await flush();
        if (stop !== null) return;
        pending.push(it);
        pendingLen += it.length + 1;
        if (perCall > 0 && pending.length >= perCall) await flush();
      }
      if (stop !== null) return;
    }
  };
  /** The items of text that holds only whole items. Gives an error text on a bad quote. */
  const split = (text: string): string[] | string => {
    if (repl !== null)
      return text
        .split(delim ?? "\n")
        .map((l) => (delim === null ? l.replace(/^[ \t]+/, "") : l))
        .filter(
          (l, k, all) => l !== "" || (delim !== null && k < all.length - 1),
        );
    if (delim !== null) {
      const items = text.split(delim);
      if (items[items.length - 1] === "") items.pop();
      return items;
    }
    return xargsWords(text);
  };
  /** The end of the whole items in `buf`: the rest may be the start of the next one. */
  const cut = (buf: string): number => {
    if (delim !== null) return buf.lastIndexOf(delim) + 1;
    if (repl !== null) return buf.lastIndexOf("\n") + 1;
    let q: string | null = null;
    let at = 0;
    for (let k = 0; k < buf.length; k++) {
      const c = buf[k];
      if (q !== null) {
        if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === "\\") k++;
      else if (/\s/.test(c)) at = k + 1;
    }
    return at;
  };
  let buf = "";
  while (stop === null && !ended) {
    const c = await io.in.readChunk(undefined, sh);
    if (c === null) break;
    buf += c;
    const n = cut(buf);
    if (n <= 0) continue;
    const w = split(buf.slice(0, n));
    buf = buf.slice(n);
    if (typeof w === "string") {
      errOut(io, "xargs", w);
      return 1;
    }
    await take(w);
    await sh.drain();
  }
  if (stop === null && !ended && buf !== "") {
    const w = split(buf);
    if (typeof w === "string") {
      errOut(io, "xargs", w);
      return 1;
    }
    await take(w);
  }
  if (stop === null) await flush();
  if (stop !== null) return stop;
  if (!ran && !noRun && repl === null) await runBatch([]);
  return stop ?? code;
};

/* ---------- diff ---------- */

type Op = { t: "=" | "-" | "+"; a: number; b: number; line: string };

/** An edit script for two line lists; the shared head and tail are cut off first. */
function diffOps(x: string[], y: string[]): Op[] {
  let h = 0;
  while (h < x.length && h < y.length && x[h] === y[h]) h++;
  let t = 0;
  while (
    t < x.length - h &&
    t < y.length - h &&
    x[x.length - 1 - t] === y[y.length - 1 - t]
  )
    t++;
  const a = x.slice(h, x.length - t);
  const b = y.slice(h, y.length - t);
  const ops: Op[] = [];
  for (let i = 0; i < h; i++) ops.push({ t: "=", a: i, b: i, line: x[i] });
  if (a.length * b.length > 4_000_000) {
    a.forEach((l, i) => ops.push({ t: "-", a: h + i, b: h, line: l }));
    b.forEach((l, j) =>
      ops.push({ t: "+", a: h + a.length, b: h + j, line: l }),
    );
  } else {
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * w + j] =
          a[i] === b[j]
            ? L[(i + 1) * w + j + 1] + 1
            : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push({ t: "=", a: h + i, b: h + j, line: a[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || L[(i + 1) * w + j] >= L[i * w + j + 1])) {
        ops.push({ t: "-", a: h + i, b: h + j, line: a[i] });
        i++;
      } else {
        ops.push({ t: "+", a: h + i, b: h + j, line: b[j] });
        j++;
      }
    }
  }
  for (let k = 0; k < t; k++)
    ops.push({
      t: "=",
      a: x.length - t + k,
      b: y.length - t + k,
      line: x[x.length - t + k],
    });
  return ops;
}

const rng = (from: number, to: number): string =>
  from === to ? String(from) : `${from},${to}`;

function isoTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000 +0000`;
}

const diff: CmdFn = async (argv, sh, io) => {
  const p = getopt("diff", argv, "uqUc:", {
    unified: ["u", false],
    brief: ["q", false],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 2;
  }
  const unified = p.opts.some((o) => o.name === "u" || o.name === "U");
  const brief = p.opts.some((o) => o.name === "q");
  if (p.rest.length < 2) {
    usageError(io, "diff", `missing operand after ‘${p.rest[0] ?? "diff"}’`);
    return 2;
  }
  const [n1, n2] = p.rest;
  const texts: string[] = [];
  const mt: number[] = [];
  for (const n of [n1, n2]) {
    const t = await readOperand("diff", n, sh, io);
    if (t === null) return 2;
    texts.push(t);
    const node = n === "-" ? null : get(sh.abs(n));
    mt.push(node ? mtimeOf(node) || clockNow() : clockNow());
  }
  if (texts[0] === texts[1]) return 0;
  if (brief) {
    io.out.write(`Files ${n1} and ${n2} differ\n`);
    return 1;
  }
  const x = splitLines(texts[0]);
  const y = splitLines(texts[1]);
  const ops = diffOps(x, y);
  let out = "";
  if (!unified) {
    for (let k = 0; k < ops.length;) {
      if (ops[k].t === "=") {
        k++;
        continue;
      }
      let e = k;
      while (e < ops.length && ops[e].t !== "=") e++;
      const del = ops.slice(k, e).filter((o) => o.t === "-");
      const add = ops.slice(k, e).filter((o) => o.t === "+");
      const aStart = ops[k].a;
      const bStart = ops[k].b;
      const ar = del.length ? rng(aStart + 1, aStart + del.length) : "";
      const br = add.length ? rng(bStart + 1, bStart + add.length) : "";
      if (!del.length) out += `${aStart}a${br}\n`;
      else if (!add.length) out += `${ar}d${bStart}\n`;
      else out += `${ar}c${br}\n`;
      for (const o of del) out += `< ${o.line}\n`;
      if (del.length && add.length) out += "---\n";
      for (const o of add) out += `> ${o.line}\n`;
      k = e;
    }
  } else {
    out += `--- ${n1}\t${isoTime(mt[0])}\n+++ ${n2}\t${isoTime(mt[1])}\n`;
    const C = 3;
    const changed: number[] = [];
    ops.forEach((o, k) => {
      if (o.t !== "=") changed.push(k);
    });
    let gi = 0;
    while (gi < changed.length) {
      const lo = changed[gi];
      let hi = lo;
      let gj = gi + 1;
      while (gj < changed.length && changed[gj] - hi <= 2 * C + 1) {
        hi = changed[gj];
        gj++;
      }
      gi = gj;
      const s = Math.max(0, lo - C);
      const e = Math.min(ops.length - 1, hi + C);
      const seg = ops.slice(s, e + 1);
      const na = seg.filter((o) => o.t !== "+").length;
      const nb = seg.filter((o) => o.t !== "-").length;
      const startA = seg.find((o) => o.t !== "+");
      const startB = seg.find((o) => o.t !== "-");
      const hs = (cnt: number, first: Op | undefined, which: "a" | "b") => {
        const st = first ? first[which] + 1 : seg[0][which];
        const base = cnt === 0 ? (first ? first[which] : seg[0][which]) : st;
        return cnt === 1 ? `${base}` : `${base},${cnt}`;
      };
      out += `@@ -${hs(na, startA, "a")} +${hs(nb, startB, "b")} @@\n`;
      for (const o of seg) out += (o.t === "=" ? " " : o.t) + o.line + "\n";
    }
  }
  io.out.write(out);
  return 1;
};

/* ---------- md5sum and sha256sum ---------- */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function md5(str: string): string {
  const bytes = utf8(str);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++)
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      const sh = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  let hex = "";
  for (let i = 0; i < 16; i++)
    hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}

function sumCmd(name: string, hash: (s: string) => string): CmdFn {
  return async (argv, sh, io) => {
    const p = getopt(name, argv, "cbt", {
      check: ["c", false],
      binary: ["b", false],
      text: ["t", false],
    });
    if (typeof p === "string") {
      io.err.write(p);
      return 1;
    }
    const check = p.opts.some((o) => o.name === "c");
    const files = p.rest.length ? p.rest : ["-"];
    let code = 0;
    if (!check) {
      for (const f of files) {
        const t = await readOperand(name, f, sh, io);
        if (t === null) {
          code = 1;
          continue;
        }
        io.out.write(`${hash(t)}  ${f}\n`);
      }
      return code;
    }
    let bad = 0;
    let unread = 0;
    for (const f of files) {
      const text = await readOperand(name, f, sh, io);
      if (text === null) {
        code = 1;
        continue;
      }
      for (const line of splitLines(text)) {
        const m = /^([0-9a-fA-F]+)  ?\*?(.*)$/.exec(line);
        if (!m) continue;
        const r = await readPath(sh.abs(m[2]), io);
        if ("err" in r) {
          errOut(io, name, `${m[2]}: ${r.err}`);
          io.out.write(`${m[2]}: FAILED open or read\n`);
          unread++;
        } else if (hash(r.text) === m[1].toLowerCase())
          io.out.write(`${m[2]}: OK\n`);
        else {
          io.out.write(`${m[2]}: FAILED\n`);
          bad++;
        }
      }
    }
    if (unread)
      errOut(
        io,
        name,
        `WARNING: ${unread} listed file${unread > 1 ? "s" : ""} could not be read`,
      );
    if (bad)
      errOut(
        io,
        name,
        `WARNING: ${bad} computed checksum${bad > 1 ? "s" : ""} did NOT match`,
      );
    return unread || bad || code ? 1 : 0;
  };
}

export const TEXT_CMDS: Record<string, CmdFn> = {
  cut,
  tr,
  paste,
  tee,
  seq,
  basename,
  dirname,
  xargs,
  diff,
  md5sum: sumCmd("md5sum", md5),
  sha256sum: sumCmd("sha256sum", sha256),
};

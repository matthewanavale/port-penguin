// AC4: `sed` (GNU sed 4.9). Commands s y d D p P n N g G h H x = q Q a i c
// b t T : { } with addresses N, $, /re/, first~step, addr,+N, addr,~N, !.
import { get } from "../paths";
import { openForWrite, writeText } from "../shell/redirect";
import type { CmdFn, IO } from "../shell/io";
import { CallSteps } from "../shell/limits";
import { errOut, getopt, readOperand, splitLines } from "./text";

class SedError extends Error {}

/* ---------- regular expressions ---------- */

const POSIX: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
};

/** Turns a POSIX BRE or ERE into JavaScript regular expression source. */
export function toJsRegex(src: string, ere: boolean): string {
  let out = "";
  let atStart = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const start: boolean = atStart;
    atStart = false;
    if (c === "\\" && i + 1 < src.length) {
      const n = src[++i];
      if (!ere && n === "(") {
        out += "(";
        atStart = true;
      } else if (!ere && n === ")") out += ")";
      else if (!ere && n === "{") out += "{";
      else if (!ere && n === "}") out += "}";
      else if (!ere && n === "|") {
        out += "|";
        atStart = true;
      } else if (!ere && (n === "+" || n === "?")) out += n;
      else if (n === "n") out += "\\n";
      else if (n === "t") out += "\\t";
      else if (n === "<") out += "\\b(?=\\w)";
      else if (n === ">") out += "\\b(?<=\\w)";
      else if ("wWsSbB".includes(n)) out += "\\" + n;
      else if (/[1-9]/.test(n)) out += "\\" + n;
      else if (n === "`") out += "^";
      else if (n === "'") out += "$";
      else if (/[A-Za-z0-9]/.test(n)) out += n;
      else out += "\\" + n;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let neg = false;
      if (src[j] === "^") {
        neg = true;
        j++;
      }
      let body = "";
      if (src[j] === "]") {
        body += "\\]";
        j++;
      }
      for (; j < src.length && src[j] !== "]"; j++) {
        if (src[j] === "[" && src[j + 1] === ":") {
          const e = src.indexOf(":]", j + 2);
          if (e > 0) {
            const nm = src.slice(j + 2, e);
            if (!POSIX[nm]) throw new SedError("invalid character class");
            body += POSIX[nm];
            j = e + 1;
            continue;
          }
        }
        if (src[j] === "\\") {
          const nx = src[j + 1];
          if (nx === "n") {
            body += "\\n";
            j++;
          } else if (nx === "t") {
            body += "\\t";
            j++;
          } else if (nx === "]" || nx === "\\") {
            body += "\\\\";
            if (nx === "\\") j++;
          } else body += "\\\\";
          continue;
        }
        body += src[j] === "[" || src[j] === "^" ? "\\" + src[j] : src[j];
      }
      if (j >= src.length) throw new SedError("unterminated address regex");
      out += "[" + (neg ? "^" : "") + body + "]";
      i = j;
      continue;
    }
    if (c === "*" && start) {
      out += "\\*";
      continue;
    }
    if (c === "^") {
      out += !ere && !start ? "\\^" : "^";
      if (ere || start) atStart = !ere && start;
      continue;
    }
    if (c === "$") {
      const last =
        ere ||
        i === src.length - 1 ||
        src.slice(i + 1, i + 3) === "\\)" ||
        src.slice(i + 1, i + 3) === "\\|";
      out += last ? "$" : "\\$";
      continue;
    }
    if (ere) {
      if (c === "(" || c === "|") atStart = true;
      out += c;
      continue;
    }
    if ("(){}|+?".includes(c)) out += "\\" + c;
    else out += c;
  }
  return out;
}

/* ---------- script parsing ---------- */

type Addr =
  | { k: "n"; n: number }
  | { k: "last" }
  | { k: "re"; re: RegExp | null }
  | { k: "step"; first: number; step: number };

interface Cmd {
  a1?: Addr;
  a2?: Addr | { k: "plus"; n: number } | { k: "mult"; n: number };
  neg: boolean;
  c: string;
  text?: string;
  re?: RegExp | null;
  repl?: string;
  g?: boolean;
  p?: boolean;
  nth?: number;
  label?: string;
  target?: number;
  y?: Map<string, string>;
  num?: number;
  // range state
  active?: boolean;
  end?: number;
}

function parseScript(src: string, ere: boolean): Cmd[] {
  const cmds: Cmd[] = [];
  const stack: number[] = [];
  let i = 0;
  let lastRe: RegExp | null = null;
  const err = (m: string): never => {
    throw new SedError(`-e expression #1, char ${i}: ${m}`);
  };
  const skipWs = () => {
    while (i < src.length && /[ \t]/.test(src[i])) i++;
  };
  const readDelimited = (d: string, what: string): string => {
    let r = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length) {
        if (src[i + 1] === d) {
          r += d === "|" || d === "+" ? "\\" + d : d;
          i++;
        } else {
          r += c + src[i + 1];
          i++;
        }
      } else if (c === d) {
        i++;
        return r;
      } else r += c;
    }
    return err(`unterminated ${what}`);
  };
  const mkRe = (s: string, flags: string): RegExp | null => {
    if (s === "") return null;
    try {
      return new RegExp(toJsRegex(s, ere), flags + "s");
    } catch (e) {
      if (e instanceof SedError) throw e;
      return err("Invalid preceding regular expression");
    }
  };
  const readAddr = (): Addr | null => {
    const c = src[i];
    if (c === "$") {
      i++;
      return { k: "last" };
    }
    if (/\d/.test(c ?? "")) {
      let n = "";
      while (/\d/.test(src[i] ?? "")) n += src[i++];
      if (src[i] === "~") {
        i++;
        let s = "";
        while (/\d/.test(src[i] ?? "")) s += src[i++];
        return { k: "step", first: +n, step: +s };
      }
      return { k: "n", n: +n };
    }
    if (c === "/" || c === "\\") {
      let d = "/";
      if (c === "\\") {
        i++;
        d = src[i];
      }
      i++;
      const body = readDelimited(d, "address regex");
      let fl = "";
      while (src[i] === "I" || src[i] === "M")
        fl += src[i++] === "I" ? "i" : "m";
      const re = mkRe(body, fl);
      return { k: "re", re };
    }
    return null;
  };
  const endCmd = () => {
    skipWs();
    if (i >= src.length || src[i] === "\n" || src[i] === ";") {
      i++;
      return;
    }
    if (src[i] === "}") return;
    err("extra characters after command");
  };
  const readText = (): string => {
    skipWs();
    if (src[i] === "\\") {
      i++;
      skipWs();
      if (src[i] === "\n") i++;
    }
    let t = "";
    for (; i < src.length; i++) {
      if (src[i] === "\\" && i + 1 < src.length) {
        i++;
        t += src[i];
      } else if (src[i] === "\n") break;
      else t += src[i];
    }
    i++;
    return t;
  };
  while (i < src.length) {
    skipWs();
    if (src[i] === ";" || src[i] === "\n") {
      i++;
      continue;
    }
    if (i >= src.length) break;
    const cmd: Cmd = { neg: false, c: "" };
    const a1 = readAddr();
    if (a1) {
      cmd.a1 = a1;
      skipWs();
      if (src[i] === ",") {
        i++;
        skipWs();
        if (src[i] === "+" || src[i] === "~") {
          const kind = src[i++] === "+" ? "plus" : "mult";
          let n = "";
          while (/\d/.test(src[i] ?? "")) n += src[i++];
          cmd.a2 = { k: kind, n: +n } as Cmd["a2"];
        } else {
          const a2 = readAddr();
          if (!a2) err("unexpected `,'");
          cmd.a2 = a2 as Addr;
        }
      }
    }
    skipWs();
    while (src[i] === "!") {
      cmd.neg = true;
      i++;
      skipWs();
    }
    const c = src[i++];
    if (c === undefined) err("missing command");
    cmd.c = c;
    switch (c) {
      case "{":
        stack.push(cmds.length);
        cmds.push(cmd);
        continue;
      case "}": {
        const o = stack.pop();
        if (o === undefined) err("unexpected `}'");
        cmds[o as number].target = cmds.length;
        cmds.push(cmd);
        endCmd();
        continue;
      }
      case "s": {
        const d = src[i++];
        if (!d || d === "\n" || d === "\\") err("unterminated `s' command");
        const pat = readDelimited(d, "`s' command");
        const rep = readDelimited(d, "`s' command");
        let fl = "";
        for (; i < src.length; i++) {
          const f = src[i];
          if (f === "g") cmd.g = true;
          else if (f === "p") cmd.p = true;
          else if (f === "i" || f === "I") fl += "i";
          else if (f === "m" || f === "M") fl += "m";
          else if (/\d/.test(f)) {
            let n = "";
            while (/\d/.test(src[i] ?? "")) n += src[i++];
            i--;
            if (+n === 0) err("number option to `s' command may not be zero");
            cmd.nth = +n;
          } else if (f === "e") {
            /* ignored */
          } else break;
        }
        cmd.re = mkRe(pat, fl);
        if (cmd.re === null) cmd.re = lastRe;
        else lastRe = cmd.re;
        cmd.repl = rep;
        cmds.push(cmd);
        endCmd();
        continue;
      }
      case "y": {
        const d = src[i++];
        const a = readDelimited(d, "`y' command").replace(
          /\\(.)/g,
          (_m, x: string) => (x === "n" ? "\n" : x === "t" ? "\t" : x),
        );
        const b = readDelimited(d, "`y' command").replace(
          /\\(.)/g,
          (_m, x: string) => (x === "n" ? "\n" : x === "t" ? "\t" : x),
        );
        if (a.length !== b.length)
          err("strings for `y' command are different lengths");
        cmd.y = new Map();
        for (let k = 0; k < a.length; k++) cmd.y.set(a[k], b[k]);
        cmds.push(cmd);
        endCmd();
        continue;
      }
      case "a":
      case "i":
      case "c":
        cmd.text = readText();
        cmds.push(cmd);
        continue;
      case ":": {
        skipWs();
        let l = "";
        while (i < src.length && src[i] !== "\n" && src[i] !== ";")
          l += src[i++];
        cmd.label = l.trim();
        cmds.push(cmd);
        continue;
      }
      case "b":
      case "t":
      case "T": {
        skipWs();
        let l = "";
        while (
          i < src.length &&
          src[i] !== "\n" &&
          src[i] !== ";" &&
          src[i] !== "}"
        )
          l += src[i++];
        cmd.label = l.trim();
        cmds.push(cmd);
        endCmd();
        continue;
      }
      case "q":
      case "Q": {
        skipWs();
        let n = "";
        while (/\d/.test(src[i] ?? "")) n += src[i++];
        cmd.num = n ? +n : 0;
        cmds.push(cmd);
        endCmd();
        continue;
      }
      case "d":
      case "D":
      case "p":
      case "P":
      case "n":
      case "N":
      case "g":
      case "G":
      case "h":
      case "H":
      case "x":
      case "=":
      case "z":
        cmds.push(cmd);
        endCmd();
        continue;
      default:
        i--;
        err(`unknown command: \`${c}'`);
    }
  }
  if (stack.length) {
    i = 0;
    err("unmatched `{'");
  }
  for (const c of cmds)
    if ((c.c === "b" || c.c === "t" || c.c === "T") && c.label) {
      const t = cmds.findIndex((x) => x.c === ":" && x.label === c.label);
      if (t < 0)
        throw new SedError(
          `-e expression #1, char ${src.length}: can't find label for jump to \`${c.label}'`,
        );
      c.target = t;
    } else if (c.c === "b" || c.c === "t" || c.c === "T")
      c.target = cmds.length;
  return cmds;
}

/* ---------- running ---------- */

function expand(rep: string, m: RegExpExecArray): string {
  let out = "";
  let mode = "";
  let one = "";
  const add = (s: string) => {
    if (one) {
      s =
        (one === "u" ? s[0]?.toUpperCase() : (s[0]?.toLowerCase() ?? "")) +
        (s.slice(1) && mode === "U"
          ? s.slice(1).toUpperCase()
          : mode === "L"
            ? s.slice(1).toLowerCase()
            : s.slice(1));
      one = "";
    } else if (mode === "U") s = s.toUpperCase();
    else if (mode === "L") s = s.toLowerCase();
    out += s;
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === "&") add(m[0]);
    else if (c === "\\" && i + 1 < rep.length) {
      const n = rep[++i];
      if (/[0-9]/.test(n)) add(m[+n] ?? "");
      else if (n === "n") add("\n");
      else if (n === "t") add("\t");
      else if (n === "U" || n === "L") mode = n;
      else if (n === "E") mode = "";
      else if (n === "u" || n === "l") one = n;
      else add(n);
    } else add(c);
  }
  return out;
}

interface Opts {
  quiet: boolean;
  separate: boolean;
  zero: boolean;
}

function runSed(
  cmds: Cmd[],
  text: string,
  o: Opts,
  startLine: number,
  io: IO,
  isLastFile: boolean,
): { out: string; exit: number | null; lines: number } {
  const nl = o.zero ? "\0" : "\n";
  const lines =
    text === "" ? [] : (text.endsWith(nl) ? text.slice(0, -1) : text).split(nl);
  const noFinalNl = text !== "" && !text.endsWith(nl);
  let out = "";
  let hold = "";
  let ln = startLine;
  let pos = 0;
  let exit: number | null = null;
  const queued: string[] = [];
  // B8: the steps of this one call (it cannot yield).
  const steps = new CallSteps();
  const isLast = () => pos >= lines.length && isLastFile;
  const emit = (s: string, last: boolean) => {
    out += s + (last && noFinalNl ? "" : nl);
  };
  for (const c of cmds) c.active = false;
  const resetT = { v: false };
  let carry: string | null = null;
  while (pos < lines.length || carry !== null) {
    let ps: string;
    if (carry !== null) {
      ps = carry;
      carry = null;
    } else {
      ps = lines[pos++];
      ln++;
    }
    resetT.v = false;
    let pc = 0;
    let deleted = false;
    let quit = false;
    cycle: while (pc < cmds.length) {
      steps.tick();
      const c = cmds[pc];
      const matches = (a: Addr): boolean =>
        a.k === "n"
          ? ln === a.n
          : a.k === "last"
            ? isLast()
            : a.k === "step"
              ? a.step === 0
                ? ln === a.first
                : ln >= a.first && (ln - a.first) % a.step === 0
              : a.re
                ? ((a.re.lastIndex = 0), a.re.test(ps))
                : false;
      let sel = true;
      if (c.a1) {
        if (!c.a2) sel = matches(c.a1);
        else if (c.active) {
          sel = true;
          const a2 = c.a2;
          if (a2.k === "n") {
            if (ln >= a2.n) c.active = false;
          } else if (a2.k === "plus") {
            if (ln >= (c.end as number)) c.active = false;
          } else if (a2.k === "mult") {
            if (a2.n === 0 || ln % a2.n === 0) c.active = false;
          } else if (matches(a2)) c.active = false;
        } else if (matches(c.a1)) {
          sel = true;
          const a2 = c.a2;
          c.active = true;
          if (a2.k === "n") {
            if (a2.n <= ln) c.active = false;
          } else if (a2.k === "plus") {
            c.end = ln + a2.n;
            if (a2.n === 0) c.active = false;
          } else if (a2.k === "mult") {
            if (a2.n === 0 || ln % a2.n === 0) c.active = false;
          } else if (a2.k === "last" && isLast()) c.active = false;
        } else sel = false;
      }
      if (c.neg) sel = !sel;
      if (c.c === "{" && !sel) {
        pc = (c.target as number) + 1;
        continue;
      }
      if (!sel || c.c === "{" || c.c === "}" || c.c === ":") {
        pc++;
        continue;
      }
      switch (c.c) {
        case "s": {
          const re = c.re;
          if (!re) throw new SedError("no previous regular expression");
          const g = new RegExp(re.source, re.flags + "g");
          let n = 0;
          let res = "";
          let last = 0;
          let did = false;
          let m: RegExpExecArray | null;
          while ((m = g.exec(ps))) {
            n++;
            if (m[0] === "") g.lastIndex++;
            if (n < (c.nth ?? 1)) continue;
            res += ps.slice(last, m.index) + expand(c.repl as string, m);
            last = m.index + m[0].length;
            did = true;
            if (!c.g) break;
          }
          if (did) {
            ps = res + ps.slice(last);
            resetT.v = true;
            if (c.p) emit(ps, isLast());
          }
          break;
        }
        case "y":
          ps = ps
            .split("")
            .map((ch) => (c.y as Map<string, string>).get(ch) ?? ch)
            .join("");
          break;
        case "d":
          deleted = true;
          break cycle;
        case "D": {
          const k = ps.indexOf("\n");
          if (k < 0) {
            deleted = true;
            break cycle;
          }
          carry = ps.slice(k + 1);
          deleted = true;
          break cycle;
        }
        case "p":
          emit(ps, isLast());
          break;
        case "P":
          emit(ps.split("\n")[0], isLast());
          break;
        case "n":
          if (pos >= lines.length) {
            if (!o.quiet) emit(ps, true);
            deleted = true;
            quit = true;
            break cycle;
          }
          if (!o.quiet) emit(ps, false);
          ps = lines[pos++];
          ln++;
          break;
        case "N":
          if (pos >= lines.length) {
            if (!o.quiet) emit(ps, true);
            deleted = true;
            quit = true;
            break cycle;
          }
          ps += "\n" + lines[pos++];
          ln++;
          break;
        case "g":
          ps = hold;
          break;
        case "G":
          ps += "\n" + hold;
          break;
        case "h":
          hold = ps;
          break;
        case "H":
          hold += "\n" + ps;
          break;
        case "x":
          [ps, hold] = [hold, ps];
          break;
        case "z":
          ps = "";
          break;
        case "=":
          out += ln + "\n";
          break;
        case "a":
          queued.push(c.text as string);
          break;
        case "i":
          out += (c.text as string) + "\n";
          break;
        case "c":
          if (!c.a2 || !c.active) out += (c.text as string) + "\n";
          deleted = true;
          break cycle;
        case "b":
          pc = c.target as number;
          continue;
        case "t":
          if (resetT.v) {
            resetT.v = false;
            pc = c.target as number;
            continue;
          }
          break;
        case "T":
          if (!resetT.v) {
            pc = c.target as number;
            continue;
          }
          resetT.v = false;
          break;
        case "q":
          exit = c.num as number;
          quit = true;
          break cycle;
        case "Q":
          exit = c.num as number;
          quit = true;
          deleted = true;
          break cycle;
      }
      pc++;
    }
    if (!deleted && !o.quiet) emit(ps, pos >= lines.length);
    if (quit && exit !== null && cmds.some((c) => c.c === "q") && !deleted) {
      /* printed above */
    }
    for (const q of queued.splice(0)) out += q + "\n";
    if (quit) break;
  }
  void io;
  return { out, exit, lines: ln };
}

const USAGE = `Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...

  -n, --quiet, --silent
                 suppress automatic printing of pattern space
      --debug
                 annotate program execution
  -e script, --expression=script
                 add the script to the commands to be executed
  -f script-file, --file=script-file
                 add the contents of script-file to the commands to be executed
  --follow-symlinks
                 follow symlinks when processing in place
  -i[SUFFIX], --in-place[=SUFFIX]
                 edit files in place (makes backup if SUFFIX supplied)
  -l N, --line-length=N
                 specify the desired line-wrap length for the \`l' command
  --posix
                 disable all GNU extensions.
  -E, -r, --regexp-extended
                 use extended regular expressions in the script
                 (for portability use POSIX -E).
  -s, --separate
                 consider files as separate rather than as a single
                 continuous long stream.
      --sandbox
                 operate in sandbox mode (disable e/r/w commands).
  -u, --unbuffered
                 load minimal amounts of data from the input files and flush
                 the output buffers more often
  -z, --null-data
                 separate lines by NUL characters
      --help     display this help and exit
      --version  output version information and exit

If no -e, --expression, -f, or --file option is given, then the first
non-option argument is taken as the sed script to interpret.  All
remaining arguments are names of input files; if no input files are
specified, then the standard input is read.
`;

const sed: CmdFn = async (argv, sh, io) => {
  // -i may carry a suffix glued to it (`-i.bak`), so it is read by hand.
  let inPlace: string | null = null;
  const args: string[] = [argv[0]];
  for (const a of argv.slice(1)) {
    if (/^-i./.test(a) && !a.startsWith("--")) inPlace = a.slice(2);
    else if (a === "-i" || a === "--in-place") inPlace = "";
    else if (a.startsWith("--in-place=")) inPlace = a.slice(11);
    else args.push(a);
  }
  const p = getopt("sed", args, "ne:f:ErsuzlN:", {
    quiet: ["n", false],
    silent: ["n", false],
    expression: ["e", true],
    file: ["f", true],
    "regexp-extended": ["E", false],
    separate: ["s", false],
    "null-data": ["z", false],
    debug: ["debug", false],
    posix: ["posix", false],
    unbuffered: ["u", false],
    sandbox: ["sandbox", false],
  });
  if (typeof p === "string") {
    io.err.write(p.replace(/\nTry .*\n$/, "\n") + USAGE);
    return 1;
  }
  const o: Opts = { quiet: false, separate: false, zero: false };
  let ere = false;
  const scripts: string[] = [];
  for (const x of p.opts) {
    if (x.name === "n") o.quiet = true;
    else if (x.name === "E" || x.name === "r") ere = true;
    else if (x.name === "s") o.separate = true;
    else if (x.name === "z") o.zero = true;
    else if (x.name === "e") scripts.push(x.val ?? "");
    else if (x.name === "f") {
      const t = await readOperand("sed", x.val ?? "", sh, io);
      if (t === null) return 1;
      scripts.push(t.replace(/\n$/, ""));
    }
  }
  let files = p.rest;
  if (scripts.length === 0) {
    if (files.length === 0) {
      io.err.write(USAGE);
      return 1;
    }
    scripts.push(files[0]);
    files = files.slice(1);
  }
  let cmds: Cmd[];
  try {
    cmds = parseScript(scripts.join("\n"), ere);
  } catch (e) {
    if (e instanceof SedError) {
      errOut(io, "sed", e.message);
      return 1;
    }
    throw e;
  }
  let code = 0;
  try {
    if (inPlace !== null) {
      if (files.length === 0) {
        errOut(io, "sed", "no input files");
        return 1;
      }
      for (const f of files) {
        const n = get(sh.abs(f));
        if (!n || n.t !== "f") {
          errOut(io, "sed", `can't read ${f}: No such file or directory`);
          code = 2;
          continue;
        }
        const r = runSed(cmds, n.x, o, 0, io, true);
        if (inPlace) {
          const slash = f.lastIndexOf("/");
          const b = inPlace.includes("*")
            ? inPlace.replace(/\*/g, f.slice(slash + 1))
            : f.slice(slash + 1) + inPlace;
          const bp = b.includes("/") ? b : f.slice(0, slash + 1) + b;
          const w = writeText(sh.abs(bp), n.x, false);
          if (w) errOut(io, "sed", `cannot rename ${f}: ${w}`);
        }
        const w = writeText(sh.abs(f), r.out, false);
        if (w) {
          errOut(io, "sed", `couldn't open temporary file ${f}: ${w}`);
          code = 4;
        }
        if (r.exit !== null) return r.exit;
      }
      void openForWrite;
      return code;
    }
    const names = files.length ? files : ["-"];
    const texts: string[] = [];
    for (const f of names) {
      if (f === "-") {
        texts.push(await io.in.readAll());
        continue;
      }
      const n = get(sh.abs(f));
      if (n && n.t === "d") {
        errOut(io, "sed", `couldn't edit ${f}: not a regular file`);
        code = 4;
        continue;
      }
      const t = n && n.t === "f" ? await readOperand("sed", f, sh, io) : null;
      if (t === null) {
        if (!n) errOut(io, "sed", `can't read ${f}: No such file or directory`);
        code = 2;
        continue;
      }
      texts.push(t);
    }
    if (o.separate) {
      for (let k = 0; k < texts.length; k++) {
        const r = runSed(cmds, texts[k], o, 0, io, true);
        io.out.write(r.out);
        if (r.exit !== null) return r.exit;
      }
    } else {
      // One stream: files are joined; a missing final newline of a middle file is added.
      const joined = texts
        .map((t, k) =>
          k < texts.length - 1 && t !== "" && !t.endsWith("\n") ? t + "\n" : t,
        )
        .join("");
      const r = runSed(cmds, joined, o, 0, io, true);
      io.out.write(r.out);
      if (r.exit !== null) return r.exit;
    }
  } catch (e) {
    if (e instanceof SedError) {
      errOut(io, "sed", e.message);
      return 1;
    }
    throw e;
  }
  void splitLines;
  return code;
};

export const SED_CMDS: Record<string, CmdFn> = { sed };

// Scope (Tab): completion that understands the new syntax. It reads the text
// before the cursor and says what kind of word the cursor is in: a command
// name, an argument, or a variable name after `$`.
import type { Context } from "./context";

export type CompletionSpot =
  | {
      kind: "var";
      /** The part of the name typed so far. */
      prefix: string;
      /** Where that part starts in the text. */
      start: number;
    }
  | {
      kind: "command" | "arg";
      /** The word at the cursor, as typed. */
      word: string;
      start: number;
      /** The words of the current command before the cursor word (the first is the command). */
      words: string[];
    };

interface Tok {
  t: "w" | "op";
  v: string;
  start: number;
  end: number;
}

/** Keywords after which a command name comes. */
const CMD_AFTER = new Set([
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
  "{",
  "coproc",
]);

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const n = s.length;
  let i = 0;
  let tick = false;
  const isOpChar = (c: string) => "|&;()".includes(c);
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\n") {
      toks.push({ t: "op", v: ";", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (isOpChar(c)) {
      const two = s.slice(i, i + 2);
      const v = ["||", "&&", ";;", "|&"].includes(two) ? two : c;
      toks.push({ t: "op", v, start: i, end: i + v.length });
      i += v.length;
      continue;
    }
    let start = i;
    let quote = "";
    for (; i < n; i++) {
      const d = s[i];
      if (quote) {
        if (d === "\\" && quote === '"') {
          i++;
          continue;
        }
        if (d === quote) {
          quote = "";
          continue;
        }
        // $( inside double quotes starts a command too
        if (quote === '"' && d === "$" && s[i + 1] === "(") {
          if (i > start)
            toks.push({ t: "w", v: s.slice(start, i), start, end: i });
          toks.push({ t: "op", v: "(", start: i, end: i + 2 });
          i += 2;
          start = i;
          i--;
          quote = "";
        }
        continue;
      }
      if (d === "\\") {
        i++;
        continue;
      }
      if (d === "'" || d === '"') {
        quote = d;
        continue;
      }
      if (d === "`") {
        if (i > start)
          toks.push({ t: "w", v: s.slice(start, i), start, end: i });
        toks.push({ t: "op", v: tick ? ")" : "(", start: i, end: i + 1 });
        tick = !tick;
        start = i + 1;
        continue;
      }
      if (d === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
        if (i > start)
          toks.push({ t: "w", v: s.slice(start, i), start, end: i });
        toks.push({ t: "op", v: "(", start: i, end: i + 2 });
        i++;
        start = i + 1;
        continue;
      }
      if ((d === "<" || d === ">") && s[i + 1] === "(") {
        if (i > start)
          toks.push({ t: "w", v: s.slice(start, i), start, end: i });
        toks.push({ t: "op", v: "(", start: i, end: i + 2 });
        i++;
        start = i + 1;
        continue;
      }
      if (d === " " || d === "\t" || d === "\n" || isOpChar(d)) break;
    }
    if (i > start) toks.push({ t: "w", v: s.slice(start, i), start, end: i });
  }
  return toks;
}

/** What is at the cursor? `before` is the text up to the cursor. */
export function analyze(before: string): CompletionSpot {
  const vm = /\$\{?([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
  if (vm) {
    return {
      kind: "var",
      prefix: vm[1],
      start: before.length - vm[1].length,
    };
  }
  const n = before.length;
  const toks = tokenize(before);
  const last = toks[toks.length - 1];
  let word = "";
  let start = n;
  let walk = toks;
  if (last && last.t === "w" && last.end === n) {
    word = last.v;
    start = last.start;
    walk = toks.slice(0, -1);
  }
  let cmdPos = true;
  let words: string[] = [];
  for (const t of walk) {
    if (t.t === "op") {
      if (t.v === ")") cmdPos = false;
      else {
        cmdPos = true;
        words = [];
      }
      continue;
    }
    if (cmdPos) {
      if (
        CMD_AFTER.has(t.v) ||
        /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(t.v)
      )
        continue;
      cmdPos = false;
      words = [t.v];
    } else words.push(t.v);
  }
  return { kind: cmdPos ? "command" : "arg", word, start, words };
}

/** Names of shell and environment variables that start with `prefix`, sorted. */
export function variableNames(ctx: Context, prefix: string): string[] {
  const names = new Set<string>([
    ...Object.keys(ctx.env),
    ...Object.keys(ctx.vars),
    ...ctx.exported,
    "HOME",
    "PWD",
    "OLDPWD",
    "PATH",
    "USER",
    "SHELL",
    "IFS",
    "RANDOM",
    "LINENO",
    "SECONDS",
    "HOSTNAME",
    "UID",
    "BASH_VERSION",
    "PIPESTATUS",
    "OPTIND",
    "REPLY",
  ]);
  return [...names].filter((x) => x.startsWith(prefix)).sort();
}

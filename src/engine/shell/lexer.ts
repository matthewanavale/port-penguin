// Shared pieces of the lexer: token types, name checks, and the decoder for
// $'...' strings. The scanning itself lives in parser.ts, because a word can
// hold a command substitution, which needs the parser.
import type { ArrayItem, Word } from "./ast";

export type Tok =
  | { t: "word"; w: Word; raw: string; pos: number; arr?: ArrayItem[] }
  | { t: "op"; v: string; pos: number }
  | { t: "io"; n: number; pos: number }
  | { t: "eof"; pos: number };

export const OPS = [
  ";;&",
  "&>>",
  "<<<",
  "<<-",
  ";;",
  ";&",
  "&&",
  "&>",
  "||",
  "|&",
  "<<",
  "<&",
  "<>",
  ">>",
  ">&",
  ">|",
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
];

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
export const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
export const isSpace = (c: string): boolean => c === " " || c === "\t";

const U4 = /^[0-9a-fA-F]{1,4}/;
const U8 = /^[0-9a-fA-F]{1,8}/;

/** Decodes the body of $'...' (the text between the quotes). */
export function ansiC(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i === s.length - 1) {
      out += c;
      continue;
    }
    const n = s[++i];
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    };
    if (n in simple) out += simple[n];
    else if (n === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 16));
        i += m[0].length;
      } else out += "\\x";
    } else if (n === "u" || n === "U") {
      const re = n === "u" ? U4 : U8;
      const m = re.exec(s.slice(i + 1));
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
      } else out += "\\" + n;
    } else if (/[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i));
      out += String.fromCharCode(parseInt((m as RegExpExecArray)[0], 8) & 255);
      i += (m as RegExpExecArray)[0].length - 1;
    } else if (n === "c" && i + 1 < s.length) {
      out += String.fromCharCode(s[++i].toUpperCase().charCodeAt(0) & 31);
    } else out += "\\" + n;
  }
  return out;
}

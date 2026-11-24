// The tokenizer and the && / ; chain split. Ported from index.html:439-459
// and :1496-1508 at 5e96ce5.
import { HOME, HOST, S } from "./state";

export type Op = "|" | "&&" | ";" | ">" | ">>";
export type Token = string | { glob: string } | { op: Op };
export type Tokens = Token[] | { err: string };

export const isOp = (t: Token): t is { op: Op } =>
  typeof t === "object" && "op" in t;
export const isGlob = (t: Token): t is { glob: string } =>
  typeof t === "object" && "glob" in t;

export function envGet(k: string): string {
  if (k === "PWD") return S.cwd;
  if (k === "HOME") return HOME;
  if (k === "USER") return "cadet";
  if (k === "SHELL") return "/bin/bash";
  if (k === "HOSTNAME") return HOST;
  if (k === "PATH") return "/usr/local/bin:/usr/bin:/bin";
  return S.env[k] !== undefined ? S.env[k] : "";
}

export function tokenize(line: string): Tokens {
  const toks: Token[] = [];
  let cur = "",
    q: string | null = null,
    has = false,
    glob = false;
  const push = () => {
    if (cur || has) toks.push(glob ? { glob: cur } : cur);
    cur = "";
    has = false;
    glob = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else cur += ch;
      continue;
    }
    if (ch === "$") {
      const m = line.slice(i + 1).match(/^\{(\w+)\}|^([A-Za-z_]\w*)|^\?/);
      if (m) {
        cur += m[0] === "?" ? String(S.lastCode || 0) : envGet(m[1] || m[2]);
        i += m[0].length;
        continue;
      }
    }
    if (q === '"') {
      if (ch === '"') q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    if (ch === "|" && line[i + 1] !== "|") {
      push();
      toks.push({ op: "|" });
      continue;
    }
    if (ch === "&" && line[i + 1] === "&") {
      push();
      toks.push({ op: "&&" });
      i++;
      continue;
    }
    if (ch === ";") {
      push();
      toks.push({ op: ";" });
      continue;
    }
    if (ch === ">") {
      push();
      if (line[i + 1] === ">") {
        toks.push({ op: ">>" });
        i++;
      } else toks.push({ op: ">" });
      continue;
    }
    if (ch === "*" || ch === "?") glob = true;
    cur += ch;
  }
  if (q) return { err: "a quote was opened but never closed" };
  push();
  return toks;
}

export interface Chain {
  text: string;
  cond: boolean;
}

/** Splits a line on && and ; outside quotes, so variables set earlier in the line are visible later. */
export function tokenizeChains(
  line: string,
): { chains: Chain[]; err?: undefined } | { err: string; chains?: undefined } {
  const chains: Chain[] = [];
  let cur = "",
    q: string | null = null,
    cond = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && line[i + 1] === "&") {
      chains.push({ text: cur, cond });
      cur = "";
      cond = true;
      i++;
      continue;
    }
    if (ch === ";") {
      chains.push({ text: cur, cond });
      cur = "";
      cond = false;
      continue;
    }
    cur += ch;
  }
  if (q) return { err: "a quote was opened but never closed" };
  chains.push({ text: cur, cond });
  return { chains: chains.filter((c) => c.text.trim()) };
}

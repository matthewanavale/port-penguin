// Styled runs to ANSI escape codes, and the xterm.js theme from today's CSS
// tokens (AC7, D17). Each style uses one of the 16 theme colors; the theme
// gives that slot the token color.
import type { ITheme } from "@xterm/xterm";
import type { Block, OutLine, Run, Style } from "../engine/output";

/** SGR codes per style. Bold follows the old CSS font-weight: 700. */
const SGR: Record<Style, string> = {
  pu: "1;33", // --tprompt, bold
  pp: "1;34", // --tpath, bold
  dir: "1;34", // --tpath, bold
  exe: "1;32", // --texe, bold
  ok: "1;36", // --tok, bold
  err: "31", // --terr
  dim: "90", // --tdim
  hl: "33;45", // --tprompt on the highlight background
};

/** Gutter color per system message block. */
const GUTTER: Record<Block, string> = {
  sys: "36", // --tok
  big: "33", // --tprompt
  alert: "31", // --terr
};

const RESET = "\x1b[0m";

/** Removes control characters (escape sequences among them) but keeps tabs and line breaks. */
// eslint-disable-next-line no-control-regex -- this strips control characters on purpose
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const clean = (text: string) => text.replace(CONTROL, "");

const sgr = (codes: string) => `\x1b[${codes}m`;

/** Renders runs on one terminal line, with no line break. */
export function renderRuns(runs: Run[], lineStyle?: Style): string {
  let out = "";
  for (const r of runs) {
    const text = clean(r.text);
    if (!text) continue;
    const style = r.style ?? lineStyle;
    out += style ? sgr(SGR[style]) + text + RESET : text;
  }
  return out;
}

/** Renders output lines. Each line, and each line break inside a run, ends with CR LF. */
export function renderLines(lines: OutLine[]): string {
  let out = "";
  for (const line of lines) {
    const gutter = line.block
      ? sgr(GUTTER[line.block]) + "│" + RESET + " "
      : "";
    // Split the runs into rows at each line break inside a run.
    const rows: Run[][] = [[]];
    for (const r of line.runs) {
      const parts = r.text.split("\n");
      parts.forEach((p, i) => {
        if (i > 0) rows.push([]);
        rows[rows.length - 1].push({ ...r, text: p });
      });
    }
    for (const row of rows)
      out += gutter + renderRuns(row, line.style) + "\r\n";
  }
  return out;
}

/** The part of a computed style that the theme reads. */
export interface CssSource {
  getPropertyValue(name: string): string;
}

function parseHex(color: string): [number, number, number] | null {
  const m = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: number[]) =>
  "#" +
  rgb
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** `top` at `alpha` over `bottom`, as the old rgba(242,193,78,.22) highlight. */
function blend(top: string, bottom: string, alpha: number): string {
  const a = parseHex(top),
    b = parseHex(bottom);
  if (!a || !b) return top;
  return toHex(a.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}

/** The xterm.js theme from the terminal CSS tokens (`--term`, `--tink`, ...). */
export function themeFromCss(style: CssSource): ITheme {
  const v = (name: string) => style.getPropertyValue(name).trim();
  const term = v("--term"),
    ink = v("--tink"),
    dim = v("--tdim"),
    prompt = v("--tprompt"),
    path = v("--tpath"),
    ok = v("--tok"),
    err = v("--terr"),
    exe = v("--texe");
  const hl = blend(prompt, term, 0.22);
  return {
    background: term,
    foreground: ink,
    cursor: prompt,
    cursorAccent: term,
    selectionBackground: path + "66",
    black: term,
    red: err,
    green: exe,
    yellow: prompt,
    blue: path,
    magenta: hl,
    cyan: ok,
    white: ink,
    brightBlack: dim,
    brightRed: err,
    brightGreen: exe,
    brightYellow: prompt,
    brightBlue: path,
    brightMagenta: hl,
    brightCyan: ok,
    brightWhite: ink,
  };
}

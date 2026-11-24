// The line editor behind the xterm.js terminal: a pure state machine with no
// DOM. Keys arrive as the data strings xterm.js sends from onData. Keys
// follow GNU readline (D16b); Ctrl-W has no handler. History is ported from
// index.html:1511-1519 at 5e96ce5. Esc (focus leaves the terminal) and
// Ctrl-C with a selection (copy) are handled by terminal.ts (D16).
import type { Completion } from "../engine/index";

export type EditorAction =
  | { type: "submit"; line: string }
  | { type: "interrupt"; line: string }
  | { type: "clear" }
  | { type: "listing"; line: string; items: string[] };

export interface LineEditorOptions {
  /** The command history, oldest first. Read on every Up and Down. */
  history: () => string[];
  /** Tab completion for a line and a cursor. */
  complete: (value: string, cursor: number) => Completion;
}

export interface LineEditor {
  readonly line: string;
  readonly cursor: number;
  /** Replaces the line (hint chips). The cursor goes to the end by default. */
  set(line: string, cursor?: number): void;
  /** One key press, or a paste. */
  input(data: string): EditorAction[];
  /** Inserts text at the cursor (extra-keys bar). */
  insert(text: string): void;
  /** Up (-1) or Down (1) in the history (extra-keys bar). */
  historyMove(dir: -1 | 1): void;
  /** Tab (extra-keys bar). */
  complete(): EditorAction[];
}

/** Escape sequences the editor knows, and what they do. */
const SEQ: Record<string, string> = {
  "\x1b[3~": "delete",
  "\x1b[D": "left",
  "\x1b[C": "right",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home",
  "\x1b[7~": "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  "\x1b[8~": "end",
  "\x1bOD": "left",
  "\x1bOC": "right",
  "\x1bOA": "up",
  "\x1bOB": "down",
};

/** Length of the escape sequence at `i` (CSI, SS3, or ESC plus one character). */
function escapeLength(data: string, i: number): number {
  const next = data[i + 1];
  if (next === undefined) return 1;
  if (next === "[") {
    let j = i + 2;
    while (j < data.length) {
      const code = data.charCodeAt(j);
      j++;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return j - i;
  }
  if (next === "O") return Math.min(3, data.length - i);
  return 2;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** UTF-16 length of the character before `i` (2 for an emoji). */
const prevLen = (s: string, i: number) =>
  i >= 2 && isLow(s.charCodeAt(i - 1)) && isHigh(s.charCodeAt(i - 2)) ? 2 : 1;
/** UTF-16 length of the character at `i`. */
const nextLen = (s: string, i: number) =>
  isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;

export function createLineEditor(opts: LineEditorOptions): LineEditor {
  let line = "";
  let cursor = 0;
  // History position: -1 means "not browsing"; draft is the unsent line.
  let hi = -1;
  let draft = "";

  const insert = (text: string) => {
    line = line.slice(0, cursor) + text + line.slice(cursor);
    cursor += text.length;
  };

  const historyMove = (dir: number) => {
    const hist = opts.history();
    if (!hist.length) return;
    if (hi === -1) {
      draft = line;
      hi = hist.length;
    }
    hi = Math.max(0, Math.min(hist.length, hi + dir));
    line = hi === hist.length ? draft : hist[hi];
    if (hi === hist.length) hi = -1;
    cursor = line.length;
  };

  const complete = (): EditorAction[] => {
    const r = opts.complete(line, cursor);
    if (r.listing.length) return [{ type: "listing", line, items: r.listing }];
    line = r.value;
    cursor = r.cursor;
    return [];
  };

  const key = (name: string) => {
    switch (name) {
      case "delete":
        if (cursor < line.length)
          line =
            line.slice(0, cursor) + line.slice(cursor + nextLen(line, cursor));
        break;
      case "left":
        if (cursor > 0) cursor -= prevLen(line, cursor);
        break;
      case "right":
        if (cursor < line.length) cursor += nextLen(line, cursor);
        break;
      case "home":
        cursor = 0;
        break;
      case "end":
        cursor = line.length;
        break;
      case "up":
        historyMove(-1);
        break;
      case "down":
        historyMove(1);
        break;
    }
  };

  const input = (data: string): EditorAction[] => {
    const actions: EditorAction[] = [];
    let text = "";
    const flush = () => {
      if (text) insert(text);
      text = "";
    };
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);
      if (ch === "\x1b") {
        flush();
        const len = escapeLength(data, i);
        const seq = data.slice(i, i + len);
        if (SEQ[seq]) key(SEQ[seq]);
        i += len - 1;
        continue;
      }
      if (code >= 0x20 && code !== 0x7f) {
        text += ch;
        continue;
      }
      flush();
      switch (ch) {
        case "\r":
        case "\n": {
          if (ch === "\r" && data[i + 1] === "\n") i++;
          actions.push({ type: "submit", line });
          line = "";
          cursor = 0;
          hi = -1;
          break;
        }
        case "\x7f":
        case "\b":
          if (cursor > 0) {
            const n = prevLen(line, cursor);
            line = line.slice(0, cursor - n) + line.slice(cursor);
            cursor -= n;
          }
          break;
        case "\x01":
          cursor = 0;
          break;
        case "\x05":
          cursor = line.length;
          break;
        case "\x15":
          line = line.slice(cursor);
          cursor = 0;
          break;
        case "\x0b":
          line = line.slice(0, cursor);
          break;
        case "\x03":
          actions.push({ type: "interrupt", line });
          line = "";
          cursor = 0;
          break;
        case "\x0c":
          actions.push({ type: "clear" });
          break;
        case "\t":
          actions.push(...complete());
          break;
        // Other control keys (Ctrl-W among them) have no handler.
      }
    }
    flush();
    return actions;
  };

  return {
    get line() {
      return line;
    },
    get cursor() {
      return cursor;
    },
    set(l: string, c?: number) {
      line = l;
      cursor = Math.max(0, Math.min(l.length, c ?? l.length));
    },
    input,
    insert,
    historyMove,
    complete,
  };
}

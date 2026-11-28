// The xterm.js terminal: prompt, line edit, history, Tab completion, Ctrl-C,
// Ctrl-L, paste, copy, and Esc to leave (D2, D16, D16b, D16c). Keys go to
// the line editor; Enter runs the line through the engine; output runs are
// written as ANSI codes (D17).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { Engine, ExecResult } from "../engine/index";
import type { OutLine } from "../engine/output";
import type { OutputEvent } from "../engine/shell/io";
import {
  createChunkRenderer,
  renderLines,
  renderRuns,
  themeFromCss,
} from "./ansi";
import { createLineEditor } from "./lineEditor";
import type { EditorAction } from "./lineEditor";

export interface GameTerminal {
  /**
   * Command output from the engine (B15): `main.ts` connects this to the
   * `onOutput` of `createEngine`. A chunk is written at once; `clear` clears
   * the screen.
   */
  output(event: OutputEvent): void;
  /** Writes lines above the prompt (panel messages). */
  print(lines: OutLine[]): void;
  /** Clears the screen and keeps the line being typed. */
  clear(): void;
  /** Clears everything, writes `lines`, then a fresh prompt. */
  restart(lines: OutLine[]): void;
  /** Puts a whole line in (hint chips). */
  setLine(text: string): void;
  /** The extra-keys bar. */
  key(k: string): void;
  focus(): void;
}

export interface TerminalOptions {
  container: HTMLElement;
  engine: Engine;
  /** Lines to show before the first prompt. */
  intro: OutLine[];
  /** Called after each command line, for the panel. */
  onResult(result: ExecResult): void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Terminal cells a code point takes: 2 for wide CJK and emoji, 0 for joiners. */
function cells(cp: number): number {
  if (
    cp === 0x200d ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  )
    return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}
/** Terminal cells a string takes. A tab counts as one cell (see `shown`). */
export const width = (s: string): number => {
  let w = 0;
  for (const ch of s) w += cells(ch.codePointAt(0) ?? 0);
  return w;
};

/** The input line as drawn: a pasted tab shows as one space, so `width` matches the screen. */
const shown = (line: string): string => line.replace(/\t/g, " ");

/** Text to write, and the rows between the first prompt row and the cursor row after it. */
export interface Drawn {
  out: string;
  rowsAbove: number;
}

/** Rows between the first prompt row and the cursor row, for a cursor at `cursor`. */
export function cursorRow(
  promptWidth: number,
  line: string,
  cursor: number,
  cols: number,
): number {
  const c = Math.max(1, cols);
  return Math.floor((promptWidth + width(line.slice(0, cursor))) / c);
}

/**
 * Redraws the prompt and `line` from the first prompt row, then puts the
 * cursor at `cursor`. `prompt` is the prompt as ANSI text; `promptWidth` is
 * its width in cells; `rowsAbove` is where the cursor is now.
 */
export function drawInput(p: {
  prompt: string;
  promptWidth: number;
  line: string;
  cursor: number;
  cols: number;
  rowsAbove: number;
}): Drawn {
  const cols = Math.max(1, p.cols);
  let out = p.rowsAbove > 0 ? `\x1b[${p.rowsAbove}A` : "";
  out += "\r\x1b[J" + p.prompt + renderRuns([{ text: shown(p.line) }]);
  const total = p.promptWidth + width(p.line);
  const at = p.promptWidth + width(p.line.slice(0, p.cursor));
  // After exactly a full row the cursor waits at the last column; a line
  // break moves it to the next row, where the math below expects it.
  const endRow = Math.floor(total / cols);
  if (total > 0 && total % cols === 0) out += "\r\n";
  const row = Math.floor(at / cols),
    col = at % cols;
  if (endRow > row) out += `\x1b[${endRow - row}A`;
  out += "\r" + (col > 0 ? `\x1b[${col}C` : "");
  return { out, rowsAbove: row };
}

/**
 * The typing fast path: when a key only added text at the end of the line,
 * gives just the new text to write. Gives null when the line needs a full redraw.
 */
export function appendTyped(p: {
  before: string;
  beforeCursor: number;
  line: string;
  cursor: number;
  actions: number;
  promptWidth: number;
  cols: number;
}): Drawn | null {
  if (
    p.actions > 0 ||
    p.beforeCursor !== p.before.length ||
    p.cursor !== p.line.length ||
    !p.line.startsWith(p.before) ||
    p.line.length <= p.before.length
  )
    return null;
  const cols = Math.max(1, p.cols);
  const total = p.promptWidth + width(p.line);
  let out = renderRuns([{ text: shown(p.line.slice(p.before.length)) }]);
  if (total % cols === 0) out += "\r\n";
  return { out, rowsAbove: Math.floor(total / cols) };
}

/** Shown in #term when xterm.js cannot start. */
export const START_ERROR = "The terminal could not start. Reload the page.";

/** How long to wait for the web font before opening the terminal anyway. */
export const FONT_WAIT_MS = 2000;

/** Copies text: the Clipboard API, or a hidden textarea when there is no secure context (D16). */
async function copyText(text: string, refocus: () => void): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back below.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing more to try.
  }
  ta.remove();
  refocus();
}

export function createTerminal(opts: TerminalOptions): GameTerminal {
  const { container, engine } = opts;
  const root = document.documentElement;
  const term = new Terminal({
    screenReaderMode: true,
    cursorBlink: true,
    drawBoldTextInBrightColors: false,
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: themeFromCss(getComputedStyle(root)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const editor = createLineEditor({
    history: () => engine.state.hist,
    complete: (value, cursor) => engine.complete(value, cursor),
  });

  // Rows between the first prompt row and the cursor row.
  let rowsAbove = 0;

  const promptText = () =>
    engine
      .prompt()
      .map((r) => r.text)
      .join("");

  /** Draws the prompt and `line` with the cursor at `cursor`. */
  function draw(line: string, cursor: number): string {
    const d = drawInput({
      prompt: renderRuns(engine.prompt()),
      promptWidth: width(promptText()),
      line,
      cursor,
      cols: term.cols,
      rowsAbove,
    });
    rowsAbove = d.rowsAbove;
    return d.out;
  }

  const redraw = () => term.write(draw(editor.line, editor.cursor));

  /** Leaves the input rows as they are and moves to a new line below them. */
  function endInput(line: string, suffix = ""): string {
    const out = draw(line, line.length) + suffix + "\r\n";
    rowsAbove = 0;
    return out;
  }

  const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

  /** Lines of an input that is not complete yet (shown with `> `). */
  let kept: string[] = [];

  const chunks = createChunkRenderer();

  /** One action that does not run a command (the listing, Ctrl-C, Ctrl-L). */
  function runOne(a: EditorAction): string {
    if (a.type === "interrupt") {
      const out = endInput(a.line, "^C");
      kept = [];
      engine.cancelInput();
      return out;
    }
    if (a.type === "clear") {
      rowsAbove = 0;
      return CLEAR;
    }
    if (a.type === "submit") return "";
    let out = endInput(a.line);
    out += renderLines([
      { style: "dim", runs: [{ text: a.items.join("  ") }] },
    ]);
    return out;
  }

  /** The editor actions that do not run a command, as one string. */
  const run = (actions: EditorAction[]): string =>
    actions.map((a) => runOne(a)).join("");

  /** True while an input runs: keys that arrive then wait (B15, this phase has no keyboard reads). */
  let running = false;
  const waiting: string[] = [];

  /**
   * Runs the editor actions in order. A complete input goes to the engine; its
   * output is written as it comes (`output`), then its game lines.
   */
  async function perform(actions: EditorAction[]): Promise<void> {
    let out = "";
    for (const a of actions) {
      if (a.type !== "submit") {
        out += runOne(a);
        continue;
      }
      out += endInput(a.line);
      kept.push(a.line);
      const text = kept.join("\n");
      if (!engine.isComplete(text)) {
        // Draw `> ` at once, so a pasted multi-line input keeps its order.
        out += renderRuns(engine.prompt());
        continue;
      }
      kept = [];
      engine.setColumns(term.cols);
      term.write(out);
      out = "";
      chunks.reset();
      const res = await engine.execute(text);
      out += chunks.finish();
      out += renderLines(res.lines);
      opts.onResult(res);
    }
    if (out) term.write(out);
  }

  /** Handles one piece of typed or pasted text. */
  async function handle(data: string): Promise<void> {
    const before = editor.line,
      beforeCursor = editor.cursor;
    const actions = editor.input(data);
    // Typing at the end of the line: write just the new text.
    const typed = appendTyped({
      before,
      beforeCursor,
      line: editor.line,
      cursor: editor.cursor,
      actions: actions.length,
      promptWidth: width(promptText()),
      cols: term.cols,
    });
    if (typed) {
      rowsAbove = typed.rowsAbove;
      term.write(typed.out);
      return;
    }
    if (!actions.some((a) => a.type === "submit")) {
      term.write(run(actions) + draw(editor.line, editor.cursor));
      return;
    }
    running = true;
    try {
      await perform(actions);
    } finally {
      running = false;
    }
    term.write(draw(editor.line, editor.cursor));
    const next = waiting.shift();
    if (next !== undefined) await handle(next);
  }

  term.onData((data) => {
    if (running) {
      waiting.push(data);
      return;
    }
    void handle(data);
  });

  function focusNext(): void {
    const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = all.find(
      (el) =>
        !container.contains(el) &&
        container.compareDocumentPosition(el) &
          Node.DOCUMENT_POSITION_FOLLOWING &&
        !el.closest("[hidden]") &&
        el.getClientRects().length > 0,
    );
    if (next) next.focus();
    else term.blur();
  }

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const mod = ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey;
    if (ev.key === "Escape" && !mod) {
      ev.preventDefault();
      focusNext();
      return false;
    }
    const k = ev.key.toLowerCase();
    if (
      ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      k === "c" &&
      term.hasSelection()
    ) {
      ev.preventDefault();
      void copyText(term.getSelection(), () => term.focus());
      term.clearSelection();
      return false;
    }
    // Ctrl-V and Cmd-V: let the browser paste; xterm.js reads the paste event.
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && k === "v") return false;
    return true;
  });

  // The theme follows light and dark mode (D17).
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const retheme = () => {
    term.options.theme = themeFromCss(getComputedStyle(root));
  };
  scheme.addEventListener("change", retheme);

  const refit = () => {
    if (!term.element) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    rowsAbove = cursorRow(
      width(promptText()),
      editor.line,
      editor.cursor,
      term.cols,
    );
    redraw();
  };

  // Intro and first prompt. xterm.js keeps writes made before open().
  term.write(renderLines(opts.intro));
  redraw();

  // Open after the fonts load, so the cell grid is measured with JetBrains
  // Mono. A slow or blocked font server delays this by FONT_WAIT_MS at most.
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
    .fonts;
  const fontWait = fonts
    ? Promise.race([
        fonts.ready,
        new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
      ])
    : Promise.resolve();
  void fontWait
    .catch(() => undefined)
    .then(() => {
      term.open(container);
      refit();
      new ResizeObserver(() => refit()).observe(container);
      if (window.matchMedia("(pointer:fine)").matches) term.focus();
    })
    .catch((e: unknown) => {
      console.error("The terminal could not start:", e);
      const msg = document.createElement("p");
      msg.className = "term-error";
      msg.setAttribute("role", "alert");
      msg.textContent = START_ERROR;
      container.replaceChildren(msg);
    });

  return {
    output(event) {
      if (event.kind === "clear") {
        chunks.reset();
        rowsAbove = 0;
        term.write(CLEAR);
        return;
      }
      const text = chunks.push(event.chunk);
      if (text) term.write(text);
    },
    print(lines) {
      let out = rowsAbove > 0 ? `\x1b[${rowsAbove}A` : "";
      out += "\r\x1b[J" + renderLines(lines);
      rowsAbove = 0;
      term.write(out + draw(editor.line, editor.cursor));
    },
    clear() {
      rowsAbove = 0;
      term.write(CLEAR + draw(editor.line, editor.cursor));
    },
    restart(lines) {
      // The engine forgot an unfinished input when it reset; so does the terminal.
      kept = [];
      rowsAbove = 0;
      term.write(CLEAR + renderLines(lines) + draw(editor.line, editor.cursor));
    },
    setLine(text) {
      editor.set(text);
      redraw();
    },
    key(k) {
      let out = "";
      if (k === "tab") out = run(editor.complete());
      else if (k === "up") editor.historyMove(-1);
      else if (k === "down") editor.historyMove(1);
      else editor.insert(k);
      term.write(out + draw(editor.line, editor.cursor));
    },
    focus() {
      term.focus();
    },
  };
}

/**
 * The extra-keys bar. A touch or mouse press acts on pointerdown and keeps
 * focus in the terminal, so the soft keyboard stays open. A keyboard or
 * switch press (a click with detail 0) acts on click and leaves focus on
 * the key, so the user can press it again.
 */
export function bindExtraKeys(
  bar: HTMLElement,
  terminal: Pick<GameTerminal, "key" | "focus">,
): void {
  const keyOf = (e: Event) =>
    (e.target as Element | null)?.closest<HTMLElement>("button[data-k]");
  bar.addEventListener("pointerdown", (e) => {
    const b = keyOf(e);
    if (!b) return;
    e.preventDefault();
    terminal.key(b.dataset.k ?? "");
    terminal.focus();
  });
  bar.addEventListener("click", (e) => {
    if (e.detail !== 0) return; // A pointer press, handled on pointerdown.
    const b = keyOf(e);
    if (!b) return;
    terminal.key(b.dataset.k ?? "");
  });
}

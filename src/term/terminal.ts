// The xterm.js terminal: prompt, line edit, history, Tab completion, Ctrl-C,
// Ctrl-L, paste, copy, and Esc to leave (D2, D16, D16b, D16c). Keys go to
// the line editor; Enter runs the line through the engine; output runs are
// written as ANSI codes (D17).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { Engine, ExecResult } from "../engine/index";
import type { OutLine } from "../engine/output";
import { renderLines, renderRuns, themeFromCss } from "./ansi";
import { createLineEditor } from "./lineEditor";
import type { EditorAction } from "./lineEditor";

export interface GameTerminal {
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
const width = (s: string): number => {
  let w = 0;
  for (const ch of s) w += cells(ch.codePointAt(0) ?? 0);
  return w;
};

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
    const cols = Math.max(1, term.cols);
    let out = rowsAbove > 0 ? `\x1b[${rowsAbove}A` : "";
    out +=
      "\r\x1b[J" + renderRuns(engine.prompt()) + renderRuns([{ text: line }]);
    const promptW = width(promptText());
    const total = promptW + width(line);
    const at = promptW + width(line.slice(0, cursor));
    // After exactly a full row the cursor waits at the last column; a line
    // break moves it to the next row, where the math below expects it.
    const endRow = Math.floor(total / cols);
    if (total > 0 && total % cols === 0) out += "\r\n";
    const row = Math.floor(at / cols),
      col = at % cols;
    if (endRow > row) out += `\x1b[${endRow - row}A`;
    out += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    rowsAbove = row;
    return out;
  }

  const redraw = () => term.write(draw(editor.line, editor.cursor));

  /** Leaves the input rows as they are and moves to a new line below them. */
  function endInput(line: string, suffix = ""): string {
    const out = draw(line, line.length) + suffix + "\r\n";
    rowsAbove = 0;
    return out;
  }

  const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

  function run(actions: EditorAction[]): string {
    let out = "";
    for (const a of actions) {
      if (a.type === "submit") {
        out += endInput(a.line);
        const res = engine.execute(a.line);
        if (res.cleared) out += CLEAR;
        out += renderLines(res.lines);
        opts.onResult(res);
      } else if (a.type === "interrupt") {
        out += endInput(a.line, "^C");
      } else if (a.type === "clear") {
        out += CLEAR;
        rowsAbove = 0;
      } else {
        out += endInput(a.line);
        out += renderLines([
          { style: "dim", runs: [{ text: a.items.join("  ") }] },
        ]);
      }
    }
    return out;
  }

  term.onData((data) => {
    const before = editor.line,
      beforeCursor = editor.cursor;
    const actions = editor.input(data);
    if (
      !actions.length &&
      beforeCursor === before.length &&
      editor.cursor === editor.line.length &&
      editor.line.startsWith(before) &&
      editor.line.length > before.length
    ) {
      // Typing at the end of the line: write just the new text.
      const added = editor.line.slice(before.length);
      const cols = Math.max(1, term.cols);
      const total = width(promptText()) + width(editor.line);
      let out = renderRuns([{ text: added }]);
      if (total % cols === 0) out += "\r\n";
      rowsAbove = Math.floor(total / cols);
      term.write(out);
      return;
    }
    term.write(run(actions) + draw(editor.line, editor.cursor));
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
    const cols = Math.max(1, term.cols);
    const at = width(promptText()) + width(editor.line.slice(0, editor.cursor));
    rowsAbove = Math.floor(at / cols);
    redraw();
  };

  // Intro and first prompt. xterm.js keeps writes made before open().
  term.write(renderLines(opts.intro));
  redraw();

  // Open after the fonts load, so the cell grid is measured with JetBrains Mono.
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } })
    .fonts;
  void (fonts ? fonts.ready : Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      term.open(container);
      refit();
      new ResizeObserver(() => refit()).observe(container);
      if (window.matchMedia("(pointer:fine)").matches) term.focus();
    })
    .catch((e: unknown) => {
      console.error("The terminal could not start:", e);
    });

  return {
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

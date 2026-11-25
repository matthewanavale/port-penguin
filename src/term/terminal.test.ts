// @vitest-environment jsdom
// AC8 and AC9: the xterm.js layer. The cursor math for wrapped lines, the
// typing fast path, the row recompute on resize, the extra-keys routing,
// Esc, Ctrl-C copy, screenReaderMode, and the start-up states. xterm.js is
// replaced by a fake that records what the terminal writes.
//
// Contract (src/term/terminal.ts):
//   width(s), cursorRow(promptWidth, line, cursor, cols)
//   drawInput({ prompt, promptWidth, line, cursor, cols, rowsAbove }) -> { out, rowsAbove }
//   appendTyped({ before, beforeCursor, line, cursor, actions, promptWidth, cols }) -> { out, rowsAbove } | null
//   createTerminal(opts) -> GameTerminal
//   bindExtraKeys(bar, terminal)
//   START_ERROR, FONT_WAIT_MS
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/index";
import type { Engine } from "../engine/index";
import {
  appendTyped,
  bindExtraKeys,
  createTerminal,
  cursorRow,
  drawInput,
  FONT_WAIT_MS,
  START_ERROR,
  width,
} from "./terminal";

const fake = vi.hoisted(() => {
  class FakeTerminal {
    static all: FakeTerminal[] = [];
    static openError: Error | null = null;
    options: Record<string, unknown>;
    cols = 80;
    element: HTMLElement | undefined;
    written = "";
    selection = "";
    dataHandler: ((d: string) => void) | undefined;
    keyHandler: ((ev: KeyboardEvent) => boolean) | undefined;
    focus = vi.fn();
    blur = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      FakeTerminal.all.push(this);
    }
    loadAddon() {}
    onData(cb: (d: string) => void) {
      this.dataHandler = cb;
      return { dispose() {} };
    }
    write(s: string) {
      this.written += s;
    }
    attachCustomKeyEventHandler(fn: (ev: KeyboardEvent) => boolean) {
      this.keyHandler = fn;
    }
    open(el: HTMLElement) {
      if (FakeTerminal.openError) throw FakeTerminal.openError;
      this.element = document.createElement("div");
      this.element.className = "xterm";
      el.appendChild(this.element);
    }
    hasSelection() {
      return this.selection !== "";
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = "";
    }
  }
  return { FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: fake.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

const FakeTerminal = fake.FakeTerminal;
type Fake = InstanceType<typeof FakeTerminal>;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  fonts: { ready: Promise<unknown> } = { ready: Promise.resolve() },
) {
  document.body.innerHTML = `
    <section class="term"><div id="term"></div></section>
    <button id="after" type="button">After</button>`;
  (document as unknown as { fonts: unknown }).fonts = fonts;
  const engine: Engine = createEngine({ storage: memoryStorage() });
  engine.start();
  const container = document.getElementById("term") as HTMLElement;
  const onResult = vi.fn();
  const execute = vi.spyOn(engine, "execute");
  const t = createTerminal({ container, engine, intro: [], onResult });
  const x = FakeTerminal.all[FakeTerminal.all.length - 1] as Fake;
  return { engine, container, onResult, execute, t, x };
}

const keydown = (init: Partial<KeyboardEvent>) =>
  ({
    type: "keydown",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...init,
  }) as unknown as KeyboardEvent;

beforeEach(() => {
  FakeTerminal.all = [];
  FakeTerminal.openError = null;
  const w = window as unknown as Record<string, unknown>;
  w.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  w.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // jsdom lays nothing out; give every element one box so focus can find it.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("width", () => {
  it("counts wide characters as two cells and joiners as none", () => {
    expect(width("abc")).toBe(3);
    expect(width("日本")).toBe(4);
    expect(width("🐧")).toBe(2);
    expect(width("é")).toBe(1);
  });
});

describe("drawInput: the prompt and line redraw", () => {
  const base = { prompt: "$ ", promptWidth: 2, cols: 10, rowsAbove: 0 };

  it("draws a short line and puts the cursor after it", () => {
    const d = drawInput({ ...base, line: "ls", cursor: 2 });
    expect(d.out).toBe("\r\x1b[J$ ls\r\x1b[4C");
    expect(d.rowsAbove).toBe(0);
  });

  it("moves up to the first prompt row before it redraws", () => {
    const d = drawInput({ ...base, rowsAbove: 2, line: "ls", cursor: 0 });
    expect(d.out.startsWith("\x1b[2A\r\x1b[J")).toBe(true);
  });

  it("breaks the line when the text fills a row exactly", () => {
    // 2 + 8 = 10 cells: the cursor goes to the start of the next row.
    const d = drawInput({ ...base, line: "abcdefgh", cursor: 8 });
    expect(d.out).toBe("\r\x1b[J$ abcdefgh\r\n\r");
    expect(d.rowsAbove).toBe(1);
  });

  it("puts the cursor in the first row of a wrapped line", () => {
    // 2 + 12 = 14 cells: two rows. Cursor at 4 is cell 6 of row 0.
    const d = drawInput({ ...base, line: "abcdefghijkl", cursor: 4 });
    expect(d.out).toBe("\r\x1b[J$ abcdefghijkl\x1b[1A\r\x1b[6C");
    expect(d.rowsAbove).toBe(0);
  });

  it("puts the cursor in the second row of a wrapped line", () => {
    const d = drawInput({ ...base, line: "abcdefghijkl", cursor: 11 });
    // Cell 13: row 1, column 3. The text ends in row 1 too, so no move up.
    expect(d.out).toBe("\r\x1b[J$ abcdefghijkl\r\x1b[3C");
    expect(d.rowsAbove).toBe(1);
  });

  it("counts wide characters as two cells", () => {
    const d = drawInput({ ...base, line: "日本語x", cursor: 3 });
    // 2 + 6 = 8 cells before the cursor.
    expect(d.out.endsWith("\r\x1b[8C")).toBe(true);
    expect(d.rowsAbove).toBe(0);
  });

  it("shows a pasted tab as one space, the cell width counts it as", () => {
    const d = drawInput({ ...base, line: "a\tb", cursor: 3 });
    expect(d.out).toBe("\r\x1b[J$ a b\r\x1b[5C");
  });

  it("treats a zero column count as one column", () => {
    const d = drawInput({ ...base, cols: 0, line: "a", cursor: 1 });
    expect(d.rowsAbove).toBe(3);
  });
});

describe("appendTyped: the typing fast path", () => {
  const base = { promptWidth: 2, cols: 10, actions: 0 };

  it("writes only the new text when typing at the end of the line", () => {
    const d = appendTyped({
      ...base,
      before: "l",
      beforeCursor: 1,
      line: "ls",
      cursor: 2,
    });
    expect(d).toEqual({ out: "s", rowsAbove: 0 });
  });

  it("adds a line break when the text fills the row exactly", () => {
    const d = appendTyped({
      ...base,
      before: "abcdefg",
      beforeCursor: 7,
      line: "abcdefgh",
      cursor: 8,
    });
    expect(d).toEqual({ out: "h\r\n", rowsAbove: 1 });
  });

  it("gives null when the cursor was not at the end", () => {
    expect(
      appendTyped({
        ...base,
        before: "ls",
        beforeCursor: 1,
        line: "lxs",
        cursor: 2,
      }),
    ).toBeNull();
  });

  it("gives null when the key made an action", () => {
    expect(
      appendTyped({
        ...base,
        actions: 1,
        before: "",
        beforeCursor: 0,
        line: "a",
        cursor: 1,
      }),
    ).toBeNull();
  });

  it("gives null when the line got shorter or did not change", () => {
    expect(
      appendTyped({
        ...base,
        before: "ls",
        beforeCursor: 2,
        line: "l",
        cursor: 1,
      }),
    ).toBeNull();
    expect(
      appendTyped({
        ...base,
        before: "ls",
        beforeCursor: 2,
        line: "ls",
        cursor: 2,
      }),
    ).toBeNull();
  });

  it("shows a pasted tab as one space", () => {
    const d = appendTyped({
      ...base,
      before: "a",
      beforeCursor: 1,
      line: "a\tb",
      cursor: 3,
    });
    expect(d?.out).toBe(" b");
  });
});

describe("cursorRow: the row recompute after a resize", () => {
  it("gives the cursor row for the new column count", () => {
    expect(cursorRow(2, "abcdefghijkl", 12, 80)).toBe(0);
    expect(cursorRow(2, "abcdefghijkl", 12, 10)).toBe(1);
    expect(cursorRow(2, "abcdefghijkl", 12, 5)).toBe(2);
    expect(cursorRow(2, "abcdefghijkl", 3, 5)).toBe(1);
  });
});

describe("createTerminal (AC8, AC9)", () => {
  it("runs xterm.js with screenReaderMode on", () => {
    const { x } = setup();
    expect(x.options.screenReaderMode).toBe(true);
  });

  it("opens in #term after the fonts load", async () => {
    const { x, container } = setup();
    await flush();
    expect(x.element).toBeDefined();
    expect(container.contains(x.element as HTMLElement)).toBe(true);
  });

  it("runs a typed line through the engine on Enter", async () => {
    const { x, execute, onResult } = setup();
    x.dataHandler?.("pwd\r");
    expect(execute).toHaveBeenCalledWith("pwd");
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("extra key Tab completes the line", () => {
    const { x, t, execute } = setup();
    x.dataHandler?.("pw");
    t.key("tab");
    x.dataHandler?.("\r");
    expect(execute).toHaveBeenLastCalledWith("pwd ");
  });

  it("extra keys Up and Down move through the history", () => {
    const { x, t, execute } = setup();
    x.dataHandler?.("pwd\r");
    x.dataHandler?.("ls\r");
    t.key("up");
    t.key("up");
    t.key("down");
    x.dataHandler?.("\r");
    expect(execute).toHaveBeenLastCalledWith("ls");
  });

  it("extra keys for symbols insert their text at the cursor", () => {
    const { x, t, execute } = setup();
    x.dataHandler?.("ls ");
    for (const k of ["-", "/", "~", "|", ">", "$"]) t.key(k);
    x.dataHandler?.("\r");
    expect(execute).toHaveBeenLastCalledWith("ls -/~|>$");
  });

  it("Esc moves focus to the next control after the terminal", () => {
    const { x } = setup();
    const ev = keydown({ key: "Escape" });
    expect(x.keyHandler?.(ev)).toBe(false);
    expect(document.activeElement?.id).toBe("after");
  });

  it("Esc with a modifier stays in the terminal", () => {
    const { x } = setup();
    expect(x.keyHandler?.(keydown({ key: "Escape", shiftKey: true }))).toBe(
      true,
    );
  });

  it("Ctrl-C with a selection copies it and does not interrupt", () => {
    const { x, execute } = setup();
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    x.selection = "hello";
    expect(x.keyHandler?.(keydown({ key: "c", ctrlKey: true }))).toBe(false);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(x.selection).toBe("");
    expect(execute).not.toHaveBeenCalled();
  });

  it("Ctrl-C with no selection goes to the line editor", () => {
    const { x } = setup();
    expect(x.keyHandler?.(keydown({ key: "c", ctrlKey: true }))).toBe(true);
  });

  it("opens even when the web font never loads (G-UX-4)", async () => {
    vi.useFakeTimers();
    const { x } = setup({ ready: new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
    expect(x.element).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(x.element).toBeDefined();
  });

  it("shows a message in #term when xterm.js cannot start (G-UX-1)", async () => {
    FakeTerminal.openError = new Error("no canvas");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = setup();
    await flush();
    const msg = container.querySelector('[role="alert"]');
    expect(msg).not.toBeNull();
    expect(msg?.textContent).toBe(START_ERROR);
    expect(START_ERROR).toMatch(/could not start.*Reload/);
  });
});

describe("bindExtraKeys (AC8, G-A11Y-1)", () => {
  function bar() {
    document.body.innerHTML = `<div id="keys">
      <button type="button" data-k="tab">Tab</button>
      <button type="button" data-k="-">-</button></div>`;
    const el = document.getElementById("keys") as HTMLElement;
    const t = { key: vi.fn(), focus: vi.fn() };
    bindExtraKeys(el, t);
    const btn = (k: string) =>
      el.querySelector(`[data-k="${k}"]`) as HTMLButtonElement;
    return { t, btn };
  }

  it("a touch press acts once, on pointerdown, and keeps the terminal focused", () => {
    const { t, btn } = bar();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    btn("-").dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // The click that follows a pointer press has detail 1.
    btn("-").dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(t.key).toHaveBeenCalledTimes(1);
    expect(t.key).toHaveBeenCalledWith("-");
    expect(t.focus).toHaveBeenCalledTimes(1);
  });

  it("Enter or Space on a focused key acts on click (detail 0)", () => {
    const { t, btn } = bar();
    btn("tab").focus();
    btn("tab").dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 0 }),
    );
    expect(t.key).toHaveBeenCalledTimes(1);
    expect(t.key).toHaveBeenCalledWith("tab");
  });

  it("ignores presses outside a key", () => {
    const { t } = bar();
    const el = document.getElementById("keys") as HTMLElement;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(t.key).not.toHaveBeenCalled();
  });
});

// AC1, AC10: continuation input. The terminal keeps lines until
// `engine.isComplete` says the input is complete, then calls `execute` with
// the lines joined by a newline. It always draws `engine.prompt()`.
describe("continuation input (AC1, AC10)", () => {
  const plainWritten = (x: Fake) =>
    // eslint-disable-next-line no-control-regex
    x.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  it("shows > twice for an if over three lines, then the output", () => {
    const { x, execute } = setup();
    x.dataHandler?.("if true; then\r");
    x.dataHandler?.("echo seen\r");
    x.dataHandler?.("fi\r");
    const shown = plainWritten(x);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("if true; then\necho seen\nfi");
    const tail = shown.slice(shown.lastIndexOf("if true; then"));
    expect(tail.match(/(^|\n)> /g)?.length).toBe(2);
    expect(tail).toContain("seen");
    expect(tail.lastIndexOf("seen")).toBeGreaterThan(tail.lastIndexOf("> "));
  });

  it("does not call execute while the input is incomplete", () => {
    const { x, execute } = setup();
    x.dataHandler?.("echo 'open\r");
    x.dataHandler?.("close'\r");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo 'open\nclose'");
  });

  it("Ctrl-C at > drops the lines, prints ^C, and sets $? to 130", () => {
    const { x, engine, execute } = setup();
    const cancel = vi.spyOn(engine, "cancelInput");
    x.dataHandler?.("if true; then\r");
    x.dataHandler?.("\x03");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(plainWritten(x)).toContain("^C");
    expect(engine.state.lastCode).toBe(130);
    x.dataHandler?.("echo $?\r");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo $?");
  });

  it("Ctrl-C at the main prompt prints ^C and sets $? to 130", () => {
    const { x, engine } = setup();
    x.dataHandler?.("\x03");
    expect(plainWritten(x)).toContain("^C");
    expect(engine.state.lastCode).toBe(130);
  });

  it("passes the column count to the engine as COLUMNS", () => {
    const { x, engine } = setup();
    x.cols = 40;
    const res = engine.execute("echo $COLUMNS");
    expect(res.chunks.map((c) => c.text).join("")).toBe("80\n");
    x.dataHandler?.("echo $COLUMNS\r");
    expect(plainWritten(x)).toContain("40");
  });

  it("shows the save-failure line once when save() fails", () => {
    document.body.innerHTML = `<section class="term"><div id="term"></div></section>`;
    (document as unknown as { fonts: unknown }).fonts = {
      ready: Promise.resolve(),
    };
    const engine = createEngine({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota full");
        },
      },
    });
    engine.start();
    createTerminal({
      container: document.getElementById("term") as HTMLElement,
      engine,
      intro: [],
      onResult: vi.fn(),
    });
    const x = FakeTerminal.all[FakeTerminal.all.length - 1] as Fake;
    x.dataHandler?.("pwd\r");
    expect(plainWritten(x).match(/progress could not be saved/g)?.length).toBe(
      1,
    );
  });
});

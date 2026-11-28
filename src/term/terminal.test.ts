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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/index";
import type { Engine } from "../engine/index";
import type { GameTerminal } from "./terminal";
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
    /** Set by a test: xterm is slow, and the completion callbacks wait. */
    holdWrites = false;
    pending: (() => void)[] = [];
    write(s: string, cb?: () => void) {
      this.written += s;
      if (!cb) return;
      if (this.holdWrites) this.pending.push(cb);
      else cb();
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

/** Sends typed text to the terminal and lets the engine finish an input it starts. */
const send = async (x: { dataHandler?: (d: string) => void }, data: string) => {
  x.dataHandler?.(data);
  await flush();
};

async function setup(
  fonts: { ready: Promise<unknown> } = { ready: Promise.resolve() },
) {
  document.body.innerHTML = `
    <section class="term"><div id="term"></div></section>
    <button id="after" type="button">After</button>`;
  (document as unknown as { fonts: unknown }).fonts = fonts;
  const sink: { term?: GameTerminal } = {};
  const engine: Engine = createEngine({
    storage: memoryStorage(),
    onOutput: (e) => sink.term?.output(e),
    onRead: (req) => sink.term?.read(req) ?? Promise.resolve(null),
  });
  await engine.start();
  const container = document.getElementById("term") as HTMLElement;
  const onResult = vi.fn();
  const execute = vi.spyOn(engine, "execute");
  const t = createTerminal({ container, engine, intro: [], onResult });
  sink.term = t;
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
  it("runs xterm.js with screenReaderMode on", async () => {
    const { x } = await setup();
    expect(x.options.screenReaderMode).toBe(true);
  });

  it("opens in #term after the fonts load", async () => {
    const { x, container } = await setup();
    await flush();
    expect(x.element).toBeDefined();
    expect(container.contains(x.element as HTMLElement)).toBe(true);
  });

  it("runs a typed line through the engine on Enter", async () => {
    const { x, execute, onResult } = await setup();
    await send(x, "pwd\r");
    expect(execute).toHaveBeenCalledWith("pwd");
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("writes the output of a command as the engine sends it (B15)", async () => {
    const { x } = await setup();
    await send(x, "echo hello\r");
    // eslint-disable-next-line no-control-regex
    const shown = x.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(shown).toContain("hello\r\n");
    expect(shown.lastIndexOf("hello")).toBeGreaterThan(
      shown.indexOf("echo hello"),
    );
  });

  it("clears the screen when the engine sends a clear event", async () => {
    const { x } = await setup();
    await send(x, "echo before; clear; echo after\r");
    const at = x.written.lastIndexOf("\x1b[H\x1b[2J\x1b[3J");
    expect(at).toBeGreaterThan(-1);
    expect(x.written.slice(at)).toContain("after");
    expect(x.written.slice(at)).not.toContain("before");
  });

  it("keeps keys typed while an input runs and acts on them after it", async () => {
    const { x, execute } = await setup();
    x.dataHandler?.("echo one\r");
    x.dataHandler?.("echo two\r");
    await flush();
    await flush();
    expect(execute.mock.calls.map((c) => c[0])).toEqual([
      "echo one",
      "echo two",
    ]);
  });

  it("Ctrl-C during sleep 100 echoes ^C and ends the command at once (B6)", async () => {
    const { x, engine, execute } = await setup();
    x.dataHandler?.("sleep 100\r");
    await flush();
    expect(engine.busy()).toBe(true);
    const before = x.written.length;
    x.dataHandler?.("\x03");
    await flush();
    await flush();
    expect(x.written.slice(before)).toContain("^C\r\n");
    expect(engine.busy()).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(engine.state.lastCode).toBe(130);
  });

  it("Ctrl-Z and Ctrl-\\ echo ^Z and ^\\ and send TSTP and QUIT (B6)", async () => {
    const { x, engine } = await setup();
    const signal = vi.spyOn(engine, "signal");
    for (const [key, echo, sig] of [
      ["\x1a", "^Z", "TSTP"],
      ["\x1c", "^\\", "QUIT"],
    ]) {
      x.dataHandler?.("sleep 100\r");
      await flush();
      const before = x.written.length;
      x.dataHandler?.(key);
      await flush();
      await flush();
      expect(x.written.slice(before)).toContain(echo);
      expect(signal).toHaveBeenLastCalledWith(sig);
    }
  });

  it("a signal key empties the keys typed ahead (B24)", async () => {
    const { x, execute } = await setup();
    x.dataHandler?.("sleep 100\r");
    await flush();
    x.dataHandler?.("echo ahead\r");
    x.dataHandler?.("\x03");
    await flush();
    await flush();
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["sleep 100"]);
  });

  it("extra key Tab completes the line", async () => {
    const { x, t, execute } = await setup();
    await send(x, "pw");
    t.key("tab");
    await send(x, "\r");
    expect(execute).toHaveBeenLastCalledWith("pwd ");
  });

  it("extra keys Up and Down move through the history", async () => {
    const { x, t, execute } = await setup();
    await send(x, "pwd\r");
    await send(x, "ls\r");
    t.key("up");
    t.key("up");
    t.key("down");
    await send(x, "\r");
    expect(execute).toHaveBeenLastCalledWith("ls");
  });

  it("extra keys for symbols insert their text at the cursor", async () => {
    const { x, t, execute } = await setup();
    await send(x, "ls ");
    for (const k of ["-", "/", "~", "|", ">", "$"]) t.key(k);
    await send(x, "\r");
    expect(execute).toHaveBeenLastCalledWith("ls -/~|>$");
  });

  it("Esc moves focus to the next control after the terminal", async () => {
    const { x } = await setup();
    const ev = keydown({ key: "Escape" });
    expect(x.keyHandler?.(ev)).toBe(false);
    expect(document.activeElement?.id).toBe("after");
  });

  it("Esc with a modifier stays in the terminal", async () => {
    const { x } = await setup();
    expect(x.keyHandler?.(keydown({ key: "Escape", shiftKey: true }))).toBe(
      true,
    );
  });

  it("Ctrl-C with a selection copies it and does not interrupt", async () => {
    const { x, execute } = await setup();
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    x.selection = "hello";
    expect(x.keyHandler?.(keydown({ key: "c", ctrlKey: true }))).toBe(false);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(x.selection).toBe("");
    expect(execute).not.toHaveBeenCalled();
  });

  it("Ctrl-C with no selection goes to the line editor", async () => {
    const { x } = await setup();
    expect(x.keyHandler?.(keydown({ key: "c", ctrlKey: true }))).toBe(true);
  });

  it("opens even when the web font never loads (G-UX-4)", async () => {
    vi.useFakeTimers();
    const { x } = await setup({ ready: new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
    expect(x.element).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(x.element).toBeDefined();
  });

  it("shows a message in #term when xterm.js cannot start (G-UX-1)", async () => {
    FakeTerminal.openError = new Error("no canvas");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = await setup();
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

  it("shows > twice for an if over three lines, then the output", async () => {
    const { x, execute } = await setup();
    await send(x, "if true; then\r");
    await send(x, "echo seen\r");
    await send(x, "fi\r");
    const shown = plainWritten(x);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("if true; then\necho seen\nfi");
    const tail = shown.slice(shown.lastIndexOf("if true; then"));
    expect(tail.match(/(^|\n)> /g)?.length).toBe(2);
    expect(tail).toContain("seen");
    expect(tail.lastIndexOf("seen")).toBeGreaterThan(tail.lastIndexOf("> "));
  });

  it("does not call execute while the input is incomplete", async () => {
    const { x, execute } = await setup();
    await send(x, "echo 'open\r");
    await send(x, "close'\r");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo 'open\nclose'");
  });

  it("Ctrl-C at > drops the lines, prints ^C, and sets $? to 130", async () => {
    const { x, engine, execute } = await setup();
    const cancel = vi.spyOn(engine, "cancelInput");
    await send(x, "if true; then\r");
    await send(x, "\x03");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(plainWritten(x)).toContain("^C");
    expect(engine.state.lastCode).toBe(130);
    await send(x, "echo $?\r");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo $?");
  });

  it("Ctrl-C at the main prompt prints ^C and sets $? to 130", async () => {
    const { x, engine } = await setup();
    await send(x, "\x03");
    expect(plainWritten(x)).toContain("^C");
    expect(engine.state.lastCode).toBe(130);
  });

  it("drops the kept lines when the game restarts (G-COR-7)", async () => {
    const { x, engine, execute, t } = await setup();
    await send(x, "if true; then" + "\r");
    await engine.reset();
    t.restart([]);
    await send(x, "echo fresh" + "\r");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo fresh");
  });

  it("passes the column count to the engine as COLUMNS", async () => {
    const { x, engine } = await setup();
    x.cols = 40;
    const res = await engine.execute("echo $COLUMNS");
    expect(res.chunks.map((c) => c.text).join("")).toBe("80\n");
    await send(x, "echo $COLUMNS\r");
    expect(plainWritten(x)).toContain("40");
  });

  it("shows the save-failure line once when save() fails", async () => {
    document.body.innerHTML = `<section class="term"><div id="term"></div></section>`;
    (document as unknown as { fonts: unknown }).fonts = {
      ready: Promise.resolve(),
    };
    const sink: { term?: GameTerminal } = {};
    const engine = createEngine({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota full");
        },
      },
      onOutput: (e) => sink.term?.output(e),
    });
    await engine.start();
    sink.term = createTerminal({
      container: document.getElementById("term") as HTMLElement,
      engine,
      intro: [],
      onResult: vi.fn(),
    });
    const x = FakeTerminal.all[FakeTerminal.all.length - 1] as Fake;
    await send(x, "pwd\r");
    expect(plainWritten(x).match(/progress could not be saved/g)?.length).toBe(
      1,
    );
  });
});

// B4, B16, B17, B24, B27, B28: keyboard reads, hints, the live region, the
// control keys, and output flow control.
describe("keyboard input in the terminal (B4, B16, B17)", () => {
  const plain = (x: Fake) =>
    // eslint-disable-next-line no-control-regex
    x.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const live = (c: HTMLElement) =>
    c.querySelector('[aria-live="polite"]') as HTMLElement;

  it("lets read v take typed keys, with echo", async () => {
    const { x, engine } = await setup();
    x.dataHandler?.("read v; echo got-$v\r");
    await flush();
    expect(engine.busy()).toBe(true);
    const before = x.written.length;
    x.dataHandler?.("hi");
    expect(x.written.slice(before)).toContain("hi");
    x.dataHandler?.("\r");
    await flush();
    await flush();
    expect(engine.busy()).toBe(false);
    expect(plain(x)).toContain("got-hi");
  });

  it("shows the keyboard hint once, before the wait", async () => {
    const { x } = await setup();
    x.dataHandler?.("cat\r");
    await flush();
    const hint =
      "port-penguin: cat is reading the keyboard. Type input and press Enter; Ctrl-D ends the input, Ctrl-C stops cat.";
    expect(plain(x)).toContain(hint);
    x.dataHandler?.("\x04");
    await flush();
    await flush();
    x.dataHandler?.("cat\r");
    await flush();
    x.dataHandler?.("\x04");
    await flush();
    await flush();
    expect(plain(x).split(hint).length - 1).toBe(1);
  });

  it("shows no keyboard hint for a command in a script", async () => {
    const { x } = await setup();
    await send(x, "printf 'cat\\n' > s.sh\r");
    x.dataHandler?.("bash s.sh\r");
    await flush();
    x.dataHandler?.("\x04");
    await flush();
    await flush();
    expect(plain(x)).not.toContain("is reading the keyboard");
  });

  it("shows the not-finished hint once, before the first >", async () => {
    const { x } = await setup();
    const hint =
      "port-penguin: the command is not finished. Type the rest, or press Ctrl-C to cancel.";
    await send(x, "if true; then\r");
    await send(x, "\x03");
    await send(x, "if true; then\r");
    await send(x, "\x03");
    const shown = plain(x);
    expect(shown.split(hint).length - 1).toBe(1);
    expect(shown.indexOf(hint)).toBeLessThan(shown.indexOf("> "));
  });

  it("has one visually hidden live region", async () => {
    const { container } = await setup();
    const regions = container.querySelectorAll('[aria-live="polite"]');
    expect(regions.length).toBe(1);
    expect(regions[0].className).toBe("sr-only");
  });

  it("announces the not-finished text at >, once per prompt", async () => {
    const { x, container } = await setup();
    await send(x, "if true; then\r");
    expect(live(container).textContent).toBe(
      "Input not finished. Continue typing, or press Control C to cancel.",
    );
    live(container).textContent = "";
    await send(x, "echo a\r");
    // The same text is not said again at the same prompt.
    expect(live(container).textContent).toBe("");
  });

  it("announces that a command waits for the keyboard", async () => {
    const { x, container } = await setup();
    x.dataHandler?.("cat\r");
    await flush();
    expect(live(container).textContent).toBe(
      "cat is waiting for keyboard input.",
    );
    x.dataHandler?.("\x04");
    await flush();
    await flush();
  });

  it("Ctrl-D at an empty prompt prints exit and starts a new prompt (B27)", async () => {
    const { x, execute, engine } = await setup();
    await send(x, "\x04");
    expect(execute).toHaveBeenCalledWith("exit");
    expect(plain(x)).toContain("exit");
    expect(plain(x)).toContain("cadet@");
    // The history keeps no `exit` for Ctrl-D.
    expect(engine.state.hist).not.toContain("exit");
  });

  it("Ctrl-D on a non-empty prompt line deletes the character under the cursor (B27)", async () => {
    const { x, execute } = await setup();
    await send(x, "echo ab");
    await send(x, "\x1b[D\x1b[D");
    await send(x, "\x04");
    await send(x, "\r");
    expect(execute).toHaveBeenLastCalledWith("echo b");
  });

  it("echoes the keys typed during a command and runs a typed line after it (B24)", async () => {
    const { x, execute, engine } = await setup();
    x.dataHandler?.("sleep 100\r");
    await flush();
    const before = x.written.length;
    x.dataHandler?.("pwd");
    expect(x.written.slice(before)).toContain("pwd");
    x.dataHandler?.("\r");
    engine.signal("INT");
    await flush();
    await flush();
    // A signal from the engine does not empty the type-ahead; the key does.
    expect(execute.mock.calls.map((c) => c[0])).toEqual(["sleep 100", "pwd"]);
  });
});

describe("the control keys of the extra-keys bar (B28, AC13)", () => {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

  it("index.html has ^C and ^D first in the bar, with labels", () => {
    const keys = /<div class="keys"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    const first = [...keys.matchAll(/data-k="([^"]+)"/g)].map((m) => m[1]);
    expect(first.slice(0, 2)).toEqual(["ctrl-c", "ctrl-d"]);
    expect(keys).toContain('aria-label="Control C: stop the command"');
    expect(keys).toContain('aria-label="Control D: end of input"');
  });

  function wire(t: GameTerminal) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="keys"><button type="button" data-k="ctrl-c">^C</button><button type="button" data-k="ctrl-d">^D</button></div>`,
    );
    const bar = document.getElementById("keys") as HTMLElement;
    bindExtraKeys(bar, t);
    return (k: string) =>
      bar
        .querySelector(`[data-k="${k}"]`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  }

  it("^C stops sleep 100 with status 130", async () => {
    const { x, t, engine } = await setup();
    const press = wire(t);
    x.dataHandler?.("sleep 100\r");
    await flush();
    press("ctrl-c");
    await flush();
    await flush();
    expect(engine.busy()).toBe(false);
    expect(engine.state.lastCode).toBe(130);
  });

  it("^C at a prompt with typed text gives ^C and a new prompt", async () => {
    const { x, t, engine } = await setup();
    const press = wire(t);
    await send(x, "echo half");
    press("ctrl-c");
    await flush();
    expect(x.written).toContain("^C");
    expect(engine.state.lastCode).toBe(130);
  });

  it("^D ends cat", async () => {
    const { x, t, engine } = await setup();
    const press = wire(t);
    x.dataHandler?.("cat\r");
    await flush();
    x.dataHandler?.("abc\r");
    await flush();
    press("ctrl-d");
    await flush();
    await flush();
    expect(engine.busy()).toBe(false);
    expect(engine.state.lastCode).toBe(0);
  });

  it("^D at an empty prompt runs exit", async () => {
    const { t, execute } = await setup();
    const press = wire(t);
    press("ctrl-d");
    await flush();
    await flush();
    expect(execute).toHaveBeenCalledWith("exit");
  });
});

describe("output flow control (B15)", () => {
  it("gives a promise while xterm is more than 256 KB behind, and ends it when xterm catches up", async () => {
    const { x, t } = await setup();
    x.holdWrites = true;
    const chunk = (n: number) => ({
      kind: "chunk" as const,
      chunk: { stream: "stdout" as const, text: "a".repeat(n) },
    });
    expect(t.output(chunk(100 * 1024))).toBeUndefined();
    const held = t.output(chunk(200 * 1024));
    expect(held).toBeInstanceOf(Promise);
    let freed = false;
    void (held as Promise<void>).then(() => (freed = true));
    await flush();
    expect(freed).toBe(false);
    // xterm writes the chunks: 300 KB fall to 0.
    x.pending.splice(0).forEach((cb) => cb());
    await flush();
    expect(freed).toBe(true);
  });

  it("stops yes from growing the page memory: the engine waits for xterm", async () => {
    const { x, engine } = await setup();
    x.holdWrites = true;
    x.dataHandler?.("yes\r");
    await new Promise((r) => setTimeout(r, 50));
    const held = x.written.length;
    await new Promise((r) => setTimeout(r, 50));
    // xterm has not written; the engine wrote about 256 KB and waits.
    expect(x.written.length).toBe(held);
    expect(held).toBeLessThan(2 * 1024 * 1024);
    expect(engine.busy()).toBe(true);
    x.dataHandler?.("\x03");
    x.holdWrites = false;
    x.pending.splice(0).forEach((cb) => cb());
    await flush();
    await flush();
    expect(engine.busy()).toBe(false);
  });
});

// AC6: the line editor behind the xterm.js terminal. Each key gets an input
// line, a cursor position, and the expected line and cursor after the key.
// Keys arrive as the data strings xterm.js sends from onData.
//
// Contract (src/term/lineEditor.ts):
//   createLineEditor({ history, complete }) -> LineEditor
//   editor.line, editor.cursor
//   editor.set(line, cursor = line.length)   hint chips put a whole line in
//   editor.input(data): EditorAction[]       one key press, or a paste
//   editor.insert(text)                      extra-keys bar: text at the cursor
//   editor.historyMove(-1 | 1)               extra-keys bar: Up and Down
//   editor.complete(): EditorAction[]        extra-keys bar: Tab
// Esc (focus leaves the terminal) and Ctrl-C with a selection (copy) are
// handled by terminal.ts before the data reaches the editor (D16).
import { describe, expect, it, vi } from "vitest";
import { createLineEditor } from "./lineEditor";
import type { EditorAction } from "./lineEditor";

const KEY = {
  backspace: "\x7f",
  delete: "\x1b[3~",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  home: "\x1b[H",
  homeApp: "\x1bOH",
  homeVt: "\x1b[1~",
  end: "\x1b[F",
  endApp: "\x1bOF",
  endVt: "\x1b[4~",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlE: "\x05",
  ctrlK: "\x0b",
  ctrlL: "\x0c",
  ctrlU: "\x15",
  ctrlW: "\x17",
  tab: "\t",
  enter: "\r",
  esc: "\x1b",
  f1: "\x1bOP",
} as const;

const noComplete = () => ({ value: "", cursor: 0, listing: [] as string[] });

function editor(line = "", cursor = line.length, history: string[] = []) {
  const ed = createLineEditor({ history: () => history, complete: noComplete });
  ed.set(line, cursor);
  return ed;
}

describe("line edit keys (AC6, D16b)", () => {
  // [name, data, line, cursor, expected line, expected cursor]
  const cases: [string, string, string, number, string, number][] = [
    ["printable key in the middle", "x", "abc", 1, "axbc", 2],
    ["printable key at the end", "d", "abc", 3, "abcd", 4],
    ["printable non-ASCII key", "é", "caf", 3, "café", 4],
    ["space", " ", "ls", 2, "ls ", 3],
    [
      "Backspace removes the character before the cursor",
      KEY.backspace,
      "abc",
      2,
      "ac",
      1,
    ],
    ["Backspace at the start does nothing", KEY.backspace, "abc", 0, "abc", 0],
    [
      "Delete removes the character under the cursor",
      KEY.delete,
      "abc",
      1,
      "ac",
      1,
    ],
    ["Delete at the end does nothing", KEY.delete, "abc", 3, "abc", 3],
    ["Left moves one character", KEY.left, "abc", 2, "abc", 1],
    ["Left at the start stays", KEY.left, "abc", 0, "abc", 0],
    ["Right moves one character", KEY.right, "abc", 1, "abc", 2],
    ["Right at the end stays", KEY.right, "abc", 3, "abc", 3],
    ["Home moves to the start", KEY.home, "abc", 2, "abc", 0],
    [
      "Home (application mode) moves to the start",
      KEY.homeApp,
      "abc",
      2,
      "abc",
      0,
    ],
    ["Home (VT) moves to the start", KEY.homeVt, "abc", 2, "abc", 0],
    ["End moves to the end", KEY.end, "abc", 1, "abc", 3],
    ["End (application mode) moves to the end", KEY.endApp, "abc", 1, "abc", 3],
    ["End (VT) moves to the end", KEY.endVt, "abc", 1, "abc", 3],
    ["Ctrl-A moves to the start", KEY.ctrlA, "abc", 2, "abc", 0],
    ["Ctrl-E moves to the end", KEY.ctrlE, "abc", 1, "abc", 3],
    [
      "Ctrl-U deletes from the cursor to the start",
      KEY.ctrlU,
      "hello world",
      6,
      "world",
      0,
    ],
    ["Ctrl-U at the start does nothing", KEY.ctrlU, "hello", 0, "hello", 0],
    [
      "Ctrl-K deletes from the cursor to the end",
      KEY.ctrlK,
      "hello world",
      5,
      "hello",
      5,
    ],
    ["Ctrl-K at the end does nothing", KEY.ctrlK, "hello", 5, "hello", 5],
    ["Ctrl-W has no handler", KEY.ctrlW, "hello world", 11, "hello world", 11],
    ["a lone Esc does not change the line", KEY.esc, "abc", 1, "abc", 1],
    ["an unknown escape sequence is not inserted", KEY.f1, "abc", 1, "abc", 1],
  ];

  for (const [name, data, line, cursor, expLine, expCursor] of cases) {
    it(name, () => {
      const ed = editor(line, cursor);
      const actions = ed.input(data);
      expect({ line: ed.line, cursor: ed.cursor }).toEqual({
        line: expLine,
        cursor: expCursor,
      });
      expect(actions).toEqual([]);
    });
  }
});

describe("Enter, Ctrl-C, Ctrl-L (AC6, D16)", () => {
  it("Enter submits the whole line, wherever the cursor is, and empties the line", () => {
    const ed = editor("ls -l", 2);
    expect(ed.input(KEY.enter)).toEqual<EditorAction[]>([
      { type: "submit", line: "ls -l" },
    ]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "",
      cursor: 0,
    });
  });

  it("Enter on an empty line submits an empty line", () => {
    const ed = editor("", 0);
    expect(ed.input(KEY.enter)).toEqual<EditorAction[]>([
      { type: "submit", line: "" },
    ]);
  });

  it("Ctrl-C with no selection gives an interrupt with the line, then a new empty line", () => {
    const ed = editor("rm -r stuff", 4);
    expect(ed.input(KEY.ctrlC)).toEqual<EditorAction[]>([
      { type: "interrupt", line: "rm -r stuff" },
    ]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "",
      cursor: 0,
    });
  });

  it("Ctrl-L asks to clear the screen and keeps the line", () => {
    const ed = editor("echo hi", 4);
    expect(ed.input(KEY.ctrlL)).toEqual<EditorAction[]>([{ type: "clear" }]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "echo hi",
      cursor: 4,
    });
  });
});

describe("history, Up and Down (AC6, index.html histMove)", () => {
  it("Up walks back, stops at the oldest entry, and puts the cursor at the end", () => {
    const ed = editor("dra", 1, ["ls", "pwd"]);
    ed.input(KEY.up);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "pwd",
      cursor: 3,
    });
    ed.input(KEY.up);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "ls",
      cursor: 2,
    });
    ed.input(KEY.up);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "ls",
      cursor: 2,
    });
  });

  it("Down walks forward and gives back the unsent draft at the end", () => {
    const ed = editor("dra", 1, ["ls", "pwd"]);
    ed.input(KEY.up);
    ed.input(KEY.up);
    ed.input(KEY.down);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "pwd",
      cursor: 3,
    });
    ed.input(KEY.down);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "dra",
      cursor: 3,
    });
    ed.input(KEY.down);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "dra",
      cursor: 3,
    });
  });

  it("Up and Down do nothing when the history is empty", () => {
    const ed = editor("abc", 1, []);
    ed.input(KEY.up);
    ed.input(KEY.down);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "abc",
      cursor: 1,
    });
  });

  it("Enter resets the history position to the newest entry", () => {
    const history = ["ls", "pwd"];
    const ed = editor("", 0, history);
    ed.input(KEY.up);
    ed.input(KEY.up);
    expect(ed.input(KEY.enter)).toEqual<EditorAction[]>([
      { type: "submit", line: "ls" },
    ]);
    history.push("ls");
    ed.input(KEY.up);
    expect(ed.line).toBe("ls");
    ed.input(KEY.up);
    expect(ed.line).toBe("pwd");
  });

  it("historyMove is the same as Up and Down (extra-keys bar)", () => {
    const ed = editor("", 0, ["ls", "pwd"]);
    ed.historyMove(-1);
    expect(ed.line).toBe("pwd");
    ed.historyMove(1);
    expect(ed.line).toBe("");
  });
});

describe("Tab completion (AC6)", () => {
  it("asks the completer with the line and cursor, and applies one result", () => {
    const complete = vi.fn(() => ({
      value: "cat welcome.txt  more",
      cursor: 16,
      listing: [] as string[],
    }));
    const ed = createLineEditor({ history: () => [], complete });
    ed.set("cat wel more", 7);
    expect(ed.input(KEY.tab)).toEqual([]);
    expect(complete).toHaveBeenCalledWith("cat wel more", 7);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "cat welcome.txt  more",
      cursor: 16,
    });
  });

  it("gives a listing action when there are several candidates", () => {
    const complete = vi.fn(() => ({
      value: "d",
      cursor: 1,
      listing: ["date", "df", "docker"],
    }));
    const ed = createLineEditor({ history: () => [], complete });
    ed.set("d", 1);
    expect(ed.input(KEY.tab)).toEqual<EditorAction[]>([
      { type: "listing", line: "d", items: ["date", "df", "docker"] },
    ]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "d",
      cursor: 1,
    });
  });

  it("complete() is the same as Tab (extra-keys bar)", () => {
    const complete = vi.fn(() => ({
      value: "pwd ",
      cursor: 4,
      listing: [] as string[],
    }));
    const ed = createLineEditor({ history: () => [], complete });
    ed.set("pw", 2);
    expect(ed.complete()).toEqual([]);
    expect(ed.line).toBe("pwd ");
  });
});

describe("paste (AC6, D16c)", () => {
  it("runs each pasted line in order and keeps a last line with no line break", () => {
    const ed = editor("", 0);
    expect(ed.input("ls\rpwd\rech")).toEqual<EditorAction[]>([
      { type: "submit", line: "ls" },
      { type: "submit", line: "pwd" },
    ]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "ech",
      cursor: 3,
    });
  });

  it("treats CR LF and LF as one line break each", () => {
    const ed = editor("", 0);
    expect(ed.input("a\r\nb\n")).toEqual<EditorAction[]>([
      { type: "submit", line: "a" },
      { type: "submit", line: "b" },
    ]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "",
      cursor: 0,
    });
  });

  it("inserts the first pasted line at the cursor of the current line", () => {
    const ed = editor("echo  there", 5);
    expect(ed.input("hi\r")).toEqual<EditorAction[]>([
      { type: "submit", line: "echo hi there" },
    ]);
  });

  it("inserts a one-line paste at the cursor without running it", () => {
    const ed = editor("cat ", 4);
    expect(ed.input("welcome.txt")).toEqual([]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "cat welcome.txt",
      cursor: 15,
    });
  });

  it("keeps a tab inside a paste as text and does not run completion", () => {
    const complete = vi.fn(() => ({
      value: "x",
      cursor: 1,
      listing: ["a", "b"],
    }));
    const ed = createLineEditor({ history: () => [], complete });
    expect(ed.input("a\tb\rc\td")).toEqual<EditorAction[]>([
      { type: "submit", line: "a\tb" },
    ]);
    expect(complete).not.toHaveBeenCalled();
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "c\td",
      cursor: 3,
    });
  });

  it("still completes on a single Tab key", () => {
    const complete = vi.fn(() => ({ value: "ls ", cursor: 3, listing: [] }));
    const ed = createLineEditor({ history: () => [], complete });
    ed.set("l");
    expect(ed.input("\t")).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(ed.line).toBe("ls ");
  });

  it("drops C1 control characters (0x80-0x9f) from typed or pasted text", () => {
    const ed = editor("", 0);
    expect(ed.input("a\x85b\x9bc\x80\x9f")).toEqual([]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "abc",
      cursor: 3,
    });
  });
});

describe("extra keys and hint chips (AC8)", () => {
  it("insert puts text at the cursor", () => {
    const ed = editor("ls  wc", 3);
    ed.insert("|");
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "ls | wc",
      cursor: 4,
    });
  });

  it("set replaces the line and puts the cursor at the end", () => {
    const ed = editor("old", 1);
    ed.set("docker ps -a");
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "docker ps -a",
      cursor: 12,
    });
  });
});

describe("Ctrl-D (B27)", () => {
  it("is end of input on an empty line", () => {
    const ed = editor("");
    expect(ed.input("\x04")).toEqual([{ type: "eof" }]);
  });

  it("deletes the character under the cursor on a non-empty line", () => {
    const ed = editor("abc", 1);
    expect(ed.input("\x04")).toEqual([]);
    expect({ line: ed.line, cursor: ed.cursor }).toEqual({
      line: "ac",
      cursor: 1,
    });
  });

  it("does nothing at the end of a non-empty line", () => {
    const ed = editor("abc");
    expect(ed.input("\x04")).toEqual([]);
    expect(ed.line).toBe("abc");
  });

  it("leaves Ctrl-Z and Ctrl-backslash without a handler at the prompt", () => {
    const ed = editor("ab");
    expect(ed.input("\x1a\x1c")).toEqual([]);
    expect(ed.line).toBe("ab");
  });
});

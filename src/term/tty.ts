// B4, B24, B27: the terminal as a Linux tty, with no DOM. While a command
// reads the keyboard it asks for **line mode** (the player edits one line with
// echo; Enter sends it with its newline; Ctrl-D on an empty line is end of
// input; Ctrl-D on a non-empty line sends the line without a newline) or
// **character mode** (each key is sent at once). Keys typed while no command
// reads are **type-ahead**: echoed at once and kept, up to 4096 characters,
// for the next reader or the next prompt. `terminal.ts` feeds the keys and
// writes what the tty returns as echo.
import type { ReadRequest } from "../engine/shell/io";
import { createLineEditor } from "./lineEditor";
import type { LineEditor } from "./lineEditor";

/** The most characters of type-ahead that the tty keeps (B24). */
export const AHEAD_MAX = 4096;

/** What a read waits for. */
interface Pending {
  req: ReadRequest;
  /** Line mode: the typed text so far. Character mode: the keys so far. */
  buf: string;
  /** The game line editor of `read -e` (B4). */
  editor: LineEditor | null;
  resolve: (text: string | null) => void;
}

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

export class Tty {
  private cur: Pending | null = null;
  private ahead = "";

  /** True while a command waits for the keyboard. */
  get reading(): boolean {
    return this.cur !== null;
  }
  /** True when the current read is in character mode. */
  get charMode(): boolean {
    return this.cur?.req.mode === "char";
  }
  /** True when keys wait in the type-ahead buffer. */
  get hasAhead(): boolean {
    return this.ahead.length > 0;
  }
  get pendingRequest(): ReadRequest | null {
    return this.cur?.req ?? null;
  }

  /**
   * A command asks for input (B4). Resolves to the typed text, or null at end
   * of input. Type-ahead is read first. `req.signal` ends the wait.
   */
  read(req: ReadRequest): Promise<string | null> {
    return new Promise((resolve) => {
      const p: Pending = {
        req,
        buf: "",
        editor:
          req.edit && req.mode === "line"
            ? createLineEditor({
                history: () => [],
                complete: (value, cursor) => ({ value, cursor, listing: [] }),
              })
            : null,
        resolve,
      };
      this.cur = p;
      req.signal?.addEventListener(
        "abort",
        () => {
          if (this.cur === p) this.cur = null;
          resolve(null);
        },
        { once: true },
      );
      if (req.signal?.aborted) {
        this.cur = null;
        resolve(null);
        return;
      }
      // Keys typed before the command asked: they were echoed already.
      if (this.ahead) {
        const a = this.ahead;
        this.ahead = "";
        this.take(a, false);
      }
    });
  }

  /** Ends the current read with a value. */
  private finish(value: string | null): void {
    const p = this.cur;
    if (!p) return;
    this.cur = null;
    p.resolve(value);
  }

  /**
   * Feeds typed or pasted keys (not the signal keys). Gives the text the
   * terminal writes as echo.
   */
  feed(data: string): string {
    return this.take(data, true);
  }

  private take(data: string, echo: boolean): string {
    let out = "";
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (this.cur?.editor) {
        // The editor takes the rest of the data in one piece.
        out += this.editor(data.slice(i), echo);
        // The editor may have ended; what is left goes on as type-ahead.
        return out;
      }
      if (ch === "\x1b") {
        i += escapeLength(data, i) - 1;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 0x80 && code <= 0x9f) continue;
      if (ch === "\r" && data[i + 1] === "\n") continue;
      out += this.cur ? this.reader(ch, echo) : this.typeAhead(ch, echo);
    }
    return out;
  }

  /** One key while a command reads (not `read -e`). */
  private reader(ch: string, echo: boolean): string {
    const p = this.cur as Pending;
    const show = p.req.echo && echo;
    const enter = ch === "\r" || ch === "\n";
    if (p.req.mode === "char") {
      if (ch === "\x04") {
        this.finish(p.buf === "" ? null : p.buf);
        return "";
      }
      const key = enter ? "\n" : ch;
      if (key < " " && key !== "\n" && key !== "\t") return "";
      p.buf += key;
      const out = show ? (enter ? "\r\n" : key) : "";
      if (p.buf.length >= (p.req.count ?? 1)) this.finish(p.buf);
      return out;
    }
    // Line mode, as a tty in canonical mode.
    if (enter) {
      const text = p.buf + "\n";
      this.finish(text);
      return show ? "\r\n" : "";
    }
    if (ch === "\x04") {
      // Empty line: end of input. Otherwise the line goes without a newline.
      this.finish(p.buf === "" ? null : p.buf);
      return "";
    }
    if (ch === "\x7f" || ch === "\b") {
      if (!p.buf) return "";
      p.buf = [...p.buf].slice(0, -1).join("");
      return show ? "\b \b" : "";
    }
    if (ch === "\x15") {
      const n = [...p.buf].length;
      p.buf = "";
      return show ? "\b \b".repeat(n) : "";
    }
    if (ch === "\x17") {
      // Ctrl-W: the last word.
      const m = /\S*\s*$/.exec(p.buf);
      const cut = m ? m[0] : "";
      p.buf = p.buf.slice(0, p.buf.length - cut.length);
      return show ? "\b \b".repeat([...cut].length) : "";
    }
    if (ch < " " && ch !== "\t") return "";
    p.buf += ch;
    return show ? ch : "";
  }

  /** `read -e`: the game line editor, history off (B4). */
  private editor(data: string, echo: boolean): string {
    const p = this.cur as Pending;
    const ed = p.editor as LineEditor;
    const show = p.req.echo && echo;
    const before = { line: ed.line, cursor: ed.cursor };
    const actions = ed.input(data);
    let out = "";
    const done = actions.find((a) => a.type === "submit" || a.type === "eof");
    if (show) {
      // Redraw the one row: back to the start of the text, write it, put the cursor back.
      if (before.cursor > 0) out += `\x1b[${before.cursor}D`;
      const line = done && done.type === "submit" ? done.line : ed.line;
      out += line + "\x1b[K";
      if (!done) {
        const back = ed.line.length - ed.cursor;
        if (back > 0) out += `\x1b[${back}D`;
      }
    }
    if (done) {
      if (done.type === "submit") {
        this.finish(done.line + "\n");
        if (show) out += "\r\n";
      } else this.finish(null);
      // Keys after the end of the line are type-ahead; the editor dropped them.
    }
    return out;
  }

  /** One key while no command reads: echoed, kept (B24). */
  private typeAhead(ch: string, echo: boolean): string {
    if (ch === "\r" || ch === "\n") {
      if (this.ahead.length >= AHEAD_MAX) return "";
      this.ahead += "\n";
      return echo ? "\r\n" : "";
    }
    if (ch === "\x7f" || ch === "\b") {
      if (!this.ahead || this.ahead.endsWith("\n")) return "";
      this.ahead = [...this.ahead].slice(0, -1).join("");
      return echo ? "\b \b" : "";
    }
    if (ch < " " && ch !== "\t") return "";
    if (this.ahead.length >= AHEAD_MAX) return "";
    this.ahead += ch;
    return echo ? ch : "";
  }

  /**
   * Ctrl-C, Ctrl-Z, and Ctrl-\\ empty the type-ahead and the line being typed,
   * as a tty does (B24).
   */
  flush(): void {
    this.ahead = "";
    const p = this.cur;
    if (p) {
      p.buf = "";
      if (p.editor) p.editor.set("");
    }
  }

  /** Takes the type-ahead for the next prompt, and empties the buffer. */
  takeAhead(): string {
    const a = this.ahead;
    this.ahead = "";
    return a;
  }
}

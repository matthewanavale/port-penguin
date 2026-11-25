// D24: the output model. A command writes to `io.out` and `io.err`. At the
// terminal both go to one ordered list of chunks, so the order of writing is
// kept. A pipe or `$( )` collects text. A redirect writes to a file.
import { LIM, LimitStop } from "./limits";
import type { Interp } from "./interp";

export type Stream = "stdout" | "stderr";

/** One piece of output that reached the terminal. */
export interface Chunk {
  stream: Stream;
  text: string;
  /** The styled form of `text` (engine HTML), when a command has one. */
  html?: string;
}

/** What task checks read (D10). */
export interface TaskCtx {
  /** The full input; lines are joined with a newline. */
  line: string;
  /** One list per simple command that ended with exit code 0. */
  segs: string[][];
  /** The basename of the last script that ran by its path. */
  ranExec: string | null;
  /** The stdout that reached the terminal. */
  allOut: string;
}

/** What a task check receives (D10). */
export type Ctx = TaskCtx;

export interface Writer {
  write(text: string, html?: string): void;
  /** True for the terminal (`ls` prints columns there). */
  readonly tty: boolean;
}

/** Counts what one input sends to the terminal (D5). */
export class Meter {
  lines = 0;
  bytes = 0;
  add(text: string): void {
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
      this.lines++;
    this.bytes += text.length;
    if (this.lines > LIM.lines) throw new LimitStop("10000 output lines");
    if (this.bytes > LIM.bytes) throw new LimitStop("1 MB of output");
  }
}

/** The terminal side: ordered chunks, the meter, and `allOut`. */
export class TermWriter implements Writer {
  readonly tty = true;
  constructor(
    private stream: Stream,
    private sink: Chunk[],
    private meter: Meter,
    private task: TaskCtx | null,
  ) {}
  write(text: string, html?: string): void {
    if (text === "" && html === undefined) return;
    this.meter.add(text);
    const c: Chunk = { stream: this.stream, text };
    if (html !== undefined) c.html = html;
    this.sink.push(c);
    if (this.stream === "stdout" && this.task) this.task.allOut += text;
  }
}

/** A pipe, a `$( )`, or a `<( )`: the text of one value (D5). */
export class BufWriter implements Writer {
  readonly tty = false;
  text = "";
  write(text: string): void {
    this.text += text;
    if (this.text.length > LIM.str) throw new LimitStop("1 MB of pipe data");
  }
}

export class NullWriter implements Writer {
  readonly tty = false;
  write(): void {
    /* /dev/null */
  }
}

/** Forwards to another writer (`2>&1`): one object, so the order is kept. */
export class AliasWriter implements Writer {
  constructor(private to: Writer) {}
  get tty(): boolean {
    return this.to.tty;
  }
  write(text: string, html?: string): void {
    this.to.write(text, html);
  }
}

/** Standard input: a text with a read position. Shared by reference. */
export class Input {
  pos = 0;
  /** True once a command read from the terminal input (the D22 hint). */
  used = false;
  /** The interpreter sets this: only a command typed at the prompt counts (D12). */
  counts: () => boolean = () => true;
  constructor(
    public text = "",
    /** True when it is the terminal (empty in 2a, D22). */
    public tty = false,
  ) {}
  /** Reads the rest. */
  readAll(): string {
    if (this.tty && this.counts()) this.used = true;
    const r = this.text.slice(this.pos);
    this.pos = this.text.length;
    return r;
  }
  /** One line without its newline, and whether the newline was there. */
  readLine(): { line: string; nl: boolean } | null {
    if (this.tty && this.counts()) this.used = true;
    if (this.pos >= this.text.length) return null;
    const i = this.text.indexOf("\n", this.pos);
    if (i < 0) {
      const line = this.text.slice(this.pos);
      this.pos = this.text.length;
      return { line, nl: false };
    }
    const line = this.text.slice(this.pos, i);
    this.pos = i + 1;
    return { line, nl: true };
  }
  readChars(n: number): string | null {
    if (this.tty && this.counts()) this.used = true;
    if (this.pos >= this.text.length) return null;
    const r = this.text.slice(this.pos, this.pos + n);
    this.pos += r.length;
    return r;
  }
  get eof(): boolean {
    return this.pos >= this.text.length;
  }
}

/** The three standard streams of one command, plus numbered ones from `exec`. */
export interface IO {
  in: Input;
  out: Writer;
  err: Writer;
  fds?: Map<number, Writer | Input>;
}

/** A command of the table: `argv[0]` is the name. It returns the exit code. */
export type CmdFn = (argv: string[], sh: Interp, io: IO) => number;

/** What the interpreter needs from the game around it. */
export interface Host {
  /** The simulated commands that are not shell builtins (D15: a table). */
  commands: Record<string, CmdFn>;
  /** Names that `type` and `which` report as `/usr/bin/NAME`. Default: the keys of `commands`. */
  paths?: () => string[];
  /** History lines, for `history`. */
  history: () => string[];
  clearHistory?: () => void;
  /** Text of `help` with no arguments (the game's command list). */
  helpText?: () => string;
}

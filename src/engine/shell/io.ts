// D24: the output model. A command writes to `io.out` and `io.err`. At the
// terminal both go to one ordered list of chunks, so the order of writing is
// kept. A pipe or `$( )` collects text. A redirect writes to a file.
import { LIM, LimitStop } from "./limits";
import type { Proc } from "./proc";

export type Stream = "stdout" | "stderr";

const NL = String.fromCharCode(10);

/** One piece of output that reached the terminal. */
export interface Chunk {
  stream: Stream;
  text: string;
  /** The styled form of `text` (engine HTML), when a command has one. */
  html?: string;
}

/** What the engine sends out while an input runs (B15). */
export type OutputEvent = { kind: "chunk"; chunk: Chunk } | { kind: "clear" };

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

/** Where the terminal output of one input goes (B15): the `Run` of the input. */
export interface OutSink {
  emit(chunk: Chunk): void;
  /** The `clear` command (or Ctrl-L) from any process. */
  clear(): void;
}

/** What `allOut` keeps of one input (B12). */
const ALL_OUT_CAP = 1_048_576;

/** The terminal side: ordered chunks and `allOut`. */
export class TermWriter implements Writer {
  readonly tty = true;
  constructor(
    private stream: Stream,
    private sink: OutSink,
    private task: TaskCtx | null,
  ) {}
  write(text: string, html?: string): void {
    if (text === "" && html === undefined) return;
    const c: Chunk = { stream: this.stream, text };
    if (html !== undefined) c.html = html;
    this.sink.emit(c);
    // B12: `allOut` keeps at most its first 1 MB per input.
    if (
      this.stream === "stdout" &&
      this.task &&
      this.task.allOut.length < ALL_OUT_CAP
    )
      this.task.allOut += text.slice(0, ALL_OUT_CAP - this.task.allOut.length);
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

/**
 * Standard input: a text with a read position. Shared by reference. The reads
 * are async (B26); in this phase every source is a whole text, so they
 * resolve at once.
 */
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
  private touch(): void {
    if (this.tty && this.counts()) this.used = true;
  }
  /** Reads the rest. */
  readAll(): Promise<string> {
    return Promise.resolve(this.takeAll());
  }
  /**
   * The rest, at once, with no wait. For the places that need a plain text
   * (`/dev/stdin` as a file name). It is only right for a text source.
   */
  takeAll(): string {
    this.touch();
    const r = this.text.slice(this.pos);
    this.pos = this.text.length;
    return r;
  }
  /** One line without its newline, and whether the newline was there. */
  readLine(): Promise<{ line: string; nl: boolean } | null> {
    this.touch();
    if (this.pos >= this.text.length) return Promise.resolve(null);
    const i = this.text.indexOf(NL, this.pos);
    if (i < 0) {
      const line = this.text.slice(this.pos);
      this.pos = this.text.length;
      return Promise.resolve({ line, nl: false });
    }
    const line = this.text.slice(this.pos, i);
    this.pos = i + 1;
    return Promise.resolve({ line, nl: true });
  }
  /** Up to `max` characters (all that is ready when there is no limit), or null at the end. */
  readChunk(max = Infinity): Promise<string | null> {
    this.touch();
    if (this.pos >= this.text.length) return Promise.resolve(null);
    const r = this.text.slice(this.pos, this.pos + max);
    this.pos += r.length;
    return Promise.resolve(r);
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
export type CmdFn = (
  argv: string[],
  sh: Proc,
  io: IO,
) => number | Promise<number>;

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

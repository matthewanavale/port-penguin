// D24: the output model. A command writes to `io.out` and `io.err`. At the
// terminal both go to one ordered list of chunks, so the order of writing is
// kept. A pipe or `$( )` collects text. A redirect writes to a file.
import { LIM, LimitStop } from "./limits";
import type { Pipe } from "./pipe";
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

/**
 * What the terminal gives back for an event: nothing, or a promise that ends
 * when it can take more (flow control, as a tty blocks a fast writer).
 */
export type OutputSink = (event: OutputEvent) => void | Promise<void>;

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
  /**
   * A pipe: gives a promise while the buffer is full (B3), or null when the
   * writer may go on. The process awaits it at its next safe point.
   */
  drain?(sh?: Proc): Promise<void> | null;
}

/** What the engine asks the terminal for while a command reads the keyboard (B4, B15). */
export interface ReadRequest {
  mode: "line" | "char";
  count?: number;
  echo: boolean;
  /** `read -e`: the game line editor, with history off (B4). */
  edit?: boolean;
  /** Set when the terminal shows a learner hint before it waits (B16a). */
  hint?: string;
  /** The command that waits (the live region names it, B17). */
  cmd?: string;
  /** Aborts the wait: a signal ended it, or `read -t` timed out. */
  signal?: AbortSignal;
}

/** Where the terminal output of one input goes (B15): the `Run` of the input. */
export interface OutSink {
  emit(chunk: Chunk): void;
  /** The `clear` command (or Ctrl-L) from any process. */
  clear(): void;
  /** A promise while the terminal cannot take more output, else null. */
  hold(): Promise<void> | null;
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
  drain(): Promise<void> | null {
    return this.sink.hold();
  }
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

/** The write end of a pipe (B3). */
export class PipeWriter implements Writer {
  readonly tty = false;
  constructor(readonly pipe: Pipe) {}
  write(text: string): void {
    this.pipe.write(text);
  }
  drain(sh?: Proc): Promise<void> | null {
    return this.pipe.full ? this.pipe.drain(sh) : null;
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
  drain(sh?: Proc): Promise<void> | null {
    return this.to.drain ? this.to.drain(sh) : null;
  }
}

/** Where more input comes from when the text is used up: a pipe or the terminal (B26). */
export interface Feed {
  /**
   * More text, or null at the end of input. `want` is how the caller reads:
   * a line (the terminal is in line mode) or a character count (character mode).
   */
  next(
    sh: Proc | undefined,
    want: { mode: "line" | "char"; count?: number; signal?: AbortSignal },
  ): Promise<string | null>;
  /** Called before the first wait of a read (the B16 hint). */
  announce?(sh: Proc | undefined): void;
}

/** A feed from a pipe. */
export function pipeFeed(pipe: Pipe, owner: Proc): Feed {
  return { next: (sh, want) => pipe.read(sh ?? owner, want.count) };
}

/**
 * Standard input: a text with a read position, and a feed for more text. It is
 * shared by reference. The reads are async (B26): a text source resolves at
 * once; a pipe waits for data (B3); the terminal asks `onRead` (B4).
 */
export class Input {
  pos = 0;
  /** The interpreter sets this: only a command typed at the prompt counts (D12). */
  counts: () => boolean = () => true;
  /** The terminal echoes the typed keys (`read -s` turns it off, B4). */
  echo = true;
  /** `read -e`: the terminal uses the game line editor (B4). */
  edit = false;
  /** `read -t`: aborts the wait of a read when its time is over. */
  signal: AbortSignal | undefined;
  /** True once the feed gave its end. */
  private ended = false;
  constructor(
    public text = "",
    /** True when it is the terminal. */
    public tty = false,
    /** More text when `text` is used up. */
    public feed: Feed | null = null,
  ) {}

  /** The text left in the buffer. */
  private get left(): number {
    return this.text.length - this.pos;
  }

  /** Asks the feed for more; false at the end. */
  private async more(
    sh: Proc | undefined,
    want: { mode: "line" | "char"; count?: number; signal?: AbortSignal },
  ): Promise<boolean> {
    if (!this.feed || this.ended) return false;
    if (this.pos > 0 && this.pos === this.text.length) {
      this.text = "";
      this.pos = 0;
    }
    const s = await this.feed.next(sh, { ...want, signal: this.signal });
    if (s === null) {
      // A signal that has a trap also ends a wait with null: not the end of input.
      if (!(sh && sh.signals.length)) this.ended = true;
      return false;
    }
    this.text += s;
    return true;
  }

  /** Called before a read waits, so the terminal can show its hint (B16). */
  announce(sh?: Proc): void {
    this.feed?.announce?.(sh);
  }

  /** Reads the rest. A whole read keeps the 1 MB value cap (B8). */
  async readAll(sh?: Proc): Promise<string> {
    while (await this.more(sh, { mode: "line" })) {
      if (this.left > LIM.str) throw new LimitStop("1 MB of pipe data");
    }
    return this.takeAll();
  }
  /**
   * The rest of the buffer, at once, with no wait. For the places that need a
   * plain text (`/dev/stdin` as a file name). It is only right for a text source.
   */
  takeAll(): string {
    const r = this.text.slice(this.pos);
    this.pos = this.text.length;
    return r;
  }
  /** One line without its newline, and whether the newline was there. */
  async readLine(sh?: Proc): Promise<{ line: string; nl: boolean } | null> {
    let from = this.pos;
    for (;;) {
      const i = this.text.indexOf(NL, from);
      if (i >= 0) {
        const line = this.text.slice(this.pos, i);
        this.pos = i + 1;
        return { line, nl: true };
      }
      from = this.text.length;
      const base = this.pos;
      if (!(await this.more(sh, { mode: "line" }))) break;
      // The buffer may have moved to its start.
      from = from - base + this.pos;
    }
    if (this.pos >= this.text.length) return null;
    const line = this.text.slice(this.pos);
    this.pos = this.text.length;
    return { line, nl: false };
  }
  /** Up to `max` characters (all that is ready when there is no limit), or null at the end. */
  async readChunk(max = Infinity, sh?: Proc): Promise<string | null> {
    if (this.left === 0) {
      const want = {
        mode: Number.isFinite(max) ? ("char" as const) : ("line" as const),
        count: Number.isFinite(max) ? max : undefined,
      };
      while (this.left === 0) if (!(await this.more(sh, want))) return null;
    }
    const r = this.text.slice(this.pos, this.pos + max);
    this.pos += r.length;
    return r;
  }
  get eof(): boolean {
    return this.pos >= this.text.length && (!this.feed || this.ended);
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

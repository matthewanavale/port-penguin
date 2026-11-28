// B3: a pipe. The stages of a pipeline run at the same time and share one pipe
// object between each two stages. The buffer holds 64 KiB. A writer waits while
// the buffer is full; a reader waits while it is empty and a writer is open.
// When every reader has closed, a write ends the writer with SIGPIPE (status
// 141, no message).
import type { Proc } from "./proc";

/** The size of the pipe buffer (B3). */
export const PIPE_CAP = 65_536;

/** A write to a pipe that nobody reads: the writer ends with status 141. */
export class SigPipe {
  readonly code = 141;
}

/** What waits on a pipe: a reader or a writer, and the process it belongs to. */
type Waiter = () => void;

export class Pipe {
  private buf = "";
  private pos = 0;
  /** Open ends. The pipeline gives one writer and one reader. */
  private writers = 1;
  private readers = 1;
  private waiting = new Set<Waiter>();

  /** Characters in the buffer that no reader took yet. */
  get size(): number {
    return this.buf.length - this.pos;
  }
  /** True when a writer must wait (the buffer holds the cap or more). */
  get full(): boolean {
    return this.size >= PIPE_CAP && this.readers > 0;
  }
  get open(): boolean {
    return this.readers > 0;
  }

  private wakeAll(): void {
    const list = [...this.waiting];
    this.waiting.clear();
    for (const w of list) w();
  }

  /**
   * Writes text. A single write may go over the cap (the writer is a
   * synchronous command); the writer then waits in `drain`. Throws `SigPipe`
   * when no reader is left.
   */
  write(text: string): void {
    if (this.readers === 0) throw new SigPipe();
    if (text === "") return;
    if (this.pos > 0 && this.pos === this.buf.length) {
      this.buf = "";
      this.pos = 0;
    }
    this.buf += text;
    this.wakeAll();
  }

  /** Waits until a process wakes this wait: data, a close, or a signal. */
  private async block(sh: Proc | undefined): Promise<void> {
    if (sh) {
      await sh.interruptible((wake) => {
        this.waiting.add(wake);
        return () => this.waiting.delete(wake);
      });
      return;
    }
    await new Promise<void>((resolve) => this.waiting.add(resolve));
  }

  /** The writer waits here while the buffer is full and a reader is open. */
  async drain(sh: Proc | undefined): Promise<void> {
    while (this.full) {
      await this.block(sh);
      if (sh && sh.signals.length) return;
    }
  }

  /**
   * Takes up to `max` characters; waits while the pipe is empty and a writer
   * is open. Gives null at the end of input. A pending signal that has a trap
   * ends the wait with an empty string.
   */
  async read(sh: Proc | undefined, max = Infinity): Promise<string | null> {
    for (;;) {
      if (this.size > 0) {
        const part = this.buf.slice(this.pos, this.pos + max);
        this.pos += part.length;
        if (this.pos >= this.buf.length) {
          this.buf = "";
          this.pos = 0;
        } else if (this.pos > PIPE_CAP) {
          this.buf = this.buf.slice(this.pos);
          this.pos = 0;
        }
        this.wakeAll();
        return part;
      }
      if (this.writers === 0) return null;
      await this.block(sh);
      if (sh && sh.signals.length) return null;
    }
  }

  closeWriter(): void {
    if (this.writers > 0) this.writers--;
    this.wakeAll();
  }

  closeReader(): void {
    if (this.readers > 0) this.readers--;
    this.buf = "";
    this.pos = 0;
    this.wakeAll();
  }
}

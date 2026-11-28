// B26: commands that read stdin as a stream. They take one chunk or one line
// at a time and stop reading when they need no more.
import type { Input } from "./io";
import type { Proc } from "./proc";

/**
 * Reads `input` chunk by chunk and calls `onLines` with the whole lines of
 * each chunk (without their newlines). A last line with no newline goes at the
 * end with `last` true. `onLines` returns true to stop reading. Between chunks
 * the process waits while its own output pipe is full (B3).
 */
export async function streamLines(
  input: Input,
  sh: Proc,
  onLines: (lines: string[], last: boolean) => boolean | void,
): Promise<void> {
  let carry = "";
  for (;;) {
    const c = await input.readChunk(undefined, sh);
    if (c === null) break;
    const parts = (carry + c).split("\n");
    carry = parts.pop() as string;
    if (parts.length && onLines(parts, false) === true) return;
    await sh.drain();
  }
  if (carry !== "") onLines([carry], true);
}

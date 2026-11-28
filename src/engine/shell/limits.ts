// D5, D6, D21, B8: the limits of the simulator, and the errors that stop an input.
// B8: the shell has no step limit and no output limit at the prompt. What stays:
// the value caps, the D6 depth limits, the file system, the steps of one call
// of `awk` or `sed` (`steps`: one call cannot yield), and `~/.bashrc`.

export const LIM = {
  /** Steps inside one call of `awk` or `sed` (B8). */
  steps: 200_000,
  rcSteps: 20_000,
  str: 1_048_576,
  /** A field width or precision (B18). */
  width: 1_000_000,
  array: 100_000,
  brace: 100_000,
  depth: 1000,
  scripts: 64,
  parse: 500,
  storage: 5 * 1024 * 1024,
};

/** An input that hit a D5 limit: it stops, shows ^C, and `$?` is 130. */
export class LimitStop extends Error {
  readonly limit: string;
  constructor(limit: string) {
    super(limit);
    this.limit = limit;
  }
}

/** A D6 depth limit: one line, and `$?` is 1 (the parser limit gives 2). */
export class NestStop extends Error {
  readonly name_: string;
  readonly limit: number;
  readonly code: number;
  constructor(name: string, limit: number, code = 1) {
    super(`${name}: nesting too deep (${limit})`);
    this.name_ = name;
    this.limit = limit;
    this.code = code;
  }
}

export const nestMessage = (name: string, limit: number): string =>
  `port-penguin: ${name}: nesting too deep (${limit})`;

export const stopMessage = (limit: string): string =>
  `port-penguin: stopped: ${limit} (the simulator has limits)`;

/** What one call of `awk` or `sed` counts its steps in (B8). */
export class CallSteps {
  private n = 0;
  constructor(private readonly limit = LIM.steps) {}
  tick(): void {
    if (++this.n > this.limit) throw new LimitStop(`${this.limit} steps`);
  }
}

/** B18: the stop for a width or precision that is too large. */
export function checkWidth(n: number): void {
  if (n > LIM.width) throw new LimitStop("1 MB string");
}

/** True for a JavaScript stack overflow (Chrome and Safari `RangeError`, Firefox `InternalError`). */
export function isStackOverflow(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e instanceof RangeError || e.name === "InternalError") &&
    /call stack|too much recursion/i.test(e.message)
  );
}

/**
 * B18: a JavaScript error from the engine that is a limit and not a bug. A
 * stack overflow is a D6 nesting stop; `Invalid string length` and
 * `Invalid array length` are the `1 MB string` stop. Gives null for any other error.
 */
export function limitFromError(e: unknown): "nest" | LimitStop | null {
  if (isStackOverflow(e)) return "nest";
  if (e instanceof RangeError) return new LimitStop("1 MB string");
  return null;
}

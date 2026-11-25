// D5, D6, D21: the limits of the simulator, and the errors that stop an input.

export const LIM = {
  steps: 200_000,
  rcSteps: 20_000,
  lines: 10_000,
  bytes: 1_048_576,
  str: 1_048_576,
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

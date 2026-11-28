// AC2, D8: the one shared normalizer. The fixtures (real Ubuntu) and the
// simulator output both pass through it before they are compared. Every
// entry has a comment that says why it exists.
//
// Node type stripping can run this file: no enums, `.ts` import extensions.

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const WEEKDAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";

/** One normalizer rule: a pattern, its fixed token, and the reason. */
interface Rule {
  re: RegExp;
  to: string;
  why: string;
}

const RULES: Rule[] = [
  {
    // The default `date` output carries the time of the run.
    re: new RegExp(
      `${WEEKDAY} ${MONTH} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d UTC \\d{4}`,
      "g",
    ),
    to: "<DATE>",
    why: "`date` with no -d prints the current time",
  },
  {
    // `ls -l` shows `Nov 24 09:00` for recent files and `Nov 24  2025` for old ones.
    re: new RegExp(`${MONTH} [ \\d]\\d (?:\\d\\d:\\d\\d| \\d{4})`, "g"),
    to: "<LSTIME>",
    why: "`ls -l` file times depend on when the file was made",
  },
  {
    // `stat`, `diff -u`, and `tar -tv` print ISO times, with or without nanoseconds and zone.
    re: /\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d(?:\.\d+)?)?(?: [+-]\d{4})?/g,
    to: "<ISOTIME>",
    why: "file times from `stat`, `diff -u`, `tar -tv` depend on when the file was made",
  },
  {
    // `stat` prints the device and inode number of the real file system.
    re: /Device: \S+\s+Inode: \d+/g,
    to: "Device: <DEV> Inode: <INO>",
    why: "device and inode numbers belong to the host file system",
  },
  {
    // The container host name; the simulator uses the same name, so a fixed token keeps the tests free of it.
    re: /port-penguin/g,
    to: "<HOST>",
    why: "the host name is part of the prompt and of messages",
  },
];

/** A `df` data row: name, three sizes, a percentage, a mount point. */
const DF_ROW =
  /^(\S+)\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+\d+%\s+(\S+)$/;
const DF_HEADER = /^Filesystem\s+/;

/** `env` and `printenv` lines the simulator does not print (D8). */
const DROPPED_ENV = /^(?:TERM|COLUMNS|SHLVL|_|TZ)=/;

/* eslint-disable no-control-regex -- escape sequences are the point of this function */
/** Removes ANSI escape sequences: CSI, OSC, and two-character escapes. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/* eslint-enable no-control-regex */

/**
 * B20: job process ids. A real PID depends on the host, so two lines carry a
 * fixed token: the `[N] PID` line that `CMD &` prints, and the PID column of
 * `jobs -l` (`[N]+  PID Running ...`). A case that needs a PID elsewhere
 * (`$!`, `jobs -p`) tests it without printing it, for example
 * `test $! -gt 0 && echo bang-ok`.
 */
const JOB_START = /^(\[\d+\]) \d+$/;
const JOB_LONG = /^(\[\d+\][+-]?\s+)\d+( )/;

/** The shared normalizer. */
export function normalize(text: string): string {
  let t = stripAnsi(text.replace(/\r/g, ""));
  for (const r of RULES) t = t.replace(r.re, r.to);
  return t
    .split("\n")
    .filter((line) => !DROPPED_ENV.test(line))
    .map((line) => {
      // `df` sizes vary by host; the column widths vary with them.
      if (DF_HEADER.test(line)) return line.replace(/\s+/g, " ");
      const m = DF_ROW.exec(line);
      if (m) return `${m[1]} <SIZE> <SIZE> <SIZE> <PCT> ${m[2]}`;
      // A prompt line may carry the echoed command before it: only a line that starts with `[N]` counts.
      return line.replace(JOB_START, "$1 <PID>").replace(JOB_LONG, "$1<PID>$2");
    })
    .join("\n");
}

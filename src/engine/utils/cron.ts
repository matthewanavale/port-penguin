// AC4: `crontab` (Debian cron 3.0pl1). One crontab for the user `cadet`,
// kept in the optional state field `crontab` (D11). Nothing runs it: the game
// does not run jobs. `-e` is not available (no editor).
import { get } from "../paths";
import { S } from "../state";
import type { CmdFn } from "../shell/io";
import { readOperand, splitLines } from "./text";

const store = (): { crontab?: string } => S;

const USAGE = `usage:\tcrontab [-u user] [-n] file
\tcrontab [ -u user ] [ -i ] { -e | -l | -r }

\t-h\t(displays this help message)

\tfile\t(default operation is replace, per 1003.2)
\t-n\t(dry run: checks the syntax, then bails out)
\t-u user\t(choose the user whose crontab is touched)

\t-e\t(edit user's crontab)
\t-l\t(list user's crontab)
\t-r\t(delete user's crontab)

\t-i\t(prompt before deleting user's crontab)
`;

const NAMES: Record<string, string[]> = {
  month: "jan feb mar apr may jun jul aug sep oct nov dec".split(" "),
  dow: "sun mon tue wed thu fri sat".split(" "),
};

/** One field: a list of `*`, N, N-M, with an optional `/step`. */
function validField(
  f: string,
  lo: number,
  hi: number,
  names?: string[],
): boolean {
  const num = (s: string): number => {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    return i >= 0 ? i + lo : NaN;
  };
  for (const item of f.split(",")) {
    const [range, step, extra] = item.split("/");
    if (extra !== undefined) return false;
    if (step !== undefined && (!/^\d+$/.test(step) || parseInt(step, 10) === 0))
      return false;
    if (range === "*") continue;
    const [a, b, more] = range.split("-");
    if (more !== undefined) return false;
    const x = num(a);
    if (isNaN(x) || x < lo || x > hi) return false;
    if (b !== undefined) {
      const y = num(b);
      if (isNaN(y) || y < lo || y > hi) return false;
    }
  }
  return true;
}

const SPECIAL =
  /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)(\s|$)/;
const FIELDS: [string, number, number, string[]?][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12, NAMES.month],
  ["day-of-week", 0, 7, NAMES.dow],
];

/** The first error of a crontab text as `[line, field]`, or null. */
function check(text: string): [number, string] | null {
  const lines = splitLines(text);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/^[ \t]+/, "");
    if (line === "" || line.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    if (line.startsWith("@")) {
      if (!SPECIAL.test(line)) return [n, "bad command"];
      continue;
    }
    const parts = line.split(/[ \t]+/);
    for (let k = 0; k < 5; k++) {
      const [name, lo, hi, names] = FIELDS[k];
      if (parts[k] === undefined) return [n + 1, name];
      if (!validField(parts[k], lo, hi, names)) return [n, name];
    }
  }
  return null;
}

const crontab: CmdFn = (argv, sh, io) => {
  let op: "replace" | "l" | "r" | "e" = "replace";
  let dry = false;
  let file: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-u") {
      const u = argv[++i];
      if (u !== "cadet") {
        io.err.write("must be privileged to use -u\n");
        return 1;
      }
    } else if (a === "-l") op = "l";
    else if (a === "-r") op = "r";
    else if (a === "-e") op = "e";
    else if (a === "-n") dry = true;
    else if (a === "-i") {
      /* the prompt is not asked */
    } else if (a === "-h") {
      io.out.write(USAGE);
      return 0;
    } else if (a === "-") file = "-";
    else if (a.startsWith("-")) {
      io.err.write(
        `crontab: invalid option -- '${a[1]}'\ncrontab: usage error: unrecognized option\n${USAGE}`,
      );
      return 1;
    } else file = a;
  }
  const st = store();
  if (op === "l") {
    if (st.crontab === undefined) {
      io.err.write("no crontab for cadet\n");
      return 1;
    }
    io.out.write(st.crontab);
    return 0;
  }
  if (op === "r") {
    if (st.crontab === undefined) {
      io.err.write("no crontab for cadet\n");
      return 1;
    }
    delete st.crontab;
    return 0;
  }
  if (op === "e") {
    io.err.write(
      "crontab: no editor is available here; write a file and run: crontab FILE\n",
    );
    return 1;
  }
  if (file === null) file = "-";
  let text: string;
  if (file === "-") text = io.in.readAll();
  else {
    const n = get(sh.abs(file));
    if (!n || n.t !== "f") {
      io.err.write(`${file}: No such file or directory\n`);
      return 1;
    }
    const t = readOperand("crontab", file, sh, io);
    if (t === null) return 1;
    text = t;
  }
  const bad = check(text);
  if (bad) {
    io.err.write(
      `"${file === "-" ? "-" : file}":${bad[0]}: bad ${bad[1].replace(/^bad /, "")}\nerrors in crontab file, can't install.\n`,
    );
    return 1;
  }
  if (!dry) st.crontab = text;
  return 0;
};

export const CRON_CMDS: Record<string, CmdFn> = { crontab };

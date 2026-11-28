// The Linux commands of the host table (D15, D24). Every command is a
// `CmdFn`: `(argv, sh, io) => code`, with `argv[0]` the name. Text goes to
// `io.out` and `io.err`; a command never goes through `sh.fail` (that adds
// the `bash:` prefix). Messages and exit codes follow GNU coreutils 9.4,
// grep 3.11, and procps on Ubuntu 24.04, where a reference case covers them.
// The commands of the game itself (`man`, `hint`, `help`, the process list,
// `curl`, `docker`) keep their run-1 text.
import { clockNow, clockDate } from "./clock";
import { NGINX_HTML, USR_BIN } from "./content";
import { compose } from "./compose";
import { docker, findImg } from "./docker";
import { esc, nameHTML, table } from "./helpers";
import type { Res } from "./helpers";
import { MAN } from "./man";
import { M } from "./missions";
import { cwd as pathCwd, get, withCwd } from "./paths";
import { sha256 } from "./sha256";
import { nul } from "./nullmap";
import { d, f, HOME, HOST, S, nulTree } from "./state";
import type { DirNode, FileNode, FsNode, Image } from "./state";
import { BUILTINS, signalJob, signalName } from "./shell/builtins";
import type { Context } from "./shell/context";
import { termCols } from "./shell/context";
import type { Proc } from "./shell/proc";
import type { CmdFn, Host, IO } from "./shell/io";
import { LIM } from "./shell/limits";
import { streamLines } from "./shell/stream";
import { SIGNALS } from "./shell/sched";
import {
  canWrite,
  readPath,
  stamp,
  storageUsed,
  writeText,
} from "./shell/redirect";
import type { FsError } from "./shell/redirect";
import { DATE_CMDS, parseDate, parseTouchT } from "./utils/date";
import { CRON_CMDS } from "./utils/cron";
import { FIND_CMDS } from "./utils/find";
import { AWK_CMDS } from "./utils/awk";
import { SED_CMDS } from "./utils/sed";
import { TAR_CMDS } from "./utils/tar";
import {
  errOut,
  getopt,
  splitLines,
  TEXT_CMDS,
  tryHelp,
  usageError,
} from "./utils/text";

void sha256;

/* ---------- small helpers ---------- */

/** GNU `quoteaf`: the file name in single quotes, as in `ls: cannot access 'x'`. */
const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
/** GNU `quote` in a UTF-8 locale: curly quotes, as in `mkdir: ... ‘x’`. */
const qc = (s: string): string => `‘${s}’`;

/** Writes text and makes sure it ends with a newline. */
function say(io: IO, text: string, html?: string): void {
  if (text === "") return;
  if (text.endsWith("\n")) io.out.write(text, html);
  else io.out.write(text + "\n", html === undefined ? undefined : html + "\n");
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const byteLen = (s: string): number => enc.encode(s).length;
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The year of `now`, for the run-1 file time of nodes without `mtime` (D18). */
function run1Time(): number {
  return Date.UTC(clockDate().getUTCFullYear(), 10, 24, 9, 0);
}
export const mtimeMs = (n: FsNode): number => n.mtime ?? run1Time();

/** Real content size: `sz` stands in for big files in the run-1 data. */
const sizeOf = (n: FsNode): number =>
  n.t === "d" ? 4096 : (n.sz ?? byteLen(n.x));

/** Disk blocks in KiB: 4 KiB units, at least one (the fixture file system). */
const blocksK = (n: FsNode): number =>
  n.t === "d" ? 4 : Math.max(1, Math.ceil(sizeOf(n) / 4096)) * 4;

/** Who owns a path: `cadet` in the home folder and below /tmp, else `root`. */
function ownerOf(abs: string): "cadet" | "root" {
  return abs === HOME || abs.startsWith(HOME + "/") || abs.startsWith("/tmp/")
    ? "cadet"
    : "root";
}

const parentOf = (abs: string): string =>
  abs.slice(0, abs.lastIndexOf("/")) || "/";
const baseOf = (abs: string): string => abs.slice(abs.lastIndexOf("/") + 1);
const joinPath = (dir: string, name: string): string =>
  dir === "/" ? "/" + name : dir + "/" + name;

/** Link count: 1 for /, /home, and the home folder; else 2 + sub folders. */
function linkCount(abs: string, n: FsNode): number {
  if (n.t === "f") return 1;
  if (abs === "/" || abs === "/home" || abs === HOME) return 1;
  return 2 + Object.values(n.c).filter((c) => c.t === "d").length;
}

interface Found {
  abs: string;
  node: FsNode;
}
interface Missing {
  abs: string;
  err: FsError;
}

/** Walks a path the way `stat` does, with Linux error texts. */
function lookup(sh: Proc, p: string): Found | Missing {
  const abs = sh.abs(p);
  // The device files that redirects know: they are not in the tree.
  if (/^\/dev\/(null|stdin|stdout|stderr)$/.test(abs))
    return { abs, node: f("", "rw-rw-rw-") };
  let node: FsNode = S.fs;
  const parts = abs.split("/").filter(Boolean);
  for (const part of parts) {
    if (node.t !== "d") return { abs, err: "Not a directory" };
    const next: FsNode | undefined = node.c[part];
    if (!next) return { abs, err: "No such file or directory" };
    node = next;
  }
  if (node.t === "f" && p.endsWith("/") && p !== "/")
    return { abs, err: "Not a directory" };
  return { abs, node };
}
const isFound = (r: Found | Missing): r is Found => "node" in r;

/** The mode string of the first rwx triple of a file for "may I read it". */
const canRead = (n: FsNode): boolean => n.m[0] === "r";

/** Parses an option list and writes the error line on failure. */
function opts(
  io: IO,
  cmd: string,
  argv: string[],
  shorts: string,
  longs: Record<string, [string, boolean]> = {},
  failCode = 1,
):
  | {
      has: (n: string) => boolean;
      val: (n: string) => string | undefined;
      all: { name: string; val?: string }[];
      rest: string[];
    }
  | number {
  const p = getopt(cmd, argv, shorts, longs);
  if (typeof p === "string") {
    io.err.write(p);
    return failCode;
  }
  return {
    has: (n) => p.opts.some((o) => o.name === n),
    val: (n) => {
      let v: string | undefined;
      for (const o of p.opts) if (o.name === n) v = o.val;
      return v;
    },
    all: p.opts,
    rest: p.rest,
  };
}

/** Right-aligns or left-aligns cells to a width. */
const padL = (s: string, w: number): string => s.padStart(w);
const padR = (s: string, w: number): string => s.padEnd(w);

/** GNU `-h` sizes: powers of 1024, rounded up, one decimal below 10. */
function human(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const u = ["K", "M", "G", "T", "P"];
  let v = bytes / 1024;
  let i = 0;
  while (Math.ceil(v) >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  const r = v < 10 ? Math.ceil(v * 10) / 10 : Math.ceil(v);
  return (v < 10 ? r.toFixed(1) : String(r)) + u[i];
}

/** The text of a file for a command; writes the error line on failure. */
async function readFileArg(
  cmd: string,
  sh: Proc,
  io: IO,
  name: string,
  how: (e: string) => string = (e) => `${name}: ${e}`,
): Promise<string | null> {
  if (name === "-") return await io.in.readAll(sh);
  const r = lookup(sh, name);
  if (!isFound(r)) {
    errOut(io, cmd, how(r.err));
    return null;
  }
  const got = await readPath(r.abs, io);
  if ("err" in got) {
    errOut(io, cmd, how(got.err));
    return null;
  }
  return got.text;
}

/** Writes a file for a command; writes the error line on failure. */
function writeFileArg(
  cmd: string,
  io: IO,
  abs: string,
  name: string,
  text: string,
  append = false,
): boolean {
  if (abs === "/dev/null") return true;
  const e = writeText(abs, text, append);
  if (e) {
    errOut(io, cmd, `${name}: ${e}`);
    return false;
  }
  return true;
}

/* ---------- ls ---------- */

interface Ent {
  /** The name as shown (the argument for a command line file). */
  name: string;
  abs: string;
  node: FsNode;
}

/** Text and styled form of one piece of output. */
type Cell = [string, string];
const plain = (s: string): Cell => [s, esc(s)];
const join = (...cs: Cell[]): Cell => [
  cs.map((c) => c[0]).join(""),
  cs.map((c) => c[1]).join(""),
];

const SHELL_SPECIAL = /[ !"$&'()*;<=>?[\\^`{|}\t\n]|^[~#]/;

/** `ls` on a terminal quotes a name that the shell would split or expand. */
function shellQuote(name: string): string {
  return SHELL_SPECIAL.test(name) ? q(name) : name;
}

function modeText(n: FsNode): string {
  return (n.t === "d" ? "d" : "-") + n.m;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ls -l` time: month, day, then the time or, for old files, the year. */
function lsTime(ms: number): string {
  const t = new Date(ms);
  const now = clockNow();
  const day = String(t.getUTCDate()).padStart(2);
  const head = `${MONTHS[t.getUTCMonth()]} ${day} `;
  const recent = ms <= now + 3600_000 && now - ms < 182.5 * 86400_000;
  if (recent) {
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const mm = String(t.getUTCMinutes()).padStart(2, "0");
    return `${head}${hh}:${mm}`;
  }
  return `${head} ${t.getUTCFullYear()}`;
}

function inodeOf(abs: string): number {
  let h = 2000000;
  for (let i = 0; i < abs.length; i++)
    h = (h * 31 + abs.charCodeAt(i)) % 9000000;
  return h + 1000000;
}

interface LsOpts {
  all: boolean;
  almost: boolean;
  format: "long" | "one" | "cols";
  human: boolean;
  dirOnly: boolean;
  classify: boolean;
  slash: boolean;
  sort: "name" | "time" | "size" | "none";
  reverse: boolean;
  recursive: boolean;
  inode: boolean;
  blocks: boolean;
  numeric: boolean;
  tty: boolean;
  color: boolean;
}

function suffixOf(e: Ent, o: LsOpts): string {
  if (e.node.t === "d") return o.classify || o.slash ? "/" : "";
  if (o.classify && e.node.m.includes("x")) return "*";
  return "";
}

function sortEnts(list: Ent[], o: LsOpts): Ent[] {
  const a = list.slice();
  if (o.sort === "time")
    a.sort(
      (x, y) => mtimeMs(y.node) - mtimeMs(x.node) || cmpStr(x.name, y.name),
    );
  else if (o.sort === "size")
    a.sort((x, y) => sizeOf(y.node) - sizeOf(x.node) || cmpStr(x.name, y.name));
  else if (o.sort === "name") a.sort((x, y) => cmpStr(x.name, y.name));
  if (o.reverse) a.reverse();
  return a;
}

/** The names of one listing as cells, with quoting for a terminal (D8 of GNU ls). */
function nameCells(list: Ent[], o: LsOpts): Cell[] {
  const shown = list.map((e) => (o.tty ? shellQuote(e.name) : e.name));
  const anyQuoted = o.tty && shown.some((s, i) => s !== list[i].name);
  return list.map((e, i) => {
    const s = suffixOf(e, o);
    let t = shown[i];
    const quoted = t !== e.name;
    const lead = anyQuoted && !quoted ? " " : "";
    t = lead + t;
    const html = o.color
      ? esc(lead) + nameHTML(shown[i], e.node).replace(/<\/span>$/, "</span>")
      : esc(t);
    return [t + s, o.color ? html + esc(s) : esc(t + s)];
  });
}

/** GNU's column layout: fewest rows that fit, filled down the columns. */
function columns(cells: Cell[], width: number): Cell[][] {
  const n = cells.length;
  if (n === 0) return [];
  const MIN = 3;
  const maxCols = Math.min(Math.max(1, Math.floor(width / MIN)), n);
  const lineLen: number[] = [];
  const valid: boolean[] = [];
  const colArr: number[][] = [];
  for (let i = 0; i < maxCols; i++) {
    lineLen[i] = (i + 1) * MIN;
    valid[i] = true;
    colArr[i] = new Array<number>(i + 1).fill(MIN);
  }
  for (let fi = 0; fi < n; fi++) {
    const nameLen = [...cells[fi][0]].length;
    for (let i = 0; i < maxCols; i++) {
      if (!valid[i]) continue;
      const rows = Math.floor((n + i) / (i + 1));
      const idx = Math.floor(fi / rows);
      const real = nameLen + (idx === i ? 0 : 2);
      if (real > colArr[i][idx]) {
        lineLen[i] += real - colArr[i][idx];
        colArr[i][idx] = real;
        valid[i] = lineLen[i] < width;
      }
    }
  }
  let cols = maxCols;
  while (cols > 1 && !valid[cols - 1]) cols--;
  const rows = Math.floor((n + cols - 1) / cols);
  const w = colArr[cols - 1];
  const out: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = c * rows + r;
      if (idx >= n) break;
      const cell = cells[idx];
      const last = c === cols - 1 || (c + 1) * rows + r >= n;
      const pad = last ? 0 : w[c] - [...cell[0]].length;
      row.push(
        last ? cell : [cell[0] + " ".repeat(pad), cell[1] + " ".repeat(pad)],
      );
    }
    out.push(row);
  }
  return out;
}

/** The lines of one listing. `dirTotal` adds the `total` line of a folder. */
function listing(list: Ent[], o: LsOpts, dirTotal: boolean): Cell[] {
  const names = nameCells(list, o);
  const lines: Cell[] = [];
  const pre = (e: Ent): string =>
    (o.inode ? `${inodeOf(e.abs)} ` : "") +
    (o.blocks
      ? `${o.human ? human(blocksK(e.node) * 1024) : blocksK(e.node)} `
      : "");
  if (o.format === "long") {
    const rows = list.map((e) => {
      const own = o.numeric
        ? ownerOf(e.abs) === "cadet"
          ? "1000"
          : "0"
        : ownerOf(e.abs);
      return {
        mode: modeText(e.node),
        links: String(linkCount(e.abs, e.node)),
        own,
        size: o.human ? human(sizeOf(e.node)) : String(sizeOf(e.node)),
        time: lsTime(mtimeMs(e.node)),
        pre: pre(e),
      };
    });
    const w = (k: "links" | "own" | "size") =>
      Math.max(0, ...rows.map((r) => r[k].length));
    if (dirTotal) {
      const sum = list.reduce((s, e) => s + blocksK(e.node), 0);
      lines.push(plain("total " + (o.human ? human(sum * 1024) : sum)));
    }
    rows.forEach((r, i) => {
      const meta = `${r.pre}${r.mode} ${padL(r.links, w("links"))} ${padR(r.own, w("own"))} ${padR(r.own, w("own"))} ${padL(r.size, w("size"))} ${r.time} `;
      lines.push(join(plain(meta), names[i]));
    });
    return lines;
  }
  if (dirTotal && o.blocks) {
    const sum = list.reduce((s, e) => s + blocksK(e.node), 0);
    lines.push(plain("total " + (o.human ? human(sum * 1024) : sum)));
  }
  if (o.format === "one" || !o.tty) {
    names.forEach((c, i) => lines.push(join(plain(pre(list[i])), c)));
    return lines;
  }
  const withPre = names.map((c, i) => join(plain(pre(list[i])), c));
  for (const row of columns(withPre, termCols.cols)) {
    lines.push(join(...row));
  }
  return lines;
}

const ls: CmdFn = (argv0, sh, io) => {
  // `--color[=WHEN]` and `--sort=WORD` take an optional or glued value.
  let color: boolean | null = null;
  let sortWord: string | null = null;
  const argv = argv0.filter((a, i) => {
    if (i === 0) return true;
    if (a === "--color" || a.startsWith("--color=")) {
      const v = a === "--color" ? "always" : a.slice(8);
      color = v !== "never" && v !== "no" && v !== "none";
      return false;
    }
    if (a.startsWith("--sort=")) {
      sortWord = a.slice(7);
      return false;
    }
    if (a.startsWith("--time-style=") || a === "--group-directories-first")
      return false;
    return true;
  });
  const r = opts(
    io,
    "ls",
    argv,
    "aAlh1CdFptrSURisnxGgoqbkf",
    {
      all: ["a", false],
      "almost-all": ["A", false],
      "human-readable": ["h", false],
      reverse: ["r", false],
      recursive: ["R", false],
      directory: ["d", false],
      classify: ["F", false],
      inode: ["i", false],
      size: ["s", false],
    },
    2,
  );
  if (typeof r === "number") return r;
  const o: LsOpts = {
    all: false,
    almost: false,
    format: "cols",
    human: false,
    dirOnly: false,
    classify: false,
    slash: false,
    sort: "name",
    reverse: false,
    recursive: false,
    inode: false,
    blocks: false,
    numeric: false,
    tty: io.out.tty && sh.promptLevel(),
    color: false,
  };
  for (const { name } of r.all) {
    switch (name) {
      case "a":
        o.all = true;
        break;
      case "A":
        o.almost = true;
        break;
      case "l":
      case "g":
      case "o":
      case "n":
        o.format = "long";
        if (name === "n") o.numeric = true;
        break;
      case "1":
        o.format = "one";
        break;
      case "C":
      case "x":
        o.format = "cols";
        break;
      case "h":
        o.human = true;
        break;
      case "d":
        o.dirOnly = true;
        break;
      case "F":
        o.classify = true;
        break;
      case "p":
        o.slash = true;
        break;
      case "t":
        o.sort = "time";
        break;
      case "S":
        o.sort = "size";
        break;
      case "U":
        o.sort = "none";
        break;
      case "f":
        o.sort = "none";
        o.all = true;
        break;
      case "r":
        o.reverse = true;
        break;
      case "R":
        o.recursive = true;
        break;
      case "i":
        o.inode = true;
        break;
      case "s":
        o.blocks = true;
        break;
    }
  }
  if (sortWord === "size") o.sort = "size";
  else if (sortWord === "time") o.sort = "time";
  else if (sortWord === "none") o.sort = "none";
  o.color = o.tty && color !== false;

  const args = r.rest.length ? r.rest : ["."];
  let code = 0;
  const files: Ent[] = [];
  const dirs: Ent[] = [];
  for (const a of args) {
    const f1 = lookup(sh, a);
    if (!isFound(f1)) {
      errOut(io, "ls", `cannot access ${q(a)}: ${f1.err}`);
      code = 2;
      continue;
    }
    const ent: Ent = { name: a, abs: f1.abs, node: f1.node };
    if (f1.node.t === "d" && !o.dirOnly) dirs.push(ent);
    else files.push(ent);
  }
  const emit = (cells: Cell[]) => {
    if (!cells.length) return;
    const text = cells.map((c) => c[0]).join("\n") + "\n";
    const html = cells.map((c) => c[1]).join("\n") + "\n";
    io.out.write(text, o.tty ? html : undefined);
  };
  let first = true;
  const gap = () => {
    if (!first) io.out.write("\n");
    first = false;
  };
  if (files.length) {
    gap();
    emit(listing(sortEnts(files, o), o, false));
  }
  const showHead = args.length > 1 || o.recursive;
  const walk = (dir: Ent, depth: number): void => {
    const node = dir.node as DirNode;
    if (!canRead(node)) {
      errOut(
        io,
        "ls",
        `cannot open directory ${q(dir.name)}: Permission denied`,
      );
      code = code || 2;
      return;
    }
    const kids: Ent[] = [];
    const names = Object.keys(node.c);
    if (o.all) {
      kids.push({ name: ".", abs: dir.abs, node });
      const par = get(parentOf(dir.abs));
      kids.push({
        name: "..",
        abs: parentOf(dir.abs),
        node: par ?? node,
      });
    }
    for (const nm of names) {
      if (nm.startsWith(".") && !o.all && !o.almost) continue;
      kids.push({ name: nm, abs: joinPath(dir.abs, nm), node: node.c[nm] });
    }
    gap();
    if (showHead) io.out.write(`${dir.name}:\n`);
    const sorted = sortEnts(kids, o);
    emit(listing(sorted, o, true));
    if (o.recursive && depth < 64) {
      for (const k of sorted)
        if (k.node.t === "d" && k.name !== "." && k.name !== "..")
          walk(
            {
              name: dir.name === "/" ? "/" + k.name : `${dir.name}/${k.name}`,
              abs: k.abs,
              node: k.node,
            },
            depth + 1,
          );
    }
  };
  for (const dEnt of sortEnts(dirs, o)) walk(dEnt, 0);
  return code;
};

/* ---------- cat, head, tail, wc ---------- */

const cat: CmdFn = async (argv, sh, io) => {
  const r = opts(io, "cat", argv, "AbeEnstTuv", {
    "show-all": ["A", false],
    "number-nonblank": ["b", false],
    "show-ends": ["E", false],
    number: ["n", false],
    "squeeze-blank": ["s", false],
    "show-tabs": ["T", false],
    "show-nonprinting": ["v", false],
  });
  if (typeof r === "number") return r;
  const has = (n: string) => r.has(n);
  const ends = has("E") || has("A") || has("e");
  const tabs = has("T") || has("A") || has("t");
  const nonblank = has("b");
  const number = has("n") && !nonblank;
  const squeeze = has("s");
  const fancy = ends || tabs || number || nonblank || squeeze;
  let code = 0;
  let lineNo = 0;
  let prevBlank = false;
  let out = "";
  const one = (line: string, nl: boolean) => {
    const blank = line === "";
    if (squeeze && blank && prevBlank) return;
    prevBlank = blank;
    let s = tabs ? line.replace(/\t/g, "^I") : line;
    if (ends && nl) s += "$";
    if (nonblank ? !blank : number) s = String(++lineNo).padStart(6) + "\t" + s;
    out += s + (nl ? "\n" : "");
  };
  for (const name of r.rest.length ? r.rest : ["-"]) {
    if (name === "-") {
      // B26: standard input is a stream. Each chunk goes out as it comes.
      if (!fancy) {
        for (;;) {
          const c = await io.in.readChunk(undefined, sh);
          if (c === null) break;
          io.out.write(c);
          await sh.drain();
        }
      } else {
        await streamLines(io.in, sh, (lines, lastPart) => {
          lines.forEach((l) => one(l, !lastPart));
          io.out.write(out);
          out = "";
        });
      }
      continue;
    }
    {
      const f1 = lookup(sh, name);
      if (isFound(f1) && f1.node.t === "d") {
        errOut(io, "cat", `${name}: Is a directory`);
        code = 1;
        continue;
      }
    }
    const t = await readFileArg("cat", sh, io, name);
    if (t === null) {
      code = 1;
      continue;
    }
    const text = t;
    if (!fancy) {
      io.out.write(text);
      continue;
    }
    const parts = text.split("\n");
    const last = parts.pop() as string;
    for (const line of parts) one(line, true);
    if (last !== "") one(last, false);
    io.out.write(out);
    out = "";
  }
  return code;
};

/** A count with the `b k K m M g G` suffixes of head and tail. */
function parseCount(
  s: string,
): { n: number; plus: boolean; minus: boolean } | null {
  const m = /^([+-]?)(\d+)([bkKmMgG]?)$/.exec(s);
  if (!m) return null;
  const mult: Record<string, number> = {
    "": 1,
    b: 512,
    k: 1024,
    K: 1024,
    m: 1048576,
    M: 1048576,
    g: 1073741824,
    G: 1073741824,
  };
  return {
    n: parseInt(m[2], 10) * mult[m[3]],
    plus: m[1] === "+",
    minus: m[1] === "-",
  };
}

function headTail(which: "head" | "tail"): CmdFn {
  return async (argv, sh, io) => {
    let count = { n: 10, plus: false, minus: false };
    let bytes = false;
    let quiet = false;
    let verbose = false;
    const files: string[] = [];
    let endOpts = false;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      const num = (v: string | undefined, kind: string): boolean => {
        const c = v === undefined ? null : parseCount(v);
        if (!c) {
          errOut(io, which, `invalid number of ${kind}: ${qc(v ?? "")}`);
          return false;
        }
        count = c;
        bytes = kind === "bytes";
        return true;
      };
      if (endOpts || a === "-" || a[0] !== "-") files.push(a);
      else if (a === "--") endOpts = true;
      else if (a === "-n" || a === "--lines") {
        if (argv[i + 1] === undefined) {
          io.err.write(
            `${which}: option requires an argument -- 'n'\n${tryHelp(which)}`,
          );
          return 1;
        }
        if (!num(argv[++i], "lines")) return 1;
      } else if (a.startsWith("--lines=")) {
        if (!num(a.slice(8), "lines")) return 1;
      } else if (a === "-c" || a === "--bytes") {
        if (argv[i + 1] === undefined) {
          io.err.write(
            `${which}: option requires an argument -- 'c'\n${tryHelp(which)}`,
          );
          return 1;
        }
        if (!num(argv[++i], "bytes")) return 1;
      } else if (a.startsWith("--bytes=")) {
        if (!num(a.slice(8), "bytes")) return 1;
      } else if (/^-n./.test(a)) {
        if (!num(a.slice(2), "lines")) return 1;
      } else if (/^-c./.test(a)) {
        if (!num(a.slice(2), "bytes")) return 1;
      } else if (/^-\d+$/.test(a)) {
        count = { n: parseInt(a.slice(1), 10), plus: false, minus: false };
        bytes = false;
      } else if (a === "-q" || a === "--quiet" || a === "--silent")
        quiet = true;
      else if (a === "-v" || a === "--verbose") verbose = true;
      else if (
        which === "tail" &&
        (a === "-f" || a === "-F" || a === "--follow")
      )
        continue;
      else if (a.startsWith("--")) {
        io.err.write(
          `${which}: unrecognized option '${a.split("=")[0]}'\n${tryHelp(which)}`,
        );
        return 1;
      } else {
        io.err.write(
          `${which}: invalid option -- '${a[1]}'\n${tryHelp(which)}`,
        );
        return 1;
      }
    }
    const names = files.length ? files : ["-"];
    const header = verbose || (!quiet && names.length > 1);
    let code = 0;
    let firstOut = true;
    for (const name of names) {
      let text: string | null;
      if (name === "-" && which === "head" && !count.minus) {
        // B26: `head` reads standard input as a stream and stops when it has enough.
        if (header)
          io.out.write(`${firstOut ? "" : "\n"}==> standard input <==\n`);
        firstOut = false;
        await headStream(io, sh, count.n, bytes);
        continue;
      }
      if (name === "-") text = await io.in.readAll(sh);
      else {
        const f1 = lookup(sh, name);
        if (!isFound(f1)) {
          errOut(io, which, `cannot open ${q(name)} for reading: ${f1.err}`);
          code = 1;
          continue;
        }
        if (f1.node.t === "d") {
          errOut(io, which, `error reading ${q(name)}: Is a directory`);
          code = 1;
          if (header) {
            io.out.write(`${firstOut ? "" : "\n"}==> ${name} <==\n`);
            firstOut = false;
          }
          continue;
        }
        const got = await readPath(f1.abs, io);
        if ("err" in got) {
          errOut(io, which, `cannot open ${q(name)} for reading: ${got.err}`);
          code = 1;
          continue;
        }
        text = got.text;
      }
      if (header) {
        io.out.write(
          `${firstOut ? "" : "\n"}==> ${name === "-" ? "standard input" : name} <==\n`,
        );
      }
      firstOut = false;
      io.out.write(slice(text, which, count, bytes));
    }
    return code;
  };
}

/** `head` of standard input, one chunk at a time; it stops reading at `n` lines or bytes. */
async function headStream(
  io: IO,
  sh: Proc,
  n: number,
  bytes: boolean,
): Promise<void> {
  let left = n;
  while (left > 0) {
    if (bytes) {
      const c = await io.in.readChunk(undefined, sh);
      if (c === null) return;
      const b = enc.encode(c);
      if (b.length <= left) {
        io.out.write(c);
        left -= b.length;
      } else {
        io.out.write(dec.decode(b.slice(0, left)));
        left = 0;
      }
    } else {
      const l = await io.in.readLine(sh);
      if (l === null) return;
      io.out.write(l.line + (l.nl ? "\n" : ""));
      left--;
    }
    await sh.drain();
  }
}

function slice(
  text: string,
  which: "head" | "tail",
  c: { n: number; plus: boolean; minus: boolean },
  bytes: boolean,
): string {
  if (bytes) {
    const b = enc.encode(text);
    let part: Uint8Array;
    if (which === "head")
      part = c.minus
        ? b.slice(0, Math.max(0, b.length - c.n))
        : b.slice(0, c.n);
    else
      part = c.plus
        ? b.slice(Math.max(0, c.n - 1))
        : b.slice(Math.max(0, b.length - c.n));
    return dec.decode(part);
  }
  // Lines keep their own endings; the last one may have none.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (which === "head") {
    const take = c.minus ? Math.max(0, lines.length - c.n) : c.n;
    return lines.slice(0, take).join("");
  }
  if (c.plus) return lines.slice(Math.max(0, c.n - 1)).join("");
  return c.n === 0 ? "" : lines.slice(-c.n).join("");
}

const head = headTail("head");
const tail = headTail("tail");

/** The counts of standard input, read in chunks (B26). Only the columns asked for are worked out. */
async function wcStream(
  io: IO,
  sh: Proc,
  cols: string[],
): Promise<Record<string, number>> {
  const c = { l: 0, w: 0, c: 0, m: 0, L: 0 };
  const want = (k: string) => cols.includes(k);
  let inWord = false;
  let cur = 0;
  for (;;) {
    const t = await io.in.readChunk(undefined, sh);
    if (t === null) break;
    if (want("l")) {
      let at = -1;
      while ((at = t.indexOf("\n", at + 1)) >= 0) c.l++;
    }
    if (want("w")) {
      const m = t.match(/\S+/g);
      c.w += m ? m.length : 0;
      if (inWord && /^\S/.test(t)) c.w--;
      inWord = /\S$/.test(t);
    }
    if (want("c")) c.c += byteLen(t);
    if (want("m")) c.m += [...t].length;
    if (want("L")) {
      const parts = t.split("\n");
      cur += [...parts[0]].length;
      c.L = Math.max(c.L, cur);
      for (let k = 1; k < parts.length; k++) {
        cur = [...parts[k]].length;
        c.L = Math.max(c.L, cur);
      }
    }
    await sh.drain();
  }
  return c;
}

const wc: CmdFn = async (argv, sh, io) => {
  const r = opts(io, "wc", argv, "lwcmL", {
    lines: ["l", false],
    words: ["w", false],
    bytes: ["c", false],
    chars: ["m", false],
    "max-line-length": ["L", false],
  });
  if (typeof r === "number") return r;
  let cols = ["l", "w", "c", "m", "L"].filter((k) => r.has(k));
  if (!cols.length) cols = ["l", "w", "c"];
  const names = r.rest.length ? r.rest : ["-"];
  interface Row {
    c: Record<string, number>;
    name: string;
  }
  const rows: Row[] = [];
  let code = 0;
  let width = 1;
  let regular = 0;
  let wide = false;
  for (const name of names) {
    let text: string;
    if (name === "-") {
      // B26: `wc` counts standard input chunk by chunk.
      wide = true;
      rows.push({
        name: name === "-" && r.rest.length === 0 ? "" : name,
        c: await wcStream(io, sh, cols),
      });
      continue;
    } else {
      const f1 = lookup(sh, name);
      if (!isFound(f1)) {
        errOut(io, "wc", `${name}: ${f1.err}`);
        code = 1;
        continue;
      }
      if (f1.node.t === "d") {
        errOut(io, "wc", `${name}: Is a directory`);
        rows.push({ c: { l: 0, w: 0, c: 0, m: 0, L: 0 }, name });
        wide = true;
        code = 1;
        continue;
      }
      const got = await readPath(f1.abs, io);
      if ("err" in got) {
        errOut(io, "wc", `${name}: ${got.err}`);
        code = 1;
        continue;
      }
      text = got.text;
      regular += sizeOf(f1.node);
    }
    let maxLine = 0;
    for (const l of text.split("\n"))
      maxLine = Math.max(maxLine, [...l].length);
    rows.push({
      name: name === "-" && r.rest.length === 0 ? "" : name,
      c: {
        l: (text.match(/\n/g) ?? []).length,
        w: text.split(/\s+/).filter(Boolean).length,
        c: byteLen(text),
        m: [...text].length,
        L: maxLine,
      },
    });
  }
  if (rows.length > 1) {
    const t: Record<string, number> = { l: 0, w: 0, c: 0, m: 0, L: 0 };
    for (const row of rows) {
      for (const k of ["l", "w", "c", "m"]) t[k] += row.c[k];
      t.L = Math.max(t.L, row.c.L);
    }
    rows.push({ name: "total", c: t });
  }
  if (cols.length === 1 && names.length <= 1) width = 1;
  else if (wide) width = 7;
  else for (let s = regular; s >= 10; s = Math.floor(s / 10)) width++;
  for (const row of rows) {
    const nums = cols.map((k) => padL(String(row.c[k]), width)).join(" ");
    io.out.write(nums + (row.name ? " " + row.name : "") + "\n");
  }
  return code;
};

/* ---------- sort, uniq ---------- */

interface KeySpec {
  f1: number;
  c1: number;
  f2: number | null;
  c2: number;
  flags: string;
}

function parseKey(s: string): KeySpec | null {
  const m =
    /^(\d+)(?:\.(\d+))?([bdfghiMnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfghiMnRrV]*))?$/.exec(
      s,
    );
  if (!m) return null;
  const f1 = parseInt(m[1], 10);
  if (f1 < 1) return null;
  return {
    f1,
    c1: m[2] ? parseInt(m[2], 10) : 1,
    f2: m[4] ? parseInt(m[4], 10) : null,
    c2: m[5] ? parseInt(m[5], 10) : 0,
    flags: (m[3] ?? "") + (m[6] ?? ""),
  };
}

/** The text of one key of a line. */
function keyText(
  line: string,
  k: KeySpec,
  sep: string | null,
  bflag: boolean,
): string {
  const starts: number[] = [];
  const ends: number[] = [];
  if (sep === null) {
    const re = /[ \t]*[^ \t]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null && m[0] !== "") {
      starts.push(m.index);
      ends.push(m.index + m[0].length);
    }
  } else {
    let pos = 0;
    for (const part of line.split(sep)) {
      starts.push(pos);
      ends.push(pos + part.length);
      pos += part.length + sep.length;
    }
  }
  if (k.f1 > starts.length) return "";
  let b = starts[k.f1 - 1];
  if (bflag || k.flags.includes("b"))
    while (b < line.length && (line[b] === " " || line[b] === "\t")) b++;
  b = Math.min(line.length, b + k.c1 - 1);
  let e = line.length;
  if (k.f2 !== null) {
    const fi = Math.min(k.f2, starts.length) - 1;
    e = k.c2 === 0 ? ends[fi] : Math.min(ends[fi], starts[fi] + k.c2);
  }
  return e > b ? line.slice(b, e) : "";
}

const MONTH_ORDER = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function numberOf(s: string, human: boolean): number {
  const m = /^[ \t]*([-+]?\d*\.?\d*)([KMGTPEZY]?)/.exec(s);
  if (!m) return 0;
  let v = parseFloat(m[1]);
  if (!Number.isFinite(v)) v = 0;
  if (human && m[2]) v *= 1024 ** ("KMGTPEZY".indexOf(m[2]) + 1);
  return v;
}

function versionCmp(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const d2 = parseInt(x, 10) - parseInt(y, 10);
      if (d2) return d2;
    } else {
      const c = cmpStr(x, y);
      if (c) return c;
    }
  }
  return ta.length - tb.length;
}

function cmpBy(a: string, b: string, fl: string): number {
  let x = a;
  let y = b;
  if (fl.includes("b")) {
    x = x.replace(/^[ \t]+/, "");
    y = y.replace(/^[ \t]+/, "");
  }
  if (fl.includes("d")) {
    x = x.replace(/[^A-Za-z0-9 \t]/g, "");
    y = y.replace(/[^A-Za-z0-9 \t]/g, "");
  }
  if (fl.includes("f")) {
    x = x.toUpperCase();
    y = y.toUpperCase();
  }
  let c: number;
  if (fl.includes("n") || fl.includes("g"))
    c = numberOf(x, false) - numberOf(y, false);
  else if (fl.includes("h")) c = numberOf(x, true) - numberOf(y, true);
  else if (fl.includes("M")) {
    const mo = (s: string) =>
      MONTH_ORDER.indexOf(s.trim().slice(0, 3).toUpperCase()) + 1;
    c = mo(x) - mo(y);
  } else if (fl.includes("V")) c = versionCmp(x, y);
  else c = cmpStr(x, y);
  return fl.includes("r") ? -c : c;
}

const sort: CmdFn = async (argv, sh, io) => {
  const r = opts(
    io,
    "sort",
    argv,
    "bdfghiMnrRsuVczk:t:o:T:S:",
    {
      "ignore-leading-blanks": ["b", false],
      "dictionary-order": ["d", false],
      "ignore-case": ["f", false],
      "general-numeric-sort": ["g", false],
      "human-numeric-sort": ["h", false],
      "month-sort": ["M", false],
      "numeric-sort": ["n", false],
      reverse: ["r", false],
      stable: ["s", false],
      unique: ["u", false],
      "version-sort": ["V", false],
      check: ["c", false],
      key: ["k", true],
      "field-separator": ["t", true],
      output: ["o", true],
    },
    2,
  );
  if (typeof r === "number") return r;
  let global = "";
  for (const k of "bdfghiMnrV") if (r.has(k)) global += k;
  const keys: KeySpec[] = [];
  for (const o of r.all) {
    if (o.name !== "k") continue;
    const k = parseKey(o.val ?? "");
    if (!k) {
      errOut(
        io,
        "sort",
        `invalid number at field start: invalid count at start of ${qc(o.val ?? "")}`,
      );
      return 2;
    }
    keys.push(k);
  }
  let sep: string | null = null;
  const tv = r.val("t");
  if (tv !== undefined) {
    if (tv.length !== 1) {
      errOut(io, "sort", `multi-character tab ${qc(tv)}`);
      return 2;
    }
    sep = tv;
  }
  let text = "";
  let code = 0;
  for (const name of r.rest.length ? r.rest : ["-"]) {
    if (name !== "-") {
      const f1 = lookup(sh, name);
      if (!isFound(f1)) {
        errOut(io, "sort", `cannot read: ${name}: ${f1.err}`);
        code = 2;
        continue;
      }
      if (f1.node.t === "d") {
        errOut(io, "sort", `read failed: ${name}: Is a directory`);
        code = 2;
        continue;
      }
    }
    const t = await readFileArg(
      "sort",
      sh,
      io,
      name,
      (e) => `cannot read: ${name}: ${e}`,
    );
    if (t === null) {
      code = 2;
      continue;
    }
    text += t.endsWith("\n") || t === "" ? t : t + "\n";
  }
  if (code && !text) return code;
  const lines = splitLines(text);
  const bflag = global.includes("b");
  const keyCmp = (a: string, b: string): number => {
    if (!keys.length) return cmpBy(a, b, global);
    for (const k of keys) {
      const fl = k.flags.replace(/[^bdfghiMnrV]/g, "") || global;
      const c = cmpBy(keyText(a, k, sep, bflag), keyText(b, k, sep, bflag), fl);
      if (c) return c;
    }
    return 0;
  };
  const unique = r.has("u");
  const stable = r.has("s") || unique;
  if (r.has("c")) {
    for (let i = 1; i < lines.length; i++) {
      const c = keyCmp(lines[i - 1], lines[i]);
      if (c > 0 || (unique && c === 0)) {
        errOut(
          io,
          "sort",
          `${r.rest[0] ?? "-"}:${i + 1}: disorder: ${lines[i]}`,
        );
        return 1;
      }
    }
    return code;
  }
  const idx = lines.map((l, i) => i);
  idx.sort((i, j) => {
    const c = keyCmp(lines[i], lines[j]);
    if (c) return c;
    if (stable) return i - j;
    const last = cmpStr(lines[i], lines[j]);
    return global.includes("r") ? -last : last;
  });
  let out: string[] = idx.map((i) => lines[i]);
  if (unique)
    out = out.filter((l, i) => i === 0 || keyCmp(out[i - 1], l) !== 0);
  const res = out.map((l) => l + "\n").join("");
  const o = r.val("o");
  if (o !== undefined) {
    const abs = sh.abs(o);
    if (!writeFileArg("sort", io, abs, o, res)) return 2;
    return code;
  }
  io.out.write(res);
  return code;
};

const uniq: CmdFn = async (argv, sh, io) => {
  const r = opts(io, "uniq", argv, "cdDuiszf:s:w:", {
    count: ["c", false],
    repeated: ["d", false],
    unique: ["u", false],
    "ignore-case": ["i", false],
    "skip-fields": ["f", true],
    "skip-chars": ["s", true],
    "check-chars": ["w", true],
  });
  if (typeof r === "number") return r;
  const num = (n: string): number | null => {
    const v = r.val(n);
    if (v === undefined) return 0;
    if (!/^\d+$/.test(v)) {
      errOut(
        io,
        "uniq",
        `${v}: invalid ${n === "f" ? "number of fields to skip" : n === "s" ? "number of bytes to skip" : "number of bytes to compare"}`,
      );
      return null;
    }
    return parseInt(v, 10);
  };
  const skipF = num("f");
  const skipS = num("s");
  const checkW = r.val("w") === undefined ? null : num("w");
  if (skipF === null || skipS === null) return 1;
  if (r.rest.length > 2) {
    errOut(io, "uniq", `extra operand ${qc(r.rest[2])}`);
    io.err.write(tryHelp("uniq"));
    return 1;
  }
  const inName = r.rest[0] ?? "-";
  const ci = r.has("i");
  const key = (l: string): string => {
    let s = l;
    for (let i = 0; i < skipF; i++) s = s.replace(/^[ \t]*[^ \t]*/, "");
    s = s.slice(skipS);
    if (checkW !== null) s = s.slice(0, checkW);
    return ci ? s.toLowerCase() : s;
  };
  const keepGroup = (n: number): boolean =>
    r.has("d") && !r.has("u")
      ? n > 1
      : r.has("u") && !r.has("d")
        ? n === 1
        : true;
  const show = ([l, n]: [string, number]): string =>
    (r.has("c") ? padL(String(n), 7) + " " + l : l) + "\n";
  if (inName === "-" && r.rest[1] === undefined) {
    // B26: `uniq` reads standard input as a stream; a group goes out when the next one starts.
    let cur: [string, number] | null = null;
    await streamLines(io.in, sh, (lines) => {
      let out = "";
      for (const l of lines) {
        if (cur && key(cur[0]) === key(l)) cur[1]++;
        else {
          if (cur && keepGroup(cur[1])) out += show(cur);
          cur = [l, 1];
        }
      }
      io.out.write(out);
    });
    const last = cur as [string, number] | null;
    if (last && keepGroup(last[1])) io.out.write(show(last));
    return 0;
  }
  const text = await readFileArg("uniq", sh, io, inName);
  if (text === null) return 1;
  const groups: [string, number][] = [];
  for (const l of splitLines(text)) {
    const last = groups[groups.length - 1];
    if (last && key(last[0]) === key(l)) last[1]++;
    else groups.push([l, 1]);
  }
  let res = groups;
  if (r.has("d") && !r.has("u")) res = res.filter((g) => g[1] > 1);
  else if (r.has("u") && !r.has("d")) res = res.filter((g) => g[1] === 1);
  const out = res
    .map(([l, n]) => (r.has("c") ? padL(String(n), 7) + " " + l : l) + "\n")
    .join("");
  if (r.rest[1] !== undefined) {
    const abs = sh.abs(r.rest[1]);
    return writeFileArg("uniq", io, abs, r.rest[1], out) ? 0 : 1;
  }
  io.out.write(out);
  return 0;
};

/* ---------- grep ---------- */

const POSIX_CLASS: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
};

/** Turns a POSIX basic or extended expression into a JavaScript source string. */
function posixToJs(p: string, ere: boolean): string {
  let out = "";
  let atStart = true;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      const n = p[++i];
      if (n === undefined) throw new Error("Trailing backslash");
      if (!ere && "(){}|+?".includes(n)) {
        out += n;
        atStart = n === "(" || n === "|";
      } else if (n === "<" || n === ">") out += "\\b";
      else if (/[1-9]/.test(n)) out += "\\" + n;
      else if (/[wWsSbB]/.test(n)) out += "\\" + n;
      else if (/[A-Za-z0-9]/.test(n)) out += n;
      else out += "\\" + n;
      if (!(!ere && "(|".includes(n))) atStart = false;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      let set = "[";
      if (p[j] === "^") {
        set += "^";
        j++;
      }
      if (p[j] === "]") {
        set += "\\]";
        j++;
      }
      let closed = false;
      for (; j < p.length; j++) {
        if (p[j] === "[" && p[j + 1] === ":") {
          const e = p.indexOf(":]", j + 2);
          if (e > 0) {
            const cls = POSIX_CLASS[p.slice(j + 2, e)];
            if (!cls) throw new Error("Invalid character class name");
            set += cls;
            j = e + 1;
            continue;
          }
        }
        if (p[j] === "]") {
          closed = true;
          break;
        }
        set += p[j] === "\\" || p[j] === "[" ? "\\" + p[j] : p[j];
      }
      if (!closed) throw new Error("Unmatched [, [^, [:, [., or [=");
      out += set + "]";
      i = j;
      atStart = false;
      continue;
    }
    if (c === "*" && atStart) {
      out += "\\*";
      atStart = false;
      continue;
    }
    if (ere) {
      if (c === "(" || c === "|") {
        out += c;
        atStart = true;
        continue;
      }
      if (c === "{") {
        const m = /^\{\d*,?\d*\}/.exec(p.slice(i));
        if (m && m[0] !== "{}") {
          out += m[0];
          i += m[0].length - 1;
        } else out += "\\{";
        atStart = false;
        continue;
      }
      out += c;
      atStart = false;
      continue;
    }
    if ("(){}|+?".includes(c)) out += "\\" + c;
    else out += c;
    atStart = false;
  }
  return out;
}

interface GrepSrc {
  name: string;
  text: string;
  /** Standard input: read as a stream, in its place in the list (B26). */
  stdin?: boolean;
}

function grepCmd(forced: "E" | "F" | null, label: string): CmdFn {
  return async (argv0, sh, io) => {
    let color: boolean | null = null;
    const includes: string[] = [];
    const excludes: string[] = [];
    const excludeDirs: string[] = [];
    const argv = argv0.flatMap((a, i): string[] => {
      if (i === 0) return [a];
      if (/^-\d+$/.test(a)) return ["-C", a.slice(1)];
      if (a === "--color" || a === "--colour" || /^--colou?r=/.test(a)) {
        const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : "auto";
        color = v !== "never" && v !== "no" && v !== "none";
        return [];
      }
      let m: RegExpExecArray | null;
      if ((m = /^--include=(.*)$/.exec(a))) {
        includes.push(m[1]);
        return [];
      }
      if ((m = /^--exclude=(.*)$/.exec(a))) {
        excludes.push(m[1]);
        return [];
      }
      if ((m = /^--exclude-dir=(.*)$/.exec(a))) {
        excludeDirs.push(m[1]);
        return [];
      }
      if (a.startsWith("--binary-files=")) return [];
      return [a];
    });
    const r = opts(
      io,
      label,
      argv,
      "EFGPiyvcnlLhHrRoqswxaIzA:B:C:m:e:f:d:D:",
      {
        "extended-regexp": ["E", false],
        "fixed-strings": ["F", false],
        "basic-regexp": ["G", false],
        "perl-regexp": ["P", false],
        "ignore-case": ["i", false],
        "no-ignore-case": ["no-ignore-case", false],
        "invert-match": ["v", false],
        count: ["c", false],
        "line-number": ["n", false],
        "files-with-matches": ["l", false],
        "files-without-match": ["L", false],
        "no-filename": ["h", false],
        "with-filename": ["H", false],
        recursive: ["r", false],
        "dereference-recursive": ["R", false],
        "only-matching": ["o", false],
        quiet: ["q", false],
        silent: ["q", false],
        "no-messages": ["s", false],
        "word-regexp": ["w", false],
        "line-regexp": ["x", false],
        text: ["a", false],
        regexp: ["e", true],
        file: ["f", true],
        "max-count": ["m", true],
        "after-context": ["A", true],
        "before-context": ["B", true],
        context: ["C", true],
      },
      2,
    );
    if (typeof r === "number") return r;
    const patterns: string[] = [];
    let havePat = false;
    for (const o of r.all) {
      if (o.name === "e") {
        patterns.push(...(o.val ?? "").split("\n"));
        havePat = true;
      } else if (o.name === "f") {
        const t = await readFileArg(label, sh, io, o.val ?? "");
        if (t === null) return 2;
        patterns.push(...splitLines(t));
        havePat = true;
      }
    }
    const rest = r.rest.slice();
    if (!havePat) {
      if (!rest.length) {
        io.err.write(
          `Usage: ${label} [OPTION]... PATTERNS [FILE]...\nTry '${label} --help' for more information.\n`,
        );
        return 2;
      }
      patterns.push(...(rest.shift() as string).split("\n"));
    }
    const mode =
      forced ?? (r.has("F") ? "F" : r.has("E") ? "E" : r.has("P") ? "P" : "G");
    const ci = (r.has("i") || r.has("y")) && !r.has("no-ignore-case");
    let re: RegExp;
    try {
      const parts = patterns.map((p) => {
        if (mode === "F") return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (mode === "P") return p;
        return posixToJs(p, mode === "E");
      });
      let src =
        parts.length === 1 ? parts[0] : parts.map((p) => `(?:${p})`).join("|");
      if (r.has("x")) src = `^(?:${src})$`;
      else if (r.has("w")) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
      re = new RegExp(src, ci ? "gi" : "g");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      errOut(
        io,
        label,
        /^(Trailing|Unmatched|Invalid character)/.test(msg)
          ? msg
          : mode === "P"
            ? "unmatched parentheses"
            : /[[]/.test(patterns.join("")) && !/\]/.test(patterns.join(""))
              ? "Unmatched [, [^, [:, [., or [="
              : "Unmatched ( or \\(",
      );
      return 2;
    }
    const recursive = r.has("r") || r.has("R");
    const names = rest.length ? rest : recursive ? ["."] : ["-"];
    const implicitDot = recursive && !rest.length;
    const srcs: GrepSrc[] = [];
    let code = 0;
    const quiet = r.has("q");
    const silent = r.has("s");
    const globTest = (g: string, nm: string): boolean =>
      new RegExp(
        "^" +
          g
            .replace(/[.+^${}()|\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
      ).test(nm);
    const allowed = (nm: string): boolean =>
      (!includes.length || includes.some((g) => globTest(g, nm))) &&
      !excludes.some((g) => globTest(g, nm));
    const addFile = (display: string, abs: string, node: FileNode): void => {
      if (!allowed(baseOf(abs))) return;
      if (!canRead(node)) {
        if (!silent) errOut(io, label, `${display}: Permission denied`);
        code = 2;
        return;
      }
      srcs.push({ name: display, text: node.x });
    };
    const walkDir = (display: string, abs: string, node: DirNode): void => {
      for (const k of Object.keys(node.c).sort()) {
        const c = node.c[k];
        const disp = implicitDot && display === "." ? k : joinPath(display, k);
        if (c.t === "d") {
          if (excludeDirs.some((g) => globTest(g, k))) continue;
          walkDir(disp, joinPath(abs, k), c);
        } else addFile(disp, joinPath(abs, k), c);
      }
    };
    for (const name of names) {
      if (name === "-") {
        srcs.push({ name: "(standard input)", text: "", stdin: true });
        continue;
      }
      const f1 = lookup(sh, name);
      if (!isFound(f1)) {
        if (!silent) errOut(io, label, `${name}: ${f1.err}`);
        code = 2;
        continue;
      }
      if (f1.node.t === "d") {
        if (recursive) walkDir(name, f1.abs, f1.node);
        else {
          if (!silent) errOut(io, label, `${name}: Is a directory`);
          code = 2;
        }
      } else if (f1.node.t === "f") {
        const got = await readPath(f1.abs, io);
        if ("err" in got) {
          if (!silent) errOut(io, label, `${name}: ${got.err}`);
          code = 2;
        } else srcs.push({ name, text: got.text });
      }
    }
    const withName =
      r.has("H") || (!r.has("h") && (srcs.length > 1 || recursive));
    const onlyCount = r.has("c");
    const listMatch = r.has("l");
    const listNone = r.has("L");
    const invert = r.has("v");
    const numbers = r.has("n");
    const onlyMatching = r.has("o");
    const maxCount =
      r.val("m") === undefined ? Infinity : parseInt(r.val("m") as string, 10);
    const ctxNum = (n: string): number | null => {
      const v = r.val(n);
      if (v === undefined) return 0;
      if (!/^\d+$/.test(v)) {
        errOut(io, label, `${v}: invalid context length argument`);
        return null;
      }
      return parseInt(v, 10);
    };
    const cC = ctxNum("C");
    let after = ctxNum("A");
    let before = ctxNum("B");
    if (cC === null || after === null || before === null) return 2;
    if (r.val("A") === undefined) after = cC;
    if (r.val("B") === undefined) before = cC;
    const paint = io.out.tty && sh.promptLevel() && color !== false;
    let matched = false;
    let printedGroup = false;
    /**
     * B26: one source that is standard input. It is read one chunk at a time,
     * with the context lines (-A, -B, -C) kept in a small window, so a pipe
     * that never ends still gives output and `-m` stops the read. Gives the
     * number of matching lines.
     */
    const streamSource = async (src: GrepSrc): Promise<number> => {
      const useCtx = before > 0 || after > 0;
      let lineNo = 0;
      let count = 0;
      let prev = -2;
      let afterLeft = 0;
      const ring: { i: number; l: string }[] = [];
      let text = "";
      let html = "";
      const emit = (i: number, l: string, isHit: boolean): void => {
        if (
          (useCtx && prev >= 0 && i !== prev + 1) ||
          (useCtx && prev === -2 && printedGroup)
        ) {
          text += "--\n";
          html += "--\n";
        }
        prev = i;
        const sep = isHit ? ":" : "-";
        const pre =
          (withName ? src.name + sep : "") + (numbers ? i + 1 + sep : "");
        if (onlyMatching) {
          if (!isHit || invert) return;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(l)) !== null) {
            if (m[0] === "") {
              re.lastIndex++;
              continue;
            }
            text += pre + m[0] + "\n";
            html +=
              esc(pre) +
              (paint ? `<span class="hl">${esc(m[0])}</span>` : esc(m[0])) +
              "\n";
          }
          return;
        }
        text += pre + l + "\n";
        let body = esc(l);
        if (paint && isHit && !invert) {
          body = "";
          let last = 0;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(l)) !== null) {
            if (m[0] === "") {
              re.lastIndex++;
              continue;
            }
            body +=
              esc(l.slice(last, m.index)) +
              `<span class="hl">${esc(m[0])}</span>`;
            last = m.index + m[0].length;
          }
          body += esc(l.slice(last));
        }
        html += esc(pre) + body + "\n";
      };
      const flush = (): void => {
        if (text) {
          printedGroup = true;
          io.out.write(text, paint ? html : undefined);
        }
        text = "";
        html = "";
      };
      if (maxCount > 0)
        await streamLines(io.in, sh, (lines) => {
          let stop = false;
          for (const l of lines) {
            const i = lineNo++;
            re.lastIndex = 0;
            const isHit = re.test(l) !== invert;
            // After the last wanted match only its trailing context is left.
            if (count >= maxCount) {
              if (afterLeft > 0) {
                afterLeft--;
                emit(i, l, false);
                if (afterLeft === 0) {
                  stop = true;
                  break;
                }
                continue;
              }
              stop = true;
              break;
            }
            if (!isHit) {
              if (afterLeft > 0) {
                afterLeft--;
                emit(i, l, false);
              } else if (before > 0) {
                ring.push({ i, l });
                if (ring.length > before) ring.shift();
              }
              continue;
            }
            count++;
            matched = true;
            if (quiet || listMatch || listNone) {
              stop = true;
              break;
            }
            if (!onlyCount) {
              for (const b of ring.splice(0)) emit(b.i, b.l, false);
              emit(i, l, true);
              afterLeft = after;
            }
            if (count >= maxCount && afterLeft === 0) {
              stop = true;
              break;
            }
          }
          flush();
          return stop;
        });
      return count;
    };
    for (const src of srcs) {
      if (src.stdin) {
        const n = await streamSource(src);
        if (quiet && matched) return 0;
        if (listMatch || listNone) {
          if (n > 0 === listMatch) io.out.write(src.name + "\n");
        } else if (onlyCount)
          io.out.write((withName ? src.name + ":" : "") + n + "\n");
        continue;
      }
      const lines = splitLines(src.text);
      const hit: boolean[] = lines.map((l) => {
        re.lastIndex = 0;
        return re.test(l) !== invert;
      });
      let count = 0;
      for (const h of hit) if (h) count++;
      count = Math.min(count, maxCount);
      if (count > 0) matched = true;
      if (quiet && matched) return 0;
      if (listMatch || listNone) {
        if (count > 0 === listMatch) io.out.write(src.name + "\n");
        continue;
      }
      if (onlyCount) {
        io.out.write((withName ? src.name + ":" : "") + count + "\n");
        continue;
      }
      if (quiet) continue;
      const show = new Set<number>();
      const isMatch = new Set<number>();
      let seen = 0;
      for (let i = 0; i < lines.length && seen < maxCount; i++) {
        if (!hit[i]) continue;
        seen++;
        isMatch.add(i);
        for (
          let k = Math.max(0, i - before);
          k <= Math.min(lines.length - 1, i + after);
          k++
        )
          show.add(k);
      }
      let text = "";
      let html = "";
      let prev = -2;
      const useCtx = before > 0 || after > 0;
      for (const i of [...show].sort((a, b) => a - b)) {
        if (
          (useCtx && prev >= 0 && i !== prev + 1) ||
          (useCtx && prev === -2 && printedGroup)
        ) {
          text += "--\n";
          html += "--\n";
        }
        prev = i;
        const sep = isMatch.has(i) ? ":" : "-";
        const pre =
          (withName ? src.name + sep : "") + (numbers ? i + 1 + sep : "");
        if (onlyMatching) {
          if (!isMatch.has(i) || invert) continue;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            if (m[0] === "") {
              re.lastIndex++;
              continue;
            }
            text += pre + m[0] + "\n";
            html +=
              esc(pre) +
              (paint ? `<span class="hl">${esc(m[0])}</span>` : esc(m[0])) +
              "\n";
          }
          continue;
        }
        text += pre + lines[i] + "\n";
        let body = esc(lines[i]);
        if (paint && isMatch.has(i) && !invert) {
          body = "";
          let last = 0;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            if (m[0] === "") {
              re.lastIndex++;
              continue;
            }
            body +=
              esc(lines[i].slice(last, m.index)) +
              `<span class="hl">${esc(m[0])}</span>`;
            last = m.index + m[0].length;
          }
          body += esc(lines[i].slice(last));
        }
        html += esc(pre) + body + "\n";
      }
      if (text) {
        printedGroup = true;
        io.out.write(text, paint ? html : undefined);
      }
    }
    if (quiet) return matched ? 0 : code || 1;
    if (code === 2) return 2;
    return matched || (listNone && srcs.length) ? 0 : 1;
  };
}

const grep = grepCmd(null, "grep");
const egrep = grepCmd("E", "egrep");
const fgrep = grepCmd("F", "fgrep");

/* ---------- files and folders ---------- */

const cloneNode = (n: FsNode): FsNode =>
  nulTree(JSON.parse(JSON.stringify(n)) as FsNode);

/** Checks that `abs` may get a new or removed entry: its folder is writable. */
const folderWritable = (abs: string): boolean =>
  canWrite(parentOf(abs) === "/" ? "/" : parentOf(abs) + "/x");

const missingOperand = (io: IO, cmd: string): number => {
  usageError(io, cmd, "missing operand");
  return 1;
};

const mkdir: CmdFn = (argv, sh, io) => {
  const r = opts(io, "mkdir", argv, "pvm:", {
    parents: ["p", false],
    verbose: ["v", false],
    mode: ["m", true],
  });
  if (typeof r === "number") return r;
  if (!r.rest.length) return missingOperand(io, "mkdir");
  let code = 0;
  const make = (abs: string, shown: string): boolean => {
    const par = get(parentOf(abs));
    if (!par || par.t !== "d") {
      errOut(
        io,
        "mkdir",
        `cannot create directory ${qc(shown)}: ${par ? "Not a directory" : "No such file or directory"}`,
      );
      return false;
    }
    if (par.c[baseOf(abs)]) {
      errOut(io, "mkdir", `cannot create directory ${qc(shown)}: File exists`);
      return false;
    }
    if (!folderWritable(abs)) {
      errOut(
        io,
        "mkdir",
        `cannot create directory ${qc(shown)}: Permission denied`,
      );
      return false;
    }
    const nd = d({});
    stamp(nd);
    par.c[baseOf(abs)] = nd;
    stamp(par);
    if (r.has("v")) io.out.write(`mkdir: created directory ${qc(shown)}\n`);
    return true;
  };
  for (const p of r.rest) {
    const abs = sh.abs(p);
    if (!r.has("p")) {
      if (!make(abs, p)) code = 1;
      continue;
    }
    const parts = abs.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += "/" + parts[i];
      const n = get(cur);
      if (n && n.t === "d") continue;
      if (n) {
        errOut(
          io,
          "mkdir",
          `cannot create directory ${qc(p)}: ${i === parts.length - 1 ? "File exists" : "Not a directory"}`,
        );
        code = 1;
        break;
      }
      if (!make(cur, i === parts.length - 1 ? p : cur)) {
        code = 1;
        break;
      }
    }
  }
  return code;
};

const rmdir: CmdFn = (argv, sh, io) => {
  const r = opts(io, "rmdir", argv, "pv", {
    parents: ["p", false],
    verbose: ["v", false],
  });
  if (typeof r === "number") return r;
  if (!r.rest.length) return missingOperand(io, "rmdir");
  let code = 0;
  for (const p of r.rest) {
    const f1 = lookup(sh, p);
    const fail = (e: string) => {
      errOut(io, "rmdir", `failed to remove ${q(p)}: ${e}`);
      code = 1;
    };
    if (!isFound(f1)) fail(f1.err);
    else if (f1.node.t !== "d") fail("Not a directory");
    else if (Object.keys(f1.node.c).length) fail("Directory not empty");
    else if (!folderWritable(f1.abs) || f1.abs === "/")
      fail("Permission denied");
    else {
      const par = get(parentOf(f1.abs)) as DirNode;
      delete par.c[baseOf(f1.abs)];
      stamp(par);
      if (r.has("v")) io.out.write(`rmdir: removing directory, ${q(p)}\n`);
    }
  }
  return code;
};

const touch: CmdFn = (argv, sh, io) => {
  const r = opts(io, "touch", argv, "acmd:t:r:fh", {
    "no-create": ["c", false],
    date: ["d", true],
    reference: ["r", true],
  });
  if (typeof r === "number") return r;
  if (!r.rest.length) {
    io.err.write(`touch: missing file operand\n${tryHelp("touch")}`);
    return 1;
  }
  const now = clockNow();
  let when = now;
  const dv = r.val("d");
  const tv = r.val("t");
  const rv = r.val("r");
  if (dv !== undefined) {
    const t = parseDate(dv, now);
    if (t === null) {
      errOut(io, "touch", `invalid date format ${qc(dv)}`);
      return 1;
    }
    when = t;
  } else if (tv !== undefined) {
    const t = parseTouchT(tv, now);
    if (t === null) {
      errOut(io, "touch", `invalid date format ${qc(tv)}`);
      return 1;
    }
    when = t;
  } else if (rv !== undefined) {
    const f1 = lookup(sh, rv);
    if (!isFound(f1)) {
      errOut(io, "touch", `failed to get attributes of ${q(rv)}: ${f1.err}`);
      return 1;
    }
    when = mtimeMs(f1.node);
  }
  let code = 0;
  for (const p of r.rest) {
    const f1 = lookup(sh, p);
    if (isFound(f1)) {
      if (ownerOf(f1.abs) !== "cadet") {
        errOut(io, "touch", `setting times of ${q(p)}: Permission denied`);
        code = 1;
        continue;
      }
      f1.node.mtime = when;
      continue;
    }
    if (r.has("c")) continue;
    const abs = f1.abs;
    const par = get(parentOf(abs));
    if (f1.err === "Not a directory" || !par || par.t !== "d") {
      errOut(io, "touch", `cannot touch ${q(p)}: ${f1.err}`);
      code = 1;
      continue;
    }
    if (!folderWritable(abs)) {
      errOut(io, "touch", `cannot touch ${q(p)}: Permission denied`);
      code = 1;
      continue;
    }
    const nf = f("");
    nf.mtime = when;
    par.c[baseOf(abs)] = nf;
    stamp(par);
  }
  return code;
};

const rm: CmdFn = (argv, sh, io) => {
  const r = opts(io, "rm", argv, "frRidvI", {
    force: ["f", false],
    recursive: ["r", false],
    dir: ["d", false],
    verbose: ["v", false],
    "no-preserve-root": ["no-preserve-root", false],
    "preserve-root": ["preserve-root", false],
  });
  if (typeof r === "number") return r;
  const force = r.has("f");
  if (!r.rest.length) {
    if (force) return 0;
    return missingOperand(io, "rm");
  }
  const rec = r.has("r") || r.has("R");
  let code = 0;
  const kill = (abs: string, shown: string, top: boolean): void => {
    const n = get(abs) as FsNode;
    if (n.t === "d") {
      if (!rec && !(r.has("d") && top)) {
        errOut(io, "rm", `cannot remove ${q(shown)}: Is a directory`);
        code = 1;
        return;
      }
      if (rec)
        for (const k of Object.keys(n.c).sort()) {
          kill(joinPath(abs, k), joinPath(shown, k), false);
        }
      else if (Object.keys(n.c).length) {
        errOut(io, "rm", `cannot remove ${q(shown)}: Directory not empty`);
        code = 1;
        return;
      }
    }
    if (!(get(abs) as FsNode | null)) return;
    if (n.t === "d" && Object.keys(n.c).length) return;
    if (!folderWritable(abs)) {
      errOut(io, "rm", `cannot remove ${q(shown)}: Permission denied`);
      code = 1;
      return;
    }
    const par = get(parentOf(abs)) as DirNode;
    delete par.c[baseOf(abs)];
    stamp(par);
    if (r.has("v"))
      io.out.write(`removed ${n.t === "d" ? "directory " : ""}${q(shown)}\n`);
  };
  for (const p of r.rest) {
    const base = p.replace(/\/+$/, "").split("/").pop();
    if (base === "." || base === "..") {
      errOut(
        io,
        "rm",
        `refusing to remove '.' or '..' directory: skipping ${q(p)}`,
      );
      code = 1;
      continue;
    }
    const f1 = lookup(sh, p);
    if (!isFound(f1)) {
      if (!force) {
        errOut(io, "rm", `cannot remove ${q(p)}: ${f1.err}`);
        code = 1;
      }
      continue;
    }
    if (f1.abs === "/" && rec && !r.has("no-preserve-root")) {
      errOut(io, "rm", `it is dangerous to operate recursively on ${q("/")}`);
      io.err.write("rm: use --no-preserve-root to override this failsafe\n");
      code = 1;
      continue;
    }
    if (f1.abs === "/") {
      errOut(io, "rm", `cannot remove ${q(p)}: Is a directory`);
      code = 1;
      continue;
    }
    kill(f1.abs, p, true);
  }
  return code;
};

/** Copies or moves; the two share their checks and their messages. */
function copyMove(kind: "cp" | "mv"): CmdFn {
  return (argv, sh, io) => {
    const r = opts(
      io,
      kind,
      argv,
      kind === "cp" ? "rRaplfinvTt:u" : "finvTt:u",
      {
        recursive: ["r", false],
        archive: ["a", false],
        force: ["f", false],
        verbose: ["v", false],
        "no-clobber": ["n", false],
        "no-target-directory": ["T", false],
        "target-directory": ["t", true],
      },
    );
    if (typeof r === "number") return r;
    const tdir = r.val("t");
    const ops = r.rest.slice();
    if (!ops.length) {
      io.err.write(`${kind}: missing file operand\n${tryHelp(kind)}`);
      return 1;
    }
    let dst: string;
    if (tdir !== undefined) dst = tdir;
    else {
      if (ops.length < 2) {
        io.err.write(
          `${kind}: missing destination file operand after ${q(ops[0])}\n${tryHelp(kind)}`,
        );
        return 1;
      }
      dst = ops.pop() as string;
    }
    const rec = r.has("r") || r.has("R") || r.has("a");
    const keepTime = r.has("a") || r.has("p");
    const dnode = lookup(sh, dst);
    const dstIsDir = isFound(dnode) && dnode.node.t === "d" && !r.has("T");
    if ((ops.length > 1 || tdir !== undefined) && !dstIsDir) {
      errOut(io, kind, `target ${q(dst)} is not a directory`);
      return 1;
    }
    let code = 0;
    for (const src of ops) {
      const s = lookup(sh, src);
      if (!isFound(s)) {
        errOut(io, kind, `cannot stat ${q(src)}: ${s.err}`);
        code = 1;
        continue;
      }
      if (kind === "cp" && s.node.t === "d" && !rec) {
        errOut(io, "cp", `-r not specified; omitting directory ${q(src)}`);
        code = 1;
        continue;
      }
      const target = dstIsDir
        ? joinPath((dnode as Found).abs, baseOf(s.abs))
        : sh.abs(dst);
      const shownDst = dstIsDir
        ? joinPath(dst.replace(/\/+$/, ""), baseOf(s.abs))
        : dst;
      if (target === s.abs) {
        errOut(io, kind, `${q(src)} and ${q(shownDst)} are the same file`);
        code = 1;
        continue;
      }
      if (s.node.t === "d" && target.startsWith(s.abs + "/")) {
        errOut(
          io,
          kind,
          kind === "cp"
            ? `cannot copy a directory, ${q(src)}, into itself, ${q(shownDst)}`
            : `cannot move ${q(src)} to a subdirectory of itself, ${q(shownDst)}`,
        );
        code = 1;
        continue;
      }
      const par = get(parentOf(target));
      if (!par || par.t !== "d") {
        errOut(
          io,
          kind,
          kind === "cp"
            ? `cannot create ${s.node.t === "d" ? "directory" : "regular file"} ${q(shownDst)}: ${par ? "Not a directory" : "No such file or directory"}`
            : `cannot move ${q(src)} to ${q(shownDst)}: ${par ? "Not a directory" : "No such file or directory"}`,
        );
        code = 1;
        continue;
      }
      const ex = par.c[baseOf(target)];
      if (ex && r.has("n")) continue;
      if (ex && ex.t === "d" && s.node.t !== "d") {
        errOut(
          io,
          kind,
          `cannot overwrite directory ${q(shownDst)} with non-directory`,
        );
        code = 1;
        continue;
      }
      if (ex && ex.t !== "d" && s.node.t === "d") {
        errOut(
          io,
          kind,
          `cannot overwrite non-directory ${q(shownDst)} with directory ${q(src)}`,
        );
        code = 1;
        continue;
      }
      if (
        !folderWritable(target) ||
        (kind === "mv" && !folderWritable(s.abs))
      ) {
        errOut(
          io,
          kind,
          kind === "cp"
            ? `cannot create ${s.node.t === "d" ? "directory" : "regular file"} ${q(shownDst)}: Permission denied`
            : `cannot move ${q(src)} to ${q(shownDst)}: Permission denied`,
        );
        code = 1;
        continue;
      }
      if (kind === "cp") {
        const copy = cloneNode(s.node);
        const fix = (n: FsNode): void => {
          if (!keepTime) stamp(n);
          if (n.t === "d") Object.values(n.c).forEach(fix);
        };
        fix(copy);
        let add = 0;
        const sum = (n: FsNode): void => {
          if (n.t === "f") add += n.x.length;
          else Object.values(n.c).forEach(sum);
        };
        sum(copy);
        const old = ex && ex.t === "f" ? ex.x.length : 0;
        if (storageUsed() - old + add > LIM.storage) {
          errOut(
            io,
            "cp",
            `error writing ${q(shownDst)}: No space left on device`,
          );
          code = 1;
          continue;
        }
        par.c[baseOf(target)] = copy;
      } else {
        const sp = get(parentOf(s.abs)) as DirNode;
        delete sp.c[baseOf(s.abs)];
        par.c[baseOf(target)] = s.node;
        stamp(sp);
      }
      stamp(par);
      if (r.has("v"))
        io.out.write(
          kind === "cp"
            ? `${q(src)} -> ${q(shownDst)}\n`
            : `renamed ${q(src)} -> ${q(shownDst)}\n`,
        );
    }
    return code;
  };
}
const cp = copyMove("cp");
const mv = copyMove("mv");

/** Applies one `chmod` mode text to a mode string. Null when it is not valid. */
function applyMode(old: string, mode: string, isDir: boolean): string | null {
  if (/^[0-7]{1,4}$/.test(mode)) {
    const v = mode.padStart(3, "0").slice(-3);
    return [...v]
      .map((c) => {
        const n = +c;
        return (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
      })
      .join("");
  }
  let cur = old.split("");
  const OFF: Record<string, number> = { u: 0, g: 3, o: 6 };
  for (const clause of mode.split(",")) {
    const m = /^([ugoa]*)(?:([-+=])([rwxXst]*|[ugo]))+$/.exec(clause);
    if (!m) return null;
    const who = /^[ugoa]*/.exec(clause)![0];
    const targets =
      who === "" || who.includes("a") ? ["u", "g", "o"] : [...who];
    const noWho = who === "";
    const rest = clause.slice(who.length);
    const re = /([-+=])([rwxXst]*|[ugo])/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(rest)) !== null) {
      const op = mm[1];
      for (const t of targets) {
        let bits: string;
        if (/^[ugo]$/.test(mm[2]))
          bits = cur.slice(OFF[mm[2]], OFF[mm[2]] + 3).join("");
        else {
          bits = "";
          for (const ch of mm[2]) {
            if (ch === "r" || ch === "w") bits += ch;
            else if (ch === "x" || (ch === "X" && (isDir || cur.includes("x"))))
              bits += "x";
          }
        }
        if (noWho && (t === "g" || t === "o")) bits = bits.replace("w", "");
        const set = (k: number, ch: string, on: boolean) => {
          cur[OFF[t] + k] = on ? ch : "-";
        };
        const has = (c: string) => bits.includes(c);
        if (op === "=") {
          set(0, "r", has("r"));
          set(1, "w", has("w"));
          set(2, "x", has("x"));
        } else if (op === "+") {
          if (has("r")) set(0, "r", true);
          if (has("w")) set(1, "w", true);
          if (has("x")) set(2, "x", true);
        } else {
          if (has("r")) set(0, "r", false);
          if (has("w")) set(1, "w", false);
          if (has("x")) set(2, "x", false);
        }
      }
    }
  }
  cur = cur.slice(0, 9);
  return cur.join("");
}

const chmod: CmdFn = (argv, sh, io) => {
  // A mode such as `-x` starts with a dash: take it out before the options.
  const args = argv.slice(1);
  const flags: string[] = [];
  let mode: string | null = null;
  const files: string[] = [];
  for (const a of args) {
    if (mode === null && /^-[rwxXst]+(,.*)?$/.test(a)) mode = a;
    else if (
      a.startsWith("-") &&
      a.length > 1 &&
      files.length === 0 &&
      mode === null
    )
      flags.push(a);
    else if (mode === null) mode = a;
    else files.push(a);
  }
  const r = opts(io, "chmod", ["chmod", ...flags], "Rvcf", {
    recursive: ["R", false],
    verbose: ["v", false],
    changes: ["c", false],
    silent: ["f", false],
    quiet: ["f", false],
  });
  if (typeof r === "number") return r;
  if (mode === null) return missingOperand(io, "chmod");
  if (!files.length) {
    io.err.write(
      `chmod: missing operand after ${qc(mode)}\n${tryHelp("chmod")}`,
    );
    return 1;
  }
  if (applyMode("rw-r--r--", mode, false) === null) {
    io.err.write(`chmod: invalid mode: ${qc(mode)}\n${tryHelp("chmod")}`);
    return 1;
  }
  let code = 0;
  const set = (n: FsNode, abs: string, shown: string): void => {
    const nm = applyMode(n.m, mode as string, n.t === "d") as string;
    if (ownerOf(abs) !== "cadet") {
      errOut(
        io,
        "chmod",
        `changing permissions of ${q(shown)}: Operation not permitted`,
      );
      code = 1;
      return;
    }
    n.m = nm;
    if (r.has("R") && n.t === "d")
      for (const k of Object.keys(n.c).sort())
        set(n.c[k], joinPath(abs, k), joinPath(shown, k));
  };
  for (const p of files) {
    const f1 = lookup(sh, p);
    if (!isFound(f1)) {
      if (!r.has("f")) errOut(io, "chmod", `cannot access ${q(p)}: ${f1.err}`);
      code = 1;
      continue;
    }
    set(f1.node, f1.abs, p);
  }
  return code;
};

/* ---------- stat, du, df, file, od ---------- */

function isoNs(ms: number): string {
  const t = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}.${p(t.getUTCMilliseconds(), 3)}000000 +0000`;
}

function octalMode(n: FsNode): string {
  let v = 0;
  for (let i = 0; i < 9; i++) if (n.m[i] !== "-") v |= 1 << (8 - i);
  return v.toString(8).padStart(4, "0");
}

const fileKind = (n: FsNode): string =>
  n.t === "d"
    ? "directory"
    : sizeOf(n) === 0
      ? "regular empty file"
      : "regular file";

const stat: CmdFn = (argv, sh, io) => {
  const r = opts(io, "stat", argv, "c:Lt", {
    format: ["c", true],
    terse: ["t", false],
  });
  if (typeof r === "number") return r;
  if (!r.rest.length) return missingOperand(io, "stat");
  const fmt = r.val("c");
  let code = 0;
  for (const p of r.rest) {
    const f1 = lookup(sh, p);
    if (!isFound(f1)) {
      errOut(io, "stat", `cannot statx ${q(p)}: ${f1.err}`);
      code = 1;
      continue;
    }
    const n = f1.node;
    const own = ownerOf(f1.abs);
    const uid = own === "cadet" ? 1000 : 0;
    const t = mtimeMs(n);
    if (fmt !== undefined) {
      const out = fmt.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
        switch (c) {
          case "n":
            return p;
          case "N":
            return q(p);
          case "s":
            return String(sizeOf(n));
          case "b":
            return String(blocksK(n) * 2);
          case "B":
            return "512";
          case "a":
            return octalMode(n)
              .slice(1)
              .replace(/^0(?=\d{3})/, "");
          case "A":
            return modeText(n);
          case "F":
            return fileKind(n);
          case "U":
          case "G":
            return own;
          case "u":
          case "g":
            return String(uid);
          case "Y":
          case "W":
          case "X":
          case "Z":
            return String(Math.floor(t / 1000));
          case "y":
          case "x":
          case "z":
          case "w":
            return isoNs(t);
          case "i":
            return String(inodeOf(f1.abs));
          case "h":
            return String(linkCount(f1.abs, n));
          case "d":
            return "171";
          case "o":
            return "4096";
          case "%":
            return "%";
          default:
            return "?";
        }
      });
      io.out.write(out + "\n");
      continue;
    }
    const mode = octalMode(n);
    const ugid = `Uid: ( ${String(uid).padStart(4)}/ ${own.padStart(7)})   Gid: ( ${String(uid).padStart(4)}/ ${own.padStart(7)})`;
    io.out.write(
      `  File: ${p}\n` +
        `  Size: ${padR(String(sizeOf(n)), 10)}\tBlocks: ${padR(String(blocksK(n) * 2), 10)} IO Block: ${padR("4096", 6)} ${fileKind(n)}\n` +
        `Device: 0,171\tInode: ${padR(String(inodeOf(f1.abs)), 10)}  Links: ${linkCount(f1.abs, n)}\n` +
        `Access: (${mode}/${modeText(n)})  ${ugid}\n` +
        `Access: ${isoNs(t)}\nModify: ${isoNs(t)}\nChange: ${isoNs(t)}\n Birth: ${isoNs(t)}\n`,
    );
  }
  return code;
};

const du: CmdFn = (argv, sh, io) => {
  const r = opts(io, "du", argv, "shabckd:", {
    summarize: ["s", false],
    "human-readable": ["h", false],
    all: ["a", false],
    "apparent-size": ["apparent", false],
    bytes: ["b", false],
    total: ["c", false],
    "max-depth": ["d", true],
  });
  if (typeof r === "number") return r;
  const bytes = r.has("b");
  const fmt = (n: number): string =>
    r.has("h") ? human(n * (bytes ? 1 : 1024)) : bytes ? String(n) : String(n);
  const maxDepth =
    r.val("d") === undefined ? Infinity : parseInt(r.val("d") as string, 10);
  let code = 0;
  let total = 0;
  const lines: string[] = [];
  const size = (n: FsNode): number => (bytes ? sizeOf(n) : blocksK(n));
  const walk = (
    n: FsNode,
    shown: string,
    depth: number,
    top: boolean,
  ): number => {
    let sum = size(n);
    if (n.t === "d")
      for (const k of Object.keys(n.c).sort())
        sum += walk(
          n.c[k],
          joinPath(shown, k).replace(/^\/\//, "/"),
          depth + 1,
          false,
        );
    const listed =
      !r.has("s") && depth <= maxDepth && (n.t === "d" || r.has("a") || top);
    if ((r.has("s") && top) || listed) lines.push(`${fmt(sum)}\t${shown}`);
    return sum;
  };
  for (const p of r.rest.length ? r.rest : ["."]) {
    const f1 = lookup(sh, p);
    if (!isFound(f1)) {
      errOut(io, "du", `cannot access ${q(p)}: ${f1.err}`);
      code = 1;
      continue;
    }
    total += walk(f1.node, p, 0, true);
  }
  if (r.has("c")) lines.push(`${fmt(total)}\ttotal`);
  if (lines.length) io.out.write(lines.join("\n") + "\n");
  return code;
};

const df: CmdFn = (argv, sh, io) => {
  const r = opts(io, "df", argv, "hHkPTi", {
    "human-readable": ["h", false],
    portability: ["P", false],
  });
  if (typeof r === "number") return r;
  let used = 12.4 * 1024 ** 3;
  (function walk(n: FsNode) {
    if (n.t === "d") for (const k in n.c) walk(n.c[k]);
    else used += n.sz ?? n.x.length;
  })(S.fs);
  const total = 59 * 1024 ** 3;
  const pct = Math.min(100, Math.ceil((used / total) * 100));
  const h = r.has("h");
  const kb = (b: number) => String(Math.floor(b / 1024));
  const cell = (b: number) => (h ? human(Math.ceil(b)) : kb(b));
  const rows: string[][] = [];
  const head = h
    ? ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"]
    : r.has("P")
      ? [
          "Filesystem",
          "1024-blocks",
          "Used",
          "Available",
          "Capacity",
          "Mounted on",
        ]
      : ["Filesystem", "1K-blocks", "Used", "Available", "Use%", "Mounted on"];
  rows.push(head);
  const row = (fs: string, size: number, u: number, mount: string) =>
    rows.push([
      fs,
      cell(size),
      cell(u),
      cell(Math.max(0, size - u)),
      `${Math.min(100, Math.ceil((u / size) * 100))}%`,
      mount,
    ]);
  let code = 0;
  if (!r.rest.length) {
    row("overlay", total, used, "/");
    row("tmpfs", 64 * 1024 ** 2, 0, "/dev");
    row("shm", 64 * 1024 ** 2, 0, "/dev/shm");
  } else {
    for (const p of r.rest) {
      const f1 = lookup(sh, p);
      if (!isFound(f1)) {
        errOut(io, "df", `${p}: ${f1.err}`);
        code = 1;
        continue;
      }
      row("overlay", total, used, "/");
    }
    if (rows.length === 1) return code;
  }
  void pct;
  const w = head.map((_, i) =>
    Math.max(
      ...rows.map((x) => x[i].length),
      i === 0 ? 14 : h && i < 4 ? 5 : 0,
    ),
  );
  io.out.write(
    rows
      .map((x) =>
        x
          .map((c, i) =>
            i === 0 || i === 5 ? padR(c, i === 5 ? 0 : w[i]) : padL(c, w[i]),
          )
          .join(" "),
      )
      .join("\n") + "\n",
  );
  return code;
};

/** A one-line description of a file's content, like `file`. */
function describe(n: FsNode): string {
  if (n.t === "d") return "directory";
  const x = n.x;
  if (x === "") return "empty";
  if (x.startsWith("\x1f\x8b") || x.startsWith("PPTAR\x1f\x8b"))
    return "gzip compressed data, from Unix";
  if (x.startsWith("PPTAR")) return "POSIX tar archive (GNU)";
  if (x.startsWith("#!")) {
    const sh = /^#!\s*\S*\/(?:env\s+)?(\w+)/.exec(x)?.[1] ?? "sh";
    const kind =
      sh === "bash"
        ? "Bourne-Again shell script"
        : sh === "python3" || sh === "python"
          ? "Python script"
          : "POSIX shell script";
    return `${kind}, ${textKind(x)} executable`;
  }
  if (/^<!DOCTYPE html|^<html/i.test(x)) return `HTML document, ${textKind(x)}`;
  return textKind(x);
}

function textKind(x: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(x)) return "data";
  const ascii = ![...x].some((c) => c.charCodeAt(0) > 127);
  let s = ascii ? "ASCII text" : "Unicode text, UTF-8 text";
  if (!ascii) s = "Unicode text, UTF-8 text";
  if (!x.includes("\n")) s += ", with no line terminators";
  return s;
}

const file: CmdFn = (argv, sh, io) => {
  const r = opts(io, "file", argv, "bi", {
    brief: ["b", false],
    "mime-type": ["i", false],
  });
  if (typeof r === "number") return r;
  if (!r.rest.length) {
    io.err.write(
      "Usage: file [OPTION...] [FILE...]\nDetermine type of FILEs.\n\n      --help                 display this help and exit\n",
    );
    return 1;
  }
  for (const p of r.rest) {
    const f1 = lookup(sh, p);
    const desc = isFound(f1)
      ? r.has("i")
        ? f1.node.t === "d"
          ? "inode/directory"
          : f1.node.x === ""
            ? "inode/x-empty"
            : "text/plain"
        : describe(f1.node)
      : `cannot open \`${p}' (${f1.err})`;
    io.out.write((r.has("b") ? "" : p + ": ") + desc + "\n");
  }
  return 0;
};

const od: CmdFn = async (argv, sh, io) => {
  const r = opts(io, "od", argv, "A:t:N:cbxdoj:v");
  if (typeof r === "number") return r;
  let type = r.has("c")
    ? "c"
    : r.has("b")
      ? "o1"
      : r.has("x")
        ? "x2"
        : r.has("d")
          ? "u2"
          : r.has("o")
            ? "o2"
            : "o2";
  if (r.val("t")) type = r.val("t") as string;
  const addr = r.val("A") ?? "o";
  let text = "";
  for (const name of r.rest.length ? r.rest : ["-"]) {
    const t = await readFileArg("od", sh, io, name);
    if (t === null) return 1;
    text += t;
  }
  let bytes = enc.encode(text);
  const lim = r.val("N");
  if (lim !== undefined) bytes = bytes.slice(0, parseInt(lim, 10));
  const kind = type[0];
  const size = kind === "c" ? 1 : parseInt(type.slice(1) || "1", 10) || 1;
  const per = 16;
  const ESC: Record<number, string> = {
    0: "\\0",
    7: "\\a",
    8: "\\b",
    9: "\\t",
    10: "\\n",
    11: "\\v",
    12: "\\f",
    13: "\\r",
  };
  const width =
    kind === "c"
      ? 4
      : kind === "x"
        ? size * 2 + 2
        : kind === "o"
          ? size * 3 + 2
          : size * 3 + 3;
  const fmtA = (n: number): string =>
    addr === "n"
      ? ""
      : addr === "d"
        ? String(n).padStart(7, "0")
        : addr === "x"
          ? n.toString(16).padStart(6, "0")
          : n.toString(8).padStart(7, "0");
  let out = "";
  for (let off = 0; off < bytes.length; off += per) {
    const chunk = bytes.slice(off, off + per);
    let line = fmtA(off);
    for (let i = 0; i < chunk.length; i += size) {
      let v = 0;
      for (let k = size - 1; k >= 0; k--) v = v * 256 + (chunk[i + k] ?? 0);
      let c: string;
      if (kind === "c") {
        const b = chunk[i];
        c =
          ESC[b] ??
          (b >= 32 && b < 127
            ? String.fromCharCode(b)
            : b.toString(8).padStart(3, "0"));
      } else if (kind === "x") c = v.toString(16).padStart(size * 2, "0");
      else if (kind === "o") c = v.toString(8).padStart(size * 3, "0");
      else c = String(v);
      line += c.padStart(width);
    }
    out += line + "\n";
  }
  if (addr !== "n") out += fmtA(bytes.length) + "\n";
  io.out.write(out);
  return 0;
};

/* ---------- environment and lookup ---------- */

/** What `env -i` and `env -u` hide from the commands they run (D14). */
const envMods = new WeakMap<Context, { clean: boolean; hidden: Set<string> }>();

/** The exported variables a command sees, as `[name, value]`. */
function visibleEnv(ctx: Context): [string, string][] {
  const mod = envMods.get(ctx);
  let pairs = ctx.exportedPairs();
  if (mod) {
    pairs = pairs.filter(([k]) => !mod.hidden.has(k));
    if (mod.clean) pairs = pairs.filter(([k]) => k in ctx.env);
  }
  return pairs;
}

const env: CmdFn = async (argv, sh, io) => {
  let i = 1;
  let clean = false;
  const unset: string[] = [];
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-i" || a === "--ignore-environment" || a === "-") clean = true;
    else if (a === "-u" || a === "--unset") {
      if (argv[i + 1] === undefined) {
        io.err.write(
          `env: option requires an argument -- 'u'\n${tryHelp("env")}`,
        );
        return 125;
      }
      unset.push(argv[++i]);
    } else if (a.startsWith("--unset=")) unset.push(a.slice(8));
    else if (a === "-0" || a === "--null") continue;
    else if (a.startsWith("--")) {
      io.err.write(`env: unrecognized option '${a}'\n${tryHelp("env")}`);
      return 125;
    } else if (a[0] === "-" && a.length > 1) {
      io.err.write(`env: invalid option -- '${a[1]}'\n${tryHelp("env")}`);
      return 125;
    } else break;
  }
  const sets: [string, string][] = [];
  for (; i < argv.length; i++) {
    const m = /^([^=]+)=(.*)$/s.exec(argv[i]);
    if (!m) break;
    sets.push([m[1], m[2]]);
  }
  const rest = argv.slice(i);
  const saved = sh.ctx;
  const c = saved.copy();
  const hidden = new Set<string>([
    ...(envMods.get(saved)?.hidden ?? []),
    ...unset,
  ]);
  if (clean) {
    c.env = nul();
    c.exported = new Set();
    c.vars = nul();
  }
  for (const u of unset) {
    delete c.env[u];
    c.exported.delete(u);
  }
  for (const [k, v] of sets) {
    c.env[k] = v;
    c.exported.add(k);
    hidden.delete(k);
  }
  envMods.set(c, {
    clean: clean || (envMods.get(saved)?.clean ?? false),
    hidden,
  });
  c.io = io;
  if (!rest.length) {
    io.out.write(
      visibleEnv(c)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
    return 0;
  }
  const name = rest[0];
  const fn = Object.hasOwn(sh.host.commands, name)
    ? sh.host.commands[name]
    : undefined;
  if (!fn && !name.includes("/")) {
    errOut(io, "env", `${qc(name)}: No such file or directory`);
    return 127;
  }
  // The command runs in a child process with the changed environment (B2).
  const child = sh.spawn(c);
  return sh.within(child, async () =>
    fn
      ? await fn(rest, child, io)
      : await child.runCommand(rest, io, { noFunc: true }),
  );
};

const printenv: CmdFn = (argv, sh, io) => {
  const r = opts(io, "printenv", argv, "0", { null: ["0", false] }, 2);
  if (typeof r === "number") return r;
  const pairs = visibleEnv(sh.ctx);
  if (!r.rest.length) {
    io.out.write(pairs.map(([k, v]) => `${k}=${v}\n`).join(""));
    return 0;
  }
  let code = 0;
  for (const n of r.rest) {
    const hit = pairs.find(([k]) => k === n);
    if (hit) io.out.write(hit[1] + "\n");
    else code = 1;
  }
  return code;
};

const dircolors: CmdFn = (argv, _sh, io) => {
  // Under TERM=dumb the built-in database has no colors (home.ts, LS_COLORS).
  if (argv.includes("-p") || argv.includes("--print-database")) return 0;
  io.out.write("LS_COLORS='';\nexport LS_COLORS\n");
  return 0;
};

/**
 * `yes` writes until a signal or a limit stops it (B8). It writes in blocks
 * and gives the browser a turn between them (B7), so Ctrl-C reaches it.
 */
const yes: CmdFn = async (argv, sh, io) => {
  const text = (argv.length > 1 ? argv.slice(1).join(" ") : "y") + "\n";
  const block = text.repeat(Math.max(1, Math.floor(1024 / text.length)));
  for (;;) {
    io.out.write(block);
    await sh.pause();
  }
};

const SLEEP_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `sleep` waits on the engine clock (B5); a signal ends the wait (B6). */
const sleep: CmdFn = async (argv, sh, io) => {
  if (argv.length < 2) return missingOperand(io, "sleep");
  let seconds = 0;
  for (const a of argv.slice(1)) {
    const m = /^(\d+\.?\d*|\.\d+)([smhd]?)$/.exec(a);
    if (!m) {
      usageError(io, "sleep", `invalid time interval ${qc(a)}`);
      return 1;
    }
    seconds += parseFloat(m[1]) * SLEEP_UNIT[m[2] || "s"];
  }
  // A `>( )` consumer of this input runs while it waits.
  await sh.cleanProcs();
  const sig = await sh.waitTime(seconds * 1000);
  return sig === null ? 0 : 128 + (SIGNALS[sig] ?? 0);
};

/** Names that exist in /usr/bin on Ubuntu but are builtins here. */
const TWINS = ["echo", "printf", "test", "[", "true", "false", "pwd"];

const which: CmdFn = (argv, sh, io) => {
  const r = opts(io, "which", argv, "as", { all: ["a", false] }, 2);
  if (typeof r === "number") return r;
  if (!r.rest.length) return 1;
  let code = 0;
  for (const n of r.rest) {
    const hit = USR_BIN.includes(n) || n === "bash" || n === "sh";
    if (!hit || n === "hint") {
      code = 1;
      continue;
    }
    io.out.write(`/usr/bin/${n}\n`);
    if (r.has("a")) io.out.write(`/bin/${n}\n`);
  }
  void sh;
  return code;
};

/* ---------- the game's own commands ---------- */

export const HELP_TEXT = `Files and folders
  pwd  ls  cd  cat  tree  mkdir  touch  cp  mv  rm  find  tar
Reading and searching
  echo  grep  head  tail  wc  sort  uniq  cut  awk  sed
Permissions, scripts and variables
  chmod  ./script.sh  bash script.sh  export  env  which
Processes and system
  ps  top  kill  pkill  df  du  free  uptime
Docker
  docker run  ps  images  pull  build  tag  stop  start  restart  rm  rmi
  docker logs  exec  inspect  stats  volume  network  system  compose
Other
  curl  whoami  hostname  date  history  clear  hint  man <command>

Join commands with | (pipe), > or >> (write to a file),
&& (run the next one if this one worked) and ; (run the next one anyway).
Wildcards like *.log work too.`;

/** Prints a run-1 style result: `out` and `err` as lines, then the code. */
function emit(res: Res, io: IO): number {
  if (res.out) say(io, res.out, io.out.tty ? res.html : undefined);
  if (res.err) say({ ...io, out: io.err } as IO, res.err);
  return res.code;
}
const line = (io: IO, text: string): number => {
  say(io, text);
  return 0;
};
const fail = (io: IO, text: string, code = 1): number => {
  say({ ...io, out: io.err } as IO, text);
  return code;
};

const man: CmdFn = (argv, _sh, io) => {
  if (!argv[1]) return fail(io, "What manual page do you want? Try: man ls");
  const m = MAN[argv[1]];
  return m ? line(io, m) : fail(io, `No manual entry for ${argv[1]}`);
};

const hint: CmdFn = (_argv, _sh, io) => {
  if (!S.unlocked)
    return fail(
      io,
      "Hints are locked. Ask your instructor for the password, then use Unlock hints in the logbook.",
    );
  const m = M[S.cur];
  return line(
    io,
    m
      ? "Hint: " + m.hint.replace(/`/g, "")
      : "You’ve finished every task. Free play!",
  );
};

const clear: CmdFn = (_argv, sh) => {
  // B15: the terminal clears when it gets the event.
  sh.out.clear();
  return 0;
};

const uname: CmdFn = (argv, _sh, io) =>
  line(
    io,
    argv.includes("-a")
      ? `Linux ${HOST} 6.8.0-harbor #1 SMP x86_64 GNU/Linux`
      : "Linux",
  );

const tree: CmdFn = (argv, sh, io) => {
  const r = opts(io, "tree", argv, "adL:", {});
  if (typeof r === "number") return r;
  const p = r.rest[0] ?? ".";
  const f1 = lookup(sh, p);
  if (!isFound(f1) || f1.node.t !== "d") {
    return fail(io, `${p} [error opening dir]\n\n0 directories, 0 files`, 2);
  }
  const maxDepth = r.val("L") ? parseInt(r.val("L") as string, 10) : Infinity;
  const ls: Cell[] = [plain(p)];
  let dirs = 0;
  let files = 0;
  (function walk(node: DirNode, pre: string, depth: number) {
    const ks = Object.keys(node.c)
      .filter((k) => r.has("a") || k[0] !== ".")
      .filter((k) => !r.has("d") || node.c[k].t === "d")
      .sort();
    ks.forEach((k, i) => {
      const last = i === ks.length - 1;
      const c = node.c[k];
      ls.push([
        pre + (last ? "└── " : "├── ") + k,
        esc(pre + (last ? "└── " : "├── ")) + nameHTML(k, c),
      ]);
      if (c.t === "d") {
        dirs++;
        if (depth < maxDepth)
          walk(c, pre + (last ? "    " : "│   "), depth + 1);
      } else files++;
    });
  })(f1.node, "", 1);
  const tail = `\n${dirs} director${dirs === 1 ? "y" : "ies"}${r.has("d") ? "" : `, ${files} file${files === 1 ? "" : "s"}`}`;
  io.out.write(
    ls.map((c) => c[0]).join("\n") + "\n" + tail + "\n",
    io.out.tty && sh.promptLevel()
      ? ls.map((c) => c[1]).join("\n") + "\n" + tail + "\n"
      : undefined,
  );
  return 0;
};

const whoami: CmdFn = (_a, _s, io) => line(io, "cadet");
const hostname: CmdFn = (_a, _s, io) => line(io, HOST);
const id: CmdFn = (_a, _s, io) =>
  line(io, "uid=1000(cadet) gid=1000(cadet) groups=1000(cadet)");

const ps: CmdFn = (argv, sh, io) => {
  const args = argv.slice(1);
  const full = args.some((a) => /^(aux|-e|-ef|-aux|-A|ax)$/.test(a));
  // B10: the processes of the jobs come after the `S.procs` rows, in PID order.
  const live = sh.interp.liveProcs();
  if (!full)
    return line(
      io,
      table(
        [["PID", "TTY", "TIME", "CMD"] as (string | number)[]].concat(
          S.procs
            .filter((p) => p.user === "cadet")
            .map((p) => [
              p.pid,
              "pts/0",
              p.cpu > 50 ? "01:12:07" : "00:00:00",
              p.cmd.split(" ")[0].replace(/^-/, ""),
            ])
            .concat(live.map((p) => [p.pid, "pts/0", "00:00:00", p.name])),
        ),
      ),
    );
  return line(
    io,
    table(
      [
        ["USER", "PID", "%CPU", "%MEM", "COMMAND"] as (string | number)[],
      ].concat(
        S.procs
          .map((p) => [
            p.user,
            p.pid,
            p.cpu.toFixed(1),
            p.mem.toFixed(1),
            p.cmd,
          ])
          .concat(live.map((p) => ["cadet", p.pid, "0.0", "0.0", p.cmdline])),
      ),
    ),
  );
};

const clockText = (): string => clockDate().toTimeString().slice(0, 8);

const top: CmdFn = (_argv, sh, io) => {
  const ps2 = S.procs.slice().sort((a, b) => b.cpu - a.cpu);
  const live = sh.interp.liveProcs();
  const load = (ps2.reduce((s, p) => s + p.cpu, 0) / 100).toFixed(2);
  return line(
    io,
    `top - ${clockText()} up 3 days,  2:14,  1 user,  load average: ${load}, ${load}, ${load}
Tasks: ${ps2.length + live.length} total,   ${ps2.filter((p) => p.cpu > 1).length} running
MiB Mem :   3936.0 total,   1412.4 free,   1201.7 used

` +
      table(
        [
          ["PID", "USER", "%CPU", "%MEM", "COMMAND"] as (string | number)[],
        ].concat(
          ps2
            .map((p) => [
              p.pid,
              p.user,
              p.cpu.toFixed(1),
              p.mem.toFixed(1),
              p.cmd,
            ])
            .concat(live.map((p) => [p.pid, "cadet", "0.0", "0.0", p.cmdline])),
        ),
      ) +
      `

(top normally updates live until you press q. Here you get one snapshot.)`,
  );
};

const pkill: CmdFn = (argv, sh, io) => {
  const args = argv.slice(1);
  const pos = args.filter((a) => !a.startsWith("-"));
  const nm = pos[0];
  if (!nm) return fail(io, "pkill: no process name given");
  const sig9 = args.includes("-9") || args.includes("-KILL");
  // B10: the processes of the jobs, by name; the signal is TERM unless one is named.
  const named = args.find((a) => /^-[A-Za-z0-9]+$/.test(a));
  const sig = (named && signalName(named.slice(1))) || "TERM";
  const liveHit = sh.interp.liveProcs().filter((p) => p.name.includes(nm));
  for (const p of liveHit) {
    const proc = p.job.live().find((x) => x.pid === p.pid);
    signalJob(sh, p.job, sig, proc === p.job.procs[0] ? undefined : proc);
  }
  const hit = S.procs.filter((p) =>
    p.cmd.split(" ")[0].replace(/^-/, "").includes(nm),
  );
  if (!hit.length) return liveHit.length ? 0 : 1;
  for (const p of hit) {
    if (p.user !== "cadet")
      return fail(
        io,
        `pkill: killing pid ${p.pid} failed: Operation not permitted`,
      );
    if (p.stubborn && !sig9) continue;
    S.procs = S.procs.filter((x) => x !== p);
  }
  return 0;
};

const free: CmdFn = (_a, _s, io) =>
  line(
    io,
    `               total        used        free      shared  buff/cache   available
Mem:           3.8Gi       1.2Gi       1.4Gi        12Mi       1.2Gi       2.4Gi
Swap:             0B          0B          0B`,
  );

const uptime: CmdFn = (_a, _s, io) => {
  const l = (S.procs.reduce((s, p) => s + p.cpu, 0) / 100).toFixed(2);
  return line(
    io,
    ` ${clockText()} up 3 days,  2:14,  1 user,  load average: ${l}, ${l}, ${l}`,
  );
};

const bash: CmdFn = (argv, sh, io) => BUILTINS.bash(sh, argv, io);

export function logStamp(): string {
  const t = clockDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getDate())}/${MONTHS[t.getMonth()]}/${t.getFullYear()}:${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} +0000`;
}

const curl: CmdFn = (argv, _sh, io) => {
  const args = argv.slice(1);
  const url = args.find((a) => a[0] !== "-");
  if (!url) return fail(io, "curl: try: curl localhost:8080");
  const m = url.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?/);
  if (!m)
    return fail(
      io,
      `curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, "").split("/")[0]} (this sandbox has no internet; try localhost)`,
      6,
    );
  const port = m[1] || "80";
  const c = S.dk.containers.find(
    (x) =>
      x.status === "running" && x.ports.some((p) => p.split(":")[0] === port),
  );
  if (!c)
    return fail(
      io,
      `curl: (7) Failed to connect to localhost port ${port}: Couldn’t connect to server (is a container running with -p ${port}:...?)`,
      7,
    );
  const img: Partial<Image> = findImg(c.image) || {};
  const stamp2 = logStamp();
  if (c.repo === "nginx") {
    c.logs.push(
      `172.17.0.1 - - [${stamp2}] "GET / HTTP/1.1" 200 615 "-" "curl/8.5.0" "-"`,
    );
    return line(io, NGINX_HTML);
  }
  if (img.reply) {
    c.logs.push(`172.17.0.1 - - [${stamp2}] "GET / HTTP/1.1" 200 -`);
    return line(io, img.reply);
  }
  return fail(io, "curl: (52) Empty reply from server", 52);
};

/** Docker and compose keep their run-1 code; the shell's cwd reaches it (D13). */
const dockerCmd: CmdFn = (argv, sh, io) =>
  withCwd(sh.ctx.cwd, () => emit(docker(argv.slice(1)), io));
const composeCmd: CmdFn = (argv, sh, io) =>
  withCwd(sh.ctx.cwd, () => emit(compose(argv.slice(1)), io));

/* ---------- the table ---------- */

const twin =
  (name: string): CmdFn =>
  (argv, sh, io) =>
    BUILTINS[name](sh, argv, io);

export const CMDS: Record<string, CmdFn> = {
  ...TEXT_CMDS,
  ...DATE_CMDS,
  ...FIND_CMDS,
  ...SED_CMDS,
  ...AWK_CMDS,
  ...TAR_CMDS,
  ...CRON_CMDS,
  ls,
  cat,
  head,
  tail,
  wc,
  sort,
  uniq,
  grep,
  egrep,
  fgrep,
  mkdir,
  rmdir,
  touch,
  rm,
  cp,
  mv,
  chmod,
  stat,
  du,
  df,
  file,
  od,
  env,
  printenv,
  which,
  dircolors,
  sleep,
  yes,
  tree,
  whoami,
  hostname,
  id,
  uname,
  clear,
  ps,
  top,
  kill: (argv, sh, io) => BUILTINS.kill(sh, argv, io),
  pkill,
  killall: pkill,
  free,
  uptime,
  bash,
  sh: bash,
  curl,
  docker: dockerCmd,
  "docker-compose": composeCmd,
  man,
  hint,
};
for (const n of TWINS) CMDS[n] = twin(n);

/** Names with a stand-in file in /usr/bin (D15). `hint` is the game's own. */
export const EXTERNAL = Object.keys(CMDS)
  .filter((n) => n !== "hint")
  .sort();

/** The host of the interpreter: the table, also under /usr/bin and /bin. */
export function createHost(extra: {
  history: () => string[];
  clearHistory?: () => void;
}): Host {
  const commands: Record<string, CmdFn> = { ...CMDS };
  for (const n of EXTERNAL) {
    commands["/usr/bin/" + n] = CMDS[n];
    commands["/bin/" + n] = CMDS[n];
  }
  return {
    commands,
    paths: () => EXTERNAL,
    history: extra.history,
    clearHistory: extra.clearHistory,
    helpText: () => HELP_TEXT,
  };
}

void pathCwd;
void f;
void LIM;
void sha256;

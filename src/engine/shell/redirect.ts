// Redirections, and the file helpers that the shell and the commands share:
// permission rules, the storage cap (D21), and file times (D18). The file
// system is shared by all contexts and is never copied (D13).
import { get, split } from "../paths";
import { f, S } from "../state";
import type { DirNode, FileNode } from "../state";
import { Input, NullWriter } from "./io";
import type { IO, Writer } from "./io";
import { LIM, LimitStop } from "./limits";
import type { Redir, Word } from "./ast";
import { resolvePath } from "./glob";

/* ---------- file helpers (absolute paths) ---------- */

/**
 * Folders where the learner may create and change files. `/var/log` stays
 * open because task 68 (`rm /var/log/crane-debug.log`) needs it.
 */
export function canWrite(abs: string): boolean {
  return (
    abs === "/var/log" ||
    abs.startsWith("/var/log/") ||
    abs === "/tmp" ||
    abs.startsWith("/tmp/") ||
    abs === "/home/cadet" ||
    abs.startsWith("/home/cadet/") ||
    abs === "/dev/null" ||
    abs.startsWith("/dev/fd/")
  );
}

/** Total size of all file content, in characters (D21 counts real content). */
export function storageUsed(): number {
  let n = 0;
  const walk = (d: DirNode) => {
    for (const k in d.c) {
      const c = d.c[k];
      if (c.t === "d") walk(c);
      else n += c.x.length;
    }
  };
  walk(S.fs);
  return n;
}

export type FsError =
  | "No such file or directory"
  | "Is a directory"
  | "Permission denied"
  | "No space left on device"
  | "Not a directory";

export function stamp(n: FileNode | DirNode): void {
  (n as { mtime?: number }).mtime = Date.now();
}

/** Reads a file. Returns the text, or the Linux error text. */
export function readText(abs: string): { text: string } | { err: FsError } {
  const n = get(abs);
  if (!n) return { err: "No such file or directory" };
  if (n.t === "d") return { err: "Is a directory" };
  if (n.m[0] !== "r") return { err: "Permission denied" };
  return { text: n.x };
}

/** Reads a file for a command: `/dev/stdin` is the input, `/dev/null` is empty. */
export function readPath(
  abs: string,
  io: IO,
): { text: string } | { err: FsError } {
  if (abs === "/dev/stdin") return { text: io.in.readAll() };
  if (abs === "/dev/null") return { text: "" };
  return readText(abs);
}

/** Checks that a file can be opened for writing; creates it when it is new. */
export function openForWrite(
  abs: string,
): { node: FileNode } | { err: FsError } {
  const [par, name] = split(abs);
  const dn = get(par);
  if (!dn) return { err: "No such file or directory" };
  if (dn.t !== "d") return { err: "Not a directory" };
  const ex = dn.c[name];
  if (ex && ex.t === "d") return { err: "Is a directory" };
  if (!canWrite(abs) || (ex && ex.m[1] !== "w") || (!ex && dn.m[1] !== "w"))
    return { err: "Permission denied" };
  if (ex) return { node: ex };
  const node = f("");
  stamp(node);
  dn.c[name] = node;
  return { node };
}

/** Writes text to a file in one step (utilities such as `tee` and `sed -i`). Returns an error or null. */
export function writeText(
  abs: string,
  text: string,
  append: boolean,
): FsError | null {
  const o = openForWrite(abs);
  if ("err" in o) return o.err;
  const old = o.node.x;
  const next = append ? old + text : text;
  if (storageUsed() - old.length + next.length > LIM.storage)
    return "No space left on device";
  o.node.x = next;
  delete o.node.sz;
  stamp(o.node);
  return null;
}

/* ---------- writers that go to a file ---------- */

/**
 * Collects the text of one command and puts it in the file when the command
 * ends. A `>` file is emptied at open, as in bash; if the commit fails (the
 * storage cap), the old content comes back (D21).
 */
export class FileWriter implements Writer {
  readonly tty = false;
  private buf = "";
  private old: string;
  constructor(
    private node: FileNode,
    private append: boolean,
    readonly path: string,
    /** `exec` redirects: each write goes to the file at once. */
    private live = false,
    /** `exec` redirects: reports a write that the storage cap refuses. */
    private onFail?: (msg: string) => void,
  ) {
    this.old = node.x;
    if (!append) {
      node.x = "";
      delete node.sz;
    }
  }
  write(text: string): void {
    if (this.live) {
      if (storageUsed() + text.length <= LIM.storage) {
        this.node.x += text;
        delete this.node.sz;
        stamp(this.node);
      } else
        this.onFail?.(`${this.path}: write error: No space left on device`);
      return;
    }
    this.buf += text;
    if (this.buf.length > LIM.str) throw new LimitStop("1 MB of redirect data");
  }
  /** Commits the text. Returns an error or null. */
  close(): FsError | null {
    const base = this.append ? this.node.x : "";
    const used = storageUsed() - this.node.x.length;
    if (used + base.length + this.buf.length > LIM.storage) {
      this.node.x = this.old;
      return "No space left on device";
    }
    this.node.x = base + this.buf;
    delete this.node.sz;
    stamp(this.node);
    this.buf = "";
    return null;
  }
}

/* ---------- applying redirections ---------- */

export interface RedirHost {
  cwd: string;
  /** Expands a redirect target to exactly one word; null on "ambiguous redirect". */
  expandTarget(w: Word): string | null;
  expandHeredoc(w: Word): string;
  expandText(w: Word): string;
  /** Prints `bash: ...` (with the script prefix). */
  fail(msg: string): void;
}

export interface Applied {
  io: IO;
  /** Commits the files. Returns the first error text, or null. */
  close(): string | null;
}

const isNum = (s: string) => /^[0-9]+$/.test(s);

/** The device files of the redirect list. */
function device(abs: string): "null" | "stdin" | "stdout" | "stderr" | null {
  switch (abs) {
    case "/dev/null":
      return "null";
    case "/dev/stdin":
      return "stdin";
    case "/dev/stdout":
      return "stdout";
    case "/dev/stderr":
      return "stderr";
    default:
      return null;
  }
}

/**
 * Applies the redirects left to right on a copy of `io`. Returns null when one
 * fails (the error is already printed and the command must not run).
 */
export function applyRedirs(
  redirs: Redir[],
  base: IO,
  host: RedirHost,
  live = false,
): Applied | null {
  const fds = new Map<number, Writer | Input>(base.fds ?? []);
  fds.set(0, base.in);
  fds.set(1, base.out);
  fds.set(2, base.err);
  const files: FileWriter[] = [];
  const closeAll = (): string | null => {
    let first: string | null = null;
    for (const w of files) {
      const e = w.close();
      if (e && !first) first = `${w.path}: ${e}`;
    }
    return first;
  };
  const fail = (msg: string): null => {
    host.fail(msg);
    closeAll();
    return null;
  };
  const openOut = (
    path: string,
    append: boolean,
  ): { w: Writer } | { err: string } => {
    const abs = resolvePath(host.cwd, path);
    const dev = device(abs);
    if (dev === "null") return { w: new NullWriter() };
    if (dev === "stdout") return { w: fds.get(1) as Writer };
    if (dev === "stderr") return { w: fds.get(2) as Writer };
    const o = openForWrite(abs);
    if ("err" in o) return { err: `${path}: ${o.err}` };
    const w = new FileWriter(
      o.node,
      append,
      path,
      live,
      live ? (m) => host.fail(m) : undefined,
    );
    files.push(w);
    return { w };
  };
  for (const r of redirs) {
    const op = r.op;
    if (op === "<<") {
      const body = r.heredoc ? host.expandHeredoc(r.heredoc.body) : "";
      fds.set(r.fd ?? 0, new Input(body));
      continue;
    }
    if (op === "<<<") {
      const t = host.expandText(r.target);
      fds.set(r.fd ?? 0, new Input(t + "\n"));
      continue;
    }
    const target = host.expandTarget(r.target);
    if (target === null) {
      const raw = r.target.map((p) => (p.k === "lit" ? p.v : "")).join("");
      return fail(`${raw || "$"}: ambiguous redirect`);
    }
    if (op === ">&" || op === "<&") {
      const fd = r.fd ?? (op === ">&" ? 1 : 0);
      if (target === "-") {
        fds.set(fd, op === ">&" ? new NullWriter() : new Input(""));
        continue;
      }
      if (isNum(target)) {
        const src = fds.get(Number(target));
        if (src === undefined) return fail(`${target}: Bad file descriptor`);
        fds.set(fd, src);
        continue;
      }
      if (op === ">&") {
        // `>& file` is `&> file`.
        const o = openOut(target, false);
        if ("err" in o) return fail(o.err);
        fds.set(1, o.w);
        fds.set(2, o.w);
        continue;
      }
      return fail(`${target}: ambiguous redirect`);
    }
    if (op === "&>" || op === "&>>") {
      const o = openOut(target, op === "&>>");
      if ("err" in o) return fail(o.err);
      fds.set(1, o.w);
      fds.set(2, o.w);
      continue;
    }
    if (op === ">" || op === ">>" || op === ">|") {
      const o = openOut(target, op === ">>");
      if ("err" in o) return fail(o.err);
      fds.set(r.fd ?? 1, o.w);
      continue;
    }
    // "<" and "<>"
    const abs = resolvePath(host.cwd, target);
    const dev = device(abs);
    if (dev === "null") fds.set(r.fd ?? 0, new Input(""));
    else if (dev === "stdin") continue;
    else {
      const t = readText(abs);
      if ("err" in t) return fail(`${target}: ${t.err}`);
      fds.set(r.fd ?? 0, new Input(t.text));
    }
  }
  const extra = new Map(fds);
  for (const k of [0, 1, 2]) extra.delete(k);
  const io: IO = {
    in: fds.get(0) as Input,
    out: fds.get(1) as Writer,
    err: fds.get(2) as Writer,
    fds: extra.size ? extra : undefined,
  };
  return { io, close: closeAll };
}

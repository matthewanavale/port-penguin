// AC4: `tar` (GNU tar 1.35): -c -x -t with -f -v -z -C. The archive is a
// text file: "PPTAR" and a JSON list. A gzip archive (-z) starts with the
// two gzip magic bytes, so `file` can tell it. Archives that run 1 wrote
// (a tree under `node`) still open.
import { get, split } from "../paths";
import { byteSize, size } from "../helpers";
import { d as mkDir, f as mkFile } from "../state";
import type { DirNode, FsNode } from "../state";
import { canWrite, stamp, writeText } from "../shell/redirect";
import type { CmdFn, IO } from "../shell/io";
import { mtimeOf } from "./text";

const MAGIC = "PPTAR";
const GZ = "\x1f\x8b";
const HELP = "Try 'tar --help' or 'tar --usage' for more information.\n";

interface Member {
  p: string;
  t: "d" | "f";
  x?: string;
  m: string;
  mt: number;
  sz?: number;
}

function flatten(nodeName: string, node: FsNode, out: Member[]): void {
  if (node.t === "d") {
    out.push({ p: nodeName + "/", t: "d", m: node.m, mt: mtimeOf(node) });
    for (const k of Object.keys(node.c))
      flatten(nodeName + "/" + k, node.c[k], out);
  } else {
    const m: Member = {
      p: nodeName,
      t: "f",
      x: node.x,
      m: node.m,
      mt: mtimeOf(node),
    };
    if (node.sz) m.sz = node.sz;
    out.push(m);
  }
}

function decode(text: string): Member[] | null {
  let t = text;
  if (t.startsWith(GZ)) t = t.slice(2);
  if (!t.startsWith(MAGIC)) return null;
  try {
    const raw = JSON.parse(t.slice(MAGIC.length)) as unknown[];
    const out: Member[] = [];
    for (const e of raw) {
      const o = e as { name?: string; node?: FsNode } & Member;
      if (o.node && o.name) flatten(o.name, o.node, out);
      else out.push(o);
    }
    return out;
  } catch {
    return null;
  }
}

const isoMin = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

const tar: CmdFn = (argv, sh, io) => {
  let mode: "c" | "x" | "t" | null = null;
  let file: string | null = null;
  let dir: string | null = null;
  let verbose = false;
  let gzip = false;
  const operands: string[] = [];
  const bad = (msg: string, code = 64): number => {
    io.err.write(`tar: ${msg}\n${HELP}`);
    return code;
  };
  const LONG: Record<string, string> = {
    create: "c",
    extract: "x",
    get: "x",
    list: "t",
    file: "f",
    verbose: "v",
    gzip: "z",
    gunzip: "z",
    directory: "C",
  };
  const pending: string[] = [];
  const apply = (c: string, val: string | null): number | null => {
    switch (c) {
      case "c":
      case "x":
      case "t":
        mode = c;
        break;
      case "v":
        verbose = true;
        break;
      case "z":
        gzip = true;
        break;
      case "j":
      case "J":
      case "p":
      case "k":
      case "h":
      case "m":
        break;
      case "f":
        file = val;
        break;
      case "C":
        dir = val;
        break;
      default:
        return bad(`invalid option -- '${c}'`);
    }
    return null;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const c = LONG[key];
      if (!c) return bad(`unrecognized option '--${key}'`);
      let val: string | null = null;
      if (c === "f" || c === "C") {
        val = eq >= 0 ? a.slice(eq + 1) : (argv[++i] ?? null);
        if (val === null) return bad(`option '--${key}' requires an argument`);
      }
      const r = apply(c, val);
      if (r !== null) return r;
    } else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === "f" || c === "C") {
          let val: string | null = a.slice(j + 1);
          if (val === "") val = argv[++i] ?? null;
          if (val === null) return bad(`option requires an argument -- '${c}'`);
          apply(c, val);
          break;
        }
        const r = apply(c, null);
        if (r !== null) return r;
      }
    } else if (i === 1 && /^[A-Za-z]+$/.test(a) && /^[cxtvzfCjJ]+$/.test(a)) {
      for (const c of a) {
        if (c === "f" || c === "C") pending.push(c);
        else {
          const r = apply(c, null);
          if (r !== null) return r;
        }
      }
    } else if (pending.length) {
      const c = pending.shift() as string;
      apply(c, a);
    } else operands.push(a);
  }
  if (pending.length)
    return bad(`option requires an argument -- '${pending[0]}'`);
  if (mode === null) {
    io.err.write(
      `tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n${HELP}`,
    );
    return 2;
  }
  const fatal = (msg: string): number => {
    io.err.write(`tar: ${msg}\ntar: Error is not recoverable: exiting now\n`);
    return 2;
  };
  const arch: string | null = file;
  const toStdio = arch === null || arch === "-";
  const base = dir ? sh.abs(dir) : sh.abs(".");
  if (dir) {
    const dn = get(base);
    if (!dn || dn.t !== "d")
      return fatal(`${dir}: Cannot open: No such file or directory`);
  }

  if (mode === "c") {
    if (operands.length === 0) {
      io.err.write(
        "tar: Cowardly refusing to create an empty archive\n" + HELP,
      );
      return 2;
    }
    if (toStdio && io.out.tty) {
      io.err.write(
        "tar: Refusing to write archive contents to terminal (missing -f option?)\ntar: Error is not recoverable: exiting now\n",
      );
      return 2;
    }
    const members: Member[] = [];
    let failed = false;
    let stripped = false;
    for (const op of operands) {
      let name = op;
      if (name.startsWith("/")) {
        name = name.replace(/^\/+/, "");
        stripped = true;
      }
      name = name.replace(/\/+$/, "");
      const node = get(op.startsWith("/") ? op : base + "/" + op);
      if (!node || name === "") {
        io.err.write(`tar: ${op}: Cannot stat: No such file or directory\n`);
        failed = true;
        continue;
      }
      flatten(name, node, members);
    }
    if (stripped) io.err.write("tar: Removing leading `/' from member names\n");
    const text = (gzip ? GZ : "") + MAGIC + JSON.stringify(members);
    if (toStdio) io.out.write(text);
    else {
      const ap = sh.abs(arch as string);
      const e = writeText(ap, text, false);
      if (e) return fatal(`${arch}: Cannot open: ${e}`);
    }
    if (verbose) {
      const w = toStdio ? io.err : io.out;
      w.write(members.map((m) => m.p + "\n").join(""));
    }
    if (failed) {
      io.err.write("tar: Exiting with failure status due to previous errors\n");
      return 2;
    }
    return 0;
  }

  // -t and -x read an archive
  let text: string;
  if (toStdio) text = io.in.readAll();
  else {
    const an = get(sh.abs(arch as string));
    if (!an) return fatal(`${arch}: Cannot open: No such file or directory`);
    if (an.t === "d") return fatal(`${arch}: Cannot read: Is a directory`);
    text = an.x;
  }
  const all = decode(text);
  if (!all) {
    io.err.write(
      "tar: This does not look like a tar archive\ntar: Skipping to next header\ntar: Exiting with failure status due to previous errors\n",
    );
    return 2;
  }
  const want = operands.map((o) => o.replace(/\/+$/, ""));
  const members = want.length
    ? all.filter((m) =>
        want.some(
          (w) => m.p.replace(/\/+$/, "") === w || m.p.startsWith(w + "/"),
        ),
      )
    : all;
  let code = 0;
  if (want.length) {
    for (const w of want)
      if (
        !members.some(
          (m) => m.p.replace(/\/+$/, "") === w || m.p.startsWith(w + "/"),
        )
      ) {
        io.err.write(`tar: ${w}: Not found in archive\n`);
        code = 2;
      }
    if (code)
      io.err.write("tar: Exiting with failure status due to previous errors\n");
  }
  if (mode === "t") {
    let out = "";
    for (const m of members) {
      if (verbose) {
        const sz = m.t === "d" ? 0 : (m.sz ?? byteSize(m.x ?? ""));
        out += `${m.t === "d" ? "d" : "-"}${m.m} cadet/cadet ${String(sz).padStart(7)} ${isoMin(m.mt || Date.now())} ${m.p}\n`;
      } else out += m.p + "\n";
    }
    io.out.write(out);
    return code;
  }
  for (const m of members) {
    const abs = base + "/" + m.p.replace(/\/+$/, "");
    if (!extract(m, abs, io)) code = 2;
    else if (verbose) io.out.write(m.p + "\n");
  }
  if (code && !want.length)
    io.err.write("tar: Exiting with failure status due to previous errors\n");
  return code;
};

/** Makes one member on the file system. Returns false after it wrote an error. */
function extract(m: Member, abs: string, io: IO): boolean {
  const name = m.p;
  const fail = (why: string): boolean => {
    io.err.write(`tar: ${name}: Cannot open: ${why}\n`);
    return false;
  };
  const [par] = split(abs);
  // make the folders above it
  const parts = par.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur += "/" + seg;
    const n = get(cur);
    if (n) {
      if (n.t !== "d") return fail("Not a directory");
      continue;
    }
    if (!canWrite(cur)) return fail("Permission denied");
    const [pp, nm] = split(cur);
    const pd = get(pp) as DirNode;
    const nd = mkDir({});
    stamp(nd);
    pd.c[nm] = nd;
  }
  const [pp, nm] = split(abs);
  const pd = get(pp) as DirNode;
  const ex = pd.c[nm];
  if (m.t === "d") {
    if (ex) {
      if (ex.t !== "d") return fail("Not a directory");
      return true;
    }
    if (!canWrite(abs)) return fail("Permission denied");
    const nd = mkDir({});
    nd.m = m.m;
    (nd as { mtime?: number }).mtime = m.mt;
    pd.c[nm] = nd;
    return true;
  }
  if (!canWrite(abs)) return fail("Permission denied");
  if (ex && ex.t === "d") return fail("Is a directory");
  const nf = mkFile(m.x ?? "", m.m, m.sz);
  (nf as { mtime?: number }).mtime = m.mt;
  pd.c[nm] = nf;
  return true;
}

void size;
export const TAR_CMDS: Record<string, CmdFn> = { tar };

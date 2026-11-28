// AC4: `find`. Expression tree with -o, -a, !, parentheses; tests, actions,
// and the global options. Messages follow GNU findutils 4.9.
import { clockNow } from "../clock";
import { get, split } from "../paths";
import { size } from "../helpers";
import type { FsNode } from "../state";
import { canWrite } from "../shell/redirect";
import { matchPattern } from "../shell/glob";
import { Input } from "../shell/io";
import type { CmdFn, IO } from "../shell/io";
import type { Proc } from "../shell/proc";
import { mtimeOf } from "./text";

interface Ent {
  path: string;
  abs: string;
  node: FsNode;
  depth: number;
  name: string;
}

type Expr =
  | { k: "or" | "and"; a: Expr; b: Expr }
  | { k: "not"; a: Expr }
  | { k: "test"; fn: (e: Ent, st: Run) => boolean }
  | { k: "act"; fn: (e: Ent, st: Run) => boolean | Promise<boolean> };

interface Run {
  sh: Proc;
  io: IO;
  code: number;
  prune: boolean;
  plus: { args: string[]; files: string[] }[];
  depthFirst: boolean;
}

class FindError extends Error {}

const ACTIONS = new Set([
  "-print",
  "-print0",
  "-delete",
  "-exec",
  "-ok",
  "-printf",
  "-ls",
]);

function cmp(spec: string, v: number): boolean {
  const m = /^([+-]?)(\d+)$/.exec(spec);
  if (!m) throw new FindError(`invalid argument \`${spec}' to`);
  const n = parseInt(m[2], 10);
  return m[1] === "+" ? v > n : m[1] === "-" ? v < n : v === n;
}

function permBits(m: string): number {
  let n = 0;
  for (let i = 0; i < 9; i++) if (m[i] && m[i] !== "-") n |= 1 << (8 - i);
  return n;
}

function parse(args: string[], sh: Proc, now: number) {
  let i = 0;
  let maxdepth = Infinity;
  let mindepth = 0;
  let depthOpt = false;
  let hasAction = false;
  const need = (name: string): string => {
    if (i >= args.length) throw new FindError(`missing argument to \`${name}'`);
    return args[i++];
  };
  const primary = (): Expr => {
    const t = args[i++];
    const test = (fn: (e: Ent, st: Run) => boolean): Expr => ({
      k: "test",
      fn,
    });
    switch (t) {
      case "(": {
        const e = orExpr();
        if (args[i] !== ")") throw new FindError("missing closing `)'");
        i++;
        return e;
      }
      case "-name":
      case "-iname": {
        const p = need(t);
        const ci = t === "-iname";
        return test((e) => matchPattern(e.name, p, false, ci));
      }
      case "-path":
      case "-wholename":
      case "-ipath": {
        const p = need(t);
        const ci = t === "-ipath";
        return test((e) => matchPattern(e.path, p, false, ci));
      }
      case "-type": {
        const v = need(t);
        if (!/^[fdlbcps]$/.test(v))
          throw new FindError(`Unknown argument to -type: ${v}`);
        return test((e) =>
          v === "d" ? e.node.t === "d" : v === "f" ? e.node.t === "f" : false,
        );
      }
      case "-mtime": {
        const v = need(t);
        cmp(v, 0);
        return test((e) =>
          cmp(v, Math.floor((now - mtimeOf(e.node)) / 86400000)),
        );
      }
      case "-mmin": {
        const v = need(t);
        cmp(v, 0);
        return test((e) => cmp(v, Math.ceil((now - mtimeOf(e.node)) / 60000)));
      }
      case "-newer": {
        const f = need(t);
        const n = get(sh.abs(f));
        if (!n) throw new FindError(`‘${f}’: No such file or directory`);
        const ref = mtimeOf(n);
        return test((e) => mtimeOf(e.node) > ref);
      }
      case "-size": {
        const v = need(t);
        const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(v);
        if (!m) throw new FindError(`invalid argument \`${v}' to \`-size'`);
        const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1048576, G: 1073741824 }[
          (m[3] || "b") as "c"
        ];
        return test((e) => cmp(m[1] + m[2], Math.ceil(size(e.node) / unit)));
      }
      case "-empty":
        return test((e) =>
          e.node.t === "d"
            ? Object.keys(e.node.c).length === 0
            : size(e.node) === 0,
        );
      case "-perm": {
        const v = need(t);
        const m = /^([-/]?)([0-7]+)$/.exec(v);
        if (!m) throw new FindError(`invalid mode ‘${v}’`);
        const want = parseInt(m[2], 8);
        return test((e) => {
          const b = permBits(e.node.m);
          return m[1] === "-"
            ? (b & want) === want
            : m[1] === "/"
              ? (b & want) !== 0
              : b === want;
        });
      }
      case "-true":
        return test(() => true);
      case "-false":
        return test(() => false);
      case "-user": {
        const u = need(t);
        return test(() => u === "cadet");
      }
      case "-maxdepth":
      case "-mindepth": {
        const v = need(t);
        if (!/^\d+$/.test(v))
          throw new FindError(
            `Expected a positive decimal integer argument to ${t}, but got ‘${v}’`,
          );
        if (t === "-maxdepth") maxdepth = parseInt(v, 10);
        else mindepth = parseInt(v, 10);
        return test(() => true);
      }
      case "-depth":
        depthOpt = true;
        return test(() => true);
      case "-prune":
        return {
          k: "act",
          fn: (_e, st) => {
            st.prune = true;
            return true;
          },
        };
      case "-print":
      case "-print0":
        hasAction = true;
        return {
          k: "act",
          fn: (e, st) => {
            st.io.out.write(e.path + (t === "-print0" ? "\0" : "\n"));
            return true;
          },
        };
      case "-printf": {
        const f = need(t);
        hasAction = true;
        return {
          k: "act",
          fn: (e, st) => {
            st.io.out.write(
              f
                .replace(/\\n/g, "\n")
                .replace(/\\t/g, "\t")
                .replace(/%(.)/g, (_m, c: string) =>
                  c === "p"
                    ? e.path
                    : c === "f"
                      ? e.name
                      : c === "s"
                        ? String(size(e.node))
                        : c === "y"
                          ? e.node.t === "d"
                            ? "d"
                            : "f"
                          : c === "%"
                            ? "%"
                            : "",
                ),
            );
            return true;
          },
        };
      }
      case "-delete":
        hasAction = true;
        depthOpt = true;
        return {
          k: "act",
          fn: (e, st) => {
            if (e.depth === 0 && e.path === ".") return true;
            if (!canWrite(e.abs)) {
              st.io.err.write(
                `find: cannot delete ‘${e.path}’: Permission denied\n`,
              );
              st.code = 1;
              return false;
            }
            const [par, nm] = split(e.abs);
            const pn = get(par);
            if (pn && pn.t === "d") delete pn.c[nm];
            return true;
          },
        };
      case "-exec":
      case "-ok": {
        const cmd: string[] = [];
        let plus = false;
        for (;;) {
          if (i >= args.length)
            throw new FindError(`missing argument to \`${t}'`);
          const a = args[i++];
          if (a === ";") break;
          if (a === "+" && cmd[cmd.length - 1] === "{}") {
            plus = true;
            break;
          }
          cmd.push(a);
        }
        if (cmd.length === 0)
          throw new FindError(`missing argument to \`${t}'`);
        hasAction = true;
        if (plus) {
          const grp = { args: cmd.slice(0, -1), files: [] as string[] };
          return {
            k: "act",
            fn: (e, st) => {
              if (!st.plus.includes(grp)) st.plus.push(grp);
              grp.files.push(e.path);
              return true;
            },
          };
        }
        return {
          k: "act",
          fn: async (e, st) =>
            (await runCmd(
              st,
              cmd.map((c) => c.split("{}").join(e.path)),
            )) === 0,
        };
      }
      default:
        if (t.startsWith("-")) throw new FindError(`unknown predicate \`${t}'`);
        throw new FindError(`paths must precede expression: \`${t}'`);
    }
  };
  const notExpr = (): Expr => {
    if (args[i] === "!" || args[i] === "-not") {
      i++;
      return { k: "not", a: notExpr() };
    }
    return primary();
  };
  const andExpr = (): Expr => {
    let l = notExpr();
    while (
      i < args.length &&
      args[i] !== "-o" &&
      args[i] !== "-or" &&
      args[i] !== ")"
    ) {
      if (args[i] === "-a" || args[i] === "-and") i++;
      l = { k: "and", a: l, b: notExpr() };
    }
    return l;
  };
  const orExpr = (): Expr => {
    let l = andExpr();
    while (args[i] === "-o" || args[i] === "-or") {
      i++;
      l = { k: "or", a: l, b: andExpr() };
    }
    return l;
  };
  const expr: Expr | null = args.length ? orExpr() : null;
  if (i < args.length) throw new FindError(`unexpected extra predicate`);
  void ACTIONS;
  return { expr, maxdepth, mindepth, depthOpt, hasAction };
}

async function runCmd(st: Run, argv: string[]): Promise<number> {
  if (!argv[0].includes("/") && !st.sh.lookup(argv[0])) {
    st.io.err.write(`find: ‘${argv[0]}’: No such file or directory\n`);
    return 1;
  }
  const child: IO = { in: new Input(""), out: st.io.out, err: st.io.err };
  return await st.sh.runCommand(argv, child, {});
}

async function evalExpr(e: Expr, ent: Ent, st: Run): Promise<boolean> {
  switch (e.k) {
    case "or":
      return (await evalExpr(e.a, ent, st)) || (await evalExpr(e.b, ent, st));
    case "and":
      return (await evalExpr(e.a, ent, st)) && (await evalExpr(e.b, ent, st));
    case "not":
      return !(await evalExpr(e.a, ent, st));
    default:
      return e.fn(ent, st);
  }
}

const find: CmdFn = async (argv, sh, io) => {
  const rest = argv.slice(1);
  let n = 0;
  while (
    n < rest.length &&
    !rest[n].startsWith("-") &&
    rest[n] !== "!" &&
    rest[n] !== "("
  )
    n++;
  const starts = n ? rest.slice(0, n) : ["."];
  let p: ReturnType<typeof parse>;
  const now = clockNow();
  try {
    p = parse(rest.slice(n), sh, now);
  } catch (e) {
    if (e instanceof FindError) {
      io.err.write(`find: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  let expr = p.expr;
  if (!p.hasAction) {
    const print: Expr = {
      k: "act",
      fn: (e, st) => {
        st.io.out.write(e.path + "\n");
        return true;
      },
    };
    expr = expr ? { k: "and", a: expr, b: print } : print;
  }
  const st: Run = {
    sh,
    io,
    code: 0,
    prune: false,
    plus: [],
    depthFirst: p.depthOpt,
  };
  const visit = async (
    path: string,
    abs: string,
    node: FsNode,
    depth: number,
  ): Promise<void> => {
    const trimmed = path.replace(/\/+$/, "") || "/";
    const name =
      trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
    const ent: Ent = { path, abs, node, depth, name };
    const run = async (): Promise<void> => {
      if (depth < p.mindepth || !expr) return;
      st.prune = false;
      await evalExpr(expr, ent, st);
    };
    if (!p.depthOpt) {
      await run();
      if (st.prune) {
        st.prune = false;
        return;
      }
    }
    if (node.t === "d" && depth < p.maxdepth)
      for (const k of Object.keys(node.c)) {
        if (!(k in node.c)) continue;
        const child = path.endsWith("/") ? path + k : path + "/" + k;
        await visit(
          child,
          abs === "/" ? "/" + k : abs + "/" + k,
          node.c[k],
          depth + 1,
        );
      }
    if (p.depthOpt) await run();
  };
  for (const s of starts) {
    const abs = sh.abs(s);
    const node = get(abs);
    if (!node) {
      io.err.write(`find: ‘${s}’: No such file or directory\n`);
      st.code = 1;
      continue;
    }
    await visit(s, abs, node, 0);
  }
  for (const g of st.plus) {
    if ((await runCmd(st, g.args.concat(g.files))) !== 0) st.code = 1;
  }
  return st.code;
};

export const FIND_CMDS: Record<string, CmdFn> = { find };

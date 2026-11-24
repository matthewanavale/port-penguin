// Pipes, redirects, commands, and scripts. Ported from index.html:461-499
// at 5e96ce5.
import { E, R } from "./helpers";
import type { Ctx, Opt, Res } from "./helpers";
import { CMDS } from "./linux";
import { base, expandGlob, get, writeFile } from "./paths";
import { S } from "./state";
import { isGlob, isOp, tokenize } from "./tokenizer";
import type { Op, Token } from "./tokenizer";

export function runPipeline(toks: Token[], ctx: Ctx): Res {
  const segs: Token[][] = [[]];
  for (const t of toks) {
    if (isOp(t) && t.op === "|") segs.push([]);
    else segs[segs.length - 1].push(t);
  }
  let stdin: string | null = null,
    res: Res = { code: 0 };
  const errs: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    let argv: Token[] = segs[i],
      redir: { op: Op; target: string } | null = null;
    const ri = argv.findIndex((t) => isOp(t));
    if (ri >= 0) {
      let tgt: Token | undefined = argv[ri + 1];
      if (tgt !== undefined && isGlob(tgt)) tgt = tgt.glob;
      if (typeof tgt !== "string")
        return E(
          "syntax error: > needs a file name after it, like: echo hi > file.txt",
          2,
        );
      redir = { op: (argv[ri] as { op: Op }).op, target: tgt };
      argv = argv.slice(0, ri).concat(argv.slice(ri + 2));
    }
    argv = argv.flatMap((t) => (isGlob(t) ? expandGlob(t.glob) : [t]));
    if (!argv.length || argv.some((t) => typeof t !== "string"))
      return E(
        "syntax error near the | symbol. Put a command on both sides of it.",
        2,
      );
    const words = argv as string[];
    res = runCmd(words, stdin, ctx, { piped: i < segs.length - 1 || !!redir });
    if (res.err) errs.push(res.err);
    if (res.code === 0) ctx.segs.push(words);
    if (redir) {
      let t = res.out || "";
      if (t && !t.endsWith("\n")) t += "\n";
      const w = writeFile(redir.target, t, redir.op === ">>");
      if (w) {
        errs.push(w);
        return { err: errs.join("\n"), code: 1 };
      }
      res = { code: res.code };
    }
    stdin = res.out || "";
  }
  return Object.assign({}, res, { err: errs.join("\n") });
}

export function runCmd(
  argv: string[],
  stdin: string | null,
  ctx: Ctx,
  opt: Opt,
): Res {
  const name = argv[0],
    args = argv.slice(1);
  const asg = name.match(/^([A-Za-z_]\w*)=(.*)$/);
  if (asg && !args.length) {
    S.env[asg[1]] = asg[2];
    return R("");
  }
  if (name.includes("/")) return runScript(name, ctx, true);
  const fn = CMDS[name];
  if (!fn)
    return E(
      `${name}: command not found. Type help to see what this terminal knows.`,
      127,
    );
  return fn(args, stdin, ctx, opt);
}

export function runScript(path: string, ctx: Ctx, needX: boolean): Res {
  const n = get(path);
  if (!n) return E(`bash: ${path}: No such file or directory`, 127);
  if (n.t === "d") return E(`bash: ${path}: Is a directory`, 126);
  if (needX && !n.m.includes("x"))
    return E(`bash: ${path}: Permission denied`, 126);
  if (ctx.depth > 3) return E("bash: scripts nested too deep");
  ctx.depth++;
  const outs: string[] = [],
    errs: string[] = [];
  for (const l of n.x.split("\n")) {
    const t = l.trim();
    if (!t || t[0] === "#") continue;
    const toks = tokenize(t);
    if (!Array.isArray(toks)) continue;
    const r = runPipeline(
      toks.filter((x) => !(isOp(x) && (x.op === "&&" || x.op === ";"))),
      ctx,
    );
    if (r.out) outs.push(r.out.replace(/\n$/, ""));
    if (r.err) errs.push(r.err);
  }
  ctx.depth--;
  if (needX) ctx.ranExec = base(path);
  return { out: outs.join("\n"), err: errs.join("\n"), code: 0 };
}

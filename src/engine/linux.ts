// The Linux commands (CMDS). Ported from index.html:501-812 at 5e96ce5.
// The output text must not change.
import { NGINX_HTML } from "./content";
import { compose } from "./compose";
import { docker, findImg } from "./docker";
import {
  byteSize,
  chmodStr,
  clone,
  E,
  esc,
  hs,
  lines,
  longRow,
  nameHTML,
  pf,
  R,
  readInput,
  table,
  treeSize,
} from "./helpers";
import type { Ctx, Opt, Res } from "./helpers";
import { MAN } from "./man";
import { M } from "./missions";
import { base, get, getDir, globRe, norm, split, writeFile } from "./paths";
import { runScript } from "./pipeline";
import { d, f, HOME, HOST, S } from "./state";
import type { DirNode, FsNode, Image } from "./state";

export type CmdFn = (
  args: string[],
  stdin: string | null,
  ctx: Ctx,
  opt: Opt,
) => Res;

export const CMDS: Record<string, CmdFn> = {
  help: () =>
    R(`Files and folders
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
Wildcards like *.log work too.`),
  man: (a) => {
    if (!a[0]) return E("What manual page do you want? Try: man ls");
    const m = MAN[a[0]];
    return m ? R(m) : E(`No manual entry for ${a[0]}`);
  },
  hint: () => {
    if (!S.unlocked)
      return E(
        "Hints are locked. Ask your instructor for the password, then use Unlock hints in the logbook.",
      );
    const m = M[S.cur];
    return m
      ? R("Hint: " + m.hint.replace(/`/g, ""))
      : R("You’ve finished every task. Free play!");
  },
  pwd: () => R(S.cwd),
  whoami: () => R("cadet"),
  hostname: () => R(HOST),
  date: () => R(new Date().toString()),
  uname: (a) =>
    R(
      a.includes("-a")
        ? `Linux ${HOST} 6.8.0-harbor #1 SMP x86_64 GNU/Linux`
        : "Linux",
    ),
  clear: () => R("", { clear: true }),
  history: () =>
    R(S.hist.map((h, i) => String(i + 1).padStart(4) + "  " + h).join("\n")),
  sudo: () => E("Nice try. Dockhands don’t get sudo. 🙂"),
  exit: () =>
    R("There’s no leaving the harbor. (Your progress is saved anyway.)"),
  ll: (a, s, c, o) => CMDS.ls(["-l"].concat(a), s, c, o),
  export: (args, s, c, o) => {
    if (!args.length) return CMDS.env([], s, c, o);
    for (const a of args) {
      const m = a.match(/^([A-Za-z_]\w*)=(.*)$/);
      if (m) S.env[m[1]] = m[2];
      else if (!/^[A-Za-z_]\w*$/.test(a))
        return E(`export: \`${a}': not a valid identifier`);
    }
    return R("");
  },
  unset: (args) => {
    args.forEach((a) => delete S.env[a]);
    return R("");
  },
  env: () =>
    R(
      [
        "USER=cadet",
        "HOME=" + HOME,
        "PWD=" + S.cwd,
        "SHELL=/bin/bash",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ]
        .concat(Object.keys(S.env).map((k) => k + "=" + S.env[k]))
        .join("\n"),
    ),
  which: (args) => {
    const BUILTIN = [
      "cd",
      "export",
      "unset",
      "history",
      "hint",
      "help",
      "exit",
      "clear",
    ];
    const outs: string[] = [];
    let code = 0;
    for (const a of args) {
      if (CMDS[a] && !BUILTIN.includes(a)) outs.push("/usr/bin/" + a);
      else code = 1;
    }
    return { out: outs.join("\n"), code: code };
  },
  ls: (args, _, _ctx, opt) => {
    const { fl, pos } = pf(args);
    const targets = pos.length ? pos : ["."];
    const h = fl.has("h");
    const outs: string[] = [],
      htmls: string[] = [],
      errs: string[] = [];
    for (const p of targets) {
      const n = get(p);
      if (!n) {
        errs.push(`ls: cannot access '${p}': No such file or directory`);
        continue;
      }
      if (n.t === "f") {
        outs.push((fl.has("l") ? longRow(n, h) : "") + p);
        htmls.push(esc(fl.has("l") ? longRow(n, h) : "") + nameHTML(p, n));
        continue;
      }
      let names = Object.keys(n.c).sort((a, b) =>
        a.replace(/^\./, "").localeCompare(b.replace(/^\./, "")),
      );
      if (!fl.has("a")) names = names.filter((x) => x[0] !== ".");
      else names = [".", ".."].concat(names);
      if (targets.length > 1) {
        outs.push(p + ":");
        htmls.push(esc(p) + ":");
      }
      const ent: [string, FsNode][] = names.map((x) => [
        x,
        x === "." || x === ".." ? d({}) : n.c[x],
      ]);
      if (fl.has("l")) {
        outs.push("total " + names.length);
        htmls.push("total " + names.length);
        for (const [x, nn] of ent) {
          outs.push(longRow(nn, h) + x);
          htmls.push(esc(longRow(nn, h)) + nameHTML(x, nn));
        }
      } else {
        outs.push(names.join(opt.piped ? "\n" : "  "));
        htmls.push(ent.map(([x, nn]) => nameHTML(x, nn)).join("  "));
      }
    }
    return {
      out: outs.join("\n"),
      html: opt.piped ? undefined : htmls.join("\n"),
      err: errs.join("\n"),
      code: errs.length ? 2 : 0,
    };
  },
  tree: (args) => {
    const p = args[0] || ".";
    const n = get(p);
    if (!n || n.t !== "d") return E(`tree: ${p}: not a folder`);
    const ls = [esc(p)];
    let dirs = 0,
      files = 0;
    (function walk(node: DirNode, pre: string) {
      const ks = Object.keys(node.c)
        .filter((k) => k[0] !== ".")
        .sort();
      ks.forEach((k, i) => {
        const last = i === ks.length - 1;
        const c = node.c[k];
        ls.push(pre + (last ? "└── " : "├── ") + nameHTML(k, c));
        if (c.t === "d") {
          dirs++;
          walk(c, pre + (last ? "    " : "│   "));
        } else files++;
      });
    })(n, "");
    ls.push("", `${dirs} directories, ${files} files`);
    const html = ls.join("\n");
    return {
      out: html
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
      html: html,
      code: 0,
    };
  },
  cd: (args) => {
    let p = args[0];
    if (!p || p === "~") p = HOME;
    if (p === "-") p = S.oldpwd;
    const n = get(p);
    if (!n) return E(`cd: ${args[0]}: No such file or directory`);
    if (n.t !== "d") return E(`cd: ${args[0]}: Not a directory`);
    S.oldpwd = S.cwd;
    S.cwd = norm(p);
    return R("");
  },
  cat: (args, stdin) => {
    const { pos } = pf(args);
    if (!pos.length) {
      if (stdin != null) return R(stdin);
      return E("cat: which file? Try: cat welcome.txt");
    }
    let out = "";
    const errs: string[] = [];
    for (const p of pos) {
      const n = get(p);
      if (!n) errs.push(`cat: ${p}: No such file or directory`);
      else if (n.t === "d") errs.push(`cat: ${p}: Is a directory`);
      else out += n.x;
    }
    return { out: out, err: errs.join("\n"), code: errs.length ? 1 : 0 };
  },
  echo: (args) => {
    let a = args;
    if (a[0] === "-n") a = a.slice(1);
    return R(a.join(" "));
  },
  mkdir: (args) => {
    const { fl, pos } = pf(args);
    if (!pos.length) return E("mkdir: missing folder name. Try: mkdir backups");
    const errs: string[] = [];
    for (const p of pos) {
      if (fl.has("p")) {
        let cur: FsNode = S.fs;
        for (const s of norm(p).split("/").filter(Boolean)) {
          const dir = cur as DirNode;
          if (!dir.c[s]) dir.c[s] = d({});
          cur = dir.c[s];
          if (cur.t !== "d") {
            errs.push(`mkdir: cannot create directory '${p}': Not a directory`);
            break;
          }
        }
        continue;
      }
      const [par, name] = split(p);
      const dn = get(par);
      if (!dn || dn.t !== "d")
        errs.push(
          `mkdir: cannot create directory '${p}': No such file or directory (add -p to create parent folders too)`,
        );
      else if (dn.c[name])
        errs.push(`mkdir: cannot create directory '${p}': File exists`);
      else dn.c[name] = d({});
    }
    return errs.length ? E(errs.join("\n")) : R("");
  },
  touch: (args) => {
    const { pos } = pf(args);
    if (!pos.length) return E("touch: missing file name");
    for (const p of pos) {
      if (get(p)) continue;
      const [par, name] = split(p);
      const dn = get(par);
      if (!dn || dn.t !== "d")
        return E(`touch: cannot touch '${p}': No such file or directory`);
      dn.c[name] = f("");
    }
    return R("");
  },
  rm: (args) => {
    const { fl, pos } = pf(args);
    if (!pos.length) return E("rm: missing operand. Try: rm file.txt");
    const errs: string[] = [];
    for (const p of pos) {
      const a = norm(p);
      if (a === "/" || HOME.startsWith(a)) {
        errs.push(
          `rm: refusing to remove '${p}'. That would sink the whole ship.`,
        );
        continue;
      }
      const n = get(p);
      if (!n) {
        if (!fl.has("f"))
          errs.push(`rm: cannot remove '${p}': No such file or directory`);
        continue;
      }
      if (n.t === "d" && !fl.has("r") && !fl.has("R")) {
        errs.push(
          `rm: cannot remove '${p}': Is a directory (use rm -r to delete a folder)`,
        );
        continue;
      }
      if (S.cwd === a || S.cwd.startsWith(a + "/")) S.cwd = split(a)[0];
      const [par, name] = split(p);
      delete getDir(par).c[name];
    }
    return errs.length ? E(errs.join("\n")) : R("");
  },
  cp: (args) => moveOrCopy(args, "cp"),
  mv: (args) => moveOrCopy(args, "mv"),
  find: (args) => {
    let starts: string[] = [],
      name: string | null = null,
      ci = false,
      type: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-name" || a === "-iname") {
        name = args[++i];
        ci = a === "-iname";
      } else if (a === "-type") type = args[++i];
      else if (a[0] === "-")
        return E(
          `find: unknown option ${a} (this sandbox knows -name, -iname and -type)`,
        );
      else if (name === null && type === null) starts.push(a);
      else
        return E(
          `find: paths must come before options: ${a}\n(Tip: put quotes around patterns, like -name "*.log")`,
        );
    }
    if (!starts.length) starts = ["."];
    const re = name ? globRe(name, ci) : null;
    const out: string[] = [];
    const errs: string[] = [];
    for (const st of starts) {
      const n = get(st);
      if (!n) {
        errs.push(`find: '${st}': No such file or directory`);
        continue;
      }
      (function walk(node: FsNode, p: string, nm: string) {
        const ok =
          (!re || re.test(nm)) &&
          (!type || (type === "d" ? node.t === "d" : node.t === "f"));
        if (ok) out.push(p);
        if (node.t === "d")
          Object.keys(node.c)
            .sort()
            .forEach((k) =>
              walk(node.c[k], (p.endsWith("/") ? p : p + "/") + k, k),
            );
      })(n, st, base(st));
    }
    return {
      out: out.join("\n"),
      err: errs.join("\n"),
      code: errs.length ? 1 : 0,
    };
  },
  grep: (args, stdin, _ctx, opt) => {
    const { fl, pos } = pf(args);
    const pat = pos[0];
    if (pat === undefined)
      return E(
        "grep: what should I search for? Try: grep ERROR logs/system.log",
      );
    let re: RegExp;
    try {
      re = new RegExp(pat, fl.has("i") ? "gi" : "g");
    } catch {
      re = new RegExp(
        pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        fl.has("i") ? "gi" : "g",
      );
    }
    const files = pos.slice(1);
    const srcs: [string, string][] = [];
    const errs: string[] = [];
    if (!files.length) {
      if (stdin == null)
        return E("grep: no file given. Try: grep PATTERN FILE");
      srcs.push(["", stdin]);
    }
    for (const p of files) {
      const n = get(p);
      if (!n) errs.push(`grep: ${p}: No such file or directory`);
      else if (n.t === "d") {
        if (fl.has("r")) {
          (function walk(node: DirNode, pp: string) {
            for (const k of Object.keys(node.c).sort()) {
              const c = node.c[k];
              if (c.t === "d") walk(c, pp + "/" + k);
              else srcs.push([pp + "/" + k, c.x]);
            }
          })(n, p.replace(/\/$/, ""));
        } else errs.push(`grep: ${p}: Is a directory`);
      } else srcs.push([p, n.x]);
    }
    const multi = srcs.length > 1;
    const outs: string[] = [],
      htmls: string[] = [];
    let count = 0;
    const hre = new RegExp(re.source, re.flags);
    for (const [nm, txt] of srcs) {
      let c = 0;
      lines(txt).forEach((l, i) => {
        re.lastIndex = 0;
        const hit = re.test(l);
        if (hit !== fl.has("v")) {
          c++;
          if (fl.has("c")) return;
          const pre =
            (multi ? nm + ":" : "") + (fl.has("n") ? i + 1 + ":" : "");
          outs.push(pre + l);
          htmls.push(
            esc(pre) +
              (fl.has("v")
                ? esc(l)
                : l.split(hre).length > 1
                  ? markAll(l, hre)
                  : esc(l)),
          );
        }
      });
      if (fl.has("c")) {
        outs.push((multi ? nm + ":" : "") + c);
        htmls.push(esc((multi ? nm + ":" : "") + c));
      }
      count += c;
    }
    return {
      out: outs.join("\n"),
      html: opt.piped ? undefined : htmls.join("\n"),
      err: errs.join("\n"),
      code: count || fl.has("c") ? 0 : 1,
    };
  },
  head: (a, s) => headTail(a, s, "head"),
  tail: (a, s) => headTail(a, s, "tail"),
  wc: (args, stdin) => {
    const { fl, pos } = pf(args);
    const items: [string, string][] = [];
    if (!pos.length) {
      if (stdin == null) return E("wc: no input. Try: wc -l notes.txt");
      items.push(["", stdin]);
    }
    for (const p of pos) {
      const n = get(p);
      if (!n || n.t !== "f") return E(`wc: ${p}: No such file`);
      items.push([p, n.x]);
    }
    return R(
      items
        .map(([nm, t]) => {
          const l =
              (t.match(/\n/g) || []).length + (t && !t.endsWith("\n") ? 1 : 0),
            w = t.split(/\s+/).filter(Boolean).length,
            c = byteSize(t);
          const parts: number[] = [];
          if (fl.has("l")) parts.push(l);
          if (fl.has("w")) parts.push(w);
          if (fl.has("c")) parts.push(c);
          if (!parts.length) parts.push(l, w, c);
          return (
            parts
              .map((x) => String(x).padStart(parts.length > 1 ? 7 : 1))
              .join(" ") + (nm ? " " + nm : "")
          );
        })
        .join("\n"),
    );
  },
  sort: (args, stdin) => {
    const { fl, pos } = pf(args);
    const r = readInput(pos, stdin, "sort");
    if (r.err !== undefined) return E(r.err);
    let ls = lines(r.text);
    if (fl.has("n"))
      ls.sort(
        (a, b) =>
          (parseFloat(a) || 0) - (parseFloat(b) || 0) || a.localeCompare(b),
      );
    else ls.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (fl.has("r")) ls.reverse();
    if (fl.has("u")) ls = ls.filter((x, i) => i === 0 || x !== ls[i - 1]);
    return R(ls.join("\n"));
  },
  uniq: (args, stdin) => {
    const { fl, pos } = pf(args);
    const r = readInput(pos, stdin, "uniq");
    if (r.err !== undefined) return E(r.err);
    const out: [string, number][] = [];
    for (const l of lines(r.text)) {
      const last = out[out.length - 1];
      if (last && last[0] === l) last[1]++;
      else out.push([l, 1]);
    }
    let res = out;
    if (fl.has("d")) res = res.filter((x) => x[1] > 1);
    return R(
      res
        .map(([l, n]) => (fl.has("c") ? String(n).padStart(7) + " " + l : l))
        .join("\n"),
    );
  },
  cut: (args, stdin) => {
    let delim = "\t",
      fields: string | null = null,
      chars: string | null = null;
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-d") delim = args[++i];
      else if (a.startsWith("-d")) delim = a.slice(2);
      else if (a === "-f") fields = args[++i];
      else if (a.startsWith("-f")) fields = a.slice(2);
      else if (a === "-c") chars = args[++i];
      else if (a.startsWith("-c")) chars = a.slice(2);
      else pos.push(a);
    }
    if (!fields && !chars)
      return E(
        'cut: you must specify fields with -f or characters with -c. Try: cut -d" " -f3 file',
      );
    const r = readInput(pos, stdin, "cut");
    if (r.err !== undefined) return E(r.err);
    const sel = (spec: string) => {
      const idx: number[] = [];
      for (const part of spec.split(",")) {
        const m = part.match(/^(\d*)-(\d*)$/);
        if (m) {
          const a = +m[1] || 1,
            b = +m[2] || 999;
          for (let i = a; i <= b; i++) idx.push(i);
        } else idx.push(+part);
      }
      return idx;
    };
    if (chars) {
      const ix = sel(chars);
      return R(
        lines(r.text)
          .map((l) => ix.map((i) => l[i - 1] || "").join(""))
          .join("\n"),
      );
    }
    const ix = sel(fields as string);
    return R(
      lines(r.text)
        .map((l) => {
          const p = l.split(delim);
          return p.length === 1
            ? l
            : ix
                .filter((i) => i <= p.length)
                .map((i) => p[i - 1])
                .join(delim);
        })
        .join("\n"),
    );
  },
  awk: (args, stdin) => {
    let sep: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-F") sep = args[++i];
      else if (a.startsWith("-F")) sep = a.slice(2);
      else rest.push(a);
    }
    const prog = rest.shift();
    if (!prog) return E("awk: missing program. Try: awk '{print $1}' file");
    const m = prog.trim().match(/^\{\s*print\s*(.*?)\s*;?\s*\}$/);
    if (!m)
      return E(
        "awk: this sandbox understands simple programs like '{print $2}' or '{print $1, $3}'",
      );
    const r = readInput(rest, stdin, "awk");
    if (r.err !== undefined) return E(r.err);
    const parts = m[1] ? m[1].split(/\s*,\s*/) : ["$0"];
    return R(
      lines(r.text)
        .map((l) => {
          const fs = sep ? l.split(sep) : l.trim().split(/\s+/);
          return parts
            .map((p) => {
              const mm = p.match(/^\$(\d+)$/);
              if (mm) return +mm[1] === 0 ? l : fs[+mm[1] - 1] || "";
              if (p === "NF") return fs.length;
              return p.replace(/^"|"$/g, "");
            })
            .join(" ");
        })
        .join("\n"),
    );
  },
  sed: (args, stdin) => {
    let inplace = false;
    const rest: string[] = [];
    for (const a of args) {
      if (a === "-i") inplace = true;
      else if (a === "-e") continue;
      else rest.push(a);
    }
    const script = rest.shift();
    if (!script) return E("sed: missing script. Try: sed 's/old/new/' file");
    const dl = script[1];
    if (script[0] !== "s" || !dl)
      return E(
        "sed: this sandbox understands substitutions like 's/old/new/' and 's/old/new/g'",
      );
    const parts = script.slice(2).split(dl);
    if (parts.length < 3)
      return E(`sed: -e expression #1: unterminated \`s' command`);
    let re: RegExp;
    try {
      re = new RegExp(parts[0], parts[2].includes("g") ? "g" : "");
    } catch {
      return E("sed: invalid pattern");
    }
    const rep = parts[1].replace(/\\(\d)/g, "$$$1").replace(/&/g, "$$&");
    const doit = (t: string) =>
      lines(t)
        .map((l) => l.replace(re, rep))
        .join("\n") + (t.endsWith("\n") ? "\n" : "");
    if (inplace) {
      if (!rest.length) return E("sed: no input files");
      for (const p of rest) {
        const n = get(p);
        if (!n || n.t !== "f")
          return E(`sed: can't read ${p}: No such file or directory`);
        n.x = doit(n.x);
        delete n.sz;
      }
      return R("");
    }
    const r = readInput(rest, stdin, "sed");
    if (r.err !== undefined) return E(r.err);
    return R(doit(r.text));
  },
  chmod: (args) => {
    const [mode, ...files] = args;
    if (!mode || !files.length)
      return E("chmod: try something like: chmod +x deploy.sh");
    for (const p of files) {
      const n = get(p);
      if (!n)
        return E(`chmod: cannot access '${p}': No such file or directory`);
      const m = chmodStr(n.m, mode);
      if (!m) return E(`chmod: invalid mode: '${mode}'`);
      n.m = m;
    }
    return R("");
  },
  tar: (args) => {
    let fl = "",
      dir: string | null = null;
    const items: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-C") {
        dir = args[++i];
        continue;
      }
      if (i === 0 && /^[a-zA-Z]+$/.test(a) && !get(a)) {
        fl += a;
        continue;
      }
      if (a[0] === "-" && a.length > 1) {
        fl += a.slice(1);
        continue;
      }
      items.push(a);
    }
    if (!/[ctx]/.test(fl))
      return E(
        "tar: You must specify one of -c (create), -t (list) or -x (extract)",
      );
    if (!fl.includes("f"))
      return E(
        "tar: Use -f to name the archive file, like: tar -czf backup.tar.gz folder",
      );
    const file = items.shift();
    if (!file) return E("tar: option requires an archive name after -f");
    const v = fl.includes("v");
    const walkNames = (names: string[]) =>
      function walk(node: FsNode, pp: string) {
        names.push(pp + (node.t === "d" ? "/" : ""));
        if (node.t === "d")
          Object.keys(node.c)
            .sort()
            .forEach((k) => walk(node.c[k], pp + "/" + k));
      };
    if (fl.includes("c")) {
      if (!items.length)
        return E("tar: Cowardly refusing to create an empty archive");
      const ents: { name: string; node: FsNode }[] = [];
      const names: string[] = [];
      for (const p of items) {
        const n = get(p);
        if (!n) return E(`tar: ${p}: Cannot stat: No such file or directory`);
        ents.push({ name: base(p), node: clone(n) });
        walkNames(names)(n, base(p));
      }
      const w = writeFile(file, "PPTAR" + JSON.stringify(ents), false);
      if (w) return E(w.replace("bash", "tar"));
      return R(v ? names.join("\n") : "");
    }
    const an = get(file);
    if (!an) return E(`tar: ${file}: Cannot open: No such file or directory`);
    if (an.t !== "f" || !an.x.startsWith("PPTAR"))
      return E("tar: This does not look like a tar archive");
    const ents = JSON.parse(an.x.slice(5)) as { name: string; node: FsNode }[];
    const names: string[] = [];
    ents.forEach((e) => walkNames(names)(e.node, e.name));
    if (fl.includes("t")) return R(names.join("\n"));
    const td = get(dir || ".");
    if (!td || td.t !== "d")
      return E(`tar: ${dir}: Cannot open: No such file or directory`);
    ents.forEach((e) => {
      td.c[e.name] = clone(e.node);
    });
    return R(v ? names.join("\n") : "");
  },
  ps: (args) => {
    const full = args.some((a) => /^(aux|-e|-ef|-aux|-A|ax)$/.test(a));
    if (!full)
      return R(
        table(
          [["PID", "TTY", "TIME", "CMD"] as (string | number)[]].concat(
            S.procs
              .filter((p) => p.user === "cadet")
              .map((p) => [
                p.pid,
                "pts/0",
                p.cpu > 50 ? "01:12:07" : "00:00:00",
                p.cmd.split(" ")[0].replace(/^-/, ""),
              ]),
          ),
        ),
      );
    return R(
      table(
        [
          ["USER", "PID", "%CPU", "%MEM", "COMMAND"] as (string | number)[],
        ].concat(
          S.procs.map((p) => [
            p.user,
            p.pid,
            p.cpu.toFixed(1),
            p.mem.toFixed(1),
            p.cmd,
          ]),
        ),
      ),
    );
  },
  top: () => {
    const ps = S.procs.slice().sort((a, b) => b.cpu - a.cpu);
    const load = (ps.reduce((s, p) => s + p.cpu, 0) / 100).toFixed(2);
    return R(
      `top - ${new Date().toTimeString().slice(0, 8)} up 3 days,  2:14,  1 user,  load average: ${load}, ${load}, ${load}
Tasks: ${ps.length} total,   ${ps.filter((p) => p.cpu > 1).length} running
MiB Mem :   3936.0 total,   1412.4 free,   1201.7 used

` +
        table(
          [
            ["PID", "USER", "%CPU", "%MEM", "COMMAND"] as (string | number)[],
          ].concat(
            ps.map((p) => [
              p.pid,
              p.user,
              p.cpu.toFixed(1),
              p.mem.toFixed(1),
              p.cmd,
            ]),
          ),
        ) +
        `

(top normally updates live until you press q. Here you get one snapshot.)`,
    );
  },
  kill: (args) => {
    let sig = "TERM";
    const pids: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-s") sig = (args[++i] || "").replace(/^SIG/, "");
      else if (a === "-l")
        return R(
          " 1) SIGHUP   2) SIGINT   9) SIGKILL  15) SIGTERM  19) SIGSTOP",
        );
      else if (/^-\w+$/.test(a)) {
        const s = a.slice(1).replace(/^SIG/, "");
        sig = s === "9" ? "KILL" : s === "15" ? "TERM" : s;
      } else pids.push(a);
    }
    if (!pids.length) return E("kill: usage: kill [-9] PID");
    const errs: string[] = [];
    for (const ps of pids) {
      const pid = +ps;
      const p = S.procs.find((x) => x.pid === pid);
      if (!p) {
        errs.push(`kill: (${ps}) - No such process`);
        continue;
      }
      if (p.user !== "cadet") {
        errs.push(`kill: (${ps}) - Operation not permitted`);
        continue;
      }
      if (p.stubborn && sig !== "KILL") continue;
      S.procs = S.procs.filter((x) => x !== p);
    }
    return errs.length ? E(errs.join("\n")) : R("");
  },
  pkill: (args) => {
    const { pos } = pf(args);
    const nm = pos[0];
    if (!nm) return E("pkill: no process name given");
    const sig9 = args.includes("-9") || args.includes("-KILL");
    const hit = S.procs.filter((p) =>
      p.cmd.split(" ")[0].replace(/^-/, "").includes(nm),
    );
    if (!hit.length) return { code: 1 };
    for (const p of hit) {
      if (p.user !== "cadet")
        return E(`pkill: killing pid ${p.pid} failed: Operation not permitted`);
      if (p.stubborn && !sig9) continue;
      S.procs = S.procs.filter((x) => x !== p);
    }
    return R("");
  },
  killall: (a, s, c, o) => CMDS.pkill(a, s, c, o),
  df: (args) => {
    let big = 0;
    (function walk(n: FsNode) {
      if (n.t === "d") for (const k in n.c) walk(n.c[k]);
      else if (n.sz) big += n.sz;
    })(S.fs);
    const total = 30 * 1024 ** 3,
      used = 12.4 * 1024 ** 3 + big,
      h = args.some((a) => a.includes("h"));
    const pct = Math.min(100, Math.round((used / total) * 100));
    const fmt = (b: number) => (h ? hs(b) : String(Math.round(b / 1024)));
    return R(
      table([
        [
          "Filesystem",
          h ? "Size" : "1K-blocks",
          "Used",
          "Avail",
          "Use%",
          "Mounted on",
        ],
        [
          "/dev/root",
          fmt(total),
          fmt(used),
          fmt(Math.max(0, total - used)),
          pct + "%",
          "/",
        ],
        [
          "tmpfs",
          fmt(2 * 1024 ** 3),
          "0",
          fmt(2 * 1024 ** 3),
          "0%",
          "/dev/shm",
        ],
      ]),
    );
  },
  du: (args) => {
    const { fl, pos } = pf(args);
    const targets = pos.length ? pos : ["."];
    const out: string[] = [];
    const errs: string[] = [];
    for (const p of targets) {
      const n = get(p);
      if (!n) {
        errs.push(`du: cannot access '${p}': No such file or directory`);
        continue;
      }
      const s = treeSize(n);
      out.push((fl.has("h") ? hs(s) : String(Math.ceil(s / 1024))) + "\t" + p);
    }
    return {
      out: out.join("\n"),
      err: errs.join("\n"),
      code: errs.length ? 1 : 0,
    };
  },
  free: () =>
    R(`               total        used        free      shared  buff/cache   available
Mem:           3.8Gi       1.2Gi       1.4Gi        12Mi       1.2Gi       2.4Gi
Swap:             0B          0B          0B`),
  uptime: () => {
    const l = (S.procs.reduce((s, p) => s + p.cpu, 0) / 100).toFixed(2);
    return R(
      ` ${new Date().toTimeString().slice(0, 8)} up 3 days,  2:14,  1 user,  load average: ${l}, ${l}, ${l}`,
    );
  },
  bash: (args, _, ctx) =>
    args[0]
      ? runScript(args[0], ctx, false)
      : E("bash: this sandbox can’t open a nested shell. Try: bash script.sh"),
  sh: (a, s, ctx, o) => CMDS.bash(a, s, ctx, o),
  curl: (args) => {
    const url = args.find((a) => a[0] !== "-");
    if (!url) return E("curl: try: curl localhost:8080");
    const m = url.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?/);
    if (!m)
      return E(
        `curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, "").split("/")[0]} (this sandbox has no internet; try localhost)`,
      );
    const port = m[1] || "80";
    const c = S.dk.containers.find(
      (c) =>
        c.status === "running" && c.ports.some((p) => p.split(":")[0] === port),
    );
    if (!c)
      return E(
        `curl: (7) Failed to connect to localhost port ${port}: Couldn’t connect to server (is a container running with -p ${port}:...?)`,
      );
    const img: Partial<Image> = findImg(c.image) || {};
    const stamp = logStamp();
    if (c.repo === "nginx") {
      c.logs.push(
        `172.17.0.1 - - [${stamp}] "GET / HTTP/1.1" 200 615 "-" "curl/8.5.0" "-"`,
      );
      return R(NGINX_HTML);
    }
    if (img.reply) {
      c.logs.push(`172.17.0.1 - - [${stamp}] "GET / HTTP/1.1" 200 -`);
      return R(img.reply);
    }
    return E("curl: (52) Empty reply from server");
  },
  docker: (args, _stdin, ctx) => docker(args, ctx),
  "docker-compose": (args) => compose(args),
};

export function markAll(l: string, re: RegExp): string {
  let out = "",
    last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  const g = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g",
  );
  while ((m = g.exec(l)) !== null) {
    if (!m[0].length) {
      g.lastIndex++;
      continue;
    }
    out += esc(l.slice(last, m.index)) + `<span class="hl">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(l.slice(last));
}

function headTail(args: string[], stdin: string | null, which: string): Res {
  let n = 10;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n") {
      n = parseInt(args[++i], 10) || 10;
    } else if (/^-n\d+$/.test(a)) n = parseInt(a.slice(2), 10);
    else if (/^-\d+$/.test(a)) n = parseInt(a.slice(1), 10);
    else rest.push(a);
  }
  const r = readInput(rest, stdin, which);
  if (r.err !== undefined) return E(r.err);
  const ls = lines(r.text);
  return R((which === "head" ? ls.slice(0, n) : ls.slice(-n)).join("\n"));
}

function moveOrCopy(args: string[], kind: string): Res {
  const { fl, pos } = pf(args);
  if (pos.length < 2)
    return E(
      `${kind}: needs a source and a destination. Try: ${kind} notes.txt backups/`,
    );
  const dst = pos[pos.length - 1];
  const errs: string[] = [];
  for (const src of pos.slice(0, -1)) {
    const n = get(src);
    if (!n) {
      errs.push(`${kind}: cannot stat '${src}': No such file or directory`);
      continue;
    }
    if (kind === "cp" && n.t === "d" && !fl.has("r") && !fl.has("R")) {
      errs.push(`cp: -r not specified; omitting directory '${src}'`);
      continue;
    }
    let target = norm(dst);
    const dn = get(dst);
    if (dn && dn.t === "d")
      target = (target === "/" ? "" : target) + "/" + base(src);
    if (target === norm(src)) continue;
    if (target.startsWith(norm(src) + "/")) {
      errs.push(
        `${kind}: cannot ${kind === "cp" ? "copy" : "move"} '${src}' into itself`,
      );
      continue;
    }
    const [par, name] = split(target);
    const pn = get(par);
    if (!pn || pn.t !== "d") {
      errs.push(`${kind}: cannot create '${dst}': No such file or directory`);
      continue;
    }
    if (pn.c[name] && pn.c[name].t === "d" && n.t !== "d") {
      errs.push(`${kind}: cannot overwrite directory '${dst}'`);
      continue;
    }
    pn.c[name] = kind === "cp" ? clone(n) : n;
    if (kind === "mv") {
      const [sp, sn] = split(src);
      delete getDir(sp).c[sn];
      const a = norm(src);
      if (S.cwd === a || S.cwd.startsWith(a + "/"))
        S.cwd = target + S.cwd.slice(a.length);
    }
  }
  return errs.length ? E(errs.join("\n")) : R("");
}

export function logStamp(): string {
  const t = new Date();
  const mo = [
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
  ][t.getMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getDate())}/${mo}/${t.getFullYear()}:${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} +0000`;
}

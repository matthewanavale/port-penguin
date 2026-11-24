// Paths and the file system. Ported from index.html:379-408 at 5e96ce5.
import { f, HOME, S } from "./state";
import type { DirNode, FsNode } from "./state";

export function norm(p?: string | null): string {
  if (p === undefined || p === null) p = ".";
  if (p === "~" || p.startsWith("~/")) p = HOME + p.slice(1);
  if (!p.startsWith("/")) p = S.cwd + "/" + p;
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}

export function get(p?: string | null): FsNode | null {
  let n: FsNode = S.fs;
  for (const s of norm(p).split("/").filter(Boolean)) {
    if (n.t !== "d" || !n.c[s]) return null;
    n = n.c[s];
  }
  return n;
}

/** `get` for a path that the caller knows is a folder. */
export function getDir(p?: string | null): DirNode {
  return get(p) as DirNode;
}

export function split(p: string): [string, string] {
  const a = norm(p);
  const i = a.lastIndexOf("/");
  return [a.slice(0, i) || "/", a.slice(i + 1)];
}

export const base = (p: string): string => split(p)[1] || "/";

export const disp = (p: string): string =>
  p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;

export function writeFile(
  p: string,
  text: string,
  append: boolean,
): string | null {
  const [par, name] = split(p);
  const dn = get(par);
  if (!dn || dn.t !== "d") return `bash: ${p}: No such file or directory`;
  const ex = dn.c[name];
  if (ex && ex.t === "d") return `bash: ${p}: Is a directory`;
  if (ex) {
    ex.x = append ? ex.x + text : text;
    delete ex.sz;
  } else dn.c[name] = f(text);
  return null;
}

export function globRe(pat: string, ci?: boolean): RegExp {
  return new RegExp(
    "^" +
      pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    ci ? "i" : "",
  );
}

export function expandGlob(pat: string): string[] {
  const sl = pat.lastIndexOf("/");
  const dirPart = sl >= 0 ? pat.slice(0, sl + 1) : "";
  const last = pat.slice(sl + 1);
  const dn = get(dirPart || ".");
  if (!dn || dn.t !== "d" || !/[*?]/.test(last)) return [pat];
  const re = globRe(last);
  const m = Object.keys(dn.c)
    .filter((n) => re.test(n) && (last.startsWith(".") || n[0] !== "."))
    .sort();
  return m.length ? m.map((n) => dirPart + n) : [pat];
}

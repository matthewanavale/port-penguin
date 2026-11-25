// Filename patterns (D3, last expansion but one). A pattern is a string in
// which a backslash quotes the next character: the expander writes quoted
// text that way.
import { get } from "../paths";

export interface GlobOpts {
  extglob?: boolean;
  dotglob?: boolean;
  nocaseglob?: boolean;
}

const ESC_RE = /[.*+?^${}()|[\]\\/-]/g;
const reEsc = (c: string): string => c.replace(ESC_RE, "\\$&");

/** Escapes text so that it matches itself as a pattern. */
export const quotePattern = (s: string): string =>
  s.replace(/[\\*?[\]()|!@+{}]/g, "\\$&");

/** True when the pattern holds an unquoted glob character. */
export function hasGlob(pat: string, extglob = false): boolean {
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "\\") i++;
    else if (c === "*" || c === "?") return true;
    else if (c === "[" && /\[[^\]]|\[\]/.test(pat.slice(i)) && closes(pat, i))
      return true;
    else if (extglob && "?*+@!".includes(c) && pat[i + 1] === "(") return true;
  }
  return false;
}

function closes(pat: string, i: number): boolean {
  let j = i + 1;
  if (pat[j] === "!" || pat[j] === "^") j++;
  if (pat[j] === "]") j++;
  for (; j < pat.length; j++) {
    if (pat[j] === "[" && pat[j + 1] === ":") {
      const e = pat.indexOf(":]", j + 2);
      if (e > 0) j = e + 1;
    } else if (pat[j] === "]") return true;
  }
  return false;
}

const CLASSES: Record<string, string> = {
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
  word: "A-Za-z0-9_",
};

/** Translates a pattern to regex source (no anchors). */
function translate(pat: string, ext: boolean): string {
  let i = 0;
  const seq = (stop: string): string => {
    let out = "";
    while (i < pat.length) {
      const c = pat[i];
      if (stop.includes(c)) break;
      if (c === "\\") {
        out += pat[i + 1] === undefined ? "\\\\" : reEsc(pat[i + 1]);
        i += 2;
        continue;
      }
      if (ext && "?*+@!".includes(c) && pat[i + 1] === "(") {
        i += 2;
        const alts: string[] = [seq("|)")];
        while (pat[i] === "|") {
          i++;
          alts.push(seq("|)"));
        }
        if (pat[i] === ")") i++;
        const body = alts.join("|");
        if (c === "!") {
          const rest = seq(stop);
          out += `(?:(?!(?:${body})${rest}$)[\\s\\S]*?)${rest}`;
          return out;
        }
        out += `(?:${body})${c === "@" ? "" : c === "?" ? "?" : c === "+" ? "+" : "*"}`;
        continue;
      }
      i++;
      if (c === "*") out += "[^/]*";
      else if (c === "?") out += "[^/]";
      else if (c === "[" && closes(pat, i - 1)) {
        let neg = false;
        if (pat[i] === "!" || pat[i] === "^") {
          neg = true;
          i++;
        }
        let set = "";
        let first = true;
        while (i < pat.length && (pat[i] !== "]" || first)) {
          first = false;
          if (pat[i] === "[" && pat[i + 1] === ":") {
            const e = pat.indexOf(":]", i + 2);
            if (e > 0) {
              set += CLASSES[pat.slice(i + 2, e)] ?? "";
              i = e + 2;
              continue;
            }
          }
          if (pat[i] === "\\" && i + 1 < pat.length) {
            set += reEsc(pat[i + 1]);
            i += 2;
            continue;
          }
          set += pat[i] === "-" ? "-" : reEsc(pat[i]);
          i++;
        }
        i++;
        out += `[${neg ? "^" : ""}${set}]`;
      } else out += reEsc(c);
    }
    return out;
  };
  return seq("");
}

const cache = new Map<string, RegExp>();

export function globRegex(pat: string, extglob = false, ci = false): RegExp {
  const key = (extglob ? "e" : "n") + (ci ? "i" : "c") + pat;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp("^(?:" + translate(pat, extglob) + ")$", ci ? "i" : "");
    if (cache.size > 500) cache.clear();
    cache.set(key, re);
  }
  return re;
}

/** `[[ s == pat ]]` and `case`: `*` also matches a slash here. */
export function matchPattern(
  s: string,
  pat: string,
  extglob = false,
  ci = false,
): boolean {
  const src = translate(pat, extglob)
    .replace(/\[\^\/\]\*/g, "[\\s\\S]*")
    .replace(/\[\^\/\]/g, "[\\s\\S]");
  try {
    return new RegExp("^(?:" + src + ")$", ci ? "i" : "").test(s);
  } catch {
    return false;
  }
}

/** The shortest or longest prefix of `s` that matches (for `${s#p}`). Returns its length or -1. */
export function prefixMatch(
  s: string,
  pat: string,
  longest: boolean,
  ext: boolean,
): number {
  if (longest) {
    for (let n = s.length; n >= 0; n--)
      if (matchPattern(s.slice(0, n), pat, ext)) return n;
  } else {
    for (let n = 0; n <= s.length; n++)
      if (matchPattern(s.slice(0, n), pat, ext)) return n;
  }
  return -1;
}

/** The start of the shortest or longest suffix of `s` that matches (for `${s%p}`), or -1. */
export function suffixMatch(
  s: string,
  pat: string,
  longest: boolean,
  ext: boolean,
): number {
  if (longest) {
    for (let n = 0; n <= s.length; n++)
      if (matchPattern(s.slice(n), pat, ext)) return n;
  } else {
    for (let n = s.length; n >= 0; n--)
      if (matchPattern(s.slice(n), pat, ext)) return n;
  }
  return -1;
}

/** One directory entry, as the glob sees it. */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** Lists a folder by absolute path; null when it is not a folder. */
export function listDir(abs: string): DirEntry[] | null {
  const n = get(abs);
  if (!n || n.t !== "d") return null;
  return Object.keys(n.c).map((name) => ({ name, dir: n.c[name].t === "d" }));
}

/** Absolute path from a cwd and a path (`~` is not expanded here). */
export function resolvePath(cwd: string, p: string): string {
  if (!p.startsWith("/")) p = cwd + "/" + p;
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return "/" + out.join("/");
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Expands one pattern to the sorted list of matching paths (empty when none). */
export function globPaths(pat: string, cwd: string, o: GlobOpts): string[] {
  const abs = pat.startsWith("/");
  // Split on unquoted slashes.
  const segs: string[] = [];
  let cur = "";
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === "\\") {
      cur += pat.slice(i, i + 2);
      i++;
    } else if (pat[i] === "/") {
      segs.push(cur);
      cur = "";
    } else cur += pat[i];
  }
  segs.push(cur);
  const trailing = segs.length > 1 && segs[segs.length - 1] === "";
  if (trailing) segs.pop();
  if (abs) segs.shift();
  const unq = (s: string) => s.replace(/\\(.)/g, "$1");
  let level: { disp: string; real: string }[] = [
    { disp: abs ? "/" : "", real: abs ? "/" : cwd },
  ];
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const last = si === segs.length - 1;
    const next: { disp: string; real: string }[] = [];
    const join = (d: string, n: string) =>
      d === "" ? n : d.endsWith("/") ? d + n : d + "/" + n;
    for (const base of level) {
      if (seg === "") continue;
      if (!hasGlob(seg, o.extglob)) {
        const name = unq(seg);
        const real = resolvePath(base.real, name);
        const n = get(real);
        if (!n) continue;
        if (!last && n.t !== "d") continue;
        next.push({ disp: join(base.disp, name), real });
        continue;
      }
      const ents = listDir(base.real);
      if (!ents) continue;
      const re = globRegex(seg, o.extglob, o.nocaseglob);
      const dots = seg.startsWith(".") || seg.startsWith("\\.") || o.dotglob;
      const names = ents
        .filter((e) => (dots || e.name[0] !== ".") && re.test(e.name))
        .map((e) => e.name)
        .sort(cmp);
      for (const name of names) {
        const real = resolvePath(base.real, name);
        const n = get(real);
        if (!last && (!n || n.t !== "d")) continue;
        next.push({ disp: join(base.disp, name), real });
      }
    }
    level = next;
    if (!level.length) return [];
  }
  let out = level.map((l) => l.disp);
  if (trailing) {
    out = level.filter((l) => get(l.real)?.t === "d").map((l) => l.disp + "/");
  }
  return out;
}

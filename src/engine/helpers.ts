// Shared helpers and the command result type. Ported from
// index.html:410-436 at 5e96ce5.
import type { FsNode } from "./state";
import { get } from "./paths";

/** What one command gives back. `html` is the styled form of `out`. */
export interface Res {
  out?: string;
  err?: string;
  code: number;
  html?: string;
  clear?: boolean;
}

export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const R = (out: string, extra?: Partial<Res>): Res =>
  Object.assign({ out: out, code: 0 }, extra || {});

export const E = (err: string, code?: number): Res => ({
  err: err,
  code: code || 1,
});

export function pf(args: string[]): { fl: Set<string>; pos: string[] } {
  const fl = new Set<string>(),
    pos: string[] = [];
  let end = false;
  for (const a of args) {
    if (!end && a === "--") {
      end = true;
      continue;
    }
    if (!end && a.length > 1 && a[0] === "-" && !/^-\d+$/.test(a)) {
      for (const ch of a.slice(1)) fl.add(ch);
    } else pos.push(a);
  }
  return { fl, pos };
}

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/** UTF-8 byte length, as `new Blob([s]).size` gives. */
export const byteSize = (s: string): number =>
  new TextEncoder().encode(s).length;

export function size(n: FsNode): number {
  if (n.t === "d") return 4096;
  if (n.sz) return n.sz;
  return byteSize(n.x);
}

export function treeSize(n: FsNode): number {
  if (n.t !== "d") return size(n);
  let s = 4096;
  for (const k in n.c) s += treeSize(n.c[k]);
  return s;
}

export function hs(b: number): string {
  if (b < 1024) return Math.round(b) + "";
  const u = ["K", "M", "G", "T"];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < 3);
  return (b >= 10 ? Math.round(b) : b.toFixed(1)) + u[i];
}

export function nameHTML(name: string, n: FsNode | null | undefined): string {
  if (!n) return esc(name);
  if (n.t === "d") return `<span class="dir">${esc(name)}</span>`;
  if (n.m.includes("x")) return `<span class="exe">${esc(name)}</span>`;
  return esc(name);
}

export function longRow(n: FsNode, h: boolean): string {
  const sz = n.t === "d" ? 4096 : size(n);
  return (
    (n.t === "d" ? "d" : "-") +
    n.m +
    " 1 cadet cadet " +
    String(h ? hs(sz) : sz).padStart(h ? 5 : 11) +
    " Nov 24 09:00 "
  );
}

export function ago(ts: number | undefined): string {
  const s = Math.max(0, Math.floor((Date.now() - (ts as number)) / 1000));
  if (s < 1) return "Less than a second";
  if (s < 60) return s + " seconds";
  const m = Math.floor(s / 60);
  if (m === 1) return "About a minute";
  if (m < 60) return m + " minutes";
  const h = Math.floor(m / 60);
  if (h === 1) return "About an hour";
  if (h < 24) return h + " hours";
  const dd = Math.floor(h / 24);
  return dd === 1 ? "1 day" : dd + " days";
}

export function table(rows: (string | number)[][]): string {
  const w = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => String(r[i]).length)),
  );
  return rows
    .map((r) =>
      r
        .map((c, i) =>
          i === r.length - 1 ? String(c) : String(c).padEnd(w[i] + 3),
        )
        .join(""),
    )
    .join("\n");
}

export function chmodStr(m: string, mode: string): string | null {
  if (/^[0-7]{3}$/.test(mode)) {
    return mode
      .split("")
      .map((c) => {
        const n = +c;
        return (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
      })
      .join("");
  }
  const mm = mode.match(/^([ugoa]*)([+-=])([rwx]*)$/);
  if (!mm) return null;
  const who = mm[1] && mm[1] !== "a" ? mm[1] : "ugo";
  const a = m.split("");
  const OFF: Record<string, number> = { u: 0, g: 3, o: 6 };
  const BIT: Record<string, number> = { r: 0, w: 1, x: 2 };
  for (const w of who) {
    const off = OFF[w];
    if (mm[2] === "=") {
      a[off] = a[off + 1] = a[off + 2] = "-";
    }
    for (const p of mm[3]) {
      const i = off + BIT[p];
      a[i] = mm[2] === "-" ? "-" : p;
    }
  }
  return a.join("");
}

export function readInput(
  pos: string[],
  stdin: string | null,
  cmd: string,
): { text: string; err?: undefined } | { err: string; text?: undefined } {
  if (!pos.length) {
    if (stdin == null)
      return {
        err: `${cmd}: no input. Give a file name or pipe something in.`,
      };
    return { text: stdin };
  }
  let t = "";
  for (const p of pos) {
    const n = get(p);
    if (!n) return { err: `${cmd}: ${p}: No such file or directory` };
    if (n.t === "d") return { err: `${cmd}: ${p}: Is a directory` };
    t += n.x;
  }
  return { text: t };
}

export const lines = (t: string): string[] => t.replace(/\n$/, "").split("\n");

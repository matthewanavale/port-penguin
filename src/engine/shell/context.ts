// D13, D14: a shell context. The prompt shell is backed by the saved state;
// copies (subshells, $( ), pipeline stages, scripts) are plain objects.
import { clockNow } from "../clock";
import { nul } from "../nullmap";
import { LimitStop, LIM } from "./limits";
import type { IO } from "./io";

export type ArrayValue = (string | undefined)[];

/** Arrays and attributes. Plain scalars stay in `env`. */
export interface VarMeta {
  type: "str" | "array" | "assoc";
  /** array: items by index; assoc: items by key. Absent for "str". */
  value?: ArrayValue | Record<string, string>;
  /** Letters: r readonly, i integer, l lower, u upper. */
  attrs?: string;
}

export interface SrcInfo {
  kind: "prompt" | "file" | "c";
  path?: string;
}

/** The terminal width, passed in by the terminal (D23). */
export const termCols = { cols: 80 };

export const HOME = "/home/cadet";
export const HOST = "port-penguin";
export const DEFAULT_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Names that are computed until the first assignment (D14). */
export const COMPUTED = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "USER",
  "SHELL",
]);
/** Computed names that `env` prints for a fresh shell. */
export const DEFAULT_EXPORTS = [
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
];

export interface Frame {
  name: string;
  /** Saved values of `local` variables, restored when the function returns. */
  saved: Map<string, { env?: string; meta?: VarMeta; exported: boolean }>;
}

export class Context {
  env: Record<string, string> = nul();
  vars: Record<string, VarMeta> = nul();
  exported = new Set<string>();
  functions: Record<string, string> = nul();
  aliases: Record<string, string> = nul();
  options: Record<string, boolean> = nul();
  params: string[] = [];
  arg0 = "bash";
  frames: Frame[] = [];
  traps: Record<string, string> = nul();
  src: SrcInfo = { kind: "prompt" };
  line = 0;
  lastArg = "";
  pipestatus: number[] = [0];
  /** `$!`: the id of the last background job (B9). */
  lastBg = "";
  io!: IO;
  /** True in the prompt shell and in `bash -i`. */
  interactive = false;
  /** Depth of conditions in which `set -e` does not apply. */
  noErr = 0;
  inTrap = false;
  loopDepth = 0;
  /** Depth of `source` in this context (`return` is allowed in it). */
  sourceDepth = 0;
  seconds = clockNow();

  protected _cwd = HOME;
  protected _oldpwd = HOME;
  protected _lastCode = 0;
  get cwd(): string {
    return this._cwd;
  }
  set cwd(v: string) {
    this._cwd = v;
  }
  get oldpwd(): string {
    return this._oldpwd;
  }
  set oldpwd(v: string) {
    this._oldpwd = v;
  }
  get lastCode(): number {
    return this._lastCode;
  }
  set lastCode(v: number) {
    this._lastCode = v;
  }

  /** A copy for a subshell, a command substitution, or a pipeline stage. */
  copy(): Context {
    const c = new Context();
    c.env = nul(this.env);
    c.vars = cloneVars(this.vars);
    c.exported = new Set(this.exported);
    c.functions = nul(this.functions);
    c.aliases = nul(this.aliases);
    c.options = nul(this.options);
    c.params = this.params.slice();
    c.arg0 = this.arg0;
    c.frames = this.frames.map((f) => ({
      name: f.name,
      saved: new Map(f.saved),
    }));
    c.traps = nul(this.traps);
    c.src = this.src;
    c.line = this.line;
    c.lastArg = this.lastArg;
    c.pipestatus = this.pipestatus.slice();
    c.lastBg = this.lastBg;
    c.io = this.io;
    c.interactive = this.interactive;
    c.noErr = this.noErr;
    c.sourceDepth = this.sourceDepth;
    c.seconds = this.seconds;
    c.cwd = this.cwd;
    c.oldpwd = this.oldpwd;
    c.lastCode = this.lastCode;
    return c;
  }

  /** A fresh context for a script: only the exported variables come along (D13). */
  child(): Context {
    const c = new Context();
    for (const [k, v] of this.exportedPairs()) {
      c.env[k] = v;
      c.exported.add(k);
    }
    c.cwd = this.cwd;
    c.oldpwd = this.oldpwd;
    c.seconds = this.seconds;
    return c;
  }

  /** Exported names with their values, computed names included. */
  exportedPairs(): [string, string][] {
    const out: [string, string][] = [];
    const seen = new Set<string>();
    const add = (k: string) => {
      if (seen.has(k)) return;
      const v = this.get(k);
      if (v === undefined) return;
      seen.add(k);
      out.push([k, v]);
    };
    for (const k of DEFAULT_EXPORTS) add(k);
    for (const k of this.exported) add(k);
    return out;
  }

  /* ---------- reading ---------- */

  /** The value of a variable; undefined when it is not set. */
  get(name: string): string | undefined {
    const m = this.vars[name];
    if (m && m.type !== "str") {
      if (m.type === "array") {
        const a = m.value as ArrayValue;
        return a[0];
      }
      return (m.value as Record<string, string>)["0"];
    }
    const e = this.env[name];
    if (e !== undefined) return e;
    switch (name) {
      case "PWD":
        return this.cwd;
      case "OLDPWD":
        return this.oldpwd === "" ? undefined : this.oldpwd;
      case "HOME":
        return HOME;
      case "USER":
      case "LOGNAME":
        return "cadet";
      case "SHELL":
        return "/bin/bash";
      case "PATH":
        return DEFAULT_PATH;
      case "LANG":
        return "C.UTF-8";
      case "HOSTNAME":
        return HOST;
      case "UID":
      case "EUID":
        return "1000";
      case "PPID":
        return "1";
      case "BASH_VERSION":
        return "5.2.21(1)-release";
      case "OSTYPE":
        return "linux-gnu";
      case "BASH":
        return "/usr/bin/bash";
      case "SHLVL":
        return "1";
      case "LINENO":
        return String(this.line);
      case "RANDOM":
        return String(Math.floor(Math.random() * 32768));
      case "SECONDS":
        return String(Math.floor((clockNow() - this.seconds) / 1000));
      case "FUNCNAME":
        return this.frames.length
          ? this.frames[this.frames.length - 1].name
          : undefined;
      case "COLUMNS":
        return String(termCols.cols);
      case "TERM":
        return "dumb";
      case "TZ":
        return "UTC";
      default:
        return undefined;
    }
  }

  isSet(name: string): boolean {
    return this.get(name) !== undefined;
  }

  ifs(): string {
    const v = this.get("IFS");
    return v === undefined ? " \t\n" : v;
  }

  array(name: string): VarMeta | undefined {
    const m = this.vars[name];
    return m && m.type !== "str" ? m : undefined;
  }

  attrs(name: string): string {
    return this.vars[name]?.attrs ?? "";
  }

  /** Values of an array in index order, or the scalar as one item. */
  list(name: string): string[] {
    const m = this.array(name);
    if (m) {
      if (m.type === "array")
        return (m.value as ArrayValue).filter(
          (x): x is string => x !== undefined,
        );
      return Object.values(m.value as Record<string, string>);
    }
    const v = this.get(name);
    return v === undefined ? [] : [v];
  }

  keys(name: string): string[] {
    const m = this.array(name);
    if (m) {
      if (m.type === "array") {
        const out: string[] = [];
        (m.value as ArrayValue).forEach((x, i) => {
          if (x !== undefined) out.push(String(i));
        });
        return out;
      }
      return Object.keys(m.value as Record<string, string>);
    }
    return this.get(name) === undefined ? [] : ["0"];
  }

  elem(name: string, idx: string): string | undefined {
    const m = this.array(name);
    if (m) {
      if (m.type === "array") {
        const a = m.value as ArrayValue;
        let i = Number(idx);
        if (!Number.isInteger(i)) i = 0;
        if (i < 0) i += a.length;
        return a[i];
      }
      return (m.value as Record<string, string>)[idx];
    }
    const i = Number(idx);
    return i === 0 || idx === "" ? this.get(name) : undefined;
  }

  /* ---------- writing ---------- */

  /** Sets a scalar. Returns an error text, or null. */
  set(name: string, value: string, append = false): string | null {
    const attrs = this.attrs(name);
    if (attrs.includes("r")) return `${name}: readonly variable`;
    if (append) {
      const old = this.get(name) ?? "";
      value = attrs.includes("i")
        ? String((Number(old) || 0) + (Number(value) || 0))
        : old + value;
    }
    if (attrs.includes("l")) value = value.toLowerCase();
    if (attrs.includes("u")) value = value.toUpperCase();
    if (value.length > LIM.str) throw new LimitStop("1 MB string");
    const m = this.vars[name];
    if (m && m.type !== "str") {
      if (m.type === "array") (m.value as ArrayValue)[0] = value;
      else (m.value as Record<string, string>)["0"] = value;
      return null;
    }
    this.env[name] = value;
    return null;
  }

  setElem(
    name: string,
    idx: string,
    value: string,
    append = false,
  ): string | null {
    const attrs = this.attrs(name);
    if (attrs.includes("r")) return `${name}: readonly variable`;
    let m = this.vars[name];
    if (!m || m.type === "str") {
      const old = this.env[name];
      m = { type: "array", value: [], attrs: m?.attrs };
      if (old !== undefined) (m.value as ArrayValue)[0] = old;
      delete this.env[name];
      this.vars[name] = m;
    }
    if (append) value = (this.elem(name, idx) ?? "") + value;
    if (attrs.includes("l")) value = value.toLowerCase();
    if (attrs.includes("u")) value = value.toUpperCase();
    if (value.length > LIM.str) throw new LimitStop("1 MB string");
    if (m.type === "array") {
      let i = Number(idx);
      if (!Number.isInteger(i)) i = 0;
      const a = m.value as ArrayValue;
      if (i < 0) i += a.length;
      if (i < 0) return `${name}[${idx}]: bad array subscript`;
      if (i >= LIM.array) throw new LimitStop("100000 array items");
      a[i] = value;
    } else (m.value as Record<string, string>)[idx] = value;
    return null;
  }

  /** `a=(...)`: replaces or appends the whole array. */
  setArray(
    name: string,
    items: { key?: string; value: string }[],
    kind: "array" | "assoc",
    append: boolean,
  ): string | null {
    const attrs = this.attrs(name);
    if (attrs.includes("r")) return `${name}: readonly variable`;
    const old = this.array(name);
    let m: VarMeta;
    if (kind === "assoc") {
      m = {
        type: "assoc",
        value: append && old?.type === "assoc" ? old.value : nul(),
        attrs: old?.attrs ?? this.vars[name]?.attrs,
      };
      let n = 0;
      for (const it of items) {
        (m.value as Record<string, string>)[it.key ?? String(n)] = it.value;
        n++;
      }
    } else {
      const arr: ArrayValue =
        append && old?.type === "array"
          ? (old.value as ArrayValue)
          : append && this.env[name] !== undefined
            ? [this.env[name]]
            : [];
      let next = arr.length;
      for (const it of items) {
        const i = it.key !== undefined ? Number(it.key) || 0 : next;
        arr[i] = it.value;
        next = i + 1;
        if (next > LIM.array) throw new LimitStop("100000 array items");
      }
      m = { type: "array", value: arr, attrs: this.vars[name]?.attrs };
    }
    delete this.env[name];
    this.vars[name] = m;
    return null;
  }

  declareKind(name: string, kind: "array" | "assoc"): void {
    const old = this.vars[name];
    if (old && old.type === kind) return;
    const v = this.get(name);
    const m: VarMeta = {
      type: kind,
      value: kind === "array" ? [] : nul(),
      attrs: old?.attrs,
    };
    if (v !== undefined) {
      if (kind === "array") (m.value as ArrayValue)[0] = v;
      else (m.value as Record<string, string>)["0"] = v;
    }
    delete this.env[name];
    this.vars[name] = m;
  }

  addAttr(name: string, attr: string): void {
    const m = this.vars[name] ?? { type: "str" as const };
    if (!(m.attrs ?? "").includes(attr)) m.attrs = (m.attrs ?? "") + attr;
    this.vars[name] = m;
  }
  removeAttr(name: string, attr: string): void {
    const m = this.vars[name];
    if (!m) return;
    m.attrs = (m.attrs ?? "").replace(attr, "");
    if (m.type === "str" && !m.attrs) delete this.vars[name];
  }

  unset(name: string): string | null {
    if (this.attrs(name).includes("r"))
      return `${name}: cannot unset: readonly variable`;
    delete this.env[name];
    delete this.vars[name];
    this.exported.delete(name);
    return null;
  }

  unsetElem(name: string, idx: string): void {
    const m = this.array(name);
    if (!m) return;
    if (m.type === "array") {
      const a = m.value as ArrayValue;
      let i = Number(idx);
      if (i < 0) i += a.length;
      delete a[i];
      while (a.length && a[a.length - 1] === undefined) a.length--;
    } else delete (m.value as Record<string, string>)[idx];
  }

  /** `local`: remembers the old value so the function return restores it. */
  declareLocal(name: string): boolean {
    const f = this.frames[this.frames.length - 1];
    if (!f) return false;
    if (!f.saved.has(name)) {
      f.saved.set(name, {
        env: this.env[name],
        meta: this.vars[name] ? cloneVars({ x: this.vars[name] }).x : undefined,
        exported: this.exported.has(name),
      });
      delete this.env[name];
      delete this.vars[name];
    }
    return true;
  }

  popFrame(): void {
    const f = this.frames.pop();
    if (!f) return;
    for (const [name, s] of f.saved) {
      delete this.env[name];
      delete this.vars[name];
      if (s.env !== undefined) this.env[name] = s.env;
      if (s.meta) this.vars[name] = s.meta;
      if (s.exported) this.exported.add(name);
      else this.exported.delete(name);
    }
  }

  /** `$-`: the option letters. */
  flags(): string {
    const o = this.options;
    let s = "";
    if (o.allexport) s += "a";
    if (o.errexit) s += "e";
    if (o.noglob) s += "f";
    s += "h";
    if (this.interactive) s += "i";
    if (this.interactive) s += "m";
    if (o.nounset) s += "u";
    if (o.xtrace) s += "x";
    s += "B";
    if (this.interactive) s += "H";
    if (this.interactive) s += "s";
    return s;
  }
}

export function cloneVars(v: Record<string, VarMeta>): Record<string, VarMeta> {
  const out: Record<string, VarMeta> = nul<VarMeta>();
  for (const [k, m] of Object.entries(v)) {
    out[k] = {
      type: m.type,
      attrs: m.attrs,
      value:
        m.value === undefined
          ? undefined
          : Array.isArray(m.value)
            ? m.value.slice()
            : nul(m.value as Record<string, string>),
    };
    if (out[k].value === undefined) delete out[k].value;
    if (out[k].attrs === undefined) delete out[k].attrs;
  }
  return out;
}

/** Turns loaded JSON (arrays with null holes) into the in-memory form. */
export function reviveVars(
  v: Record<string, unknown>,
): Record<string, VarMeta> {
  const out: Record<string, VarMeta> = nul<VarMeta>();
  for (const [k, raw] of Object.entries(v)) {
    const m = raw as { type?: string; value?: unknown; attrs?: string } | null;
    if (!m || typeof m !== "object") continue;
    const type = m.type === "array" || m.type === "assoc" ? m.type : "str";
    const meta: VarMeta = { type };
    if (typeof m.attrs === "string") meta.attrs = m.attrs;
    if (type === "array") {
      const arr: ArrayValue = [];
      const src = Array.isArray(m.value)
        ? (m.value as unknown[])
        : Object.entries((m.value as Record<string, unknown>) ?? {}).map(
            ([i, x]) => [Number(i), x] as const,
          );
      if (Array.isArray(m.value))
        (src as unknown[]).forEach((x, i) => {
          if (typeof x === "string") arr[i] = x;
        });
      else
        for (const [i, x] of src as [number, unknown][])
          if (typeof x === "string" && Number.isInteger(i)) arr[i] = x;
      meta.value = arr;
    } else if (type === "assoc") {
      const o: Record<string, string> = nul();
      for (const [i, x] of Object.entries(
        (m.value as Record<string, unknown>) ?? {},
      ))
        if (typeof x === "string") o[i] = x;
      meta.value = o;
    }
    out[k] = meta;
  }
  return out;
}

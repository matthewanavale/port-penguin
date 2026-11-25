// Shell arithmetic: $(( )), (( )), let, array subscripts. 64-bit integers.

export interface ArithHost {
  /** The text value of a variable, or undefined. */
  getVar(name: string): string | undefined;
  getElem(name: string, idx: string): string | undefined;
  /** Returns an error text or null. */
  setVar(name: string, value: string): string | null;
  setElem(name: string, idx: string, value: string): string | null;
}

export class ArithError extends Error {}

type Tok =
  | { t: "num"; v: bigint }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPS3 = ["<<=", ">>=", "**="];
const OPS2 = [
  "**",
  "<<",
  ">>",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "^=",
  "|=",
  "++",
  "--",
];
const M64 = (n: bigint) => BigInt.asIntN(64, n);

function digitValue(ch: string): number {
  if (/[0-9]/.test(ch)) return ch.charCodeAt(0) - 48;
  if (/[a-z]/.test(ch)) return ch.charCodeAt(0) - 87;
  if (/[A-Z]/.test(ch)) return ch.charCodeAt(0) - 29;
  return ch === "@" ? 62 : 63;
}

function lex(src: string): { toks: Tok[]; pos: number[] } {
  const toks: Tok[] = [];
  const pos: number[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    pos.push(i);
    if (/[0-9]/.test(c)) {
      const m = /^(?:0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z@_]+|[0-9]+)/.exec(
        src.slice(i),
      ) as RegExpExecArray;
      const s = m[0];
      let v: bigint;
      if (/^0[xX]/.test(s)) v = BigInt(s);
      else if (s.includes("#")) {
        const [b, d] = s.split("#");
        const base = Number(b);
        if (base < 2 || base > 64)
          throw new ArithError(
            `${s}: invalid arithmetic base (error token is "${s}")`,
          );
        v = 0n;
        for (const ch of d) {
          const dig = digitValue(ch);
          if (dig >= base)
            throw new ArithError(
              `${s}: value too great for base (error token is "${s}")`,
            );
          v = v * BigInt(base) + BigInt(dig);
        }
      } else if (s.length > 1 && s[0] === "0") {
        if (/[89]/.test(s))
          throw new ArithError(
            `${s}: value too great for base (error token is "${s}")`,
          );
        v = BigInt("0o" + s.slice(1));
      } else v = BigInt(s);
      toks.push({ t: "num", v });
      i += s.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
      toks.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (OPS3.includes(three)) {
      toks.push({ t: "op", v: three });
      i += 3;
    } else if (OPS2.includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
    } else if ("+-*/%<>=!~&|^?:,()[]".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
    } else
      throw new ArithError(
        `${src}: syntax error: invalid arithmetic operator (error token is "${src.slice(i)}")`,
      );
  }
  return { toks, pos };
}

type Ref = { name: string; idx?: string } | null;

/** Evaluates an expression. Throws ArithError with the bash message. */
export function evalArith(src: string, host: ArithHost, depth = 0): bigint {
  if (depth > 20)
    throw new ArithError(`${src}: expression recursion level exceeded`);
  const { toks, pos } = lex(src);
  if (!toks.length) return 0n;
  let p = 0;
  let lastRef: Ref = null;
  const peek = () => toks[p];
  const isOp = (v: string) =>
    toks[p]?.t === "op" && (toks[p] as { v: string }).v === v;
  const fail = (what: string): never => {
    const at = pos[Math.min(p, pos.length - 1)] ?? 0;
    throw new ArithError(`${src}: ${what} (error token is "${src.slice(at)}")`);
  };
  const valueOf = (name: string, idx?: string): bigint => {
    const v = idx === undefined ? host.getVar(name) : host.getElem(name, idx);
    if (v === undefined || v === "") return 0n;
    if (/^\s*-?[0-9]+\s*$/.test(v)) return BigInt(v.trim());
    return evalArith(v, host, depth + 1);
  };
  const store = (ref: NonNullable<Ref>, v: bigint) => {
    const err =
      ref.idx === undefined
        ? host.setVar(ref.name, v.toString())
        : host.setElem(ref.name, ref.idx, v.toString());
    if (err) throw new ArithError(err);
  };
  const bin = (next: () => bigint, ops: string[], f: (op: string, a: bigint, b: bigint) => bigint) => {
    let v = next();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !ops.includes(t.v)) break;
      p++;
      v = f(t.v, v, next());
      lastRef = null;
    }
    return v;
  };

  function comma(): bigint {
    let v = assign();
    while (isOp(",")) {
      p++;
      v = assign();
    }
    return v;
  }
  function assign(): bigint {
    const v = ternary();
    const t = peek();
    if (
      t &&
      t.t === "op" &&
      /^(=|\+=|-=|\*=|\/=|%=|<<=|>>=|&=|\^=|\|=|\*\*=)$/.test(t.v)
    ) {
      const ref = lastRef as Ref;
      if (!ref) return fail("attempted assignment to non-variable");
      p++;
      const rhs = assign();
      const cur = valueOf(ref.name, ref.idx);
      let res: bigint;
      switch (t.v) {
        case "=":
          res = rhs;
          break;
        case "+=":
          res = cur + rhs;
          break;
        case "-=":
          res = cur - rhs;
          break;
        case "*=":
          res = cur * rhs;
          break;
        case "/=":
          if (rhs === 0n) fail("division by 0");
          res = cur / rhs;
          break;
        case "%=":
          if (rhs === 0n) fail("division by 0");
          res = cur % rhs;
          break;
        case "<<=":
          res = cur << rhs;
          break;
        case ">>=":
          res = cur >> rhs;
          break;
        case "&=":
          res = cur & rhs;
          break;
        case "^=":
          res = cur ^ rhs;
          break;
        case "|=":
          res = cur | rhs;
          break;
        default:
          res = cur ** rhs;
      }
      res = M64(res);
      store(ref, res);
      lastRef = null;
      return res;
    }
    return v;
  }
  function ternary(): bigint {
    const c = lor();
    if (isOp("?")) {
      p++;
      const a = assign();
      if (!isOp(":")) fail("expected `:' in conditional expression");
      p++;
      const b = assign();
      lastRef = null;
      return c !== 0n ? a : b;
    }
    return c;
  }
  const lor = () =>
    bin(land, ["||"], (_o, a, b) => (a !== 0n || b !== 0n ? 1n : 0n));
  const land = () =>
    bin(bor, ["&&"], (_o, a, b) => (a !== 0n && b !== 0n ? 1n : 0n));
  const bor = () => bin(bxor, ["|"], (_o, a, b) => a | b);
  const bxor = () => bin(band, ["^"], (_o, a, b) => a ^ b);
  const band = () => bin(eq, ["&"], (_o, a, b) => a & b);
  const eq = () =>
    bin(rel, ["==", "!="], (o, a, b) => ((o === "==") === (a === b) ? 1n : 0n));
  const rel = () =>
    bin(shift, ["<", "<=", ">", ">="], (o, a, b) =>
      (o === "<" ? a < b : o === "<=" ? a <= b : o === ">" ? a > b : a >= b)
        ? 1n
        : 0n,
    );
  const shift = () =>
    bin(add, ["<<", ">>"], (o, a, b) => (o === "<<" ? M64(a << b) : a >> b));
  const add = () =>
    bin(mul, ["+", "-"], (o, a, b) => M64(o === "+" ? a + b : a - b));
  function mul(): bigint {
    let v = pow();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !["*", "/", "%"].includes(t.v)) break;
      p++;
      const at = pos[Math.min(p, pos.length - 1)] ?? 0;
      const r = pow();
      if (t.v !== "*" && r === 0n)
        throw new ArithError(
          `${src}: division by 0 (error token is "${src.slice(at)}")`,
        );
      v = t.v === "*" ? M64(v * r) : t.v === "/" ? v / r : v % r;
      lastRef = null;
    }
    return v;
  }
  function pow(): bigint {
    const b = unary();
    if (isOp("**")) {
      p++;
      const e = pow();
      lastRef = null;
      if (e < 0n) fail("exponent less than 0");
      return M64(b ** e);
    }
    return b;
  }
  function unary(): bigint {
    const t = peek();
    if (t && t.t === "op") {
      if (t.v === "+" || t.v === "-" || t.v === "!" || t.v === "~") {
        p++;
        const v = unary();
        lastRef = null;
        return t.v === "+"
          ? v
          : t.v === "-"
            ? M64(-v)
            : t.v === "!"
              ? v === 0n
                ? 1n
                : 0n
              : ~v;
      }
      if (t.v === "++" || t.v === "--") {
        p++;
        unary();
        const ref = lastRef as Ref;
        if (!ref) return fail("operand expected");
        const nv = valueOf(ref.name, ref.idx) + (t.v === "++" ? 1n : -1n);
        store(ref, nv);
        lastRef = null;
        return nv;
      }
    }
    const v = primary();
    const ref = lastRef as Ref;
    if ((isOp("++") || isOp("--")) && ref) {
      const d = (peek() as { v: string }).v === "++" ? 1n : -1n;
      p++;
      const old = valueOf(ref.name, ref.idx);
      store(ref, old + d);
      lastRef = null;
      return old;
    }
    return v;
  }
  function primary(): bigint {
    const t = peek();
    lastRef = null;
    if (!t) return fail("syntax error: operand expected");
    if (t.t === "num") {
      p++;
      return t.v;
    }
    if (t.t === "id") {
      p++;
      if (isOp("[")) {
        p++;
        const start = p;
        let depth = 1;
        while (p < toks.length) {
          const x = toks[p];
          if (x.t === "op" && x.v === "[") depth++;
          if (x.t === "op" && x.v === "]" && --depth === 0) break;
          p++;
        }
        if (p >= toks.length) fail("missing `]'");
        const inner = src.slice(
          pos[start] ?? 0,
          p < pos.length ? pos[p] : src.length,
        );
        p++;
        const idx = evalArith(inner, host, depth + 1).toString();
        lastRef = { name: t.v, idx };
        return valueOf(t.v, idx);
      }
      lastRef = { name: t.v };
      return valueOf(t.v);
    }
    if (t.v === "(") {
      p++;
      const v = comma();
      if (!isOp(")")) fail("missing `)'");
      p++;
      lastRef = null;
      return v;
    }
    return fail("syntax error: operand expected");
  }

  const v = comma();
  if (p < toks.length) {
    const at = pos[p] ?? 0;
    throw new ArithError(
      `${src}: syntax error in expression (error token is "${src.slice(at)}")`,
    );
  }
  return v;
}

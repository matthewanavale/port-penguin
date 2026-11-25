// AC1, AC3, AC10, D6: the parser. One test per grammar rule and per syntax
// error.
//
// Contract (src/engine/shell/parser.ts):
//   parse(text: string): ParseResult
//     { status: "ok", ast }                  ast = { type: "script", items: Node[] }
//     { status: "incomplete" }               the input waits for more lines
//     { status: "error", message: string }   the bash message, no "line N" prefix
//   Node `type` names used below: simple, pipeline, andor, if, case, for,
//   cfor, while, until, group, subshell, function, arith, cond.
import { describe, expect, it } from "vitest";
import { parse } from "./parser";

const types = (src: string): string[] => {
  const r = parse(src);
  expect(r.status, src).toBe("ok");
  const found = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (typeof o.type === "string") found.add(o.type);
      Object.values(o).forEach(walk);
    }
  };
  walk((r as { ast: unknown }).ast);
  return [...found];
};

describe("grammar rules (AC3)", () => {
  const rules: [string, string][] = [
    ["echo hi", "simple"],
    ["a | b", "pipeline"],
    ["! a | b", "pipeline"],
    ["a && b || c", "andor"],
    ["a; b\nc", "simple"],
    ["if a; then b; elif c; then d; else e; fi", "if"],
    ["case $x in a|b) c;; d) e;& f) g;;& *) h;; esac", "case"],
    ["for i in 1 2; do echo $i; done", "for"],
    ["for i; do :; done", "for"],
    ["for ((i=0;i<3;i++)); do :; done", "cfor"],
    ["while a; do b; done", "while"],
    ["until a; do b; done", "until"],
    ["{ a; b; }", "group"],
    ["( a; b )", "subshell"],
    ["f() { a; }", "function"],
    ["function f { a; }", "function"],
    ["function f() { a; }", "function"],
    ["(( 1 + 2 ))", "arith"],
    ["[[ a == b && -n c ]]", "cond"],
    ["[[ $x =~ ^a(b)$ ]]", "cond"],
  ];
  for (const [src, type] of rules) {
    it(`parses ${JSON.stringify(src)} as ${type}`, () => {
      expect(types(src)).toContain(type);
    });
  }

  it("parses every redirection form", () => {
    for (const src of [
      "a > f",
      "a >> f",
      "a < f",
      "a 2> f",
      "a 2>> f",
      "a 2>&1",
      "a &> f",
      "a &>> f",
      "a >&2",
      "a <<< word",
      "a <<EOF\nx\nEOF",
      "a <<-EOF\n\tx\n\tEOF",
      "a <<'EOF'\nx\nEOF",
      "a 3< f 4> g",
      "a <(b) >(c)",
    ])
      expect(parse(src).status, src).toBe("ok");
  });

  it("parses quoting forms, comments, and expansions in words", () => {
    for (const src of [
      "echo 'a' \"b $c\" $'d\\n' e\\ f",
      "echo a # note",
      "echo ${a:-b} ${#a} ${a[@]} ${!a[@]} ${a//x/y} $((1+2)) $(b) `c`",
      "echo {a,b}{1..3}",
      "a=1 b=(x y) c+=z d[2]=w cmd",
    ])
      expect(parse(src).status, src).toBe("ok");
  });

  it("parses an empty input and a comment-only input as an empty script", () => {
    for (const src of ["", "   ", "# nothing", "\n\n"]) {
      const r = parse(src);
      expect(r.status).toBe("ok");
      expect((r as { ast: { items: unknown[] } }).ast.items).toEqual([]);
    }
  });
});

describe("syntax errors (AC1)", () => {
  const errors: [string, string][] = [
    ["echo a; fi", "bash: syntax error near unexpected token `fi'"],
    ["echo a )", "bash: syntax error near unexpected token `)'"],
    ["done", "bash: syntax error near unexpected token `done'"],
    ["esac", "bash: syntax error near unexpected token `esac'"],
    ["}", "bash: syntax error near unexpected token `}'"],
    ["a | | b", "bash: syntax error near unexpected token `|'"],
    ["; a", "bash: syntax error near unexpected token `;'"],
    ["a &&& b", "bash: syntax error near unexpected token `&'"],
    ["if true; then fi", "bash: syntax error near unexpected token `fi'"],
    ["echo a >", "bash: syntax error near unexpected token `newline'"],
    ["echo (", "bash: syntax error near unexpected token `newline'"],
    ["for in x; do :; done", "bash: syntax error near unexpected token `x'"],
  ];
  for (const [src, message] of errors) {
    it(`reports ${JSON.stringify(src)}`, () => {
      expect(parse(src)).toEqual({ status: "error", message });
    });
  }
});

describe("incomplete input waits for more lines (AC1, AC10)", () => {
  const incomplete = [
    "echo 'open",
    'echo "open',
    "echo $(open",
    "echo `open",
    "echo ${open",
    "if true; then",
    "if true; then echo a; elif",
    "for i in 1; do",
    "while true; do",
    "until false; do",
    "case a in",
    "case a in a) echo;;",
    "{ echo",
    "( echo",
    "f() {",
    "echo a |",
    "echo a &&",
    "echo a ||",
    "echo a \\",
    "cat <<EOF",
    "cat <<EOF\nline",
    "cat <<-EOF\n\tline",
    "(( 1 +",
    "[[ a ==",
  ];
  for (const src of incomplete) {
    it(`treats ${JSON.stringify(src)} as incomplete`, () => {
      expect(parse(src).status).toBe("incomplete");
    });
  }

  it("treats the same inputs, once closed, as complete", () => {
    for (const src of [
      "echo 'open'",
      "if true; then echo; fi",
      "cat <<EOF\nline\nEOF",
      "echo a |\ncat",
      "echo a \\\nb",
      "{ echo; }",
    ])
      expect(parse(src).status, src).toBe("ok");
  });
});

describe("parser nesting limit (D6)", () => {
  it("refuses 600 nested subshells written with spaces", () => {
    const src = "( ".repeat(600) + "true" + " )".repeat(600);
    const r = parse(src);
    expect(r.status).toBe("error");
    expect((r as { message: string }).message).toContain(
      "nesting too deep (500)",
    );
  });

  it("accepts 100 nested subshells", () => {
    const src = "( ".repeat(100) + "true" + " )".repeat(100);
    expect(parse(src).status).toBe("ok");
  });

  it("never throws a JavaScript error on deep input", () => {
    for (const open of ["$(", "`", "{ ", "if true; then ", '"$(']) {
      expect(() => parse(open.repeat(5000))).not.toThrow();
    }
  });
});

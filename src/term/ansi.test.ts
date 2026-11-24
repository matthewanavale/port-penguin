// AC7 and D17: styled runs become ANSI escape codes, and the xterm.js theme
// maps the ANSI colors to today's CSS tokens. The test does not fix which
// ANSI slot a style uses. It reads the slot from the escape codes and checks
// that the theme gives that slot the right token color.
//
// Contract (src/term/ansi.ts):
//   renderLines(lines: OutLine[]): string   each line ends with "\r\n"
//   themeFromCss(style): ITheme             style.getPropertyValue("--term") ...
import { describe, expect, it } from "vitest";
import type { OutLine, Style } from "../engine/output";
import { renderLines, themeFromCss } from "./ansi";

const LIGHT: Record<string, string> = {
  "--term": "#0F2133",
  "--tink": "#D8E4ED",
  "--tdim": "#8199AD",
  "--tprompt": "#F2C14E",
  "--tpath": "#8FB8F5",
  "--tok": "#7DD3C4",
  "--terr": "#F5A08B",
  "--texe": "#9EE493",
};
const DARK: Record<string, string> = { ...LIGHT, "--term": "#08131D" };

/** A computed style whose custom properties have a leading space, as browsers return them. */
const css = (tokens: Record<string, string>) => ({
  getPropertyValue: (name: string) =>
    name in tokens ? ` ${tokens[name]}` : "",
});

const theme = themeFromCss(css(LIGHT)) as unknown as Record<
  string,
  string | undefined
>;

const SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];
type Attr = { fg: string; bg: string; bold: boolean };

/** Applies the SGR codes in `out` and returns the attributes of every printed character. */
function paint(out: string): { ch: string; attr: Attr }[] {
  const res: { ch: string; attr: Attr }[] = [];
  let attr: Attr = { fg: "foreground", bg: "background", bold: false };
  // eslint-disable-next-line no-control-regex -- this test reads ANSI escape codes
  const re = /\x1b\[([\d;]*)m/y;
  for (let i = 0; i < out.length;) {
    re.lastIndex = i;
    const m = re.exec(out);
    if (m) {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 0) attr = { fg: "foreground", bg: "background", bold: false };
        else if (c === 1) attr = { ...attr, bold: true };
        else if (c === 22) attr = { ...attr, bold: false };
        else if (c >= 30 && c <= 37) attr = { ...attr, fg: SLOTS[c - 30] };
        else if (c >= 90 && c <= 97)
          attr = { ...attr, fg: "bright" + cap(SLOTS[c - 90]) };
        else if (c === 39) attr = { ...attr, fg: "foreground" };
        else if (c >= 40 && c <= 47) attr = { ...attr, bg: SLOTS[c - 40] };
        else if (c >= 100 && c <= 107)
          attr = { ...attr, bg: "bright" + cap(SLOTS[c - 100]) };
        else if (c === 49) attr = { ...attr, bg: "background" };
        else
          throw new Error(
            `unexpected SGR code ${c}: use the 16 theme colors only`,
          );
      }
      i = re.lastIndex;
    } else {
      res.push({ ch: out[i], attr });
      i++;
    }
  }
  return res;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// eslint-disable-next-line no-control-regex -- this test reads ANSI escape codes
const stripSgr = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
const color = (slot: string) => theme[slot]?.toUpperCase();

/** Attributes of the first character of `needle` in the rendered output. */
function attrOf(lines: OutLine[], needle: string): Attr {
  const cells = paint(renderLines(lines));
  const text = cells.map((c) => c.ch).join("");
  const at = text.indexOf(needle);
  expect(at, `"${needle}" in output`).toBeGreaterThanOrEqual(0);
  return cells[at].attr;
}

describe("theme from CSS tokens (AC7, D17)", () => {
  it("uses --term as background and --tink as foreground", () => {
    expect(theme.background?.toUpperCase()).toBe("#0F2133");
    expect(theme.foreground?.toUpperCase()).toBe("#D8E4ED");
  });

  it("uses the dark-mode --term as background in dark mode", () => {
    const dark = themeFromCss(css(DARK)) as unknown as Record<
      string,
      string | undefined
    >;
    expect(dark.background?.toUpperCase()).toBe("#08131D");
  });
});

describe("style runs to ANSI (AC7, D17)", () => {
  // [style, token, bold] — bold follows today's CSS font-weight: 700.
  const cases: [Style, string, boolean][] = [
    ["pu", "--tprompt", true],
    ["pp", "--tpath", true],
    ["dir", "--tpath", true],
    ["exe", "--texe", true],
    ["ok", "--tok", true],
    ["err", "--terr", false],
    ["dim", "--tdim", false],
  ];
  for (const [style, token, bold] of cases) {
    it(`"${style}" uses ${token}${bold ? " in bold" : ""}`, () => {
      const a = attrOf(
        [
          {
            runs: [
              { text: "before " },
              { text: "X", style },
              { text: " after" },
            ],
          },
        ],
        "X",
      );
      expect(color(a.fg)).toBe(LIGHT[token]);
      expect(a.bold).toBe(bold);
    });
  }

  it("plain text uses the foreground color (--tink), not bold", () => {
    const a = attrOf([{ runs: [{ text: "plain" }] }], "plain");
    expect(color(a.fg)).toBe(LIGHT["--tink"]);
    expect(a.bold).toBe(false);
  });

  it("styles end with their run: the next plain run is back to normal", () => {
    const a = attrOf(
      [{ runs: [{ text: "A", style: "ok" }, { text: "B" }] }],
      "B",
    );
    expect(color(a.fg)).toBe(LIGHT["--tink"]);
    expect(a.bold).toBe(false);
    expect(a.bg).toBe("background");
  });

  it("the grep match highlight (hl) is a background color with --tprompt text", () => {
    const a = attrOf(
      [
        {
          runs: [
            { text: "x " },
            { text: "ERROR", style: "hl" },
            { text: " y" },
          ],
        },
      ],
      "ERROR",
    );
    expect(color(a.fg)).toBe(LIGHT["--tprompt"]);
    expect(a.bg).not.toBe("background");
    expect(color(a.bg)).toMatch(/^#[0-9A-F]{6}$/);
    expect(color(a.bg)).not.toBe(LIGHT["--tprompt"]);
    expect(color(a.bg)).not.toBe(LIGHT["--term"]);
    const after = attrOf(
      [
        {
          runs: [
            { text: "x " },
            { text: "ERROR", style: "hl" },
            { text: " y" },
          ],
        },
      ],
      " y",
    );
    expect(after.bg).toBe("background");
  });

  it("a line style colors the runs that have no style of their own", () => {
    const a = attrOf([{ style: "err", runs: [{ text: "boom" }] }], "boom");
    expect(color(a.fg)).toBe(LIGHT["--terr"]);
  });

  it("a run style wins over the line style", () => {
    const a = attrOf(
      [{ style: "dim", runs: [{ text: "a " }, { text: "P", style: "pu" }] }],
      "P",
    );
    expect(color(a.fg)).toBe(LIGHT["--tprompt"]);
  });
});

describe("system message blocks (D17)", () => {
  const block = (kind: "sys" | "big" | "alert"): OutLine => ({
    block: kind,
    runs: [
      { text: "✓ Done", style: "ok" },
      { text: "  " },
      { text: "+10 XP", style: "dim" },
      { text: "\nafter text", style: "dim" },
    ],
  });

  it("puts a │ gutter at the start of each line of the block", () => {
    expect(stripSgr(renderLines([block("sys")]))).toBe(
      "│ ✓ Done  +10 XP\r\n│ after text\r\n",
    );
  });

  for (const [kind, token] of [
    ["sys", "--tok"],
    ["big", "--tprompt"],
    ["alert", "--terr"],
  ] as const) {
    it(`colors the gutter of a "${kind}" block with ${token}, on every line`, () => {
      const cells = paint(renderLines([block(kind)]));
      const gutters = cells.filter((c) => c.ch === "│");
      expect(gutters).toHaveLength(2);
      for (const g of gutters) expect(color(g.attr.fg)).toBe(LIGHT[token]);
    });
  }

  it("keeps the run style after the gutter on the second line", () => {
    const a = attrOf([block("sys")], "after text");
    expect(color(a.fg)).toBe(LIGHT["--tdim"]);
  });
});

describe("line breaks and text safety", () => {
  it("ends every line with CR LF and never writes a bare LF", () => {
    const out = renderLines([
      { runs: [{ text: "a\nb" }] },
      { runs: [] },
      { runs: [{ text: "c" }] },
    ]);
    expect(stripSgr(out)).toBe("a\r\nb\r\n\r\nc\r\n");
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it("does not pass escape sequences from the text through to the terminal", () => {
    const out = renderLines([
      { runs: [{ text: "evil\x1b[2Jtext\x1b]0;title\x07" }] },
    ]);
    expect(out).not.toContain("\x1b[2J");
    expect(out).not.toContain("\x1b]0;");
    expect(stripSgr(out)).not.toContain("\x1b");
    expect(stripSgr(out)).toContain("evil");
  });
});

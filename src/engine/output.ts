// Engine output as styled text runs (D9). The engine has no DOM: it builds
// the same small HTML strings as index.html at 5e96ce5, and `htmlToRuns`
// reads them back into runs. Only the fixed span classes the engine emits
// are known. The terminal renderer turns runs into ANSI codes.

/** A text style. The names are the CSS classes of the old page. */
export type Style = "pu" | "pp" | "dir" | "exe" | "ok" | "err" | "dim" | "hl";

/** A system message block: "sys" (task done), "big" (news), "alert" (pager). */
export type Block = "sys" | "big" | "alert";

export interface Run {
  text: string;
  style?: Style;
}

export interface OutLine {
  runs: Run[];
  /** The style of runs that have none of their own. */
  style?: Style;
  block?: Block;
}

const STYLES: readonly string[] = [
  "pu",
  "pp",
  "dir",
  "exe",
  "ok",
  "err",
  "dim",
  "hl",
];
const BLOCKS: Record<string, Block> = {
  sys: "sys",
  big: "big",
  alert: "alert",
};

const isStyle = (s: string): s is Style => STYLES.includes(s);

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/**
 * Reads engine HTML (escaped text and `<span class="...">` without nesting)
 * into runs. The joined run text equals the `textContent` the old page showed.
 */
export function htmlToRuns(html: string): Run[] {
  const runs: Run[] = [];
  const re = /<span class="([^"]*)">([^<]*)<\/span>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => {
    if (s) runs.push({ text: decode(s.replace(/<[^>]*>/g, "")) });
  };
  while ((m = re.exec(html)) !== null) {
    plain(html.slice(last, m.index));
    const text = decode(m[2]);
    if (text) {
      const cls = m[1].split(/\s+/).find(isStyle);
      runs.push(cls ? { text, style: cls } : { text });
    }
    last = m.index + m[0].length;
  }
  plain(html.slice(last));
  return runs;
}

/** Applies a line class list of the old page ("err", "sys big", ...) to a line. */
function withClass(runs: Run[], cls?: string): OutLine {
  const line: OutLine = { runs };
  for (const c of (cls || "").split(/\s+/)) {
    if (c === "sys") line.block = line.block || "sys";
    else if (c in BLOCKS) line.block = BLOCKS[c];
    else if (isStyle(c)) line.style = c;
  }
  return line;
}

/** The old `line(html, cls)`: one output line from engine HTML. */
export const htmlLine = (html: string, cls?: string): OutLine =>
  withClass(htmlToRuns(html), cls);

/** The old `print(text, cls)`: plain text, one trailing line break removed. */
export const textLine = (text: string, cls?: string): OutLine =>
  withClass([{ text: text.replace(/\n$/, "") }], cls);

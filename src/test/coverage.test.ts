// D9 (2): every run-1 command name and every `docker` subcommand is used by
// at least one golden script. The names come from a frozen list written from
// the run-1 page, so the guard survives the deletion of src/legacy/.
import { describe, expect, it } from "vitest";
import frozen from "./fixtures/run1-commands.json";
import { lineOf, SCRIPTS } from "./scripts";

/** Every command line in the scripts, split on |, ||, &&, and ; into word lists. */
function segments(): string[][] {
  const out: string[][] = [];
  for (const s of SCRIPTS) {
    for (const step of s.steps) {
      const line = lineOf(step);
      if (line === undefined) continue;
      for (const seg of line.split(/\|\||\||&&|;/)) {
        const words = seg.trim().split(/\s+/).filter(Boolean);
        if (words.length) out.push(words);
      }
    }
  }
  return out;
}

describe("golden script coverage (D9 (2))", () => {
  const segs = segments();

  it("keeps the frozen list of run-1 command names", () => {
    expect(frozen.commands.length).toBeGreaterThan(40);
  });

  it("uses every run-1 command name at least once", () => {
    const used = new Set(segs.map((w) => w[0]));
    expect(frozen.commands.filter((n) => !used.has(n))).toEqual([]);
  });

  it("uses every docker subcommand", () => {
    const docker = segs.filter((w) => w[0] === "docker");
    expect(
      frozen.dockerSubcommands.filter(
        (sub) => !docker.some((w) => w[1] === sub),
      ),
    ).toEqual([]);
    expect(
      frozen.dockerGroupSubcommands.filter((pair) => {
        const [group, sub] = pair.split(" ");
        return !docker.some((w) => w[1] === group && w[2] === sub);
      }),
    ).toEqual([]);
  });

  it("uses every docker compose subcommand, and docker-compose", () => {
    const compose = segs.filter((w) => w[0] === "docker" && w[1] === "compose");
    expect(
      frozen.composeSubcommands.filter(
        (sub) => !compose.some((w) => w[2] === sub),
      ),
    ).toEqual([]);
    expect(segs.some((w) => w[0] === "docker-compose")).toBe(true);
  });

  it("uses pipes, redirects, &&, ;, globs, quotes, variables, and error paths", () => {
    const lines = SCRIPTS.flatMap((s) =>
      s.steps.map(lineOf).filter((x): x is string => x !== undefined),
    );
    expect(lines.some((l) => / \| /.test(l))).toBe(true);
    expect(lines.some((l) => / > /.test(l))).toBe(true);
    expect(lines.some((l) => / >> /.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("&&"))).toBe(true);
    expect(lines.some((l) => l.includes(";"))).toBe(true);
    expect(lines.some((l) => /(^|\s)[^'"\s]*[*?]/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('"'))).toBe(true);
    expect(lines.some((l) => l.includes("'"))).toBe(true);
    expect(lines.some((l) => /\$[A-Za-z{?]/.test(l))).toBe(true);
    expect(lines.some((l) => /^[A-Za-z_]\w*=/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes("nosuch"))).toBe(true);
  });

  it("has unique script names", () => {
    const names = SCRIPTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

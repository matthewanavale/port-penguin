// AC3 and AC4 against the legacy fixture (D15): the walkthrough passes on the
// old index.html, the golden scripts cover what AC3 lists, two recordings in
// a row are equal, and the committed golden files match a fresh recording.
//
// Record the golden files again with: npm run golden:record
import { afterEach, describe, expect, it } from "vitest";
import { openLegacy, recordGolden } from "./legacyHarness";
import type { LegacyGame } from "./legacyHarness";
import {
  COMPOSE_SUBCOMMANDS,
  DOCKER_GROUP_SUBCOMMANDS,
  DOCKER_SUBCOMMANDS,
  SCRIPTS,
} from "./scripts";
import { SOLUTIONS } from "./solutions";

let open: LegacyGame[] = [];
afterEach(() => {
  for (const g of open) g.close();
  open = [];
});
const legacy = (...args: Parameters<typeof openLegacy>) => {
  const g = openLegacy(...args);
  open.push(g);
  return g;
};

/** Every command line in the scripts, split on |, &&, and ; into word lists. */
function segments(): string[][] {
  const out: string[][] = [];
  for (const s of SCRIPTS) {
    for (const step of s.steps) {
      if (typeof step !== "string") continue;
      for (const seg of step.split(/\|\||\||&&|;/)) {
        const words = seg.trim().split(/\s+/).filter(Boolean);
        if (words.length) out.push(words);
      }
    }
  }
  return out;
}
const commandLines = () =>
  SCRIPTS.flatMap((s) =>
    s.steps.filter((x): x is string => typeof x === "string"),
  );

describe("legacy harness", () => {
  it("loads the fixture and exposes window.__pp", () => {
    const g = legacy();
    expect(typeof g.pp().sha256).toBe("function");
    expect(g.pp().M).toHaveLength(70);
    expect(g.state().cur).toBe(0);
    expect(g.saved()).not.toBeNull();
  });

  it("runs a command and returns text, code, cwd, and task index", () => {
    const g = legacy();
    const r = g.run("pwd");
    expect(r.text.split("\n")[0]).toBe("/home/cadet");
    expect(r.code).toBe(0);
    expect(r.cwd).toBe("/home/cadet");
    expect(r.cur).toBe(1);
    expect(g.run("nosuch").code).toBe(127);
  });

  it("is deterministic: the fake clock and the seeded random give the same state twice", () => {
    const a = legacy();
    const b = legacy();
    a.run("docker run -d --name web nginx");
    b.run("docker run -d --name web nginx");
    expect(a.saved()).toBe(b.saved());
  });
});

describe("golden script coverage (AC3)", () => {
  const segs = segments();

  it("uses every command name in CMDS at least once", () => {
    // Tab on an empty line lists every key of CMDS, read from the fixture itself.
    const listing = legacy().tab("").listing;
    expect(listing).not.toBeNull();
    const names = (listing as string).split(/\s+/).filter(Boolean);
    expect(names.length).toBeGreaterThan(40);
    const used = new Set(segs.map((w) => w[0]));
    expect(names.filter((n) => !used.has(n))).toEqual([]);
  });

  it("uses every docker subcommand", () => {
    const docker = segs.filter((w) => w[0] === "docker");
    const missing = DOCKER_SUBCOMMANDS.filter(
      (sub) => !docker.some((w) => w[1] === sub),
    );
    expect(missing).toEqual([]);
    const missingGroup = DOCKER_GROUP_SUBCOMMANDS.filter((pair) => {
      const [group, sub] = pair.split(" ");
      return !docker.some((w) => w[1] === group && w[2] === sub);
    });
    expect(missingGroup).toEqual([]);
  });

  it("uses every docker compose subcommand, and docker-compose", () => {
    const compose = segs.filter((w) => w[0] === "docker" && w[1] === "compose");
    const missing = COMPOSE_SUBCOMMANDS.filter(
      (sub) => !compose.some((w) => w[2] === sub),
    );
    expect(missing).toEqual([]);
    expect(segs.some((w) => w[0] === "docker-compose")).toBe(true);
  });

  it("uses pipes, redirects, &&, ;, globs, quotes, variables, and error paths", () => {
    const lines = commandLines();
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

describe("walkthrough on the legacy fixture (AC4)", () => {
  it("has one solution per task, in task order", () => {
    const M = legacy().pp().M;
    expect(SOLUTIONS).toHaveLength(M.length);
    expect(SOLUTIONS.map((s) => s.title)).toEqual(M.map((m) => m.title));
    expect(SOLUTIONS.map((s) => s.task)).toEqual(M.map((_, i) => i + 1));
  });

  it("completes all 70 tasks in order and reaches the last rank", () => {
    const g = legacy();
    for (const sol of SOLUTIONS) {
      for (const cmd of sol.commands) g.run(cmd);
      expect(g.state().done, `task ${sol.task}: ${sol.title}`).toContain(
        sol.task - 1,
      );
    }
    const s = g.state();
    expect(s.done).toHaveLength(70);
    expect(s.cur).toBe(70);
    expect(g.textOf("rankName")).toBe("Harbor master");
    expect(g.textOf("xp")).toBe("700 XP, 70 of 70 tasks");
  });
});

describe("golden transcripts from the legacy fixture (AC3)", () => {
  for (const script of SCRIPTS) {
    it(`records "${script.name}" the same twice, and matches its golden file`, async () => {
      const first = recordGolden(script);
      const second = recordGolden(script);
      expect(second).toEqual(first);
      await expect(JSON.stringify(first, null, 2) + "\n").toMatchFileSnapshot(
        `./golden/${script.name}.json`,
      );
    });
  }
});

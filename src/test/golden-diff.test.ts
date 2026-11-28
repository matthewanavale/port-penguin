// D9 (4)-(6), AC9: the goldens against their run-1 copies. A re-recorded step
// may differ from run 1 only with a `reason` that starts with a code R1 to R7.
// Steps are matched by index; added steps go at the end. The final save is
// compared on a fixed set of fields; a difference needs a reason on the last
// step of the golden. The run-1 copies in src/test/golden-run1/ are never edited.
import { describe, expect, it } from "vitest";
import { REASON_CODES } from "./golden";
import type { Golden, GoldenStep } from "./golden";
import { SCRIPTS } from "./scripts";

const now = import.meta.glob<Golden>("./golden/*.json", {
  eager: true,
  import: "default",
});
const old = import.meta.glob<Golden>("./golden-run1/*.json", {
  eager: true,
  import: "default",
});
const byName = (files: Record<string, Golden>) =>
  new Map(Object.values(files).map((g) => [g.script, g]));
const current = byName(now);
const run1 = byName(old);

const hasReason = (s: GoldenStep): boolean =>
  typeof s.reason === "string" &&
  REASON_CODES.some((code) =>
    new RegExp(`^${code}\\b`).test(s.reason as string),
  );

/** The fields of a step that a reason must explain (D9 (6)). */
function observable(s: GoldenStep): unknown {
  if ("input" in s)
    return {
      input: s.input,
      text: s.text,
      cleared: s.cleared,
      code: s.code,
      cwd: s.cwd,
      cur: s.cur,
    };
  if ("tab" in s)
    return {
      tab: s.tab,
      listing: s.listing,
      value: s.value,
      newCursor: s.newCursor,
    };
  return { advanceMs: s.advanceMs };
}

interface SaveShape {
  done: number[];
  cur: number;
  unlocked: boolean;
  cwd: string;
  hist: string[];
  dk: {
    images: { repo: string; tag: string }[];
    containers: { name: string; status: string }[];
  };
  fs: unknown;
}

/** Files under /home/cadet, except .bashrc, with their content and mode; mtime is ignored. */
function homeFiles(fs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (n: unknown, path: string) => {
    const node = n as {
      t: string;
      c?: Record<string, unknown>;
      x?: string;
      m?: string;
    };
    if (node.t === "d")
      for (const [name, child] of Object.entries(node.c ?? {}))
        walk(child, `${path}/${name}`);
    else out[path] = `${node.m}|${node.x}`;
  };
  const home = (fs as { c: Record<string, { c: Record<string, unknown> }> }).c
    .home.c.cadet;
  walk(home, "/home/cadet");
  delete out["/home/cadet/.bashrc"];
  return out;
}

function saveFields(raw: string | null) {
  const s = JSON.parse(raw as string) as SaveShape;
  return {
    done: s.done,
    cur: s.cur,
    unlocked: s.unlocked,
    cwd: s.cwd,
    hist: s.hist,
    containers: s.dk.containers.map((c) => `${c.name}:${c.status}`),
    images: s.dk.images.map((i) => `${i.repo}:${i.tag}`),
    files: homeFiles(s.fs),
  };
}

describe("golden files against run 1 (AC9)", () => {
  it("has a golden file and a run-1 copy for every script", () => {
    for (const s of SCRIPTS) {
      expect(current.has(s.name), `golden ${s.name}`).toBe(true);
      expect(run1.has(s.name), `golden-run1 ${s.name}`).toBe(true);
    }
  });

  for (const script of SCRIPTS) {
    describe(script.name, () => {
      const g = current.get(script.name);
      const o = run1.get(script.name);
      if (!g || !o) {
        it("is missing a file", () => expect(g && o).toBeTruthy());
        return;
      }

      it("explains every changed step with a reason code", () => {
        const unexplained: string[] = [];
        g.steps.forEach((step, i) => {
          const before = o.steps[i];
          if (!before) return; // an added step at the end
          if (
            JSON.stringify(observable(step)) !==
              JSON.stringify(observable(before)) &&
            !hasReason(step)
          )
            unexplained.push(
              `step ${i}: ${JSON.stringify(observable(step)).slice(0, 80)}`,
            );
        });
        expect(unexplained).toEqual([]);
      });

      it("keeps R3 steps at the index of the step they replace", () => {
        g.steps.forEach((step, i) => {
          if (step.replaces === undefined) return;
          expect(step.replaces, `step ${i}`).toBe(i);
          expect(step.reason, `step ${i}`).toMatch(/^R3\b/);
          expect(o.steps[i], `step ${i} has a run-1 step`).toBeDefined();
        });
      });

      it("only adds steps at the end, and only removes none", () => {
        expect(g.steps.length).toBeGreaterThanOrEqual(o.steps.length);
      });

      it("uses only the known reason codes", () => {
        for (const step of g.steps)
          if (step.reason !== undefined)
            expect(hasReason(step), step.reason).toBe(true);
      });

      it("explains a changed final save with a reason on the last step", () => {
        const a = saveFields(g.save);
        const b = saveFields(o.save);
        if (JSON.stringify(a) !== JSON.stringify(b))
          expect(
            hasReason(g.steps[g.steps.length - 1]),
            "last step needs a reason",
          ).toBe(true);
      });

      it("carries the reason and replaces of the script step into the golden", () => {
        const scriptSteps = script.steps;
        scriptSteps.forEach((st, i) => {
          if (typeof st === "object" && "input" in st) {
            const rec = g.steps[i] as { reason?: string; replaces?: number };
            expect(rec.reason).toBe(st.reason);
            expect(rec.replaces).toBe(st.replaces);
          }
        });
      });
    });
  }
});

describe("the run-1 copies (D9 (4))", () => {
  it("hold the same scripts as the goldens, with no reason fields", () => {
    for (const g of run1.values())
      for (const step of g.steps) expect(step.reason).toBeUndefined();
    expect([...run1.keys()].sort()).toEqual(SCRIPTS.map((s) => s.name).sort());
  });
});

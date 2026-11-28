// AC8, D11: rollback proof. A save from this build passes the run-1 load()
// check and keeps every run-1 field with the same type, so a rollback to
// a6fa9d3 keeps progress. New state lives in new optional fields only.
import { afterEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import type { Golden } from "./golden";
import { SOLUTIONS } from "./solutions";

afterEach(restore);

/** The run-1 `load()` validation (src/engine/state.ts at a6fa9d3), copied as a fixed function. */
function run1Load(raw: string | null): Record<string, unknown> | null {
  try {
    if (raw) {
      const o = JSON.parse(raw) as Record<string, unknown> | null;
      if (o && o.fs && o.dk && o.procs && Array.isArray(o.done)) return o;
    }
  } catch {
    // A broken save starts a fresh game.
  }
  return null;
}

const kind = (v: unknown): string =>
  Array.isArray(v) ? "array" : v === null ? "null" : typeof v;

/** The fields run 1 saved, in a save of a6fa9d3. */
const RUN1_FIELDS = [
  "fs",
  "cwd",
  "oldpwd",
  "env",
  "procs",
  "lastCode",
  "dk",
  "done",
  "cur",
  "hist",
  "setup",
  "unlocked",
];

const goldens = import.meta.glob<Golden>("./golden/*.json", {
  eager: true,
  import: "default",
});
const run1 = import.meta.glob<Golden>("./golden-run1/*.json", {
  eager: true,
  import: "default",
});

describe("every golden script (AC8)", () => {
  for (const [path, g] of Object.entries(goldens)) {
    it(`${g.script}: the saved JSON passes the run-1 load() and keeps every run-1 field`, () => {
      const mine = run1Load(g.save) as Record<string, unknown> | null;
      expect(mine, path).not.toBeNull();
      const before = run1[path.replace("./golden/", "./golden-run1/")];
      const old = JSON.parse(before.save as string) as Record<string, unknown>;
      for (const key of Object.keys(old))
        expect(
          kind((mine as Record<string, unknown>)[key]),
          `${g.script}.${key}`,
        ).toBe(kind(old[key]));
      for (const key of RUN1_FIELDS) expect(mine, key).toHaveProperty(key);
    });
  }

  it("covers every golden script", () => {
    expect(Object.keys(goldens).sort()).toEqual(
      Object.keys(run1)
        .map((p) => p.replace("golden-run1", "golden"))
        .sort(),
    );
  });
});

describe("new optional fields (D11, AC8)", () => {
  it("an engine that uses them still saves a file the run-1 load() accepts", async () => {
    const sh = await openShell();
    await sh.run("mkdir -p /tmp/w && cd /tmp/w");
    await sh.run("export E1=1; a=(1 2 3); declare -A m=([k]=v); readonly R=1");
    await sh.run(
      "f() { echo fn; }; alias zz='echo zz'; shopt -s extglob; set -o pipefail",
    );
    await sh.run("printf '* * * * * echo hi\\n' > c; crontab c; echo x > g");
    const loaded = run1Load(sh.store.get(SAVE_KEY) as string);
    expect(loaded).not.toBeNull();
    const save = loaded as Record<string, unknown>;
    for (const key of [
      "exported",
      "vars",
      "functions",
      "aliases",
      "options",
      "crontab",
    ])
      expect(save, key).toHaveProperty(key);
    for (const key of RUN1_FIELDS) expect(save, key).toHaveProperty(key);
    for (const v of Object.values(save.env as Record<string, unknown>))
      expect(typeof v).toBe("string");
  });

  it("keeps env as plain strings, so a run-1 build can read it", async () => {
    const sh = await openShell();
    await sh.run("s=text; a=(1 2); export e=1");
    const env = (
      JSON.parse(sh.store.get(SAVE_KEY) as string) as {
        env: Record<string, unknown>;
      }
    ).env;
    expect(env.s).toBe("text");
    expect(env.e).toBe("1");
    expect(typeof env.a === "undefined" || typeof env.a === "string").toBe(
      true,
    );
  });

  it("accepts a hand-made save with all new fields and keeps playing", async () => {
    const sh = await openShell();
    const base = JSON.parse(sh.store.get(SAVE_KEY) as string) as Record<
      string,
      unknown
    >;
    const fs = base.fs as { c: Record<string, { c: Record<string, unknown> }> };
    const home = fs.c.home.c as Record<string, { c: Record<string, unknown> }>;
    home.cadet.c["stamped.txt"] = {
      t: "f",
      x: "x",
      m: "rw-r--r--",
      mtime: 1705314600000,
    };
    const withNew = {
      ...base,
      exported: ["E1"],
      vars: {
        arr: { type: "array", value: ["1", "2"] },
        assoc: { type: "assoc", value: { k: "v" } },
      },
      functions: { f: "echo fn" },
      aliases: { zz: "echo zz" },
      options: { pipefail: true },
      crontab: "* * * * * echo hi\n",
    };
    expect(run1Load(JSON.stringify(withNew))).not.toBeNull();
    const again = await openShell({ saved: JSON.stringify(withNew) });
    expect((await again.run("echo ok")).out).toBe("ok\n");
    expect((await again.run("stat -c %Y stamped.txt")).out).toBe(
      "1705314600\n",
    );
  });
});

describe("save compatibility with the last task", () => {
  it("plays the whole walkthrough and still passes the run-1 load()", async () => {
    const sh = await openShell();
    for (const sol of SOLUTIONS)
      for (const cmd of sol.commands) await sh.run(cmd);
    expect(run1Load(sh.store.get(SAVE_KEY) ?? null)).not.toBeNull();
  });
});

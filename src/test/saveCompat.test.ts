// AC7, D9 (1), D11: a state saved by run 1 under port-penguin-v2 loads into the
// engine. The game continues at the same task, with the same files,
// containers, history, and hint unlock state. The run-1 saves are fixtures in
// src/test/fixtures/run1-saves/, written once from the run-1 page.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from "vitest";
import { SAVE_KEY } from "../engine/index";
import { openShell, restore } from "./engineHarness";
import { SOLUTIONS } from "./solutions";

afterEach(restore);

const raw = import.meta.glob<string>("./fixtures/run1-saves/*", {
  eager: true,
  query: "?raw",
  import: "default",
});
const fixture = (name: string): string => {
  const text = raw[`./fixtures/run1-saves/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
};
const saveNames = Object.keys(raw)
  .map((p) => p.replace("./fixtures/run1-saves/", ""))
  .filter((n) => n.endsWith(".json"));

type Node = {
  t: string;
  c?: Record<string, Node>;
  x?: string;
  m?: string;
  mtime?: number;
};

/** The run-1 view of a file system: no `mtime`, and no ~/.bashrc, which runs at start (D13). */
function run1View(fs: Node, isRoot = true): Node {
  const copy: Node = { ...fs };
  delete copy.mtime;
  if (fs.c) {
    copy.c = {};
    for (const [name, child] of Object.entries(fs.c))
      copy.c[name] = run1View(child, false);
  }
  if (isRoot) {
    const home = (copy.c as Record<string, Node>).home.c as Record<
      string,
      Node
    >;
    delete (home.cadet.c as Record<string, Node>)[".bashrc"];
  }
  return copy;
}

describe("loading a run-1 save (AC7)", () => {
  it("has the fixtures D9 (1) lists", () => {
    for (const n of [
      "walkthrough-end.json",
      "task20-unlocked.json",
      "task35.json",
      "task58.json",
      "hint-task20.txt",
    ])
      expect(raw[`./fixtures/run1-saves/${n}`], n).toBeDefined();
    expect(saveNames.length).toBeGreaterThanOrEqual(5 + 20);
  });

  for (const name of saveNames) {
    it(`${name}: continues at the same task with the same state`, () => {
      const old = JSON.parse(fixture(name)) as Record<string, any>;
      const sh = openShell({ saved: fixture(name) });
      expect(sh.engine.resumed).toBe(true);
      const s = sh.engine.state as unknown as Record<string, any>;
      expect(s.cur).toBe(old.cur);
      expect(s.done).toEqual(old.done);
      expect(s.cwd).toBe(old.cwd);
      expect(s.dk).toEqual(old.dk);
      expect(s.procs).toEqual(old.procs);
      expect(s.hist).toEqual(old.hist);
      expect(s.unlocked).toBe(old.unlocked);
      expect(run1View(s.fs)).toEqual(run1View(old.fs));
      for (const [k, v] of Object.entries(old.env as Record<string, string>))
        expect(s.env[k], `env ${k}`).toBe(v);
    });
  }

  it("the first save ignores ~/.bashrc and mtime, and writes every run-1 field back", () => {
    const old = JSON.parse(fixture("task58.json")) as Record<string, any>;
    const sh = openShell({ saved: fixture("task58.json") });
    const mine = JSON.parse(sh.store.get(SAVE_KEY) as string) as Record<
      string,
      any
    >;
    for (const key of Object.keys(old)) {
      if (key === "fs") expect(run1View(mine.fs)).toEqual(run1View(old.fs));
      else if (key !== "hist") expect(mine[key], key).toEqual(old[key]);
    }
  });

  it("plays the next task from the loaded state", () => {
    const sh = openShell({ saved: fixture("task58.json") });
    for (const cmd of SOLUTIONS[58].commands) sh.run(cmd);
    expect(sh.engine.state.done).toContain(58);
    expect(sh.engine.state.cur).toBe(59);
  });

  it("gives the run-1 hint text after loading an unlocked save", () => {
    const sh = openShell({ saved: fixture("task20-unlocked.json") });
    const hint = fixture("hint-task20.txt").trimEnd();
    expect(hint.startsWith("Hint: ")).toBe(true);
    expect(sh.run("hint").text).toBe(hint);
  });

  it("runs the setup of the current task when the save has not run it yet", () => {
    const original = JSON.parse(fixture("task35.json")) as Record<string, any>;
    const old = JSON.parse(fixture("task35.json")) as Record<string, any>;
    expect(old.cur).toBe(35);
    delete old.setup["35"];
    old.procs = (old.procs as { cmd: string }[]).filter(
      (p) => !p.cmd.startsWith("fog-horn"),
    );
    const sh = openShell({ saved: JSON.stringify(old) });
    expect(sh.startText).toContain("fog-horn");
    expect(sh.engine.state.procs).toEqual(original.procs);
    expect(sh.engine.state.setup).toEqual(original.setup);
  });

  for (const [label, text] of [
    ["not JSON", "{oops"],
    ["missing dk", '{"fs":{},"procs":[],"done":[]}'],
    ["done is not a list", '{"fs":{},"dk":{},"procs":[],"done":1}'],
  ] as const) {
    it(`starts a fresh game when the save is ${label}`, () => {
      const sh = openShell({ saved: text });
      expect(sh.engine.resumed).toBe(false);
      expect(sh.engine.state.cur).toBe(0);
      expect(sh.engine.state.done).toEqual([]);
      expect(sh.engine.state.cwd).toBe("/home/cadet");
    });
  }
});

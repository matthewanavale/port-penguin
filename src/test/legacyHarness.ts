// D15: runs the byte-for-byte copy of the old index.html (commit 5e96ce5)
// in its own JSDOM window. This is the reference engine for the golden
// transcripts, the walkthrough, and the save tests.
import { JSDOM, VirtualConsole } from "jsdom";
import legacyHtml from "../legacy/index.legacy.html?raw";
import { makeFakeDate, seededRandom, SEED, START_MS } from "./determinism";
import type { FakeClock } from "./determinism";
import type { GoldenScript } from "./scripts";

export const SAVE_KEY = "port-penguin-v2";

/** What one command line gives back. */
export interface LegacyStep {
  /** Plain text of the new terminal lines, without the echoed command. */
  text: string;
  /** True when the command cleared the screen. `text` is then only what came after. */
  cleared: boolean;
  /** `S.lastCode` after the line. */
  code: number;
  /** `S.cwd` after the line. */
  cwd: string;
  /** `S.cur` (the task index) after the line. */
  cur: number;
}

/** What one Tab press gives back. */
export interface LegacyTab {
  value: string;
  cursor: number;
  /** The candidate list the terminal printed, or null when it printed none. */
  listing: string | null;
}

export interface LegacyGame {
  run(line: string): LegacyStep;
  tab(value: string, cursor?: number): LegacyTab;
  /** A deep copy of the live state `S`. */
  state(): LegacyState;
  /** The raw JSON string saved under `port-penguin-v2`, or null. */
  saved(): string | null;
  /** `window.__pp` as the page exposes it. */
  pp(): LegacyPP;
  /** Text of an element by id, for the header and the panel. */
  textOf(id: string): string;
  readonly clock: FakeClock;
  close(): void;
}

export interface LegacyState {
  cwd: string;
  cur: number;
  done: number[];
  hist: string[];
  lastCode: number;
  unlocked: boolean;
  fs: unknown;
  dk: {
    images: unknown[];
    containers: unknown[];
    volumes: unknown[];
    networks: unknown[];
  };
  [key: string]: unknown;
}

export interface LegacyPP {
  sha256(s: string): string;
  state(): LegacyState;
  M: { title: string; ch: number }[];
}

export interface OpenOptions {
  seed?: number;
  startMs?: number;
  /** A JSON string to put under `port-penguin-v2` before the page loads. */
  saved?: string;
}

interface LegacyWindow {
  document: Document;
  __pp: LegacyPP;
  KeyboardEvent: typeof KeyboardEvent;
  close(): void;
}

function memoryStorage(store: Map<string, string>): Storage {
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
}

/** Loads the legacy page with a fresh fake clock and a reseeded `Math.random`. */
export function openLegacy(opts: OpenOptions = {}): LegacyGame {
  const clock = makeFakeDate(opts.startMs ?? START_MS);
  const random = seededRandom(opts.seed ?? SEED);
  const store = new Map<string, string>();
  if (opts.saved !== undefined) store.set(SAVE_KEY, opts.saved);

  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: unknown) => errors.push(e));

  const dom = new JSDOM(legacyHtml, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: false,
    virtualConsole,
    beforeParse(win: Record<string, unknown> & { Math: Math }) {
      win.Date = clock.Date;
      win.Math.random = random;
      win.matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      });
      win.requestAnimationFrame = (cb: (t: number) => void) => {
        cb(0);
        return 0;
      };
      win.cancelAnimationFrame = () => {};
      Object.defineProperty(win, "localStorage", {
        configurable: true,
        value: memoryStorage(store),
      });
    },
  });

  const win = dom.window as unknown as LegacyWindow;
  const doc = win.document;
  if (errors.length)
    throw new Error(`legacy page failed to load: ${String(errors[0])}`);
  if (!win.__pp) throw new Error("legacy page did not expose window.__pp");

  const out = doc.getElementById("out") as HTMLElement;
  const inp = doc.getElementById("cmd") as HTMLInputElement;
  const observer = new (
    dom.window as unknown as { MutationObserver: typeof MutationObserver }
  ).MutationObserver(() => {});
  observer.observe(out, { childList: true });

  const mark = () => {
    observer.takeRecords();
    for (const el of Array.from(out.children)) el.setAttribute("data-seen", "");
  };
  const collect = () => {
    const cleared = observer
      .takeRecords()
      .some((r) => r.removedNodes.length > 0);
    const fresh = Array.from(out.children).filter(
      (el) => !el.hasAttribute("data-seen"),
    );
    return { cleared, fresh };
  };
  const key = (k: string) =>
    inp.dispatchEvent(
      new win.KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
      }),
    );
  const check = () => {
    if (errors.length)
      throw new Error(`legacy page error: ${String(errors[0])}`);
  };

  return {
    clock,
    run(line: string): LegacyStep {
      mark();
      inp.value = line;
      key("Enter");
      check();
      const { cleared, fresh } = collect();
      let lines = fresh;
      if (!cleared) {
        if (!lines[0] || !lines[0].classList.contains("cmdl")) {
          throw new Error(
            `expected the echoed command line first, for: ${line}`,
          );
        }
        lines = lines.slice(1);
      }
      const s = win.__pp.state();
      return {
        text: lines.map((el) => el.textContent ?? "").join("\n"),
        cleared,
        code: s.lastCode,
        cwd: s.cwd,
        cur: s.cur,
      };
    },
    tab(value: string, cursor?: number): LegacyTab {
      mark();
      inp.value = value;
      const c = cursor ?? value.length;
      inp.setSelectionRange(c, c);
      key("Tab");
      check();
      const { fresh } = collect();
      const listed = fresh.filter((el) => !el.classList.contains("cmdl"));
      const res: LegacyTab = {
        value: inp.value,
        cursor: inp.selectionStart ?? inp.value.length,
        listing: listed.length
          ? listed.map((el) => el.textContent ?? "").join("\n")
          : null,
      };
      inp.value = "";
      return res;
    },
    state: () => JSON.parse(JSON.stringify(win.__pp.state())) as LegacyState,
    saved: () => store.get(SAVE_KEY) ?? null,
    pp: () => win.__pp,
    textOf: (id: string) => doc.getElementById(id)?.textContent ?? "",
    close() {
      observer.disconnect();
      win.close();
    },
  };
}

/** One recorded step of a golden file. */
export type GoldenStep =
  | ({ input: string } & LegacyStep)
  | { advanceMs: number }
  | {
      tab: string;
      cursor: number;
      value: string;
      newCursor: number;
      listing: string | null;
    };

/** The content of src/test/golden/<script>.json. */
export interface Golden {
  script: string;
  steps: GoldenStep[];
  /** The raw JSON string the legacy page saved under port-penguin-v2 after the last step (AC5b). */
  save: string | null;
}

/** Runs one golden script on a fresh legacy page and records every step. */
export function recordGolden(script: GoldenScript): Golden {
  const game = openLegacy();
  try {
    const steps: GoldenStep[] = [];
    for (const step of script.steps) {
      if (typeof step === "string") {
        steps.push({ input: step, ...game.run(step) });
      } else if ("advanceMs" in step) {
        game.clock.advance(step.advanceMs);
        steps.push({ advanceMs: step.advanceMs });
      } else {
        const cursor = step.cursor ?? step.tab.length;
        const r = game.tab(step.tab, cursor);
        steps.push({
          tab: step.tab,
          cursor,
          value: r.value,
          newCursor: r.cursor,
          listing: r.listing,
        });
      }
    }
    return { script: script.name, steps, save: game.saved() };
  } finally {
    game.close();
  }
}

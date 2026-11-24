// Page wiring: the engine, the terminal, the panel, the intro, the
// extra-keys bar, the debug handle window.__pp, and the service worker.
// Ported from index.html:1548-1590 at 5e96ce5.
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { createEngine, M, rankFor, sha256 } from "./engine/index";
import type { Mission, State } from "./engine/index";
import { htmlLine } from "./engine/output";
import type { OutLine } from "./engine/output";
import { bindExtraKeys, createTerminal } from "./term/terminal";
import { createPanel } from "./ui/panel";

declare global {
  interface Window {
    /** Debug handle, unchanged from the old page (run 5 decides its future). */
    __pp?: {
      sha256: (s: string) => string;
      state: () => State;
      M: Mission[];
    };
  }
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const engine = createEngine({
  storage: {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
  },
});

function intro(isNew: boolean): OutLine[] {
  if (isNew) {
    const where = window.matchMedia("(max-width:880px)").matches
      ? " above"
      : " on the right";
    return [
      htmlLine(
        `<span class="pu">Port Penguin harbor terminal</span>
<span class="dim">70 tasks across 8 chapters, from your first command to shipping a release.
Type a command and press Enter. Your first task is in the logbook${where}.
Type</span> help <span class="dim">to see every command, or</span> man <span class="dim">plus a command name to learn about it.</span>`,
        "sys big",
      ),
    ];
  }
  const S = engine.state;
  return [
    htmlLine(
      `<span class="pu">Welcome back, ${esc(rankFor(S.done.length).toLowerCase())}.</span>
<span class="dim">${S.cur < M.length ? "Picking up at task " + (S.cur + 1) + ": " + esc(M[S.cur].title) + "." : "You’ve reached the end of the logbook. The harbor is yours to explore."}</span>`,
      "sys big",
    ),
  ];
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

// Old order: intro, then the task setup (its alert), then save.
const first = intro(!engine.resumed);
first.push(...engine.start());

const panel = createPanel({
  engine,
  print: (lines) => terminal.print(lines),
  setLine: (text) => terminal.setLine(text),
  focusTerminal: () => terminal.focus(),
  resetAll,
});

const terminal = createTerminal({
  container: $("term"),
  engine,
  intro: first,
  onResult(res) {
    const tasks = res.events.filter((e) => e.type === "task");
    const last = tasks[tasks.length - 1];
    panel.render(last && last.type === "task" ? last.index : -1);
  },
});

function resetAll(): void {
  engine.reset();
  terminal.restart(intro(true));
  panel.render();
  terminal.focus();
}

panel.render();

$("clearBtn").onclick = () => {
  terminal.clear();
  terminal.focus();
};

bindExtraKeys($("keys"), terminal);

window.__pp = { sha256, state: () => engine.state, M };

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

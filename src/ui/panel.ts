// The side panel: task card, hints, skip, unlock, container yard, learned
// commands, lock, and reset. Plain DOM code with the same markup and
// behavior as index.html:1402, :1410-1446, :1561-1567 at 5e96ce5.
import { CH, M, rankFor } from "../engine/index";
import type { Engine } from "../engine/index";
import type { OutLine } from "../engine/output";

export interface PanelOptions {
  engine: Engine;
  /** Writes lines in the terminal. */
  print(lines: OutLine[]): void;
  /** Puts a hint command in the terminal line. */
  setLine(text: string): void;
  focusTerminal(): void;
  /** Starts a fresh game. */
  resetAll(): void | Promise<void>;
}

export interface Panel {
  /** Draws the panel. `land` is the task whose box lands with a bounce. */
  render(land?: number): void;
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Task text: `code` in backticks becomes <code>, or a chip that fills the terminal line. */
function md(s: string, click?: boolean): string {
  return esc(s).replace(/`([^`]+)`/g, (_, c: string) =>
    click
      ? `<button type="button" class="chip" data-ins="${c.replace(/"/g, "&quot;")}">${c}</button>`
      : `<code>${c}</code>`,
  );
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

export function createPanel(opts: PanelOptions): Panel {
  const { engine } = opts;

  function render(land = -1): void {
    const S = engine.state;
    const n = S.done.length;
    el("rankName").textContent = rankFor(n);
    el("xp").textContent = `${n * 10} XP, ${n} of ${M.length} tasks`;
    el("lockBtn").hidden = !S.unlocked;
    const mEl = el("mission");
    if (S.cur >= M.length) {
      mEl.style.setProperty("--cc", "var(--c8)");
      mEl.innerHTML = `<div class="meta"><b>${n === M.length ? "All tasks done" : "End of the logbook"}</b><span>${n} of ${M.length}</span></div><h2>${n === M.length ? "You’re the harbor master" : "You reached the end"}</h2><p>You navigated a Linux file system, searched and transformed text, managed permissions, processes and disks, then built, networked and shipped containers with Docker and Compose.</p><p>For the real thing, install Docker on your own computer and try these same commands. For more Linux practice, the free OverTheWire Bandit wargame is a great next step.</p><div class="actions"><button type="button" class="btn primary" id="again">Play again</button></div>`;
      el("again").onclick = opts.resetAll;
    } else {
      const m = M[S.cur];
      const ch = CH[m.ch];
      mEl.style.setProperty("--cc", `var(${ch.col})`);
      const actions = S.unlocked
        ? `<button type="button" class="btn primary" id="hintBtn">Show hint</button><button type="button" class="btn" id="skipBtn">Skip task</button>`
        : `<button type="button" class="btn" id="unlockBtn">Unlock hints</button>`;
      mEl.innerHTML =
        `<div class="meta"><b>${esc(ch.name)}</b><span>Task ${S.cur + 1} of ${M.length}</span></div><h2>${esc(m.title)}</h2><p>${md(m.text)}</p><div class="goal">${md(m.goal)}</div>` +
        (S.unlocked
          ? `<div class="hint" id="hintBox" hidden>${md(m.hint, true)}<br><small style="color:var(--muted)">Tap a command to put it in the terminal.</small></div>`
          : "") +
        `<form class="unlock" id="unlockForm" hidden><label for="pw">Instructor password</label><div class="pwrow"><input id="pw" type="password" autocomplete="off"><button type="submit" class="btn primary">Unlock</button></div><p id="pwMsg" role="alert"></p></form>` +
        `<div class="actions">${actions}</div>`;
      if (S.unlocked) {
        el("hintBtn").onclick = () => {
          const h = el("hintBox");
          h.hidden = !h.hidden;
          el("hintBtn").textContent = h.hidden ? "Show hint" : "Hide hint";
        };
        el("skipBtn").onclick = async () => {
          const lines = await engine.skip();
          render();
          opts.print(lines);
          opts.focusTerminal();
        };
      } else {
        el("unlockBtn").onclick = () => {
          const f = el("unlockForm");
          f.hidden = !f.hidden;
          if (!f.hidden) el("pw").focus();
        };
        el<HTMLFormElement>("unlockForm").onsubmit = async (e) => {
          e.preventDefault();
          const pw = el<HTMLInputElement>("pw");
          const lines = await engine.unlock(pw.value);
          if (lines) {
            render();
            opts.print(lines);
          } else {
            el("pwMsg").textContent = "That password isn’t right.";
            pw.select();
          }
        };
      }
    }
    const y = el("yard");
    y.innerHTML =
      "<h3>Container yard</h3>" +
      CH.map(
        (ch, ci) =>
          `<div class="row" style="--cc:var(${ch.col})"><span>${esc(ch.name)}</span><div class="boxes">${M.map(
            (m, i) => {
              if (m.ch !== ci) return "";
              const cls = `box${S.done.includes(i) ? " done" : ""}${i === S.cur ? " cur" : ""}${i === land ? " land" : ""}`;
              const lbl = `Task ${i + 1}: ${esc(m.title)}${S.done.includes(i) ? ", done" : ""}`;
              return S.unlocked
                ? `<button type="button" class="${cls}" data-go="${i}" title="${lbl}" aria-label="${lbl}"></button>`
                : `<span class="${cls}" title="${lbl}" role="img" aria-label="${lbl}"></span>`;
            },
          ).join("")}</div></div>`,
      ).join("") +
      `<small>Each finished task lands a container.${S.unlocked ? " Click any box to jump to that task." : ""}</small>`;
    const learned = S.done
      .slice()
      .sort((a, b) => a - b)
      .map((i) => M[i].learn);
    const L = el<HTMLDetailsElement>("learned");
    const open = L.open;
    L.innerHTML =
      `<summary>Commands you’ve learned (${learned.length})</summary>` +
      (learned.length
        ? `<dl>${learned.map((l) => `<dt><code>${esc(l[0])}</code></dt><dd>${esc(l[1])}</dd>`).join("")}</dl>`
        : '<p style="margin:10px 0 0;color:var(--muted);font-size:14.5px">Finish a task and its command shows up here as a cheat sheet.</p>');
    L.open = open;
  }

  const panelEl = document.querySelector<HTMLElement>(".panel");
  panelEl?.addEventListener("click", async (e) => {
    const target = e.target as Element | null;
    const chip = target?.closest<HTMLElement>("[data-ins]");
    if (chip) {
      opts.setLine(chip.dataset.ins ?? "");
      opts.focusTerminal();
      return;
    }
    const box = target?.closest<HTMLElement>("[data-go]");
    if (box && engine.state.unlocked) {
      const lines = await engine.jump(+(box.dataset.go ?? 0));
      render();
      opts.print(lines);
    }
  });

  el("lockBtn").onclick = async () => {
    const lines = await engine.lock();
    render();
    opts.print(lines);
  };

  let resetArmed: ReturnType<typeof setTimeout> | null = null;
  el("resetBtn").onclick = () => {
    const b = el("resetBtn");
    if (!resetArmed) {
      b.textContent = "Click again to erase all progress";
      resetArmed = setTimeout(() => {
        b.textContent = "Reset progress";
        resetArmed = null;
      }, 3500);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    b.textContent = "Reset progress";
    void opts.resetAll();
  };

  return { render };
}

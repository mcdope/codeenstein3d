// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * External console sidebar: a DOM panel next to the canvas that mirrors
 * `console.log` output and, while a level is running, occasionally drops a
 * random in-character hint. Hidden while the canvas is the Fullscreen API's
 * target element, since only the fullscreen element (and its descendants)
 * render in that state — a DOM sibling of the canvas doesn't render at all,
 * same reasoning as the native canvas HUD/overlays (see `hud.ts`/`gameHud.ts`).
 */

/** Oldest lines are dropped once the log exceeds this many entries, so a
 * long session's sidebar doesn't grow without bound. */
const MAX_LINES = 200;

/** Flavor hints, printed at random while a level is running — a lightweight
 * nod to the source material the level was built from, not a walkthrough. */
const HINTS = [
  "WARNING: proximity signatures detected.",
  "TIP: long corridors sometimes hide timed traps.",
  "TIP: not every wall that looks solid actually is.",
  "NOTICE: elite-complexity functions guard the best loot.",
  "TIP: header files make good restock stops.",
  "TIP: large comment blocks sometimes glow for a reason.",
  "WARNING: private and protected methods stay locked without a key.",
  "TIP: ghidra's splash damage isn't picky about who's standing in it.",
  "NOTICE: an aggroed enemy keeps coming, even out of sight.",
  "TIP: dead code doesn't just sit there — it hides things.",
];

/** Minimum/maximum delay (ms) between random hints. */
const HINT_MIN_DELAY_MS = 18000;
const HINT_MAX_DELAY_MS = 40000;

export interface ConsoleSidebarHandle {
  /** Enable/disable the periodic random hints (kept off outside an active level). */
  setHintsActive: (active: boolean) => void;
}

/**
 * Wire up the sidebar: mirrors every `console.log` call into `logEl` (in
 * addition to still logging normally — devtools keep working), toggles
 * `sidebarEl`'s visibility opposite the canvas's fullscreen state, and starts
 * the random-hint timer (inert until `setHintsActive(true)` is called).
 */
export function initConsoleSidebar(
  canvas: HTMLCanvasElement,
  sidebarEl: HTMLElement,
  logEl: HTMLElement,
): ConsoleSidebarHandle {
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]): void => {
    originalLog(...args);
    appendLine(logEl, args);
  };

  const updateVisibility = (): void => {
    sidebarEl.classList.toggle("hidden", document.fullscreenElement === canvas);
  };
  document.addEventListener("fullscreenchange", updateVisibility);
  updateVisibility();

  let hintsActive = false;
  /** Index of the last hint actually printed, so the next pick can avoid
   * repeating it back-to-back — `-1` (never matches) until the first hint. */
  let lastHintIndex = -1;
  const scheduleHint = (): void => {
    const delay = HINT_MIN_DELAY_MS + Math.random() * (HINT_MAX_DELAY_MS - HINT_MIN_DELAY_MS);
    window.setTimeout(() => {
      if (hintsActive) {
        let index = Math.floor(Math.random() * HINTS.length);
        while (HINTS.length > 1 && index === lastHintIndex) {
          index = Math.floor(Math.random() * HINTS.length);
        }
        lastHintIndex = index;
        console.log(`%c[hint] ${HINTS[index]}`, "color:#f2d64b");
      }
      scheduleHint();
    }, delay);
  };
  scheduleHint();

  return {
    setHintsActive(active: boolean): void {
      hintsActive = active;
    },
  };
}

/** Lines longer than this are truncated — a huge raw-file dump (the "log
 * this file's text" fallback for unparsable files) shouldn't blow up the
 * panel either. */
const MAX_LINE_LENGTH = 300;

/**
 * Render one `console.log(...)` call as a DOM line, or skip it entirely.
 * Recognizes this codebase's own `%c<message>", "color:#rrggbb..."`
 * convention (used throughout the engine) and applies the color directly
 * rather than showing the raw format string. This is flavor text, not a dev
 * console: a call whose message isn't a string (an object/array logged for
 * devtools inspection, e.g. a whole `ParsedFile`/`GameMap` dump) is dropped
 * without rendering anything, and any *trailing* non-string argument after a
 * real string message is silently ignored rather than stringified — object
 * dumps wreck both readability and the retro-terminal effect.
 */
function appendLine(container: HTMLElement, args: unknown[]): void {
  if (typeof args[0] !== "string") return;

  let text = args[0];
  let color = "";
  if (text.includes("%c")) {
    const style = typeof args[1] === "string" ? args[1] : "";
    const match = /color:\s*([^;]+)/.exec(style);
    color = match ? match[1].trim() : "";
    text = text.replace(/%c/g, "");
  }
  if (text.length > MAX_LINE_LENGTH) text = `${text.slice(0, MAX_LINE_LENGTH)}…`;

  const line = document.createElement("div");
  line.className = "console-line";
  if (color) line.style.color = color;
  line.textContent = text;
  container.appendChild(line);

  while (container.children.length > MAX_LINES) {
    container.firstChild?.remove();
  }
  container.scrollTop = container.scrollHeight;
}

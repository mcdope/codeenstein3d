// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The boss key (F9): one press hides the game behind a plain code-editor
 * surface, the same press brings it back.
 *
 * **A browser cannot minimise its own window.** `window.minimize()` does not
 * exist; `moveTo`/`resizeTo`/`close` only apply to windows the page itself
 * opened via `window.open`; pages get no control over browser chrome at all.
 * So the disguise has to happen *inside* the page, and everything below
 * follows from that.
 *
 * **What it shows is the level's own source file**, syntax-highlighted (see
 * `./codeHighlight.ts`) — the file this level was generated from is the most
 * plausible thing to have on screen, and it is already in memory. With no
 * level running (the launch screen) or on a multiplayer guest (which only
 * ever receives a serialised `GameMap`, never a path or the text), the caller
 * supplies a bundled fallback file instead.
 *
 * Four things about the implementation are load-bearing and were each learned
 * from something already documented in this repo:
 *
 * 1. **The overlay must exit fullscreen, synchronously.** `F` fullscreens the
 *    *canvas alone* (`src/engine/input.ts`), and per the Fullscreen API only
 *    the fullscreen element and its descendants paint — so this overlay would
 *    render as literally nothing while fullscreen. `exitFullscreen()` and the
 *    later `requestFullscreen()` therefore run inside the keydown handler:
 *    deferring either to a polled flag consumed in the rAF loop is rejected
 *    by browsers, which is the same constraint `InputController`'s own `F`
 *    branch documents.
 * 2. **The game pauses because the canvas really loses focus.** Focusing the
 *    overlay fires the canvas's existing `blur` handler, which forces
 *    `isPaused = true` in `simulate()` — the identical path alt-tabbing has
 *    always taken. Nothing is synthesised into the input stream, so a run
 *    being recorded stays honest. (In a multiplayer session there is no pause
 *    to get: `localInputSampler` drains and zeroes blur/escape/click before
 *    they reach the engine, because lockstep cannot be frozen unilaterally.
 *    Co-op therefore gets cover without pause, which is exactly what
 *    alt-tabbing there already does.)
 * 3. **It does not resume the game on the way out.** Un-bossing reveals the
 *    game still paused rather than dropping the player back into a fight with
 *    whatever was standing next to them. The existing click-to-resume path
 *    then does the rest, including re-acquiring pointer lock — which is also
 *    why nothing here calls `requestPointerLock()`: a re-lock driven from
 *    script right after an Escape-driven exit is blocked on purpose.
 * 4. **None of this is reachable by any bot-driven test.** The harnesses
 *    never blur, never click and never leave fullscreen. The unit tests below
 *    it pin state transitions; whether F9 survives the window manager and
 *    whether fullscreen really round-trips are manual checks, the same way
 *    the `Ctrl+W` incident could only ever have been caught by a real
 *    keypress.
 */
import { extensionOf, renderHighlighted } from "./codeHighlight";

/** What the disguise displays. `path` drives the highlighter's language
 * choice and every label on screen; `source` is the raw file text. */
export interface BossScreenContent {
  readonly path: string;
  readonly source: string;
}

export interface BossScreenDeps {
  /** The game canvas — refocused on close so gameplay keys work again, and
   * the element whose fullscreen state is preserved across the overlay. */
  readonly canvas: HTMLCanvasElement;
  /** Resolved at press time, not at construction: the level (and therefore
   * the file on show) changes over a session. */
  readonly getContent: () => BossScreenContent;
  /** Custom BGM keeps playing through every pause this app has — it is never
   * stopped anywhere — which under a fake editor is the loudest possible
   * tell. */
  readonly bgm: { pause: () => void; resume: () => void };
}

export interface BossScreen {
  toggle: () => void;
  isOpen: () => boolean;
}

/**
 * Keys swallowed while the overlay is up.
 *
 * Escape is here by the user's own call: only F9 dismisses, so a reflexive
 * Escape cannot un-hide the game at the worst possible moment. Enter and
 * Space are here for a subtler reason — `GameHud`'s overlays (the level-start
 * briefing, the end-of-run screens) arm a *window*-scoped keydown listener
 * for exactly those three codes, so without this, pressing Space behind the
 * disguise would dismiss a pending briefing and start the level underneath
 * it. Everything else (arrows, PageUp/PageDown, Home/End) is deliberately let
 * through so the code on screen can be scrolled like real code.
 */
const SWALLOWED_CODES: ReadonlySet<string> = new Set(["Escape", "Enter", "Space"]);

/** A neutral document glyph, inline so it needs no network and no new asset.
 * The tab strip gives the game away otherwise — the favicon is the one part
 * of the disguise that is visible without looking at the page at all. */
const DISGUISE_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" rx="2" fill="#2b2d31"/>' +
      '<path d="M4 4h8M4 7h8M4 10h5" stroke="#9aa0a6" stroke-width="1.4" stroke-linecap="round"/>' +
      "</svg>",
  );

/** Editor-status-bar label per extension. Cosmetic only. */
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  c: "C",
  h: "C Header",
  cpp: "C++",
  cs: "C#",
  java: "Java",
  js: "JavaScript",
  jsx: "JavaScript React",
  ts: "TypeScript",
  tsx: "TypeScript React",
  go: "Go",
  rs: "Rust",
  scala: "Scala",
  m: "Objective-C",
  php: "PHP",
  py: "Python",
  rb: "Ruby",
  sh: "Shell Script",
};

function languageLabel(path: string): string {
  return LANGUAGE_LABELS[extensionOf(path)] ?? "Plain Text";
}

function fileNameOf(path: string): string {
  // `?? path` is defensive only: split() never returns an empty array.
  /* v8 ignore next -- @preserve */
  return path.split("/").pop() ?? path;
}

export function createBossScreen(deps: BossScreenDeps): BossScreen {
  let root: HTMLDivElement | null = null;
  let previouslyFocused: Element | null = null;
  let savedTitle = "";
  /** `[link, original href attribute]` for every icon link, so the tab icon
   * comes back exactly as it was rather than being hardcoded to a guess. The
   * *attribute* rather than the `href` property, which resolves to an
   * absolute URL and would silently rewrite the document's own markup. */
  let savedIcons: [HTMLLinkElement, string | null][] = [];
  /** Whether *this* overlay took fullscreen away, so closing only restores
   * fullscreen the player actually had. */
  let tookFullscreen = false;

  function onKey(event: KeyboardEvent): void {
    if (!SWALLOWED_CODES.has(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function build(content: BossScreenContent): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "boss-screen";
    // Focusable but not tab-reachable: the overlay takes focus on open (which
    // is also what pauses the game), and gives it back on close.
    el.tabIndex = -1;

    const bar = document.createElement("div");
    bar.className = "boss-screen-bar";
    const tab = document.createElement("span");
    tab.className = "boss-screen-tab";
    tab.textContent = fileNameOf(content.path);
    const crumb = document.createElement("span");
    crumb.className = "boss-screen-crumb";
    crumb.textContent = content.path;
    bar.append(tab, crumb);

    const code = document.createElement("div");
    code.className = "boss-screen-code";
    renderHighlighted(code, content.source, content.path);

    const status = document.createElement("div");
    status.className = "boss-screen-status";
    const left = document.createElement("span");
    left.textContent = `${languageLabel(content.path)}   UTF-8   LF`;
    const right = document.createElement("span");
    right.textContent = `${content.source.split("\n").length} lines`;
    status.append(left, right);

    el.append(bar, code, status);
    return el;
  }

  function show(): void {
    // Already up: a second press must not stack a second overlay (and must
    // not overwrite the saved title/favicon with the disguise's own).
    /* v8 ignore next -- @preserve */
    if (root) return;

    // Synchronously, while this is still a user gesture — see the module doc.
    tookFullscreen = document.fullscreenElement === deps.canvas;
    if (tookFullscreen) void document.exitFullscreen().catch(() => undefined);

    // Resolved once: the title and the overlay must agree on which file this
    // is, and `getContent` reads live module state in `main.ts`.
    const content = deps.getContent();
    previouslyFocused = document.activeElement;
    root = build(content);
    document.body.append(root);
    // Capture phase, so a swallowed key never reaches the window-scoped
    // listeners `InputController` and `GameHud` keep armed underneath.
    window.addEventListener("keydown", onKey, true);
    // Focus is what pauses the game (the canvas blurs) as well as what makes
    // the code scrollable by keyboard.
    root.focus();

    savedTitle = document.title;
    document.title = fileNameOf(content.path);
    savedIcons = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((link) => [link, link.getAttribute("href")]);
    for (const [link] of savedIcons) link.setAttribute("href", DISGUISE_FAVICON);

    deps.bgm.pause();
  }

  function hide(): void {
    /* v8 ignore next -- @preserve */
    if (!root) return;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    root = null;

    document.title = savedTitle;
    for (const [link, href] of savedIcons) {
      // A link that had no `href` at all is put back the same way, rather
      // than left holding the disguise's data URI.
      /* v8 ignore next -- @preserve */
      if (href === null) link.removeAttribute("href");
      else link.setAttribute("href", href);
    }
    savedIcons = [];

    deps.bgm.resume();

    // Also synchronous, and also only valid because the dismiss keypress is
    // itself the user gesture that permits it.
    if (tookFullscreen) void deps.canvas.requestFullscreen().catch(() => undefined);
    tookFullscreen = false;

    // Hand focus back to whatever had it — during play that is the canvas,
    // and without it every gameplay key stays dead, since `InputController`
    // binds keydown to the canvas rather than the window.
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    else deps.canvas.focus();
    previouslyFocused = null;
    // Deliberately does not un-pause: see the module doc comment.
  }

  return {
    toggle(): void {
      if (root) hide();
      else show();
    },
    isOpen(): boolean {
      return root !== null;
    },
  };
}

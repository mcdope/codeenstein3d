// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * First-run guided tour: a sequence of popouts anchored to real sidebar
 * controls, teaching where things are rather than what the game is.
 *
 * **Why this exists alongside the two things that already do.** `#intro-screen`
 * (static markup in the viewport) explains the *concept* — how files map onto
 * levels — and `#player-guide-link` opens the written guide on GitHub. Neither
 * points at a control. A newcomer who reads both still has to guess which of
 * the five sidebar tabs starts a game without any setup.
 *
 * **Scope is the cold-start screen only, and that is a constraint rather than a
 * choice.** At a genuine first run the file tree is empty and no level is
 * running, so everything in `doc/user/hud-and-ui.md` — HUD, minimap, compass,
 * automap — has nothing on screen to anchor to. This teaches how to *start*.
 *
 * **Tab switching is declarative and always restored.** The blanket "no step
 * may switch a launch tab" rule was relaxed (user decision, 2026-08-16) when
 * the settings moved behind their own tab: a step may carry `activateTabId`
 * to have its tab opened for it (the Settings walk-through needs the panel
 * visible to anchor to), every step *without* one re-activates the tab that
 * was selected when the tour began, and `stop()` restores that initial tab on
 * every exit path (Done, Skip, Escape). What remains banned is the original
 * sin: ending the tour on a different tab than the player started on —
 * switch-without-restore on persistent UI state.
 */

/** One stop on the tour. `targetId` is an element id in `index.html`. */
export interface TourStep {
  targetId: string;
  title: string;
  body: string;
  /** Launch-tab button id (e.g. `"tab-settings"`) this step needs active —
   * the tour clicks it before measuring the target, and re-activates the
   * tour's initial tab for steps without one. See the module doc for the
   * restore guarantee. */
  activateTabId?: string;
}

export interface IntroTour {
  /** Show the first resolvable step. A no-op when already running, so a double
   * click on the "Take the tour" button cannot stack two overlays. */
  start(): void;
  /** Tear down and restore focus. Safe to call when not running. */
  stop(): void;
}

/** Gap in px between the highlighted control and the popout beside it. */
const POPOUT_GAP = 12;
/** Popout width. Fixed rather than content-sized so placement can be decided
 * before the browser has laid the text out — jsdom reports a zero-width rect
 * either way, and a fixed width keeps the two environments in agreement. */
const POPOUT_WIDTH = 280;
/** Keeps a clamped popout off the very edge of the viewport. */
const VIEWPORT_MARGIN = 8;

/**
 * The steps the tour ships with. Worded from `doc/user/getting-started.md`,
 * `multiplayer.md` and `hud-and-ui.md` so the tour and the written guide cannot
 * drift into saying different things.
 *
 * **Ordered by position in the sidebar, top to bottom**, not by importance.
 * Each step scrolls its target into view, so an order that jumped between the
 * top and the bottom of a sidebar taller than the viewport would yank the page
 * around under the reader.
 */
export const DEFAULT_TOUR_STEPS: readonly TourStep[] = [
  {
    targetId: "launch-tabs",
    title: "Six tabs, five ways in",
    body: "Four of these tabs load source code to play — from your machine, a saved run, a public repository, or the bundled demos. The fifth hosts co-op, and the gear holds the settings. Every file you load becomes a level.",
  },
  {
    // Local is the leftmost tab and the one selected on arrival, so it leads
    // the per-tab walk. It had no step at all until a playtest noticed: the
    // overview mentions "from your machine" and then nothing followed it up,
    // which also left the Repo step's old title ("Or play your own code")
    // reading as though it were this tab's job.
    targetId: "tab-local",
    title: "Play a folder on this machine",
    body: "Select Workspace opens a folder picker, and every source file inside becomes a level — a single script or a whole repository. The folder is read in your browser and nothing is uploaded anywhere. This is also the only tab whose runs autosave, so a campaign you leave halfway comes back under Continue. It needs Chrome, Edge or Brave: the folder picker it uses does not exist in other browsers, and the button says so if yours cannot.",
  },
  {
    // Steps follow the tab strip left to right and Repo sits third, after
    // Local and before Demos. Anchored on the tab button rather than
    // `#repo-input`, the same shape `tab-local`, `tab-demo` and
    // `tab-multiplayer` use — a step reaching into the panel would need
    // `activateTabId` and would walk strip -> panel -> strip across
    // consecutive popouts, which is what the ordering rule above exists to
    // prevent.
    targetId: "tab-repo",
    title: "Play code you don't have locally",
    body: "Paste a repository from GitHub, GitLab or Codeberg and its files become the levels, no download or checkout of your own needed. The address says which site it came from, and the button names the one it recognised before anything is fetched — a bare owner/repo still means GitHub. Public repositories only. Below it sit four suggestions from Easy to Nightmare if you'd rather not pick one.",
  },
  {
    targetId: "tab-demo",
    title: "Start here if you're new",
    body: "Demos launches a bundled multi-language campaign with no setup at all — no local files, no network. It's the fastest way to see what the game does with code.",
  },
  {
    targetId: "tab-multiplayer",
    title: "Co-op, up to four",
    body: "Host a session and share the short code, or join with someone else's — joining needs no workspace of your own at all. Only the host loads the code; everyone else receives the finished level over the connection. A locally-picked folder can't be hosted, so host from Demos or a loaded repository.",
  },
  {
    targetId: "tab-settings",
    title: "Everything you can tweak",
    body: "The gear tab collects the game's settings — who you are, how it plays, how it sounds, how it looks. Everything in it is remembered between sessions. Let's step through it.",
  },
  {
    targetId: "player-name-input",
    activateTabId: "tab-settings",
    title: "Say who you are (optional)",
    body: "Set a name and it floats above your character in co-op so teammates can tell who's who, and it labels your own highscore entries. It's remembered between sessions, and it only ever goes to the people in your session — never to a server.",
  },
  {
    targetId: "difficulty-select",
    activateTabId: "tab-settings",
    title: "Set the rules first",
    body: "Difficulty and gore apply to the next level you launch, so pick them before you start. Difficulty then locks for the rest of the run — a score is only comparable if it held throughout. Both are remembered between sessions.",
  },
  {
    targetId: "render-quality-select",
    activateTabId: "tab-settings",
    title: "Classic look, or Sharp",
    body: "Classic keeps the game's intended 640×400 retro look — the default. Sharp doubles the internal resolution for crisper walls and sprites, paired with a half-resolution floor so it stays fast — worth trying on a 120Hz display. Applies at the next level you launch; aiming is identical in both.",
  },
  {
    targetId: "wad-tabs",
    activateTabId: "tab-settings",
    title: "Bring your own textures",
    body: "Point it at a DOOM .wad and the walls, doors and floors come from that instead of the built-in look — it picks broadly-compatible textures out of the file for you. Or take one from the curated online list, no download or file picker needed, each with its license and credits shown. Either way it lasts for the session, not forever.",
  },
  {
    targetId: "view-highscores",
    title: "Scores stay on your machine",
    // Anchored on the button and describing the dialog rather than opening
    // it, deliberately: a dialog shown with `showModal()` lives in the
    // browser's top layer, which paints above every z-index — the popout and
    // its buttons would be behind it and unreachable. Same reason this tour
    // is a fixed layer rather than a `<dialog>` (see `style.css`).
    //
    // The old body claimed every entry could be replayed. Two states say
    // otherwise (`highscorePanel.ts`): a run recorded before a balance change
    // reads "rules changed" with no button, and one whose recording was
    // dropped shows a dash.
    body: "Runs are scored and kept locally — nothing is uploaded. Each row also says what the run cost: which difficulty it was played on, and how many rollbacks it spent restarting a level. Watch replays a run frame-for-frame; Export plays it back and records that to a .webm video, in real time at 1x with the controls locked until it finishes. A run recorded before a balance change reads \"rules changed\" instead — it would no longer match its own score.",
  },
  {
    targetId: "file-tree",
    title: "Your code, as levels",
    body: "Once a workspace loads, its files appear here and each one is a playable level. The game picks a sensible starting point on its own, but you can click any file to drop straight into it.",
  },
  {
    targetId: "console-sidebar",
    title: "The log is part of the game",
    body: "This panel mirrors what the level is doing as you play — doors, secrets, pickups and kills all report here. That's the whole tour: pick Demos in the sidebar and you're in.",
  },
];

/** Places the popout beside `rect`, preferring the right of the sidebar column
 * and falling back to below when that would overflow. Exported for its own
 * test: the fallback is the part that only fires on a narrow viewport, which is
 * exactly the case a manual check is least likely to try. */
export function placePopout(
  rect: { left: number; top: number; right: number; bottom: number; height: number },
  viewport: { width: number; height: number },
  popoutHeight: number,
): { left: number; top: number } {
  const rightOf = rect.right + POPOUT_GAP;
  const fitsRight = rightOf + POPOUT_WIDTH + VIEWPORT_MARGIN <= viewport.width;
  const left = fitsRight ? rightOf : rect.left;
  const top = fitsRight ? rect.top : rect.bottom + POPOUT_GAP;
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(left, viewport.width - POPOUT_WIDTH - VIEWPORT_MARGIN)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(top, viewport.height - popoutHeight - VIEWPORT_MARGIN)),
  };
}

export function createIntroTour(steps: readonly TourStep[], onFinish: () => void): IntroTour {
  let index = 0;
  let root: HTMLDivElement | null = null;
  let previouslyFocused: Element | null = null;
  /** The launch tab that was selected when the tour started — re-activated
   * for every step without its own `activateTabId`, and restored on every
   * exit path. Null when no tab bar exists (some unit fixtures). */
  let initialTabId: string | null = null;

  /** Activate the launch tab `tabId` names by clicking its button — reusing
   * the app's own switcher listener keeps aria/hidden handling in one place.
   * No-ops when the tab is already selected (a click would be harmless, but
   * re-clicking on every render is noise) or the id resolves to nothing. */
  function activateTab(tabId: string | null): void {
    if (!tabId) return;
    const button = document.getElementById(tabId);
    if (!(button instanceof HTMLElement)) return;
    if (button.getAttribute("aria-selected") === "true") return;
    button.click();
  }

  /**
   * Steps whose target is absent or invisible are dropped rather than thrown on
   * — a tour that died on a missing element would break the very first run it
   * exists for.
   *
   * **Visibility is tested through `display`, not just the `hidden` attribute,
   * and that distinction is load-bearing here.** This app hides optional
   * controls by assigning `style.display = "none"`: `#tab-continue` until a
   * save exists, `#tab-multiplayer` when the build has no signaling server
   * configured. An `hidden`-only check passes those, and the step then anchors
   * to a zero-size rect — which is exactly what the first browser run of this
   * tour did, parking the multiplayer popout on an invisible tab.
   */
  const isVisible = (el: HTMLElement): boolean => !el.hidden && getComputedStyle(el).display !== "none";
  const resolvable = (): { step: TourStep; target: HTMLElement }[] =>
    steps
      .map((step) => ({ step, target: document.getElementById(step.targetId) }))
      .filter((entry): entry is { step: TourStep; target: HTMLElement } => entry.target !== null && isVisible(entry.target));

  function stop(): void {
    if (!root) return;
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    root = null;
    // The restore half of the module's tab-switching guarantee: whatever tab
    // the player was on when the tour began is the tab they end on — on
    // every exit path (Done, Skip, Escape all funnel through here).
    activateTab(initialTabId);
    initialTabId = null;
    // Restore focus to whatever had it before the tour stole it — otherwise a
    // keyboard user is dumped at the top of the document.
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    previouslyFocused = null;
    onFinish();
  }

  /** Only ever bound while the tour is up — `start` adds it, `stop` removes it
   * — so it needs no "am I running?" guard of its own. */
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    }
  }

  /**
   * Move by `delta`, or end the tour when that runs off either end.
   *
   * `resolvable()` is recomputed here rather than cached, so a step whose
   * target disappeared mid-tour (a workspace load re-rendering the sidebar,
   * say) simply shortens the list — and a list that has shortened to nothing
   * ends the tour through the same bounds check as reaching the last step.
   * That is why `render` needs no "what if there is no step" guard: both call
   * sites resolve the entry first and pass it in.
   */
  function go(delta: number): void {
    const entries = resolvable();
    const next = index + delta;
    if (next < 0) return;
    if (next >= entries.length) {
      stop();
      return;
    }
    index = next;
    render(entries[next], entries.length);
  }

  function render(entry: { step: TourStep; target: HTMLElement }, total: number): void {
    root!.replaceChildren();

    // A step inside a tab panel declares the tab it needs; every other step
    // gets the tour's initial tab back, so stepping Back across the settings
    // boundary (or past it) never leaves the wrong panel showing. Must happen
    // before the rect measurement below — a target inside a hidden panel
    // measures as a zero-size rect.
    activateTab(entry.step.activateTabId ?? initialTabId);

    // Bring the control into view *before* measuring it. The sidebar is taller
    // than most viewports — `#file-tree` and `#view-highscores` sit below the
    // fold on a 900px-high window — and without this the popout is clamped into
    // view while its highlight stays off-screen, so the tour points at nothing.
    // Caught only by driving a real browser; every unit test here stubs the
    // rect and so cannot see it.
    //
    // Guarded because jsdom does not implement scrolling.
    if (typeof entry.target.scrollIntoView === "function") entry.target.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = entry.target.getBoundingClientRect();
    const highlight = document.createElement("div");
    highlight.className = "intro-tour-highlight";
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;

    const popout = document.createElement("div");
    popout.className = "intro-tour-popout";
    popout.setAttribute("role", "dialog");
    popout.setAttribute("aria-modal", "true");
    popout.tabIndex = -1;

    const heading = document.createElement("h3");
    heading.className = "intro-tour-title";
    heading.textContent = entry.step.title;
    popout.setAttribute("aria-label", entry.step.title);

    const body = document.createElement("p");
    body.className = "intro-tour-body";
    body.textContent = entry.step.body;

    const progress = document.createElement("p");
    progress.className = "intro-tour-progress";
    progress.textContent = `${index + 1} of ${total}`;

    const controls = document.createElement("div");
    controls.className = "intro-tour-controls";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "settings-btn intro-tour-btn";
    back.textContent = "Back";
    back.disabled = index === 0;
    back.addEventListener("click", () => go(-1));
    const next = document.createElement("button");
    next.type = "button";
    next.className = "settings-btn intro-tour-btn";
    next.textContent = index === total - 1 ? "Done" : "Next";
    next.addEventListener("click", () => go(1));
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "settings-btn intro-tour-btn intro-tour-btn--skip";
    skip.textContent = "Skip";
    skip.addEventListener("click", () => stop());
    controls.append(back, next, skip);

    popout.append(heading, body, progress, controls);
    root!.append(highlight, popout);

    // Measured after insertion: the height depends on how the body text wraps,
    // which nothing can know beforehand.
    const placed = placePopout(rect, { width: window.innerWidth, height: window.innerHeight }, popout.getBoundingClientRect().height);
    popout.style.left = `${placed.left}px`;
    popout.style.top = `${placed.top}px`;
    popout.focus();
  }

  return {
    start(): void {
      // Already running: a second click must not stack a second overlay.
      if (root) return;
      const entries = resolvable();
      if (entries.length === 0) {
        onFinish();
        return;
      }
      previouslyFocused = document.activeElement;
      initialTabId = document.querySelector('#launch-tabs [role="tab"][aria-selected="true"]')?.id ?? null;
      index = 0;
      root = document.createElement("div");
      root.className = "intro-tour";
      document.body.append(root);
      // Capture phase, so Escape reaches the tour before any other global
      // handler treats it as "close my thing".
      window.addEventListener("keydown", onKey, true);
      render(entries[0], entries.length);
    },
    stop,
  };
}

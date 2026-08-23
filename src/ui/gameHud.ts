// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Blocking level overlays — the pre-level briefing, the post-level commit
 * summary, and the end-of-run screens ("Kernel Panic" / "Build Successful") —
 * drawn directly on the game canvas rather than as DOM elements.
 *
 * These used to be a DOM overlay stacked on top of the canvas, but F now
 * fullscreens the canvas alone (see `InputController`) — and per the
 * Fullscreen API, only the fullscreen element and its descendants are ever
 * painted while it's active. A DOM sibling of the canvas (which is exactly
 * what these were) simply doesn't render at all in that state, so the whole
 * screen appeared to silently freeze with no explanation. Drawing on the
 * canvas itself means these are always visible, fullscreen or not.
 */

import { DESIGN_WIDTH, overlayFrame, withOverlayScale } from "../engine/overlayScale";
import type { ScoreBreakdown } from "../engine/scoring";
import type { PlayerFacingStats } from "../engine/playerStats";

/** AST/level stats shown on the pre-level briefing. */
export interface LevelStartInfo {
  campaign: string;
  levelName: string;
  roomCount: number;
  enemyCount: number;
  secretRoomCount: number;
}

/** Curated "how'd I do" numbers shown on the commit summary and the two
 * run-end screens — see `./engine/playerStats.ts` and `./engine/scoring.ts`. */
export interface StatsScreenInfo {
  scoreBreakdown: ScoreBreakdown;
  playerStats: PlayerFacingStats;
}

/** Stats shown on the post-level commit summary. */
export interface CommitSummaryInfo {
  linesRefactored: number;
  bugsSquashed: number;
  /** This level's own curated stats/breakdown — omitted shows just the two
   * fields above, same as before this existed. */
  stats?: StatsScreenInfo;
}

export interface OverlayContent {
  title: string;
  /** Theme color for the title, box border, and button (a CSS color string). */
  color: string;
  lines: string[];
  stats?: [string, string][];
  buttonLabel: string;
  /** A second, non-default choice, drawn beside the primary. Label and
   * handler travel together so they cannot desync — an overlay showing a
   * button that does nothing is worse than one with no button. Absent (every
   * caller but the rollback death screen) takes a byte-identical path to
   * before this existed. */
  secondary?: { label: string; onPick: () => void };
  /** Widens the box's max width — the commit summary and run-end screens
   * need this once they carry `StatsScreenInfo`'s grouped rows (e.g.
   * "Health 500 · Ammo 250 · Speed 400 · Accuracy 180"), which run
   * noticeably longer than the plain 1-2-word stat values every other
   * overlay uses. */
  wide?: boolean;
}

export class GameHud {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** `stats` is the whole *run's* cumulative breakdown/totals (not just the
   * level died on) — see `EngineStats.runScoreBreakdown`/`runPlayerStats`.
   * `undefined` shows the screen with no stats rows, same as before this
   * param existed (e.g. the replay viewer's failure paths). */
  showKernelPanic(
    stats: StatsScreenInfo | undefined,
    onReturn: () => void,
    opts?: {
      rollback?: { remaining: number; onRollback: () => void };
      /** Whether any cheat has fired this run — `EngineStats.cheatsUsed`, the
       * same latch the in-play HUD badge reads, so this screen can never
       * contradict the badge the player was looking at a second ago. Adds one
       * line and nothing else; a clean run takes a byte-identical path to
       * before this existed. Deliberately ignored when a rollback is on
       * offer — see the `lines` branch below. */
      cheated?: boolean;
    },
  ): void {
    const rollback = opts?.rollback;
    // "Roll back" is the *primary* deliberately. Space is also the fire key,
    // and `DISMISS_LOCK_MS` exists precisely because players mash it — if
    // "Give up" were the default, a mashed trigger would irreversibly end the
    // run, whereas a mis-triggered rollback costs one rollback and puts the
    // player back in play. Escape keeps the meaning it already has on this
    // screen (leave, back to the file tree), which is why it maps to the
    // secondary rather than to some notion of "cancel".
    // `rollback.remaining` is the count *after* this rollback is spent — it
    // is decremented at the death itself, before this screen is shown (see
    // `onGameOver`), so that closing the tab here is not a free retry. That
    // makes a bare "N left" actively wrong to read: on the last one it says
    // "0 rollbacks left" directly above a button offering to spend one, which
    // is how this first got reported. Every line below therefore talks about
    // *this* choice and what follows it, never about a bare balance.
    const n = rollback?.remaining ?? 0;
    this.show(
      {
        title: "KERNEL PANIC",
        color: "#ff4d4d",
        lines: rollback
          ? [
              "System stability reached 0%.",
              n === 0
                ? "This is your last rollback — the level restarts as you entered it."
                : `${n} more rollback${n === 1 ? "" : "s"} after this one — the level restarts as you entered it.`,
              "This attempt's score and kills are discarded, and the run is marked.",
            ]
          : [
              "System stability reached 0%.",
              "The process was terminated.",
              // Only on the death that actually ends the run. The rollback
              // variant above is a real decision the player has to read, and
              // every line on it is required to describe *that choice* — a
              // joke wedged in among the three dilutes it, and the punchline
              // wants a death that sticks anyway.
              ...(opts?.cheated ? ["You cheated and still died. lol"] : []),
            ],
        stats: stats ? statRows(stats) : undefined,
        buttonLabel: rollback ? "Roll back" : "Return to file tree",
        ...(rollback ? { secondary: { label: "Give up", onPick: onReturn } } : {}),
        wide: stats !== undefined,
      },
      rollback ? rollback.onRollback : onReturn,
    );
  }

  /** `stats` is the whole run's cumulative breakdown/totals — see
   * `showKernelPanic`'s doc comment. */
  showBuildSuccessful(stats: StatsScreenInfo | undefined, onReturn: () => void): void {
    this.show(
      {
        title: "BUILD SUCCESSFUL",
        color: "#37d24a",
        lines: ["return statement reached. Exit code 0 —", "the module compiled clean."],
        stats: stats ? statRows(stats) : undefined,
        buttonLabel: "Return to file tree",
        wide: stats !== undefined,
      },
      onReturn,
    );
  }

  /** Pre-level briefing: campaign/level identity and AST stats. Blocks play
   * until acknowledged — the engine isn't started until `onAck` fires. */
  showLevelStart(info: LevelStartInfo, onAck: () => void): void {
    this.show(
      {
        title: info.campaign,
        color: "#3fd0e0",
        lines: [`Compiling ${info.levelName}…`],
        stats: [
          ["Rooms", String(info.roomCount)],
          ["Enemies", String(info.enemyCount)],
          ["Secrets", String(info.secretRoomCount)],
        ],
        buttonLabel: "Start",
      },
      onAck,
    );
  }

  /** Post-level commit summary, shown after reaching the exit and before the
   * next level (or the final Build Successful screen) loads. */
  showCommitSummary(info: CommitSummaryInfo, onAck: () => void): void {
    this.show(
      {
        title: "COMMIT SUMMARY",
        color: "#f2d64b",
        lines: [],
        stats: [
          ["Lines refactored", String(info.linesRefactored)],
          ["Bugs squashed", String(info.bugsSquashed)],
          ...(info.stats ? statRows(info.stats) : []),
        ],
        buttonLabel: "Continue",
        wide: info.stats !== undefined,
      },
      onAck,
    );
  }

  /** End-of-run comparison table for a multiplayer session (multiplayer step
   * 9) — one row per roster player, built by the caller (`main.ts`, which
   * owns the `SessionEndReason`-to-`title`/`color` mapping and the roster-id-
   * to-label formatting; this method stays as domain-agnostic as every other
   * one here, taking only plain strings). Reuses the same `stats`
   * label/value layout every other screen already gets — a comparison table
   * is just N rows instead of one run's own breakdown. */
  showMultiplayerResults(title: string, color: string, rows: [string, string][], onReturn: () => void): void {
    this.show(
      {
        title,
        color,
        lines: [],
        stats: rows,
        buttonLabel: "Return to file tree",
        wide: true,
      },
      onReturn,
    );
  }

  /** Replay playback ended for a reason other than a natural in-run win/death
   * (both of which already show their own Kernel Panic / Build Successful
   * overlay) — a manual stop, a seek/transport action, or a file that
   * couldn't be relocated/re-verified against the recorded run. Without this,
   * every one of those paths would otherwise just silently snap back to the
   * file tree with no on-screen explanation. */
  showReplayEnded(reason: string, onReturn: () => void): void {
    this.show(
      {
        title: "REPLAY ENDED",
        color: "#3fd0e0",
        lines: [reason],
        buttonLabel: "Return to file tree",
      },
      onReturn,
    );
  }

  /** Shown once, right before the Highscores dialog's "Export" button jumps
   * straight into recording with no replay UI seen yet — explains that
   * capture runs in real time (1x) and locks the transport controls, so
   * that's not a surprise once acknowledged. `startReplay` gates its own
   * `advanceLevel()` call behind `onAck` here too, not just the recording
   * start, so nothing plays until the user has actually seen this. Not
   * shown for the transport bar's own Record button — by that point the
   * user is already looking at the replay and clicked a clearly-labeled
   * button, so the extra step would just be friction. */
  showRecordingNotice(onAck: () => void): void {
    this.show(
      {
        title: "RECORDING",
        color: "#ff4d4d",
        lines: ["Captures in real time (1x) — transport controls", "lock until you stop recording."],
        buttonLabel: "Start recording",
      },
      onAck,
    );
  }

  private show(content: OverlayContent, onAck: () => void): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx) drawOverlay(ctx, content);

    // Primary first, secondary (when there is one) second — the same order
    // `overlayLayout` returns the rects in, so an index means the same thing
    // in both.
    const handlers = content.secondary ? [onAck, content.secondary.onPick] : [onAck];
    // The design frame is taken from `overlayFrame` rather than from the
    // context, because the hit rects are still needed when `getContext`
    // returned null (jsdom, a lost context) — the overlay is invisible then,
    // but Space and the gamepad still have to dismiss it.
    const frame = overlayFrame(this.canvas.width, this.canvas.height);
    const rects = overlayLayout(frame.w, frame.h, content).buttons;

    // Every one of these overlays can appear mid-fight (dying, or stepping on
    // the exit while still under fire) — with Space/mousedown also being the
    // fire controls, a player mashing the trigger the instant this appears
    // would otherwise dismiss it before they even see it. `shownAt` gates
    // every trigger below until `DISMISS_LOCK_MS` has actually elapsed,
    // rather than removing the listeners immediately.
    const shownAt = performance.now();
    const isLocked = (): boolean => performance.now() - shownAt < DISMISS_LOCK_MS;

    // Confirmable by the same triggers as firing a weapon in-game (Space,
    // mousedown — not "click", which only fires on release; a dialog should
    // dismiss the instant you pull the trigger, same as a shot would go off),
    // plus Enter/Escape for a conventional dialog feel. One-shot: every
    // listener removes itself the moment any of them fires (after the lock
    // above has expired).
    const pick = (index: number): void => {
      if (isLocked()) return;
      window.removeEventListener("keydown", onKey);
      this.canvas.removeEventListener("mousedown", onMouseDown);
      cancelAnimationFrame(gamepadPollId);
      handlers[index]();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        pick(0);
      } else if (e.code === "Escape") {
        e.preventDefault();
        // The last handler, which is the primary when there is only one — so
        // a single-button overlay keeps Escape's existing "dismiss" meaning
        // exactly, and a two-button one gets the conventional cancel.
        pick(handlers.length - 1);
      }
    };
    const onMouseDown = (e: MouseEvent): void => {
      // One button: anywhere on the canvas, as before this existed.
      if (handlers.length === 1) {
        pick(0);
        return;
      }
      // Two: an explicit choice is required, so a press that misses both
      // does nothing at all and leaves the listeners attached. The canvas
      // renders at 640x400 (or 1280x800) and is CSS-scaled up by
      // `canvasFit.ts`, so client coordinates have to be scaled back — there
      // is no other client-to-canvas mapping in the codebase to reuse, since
      // aiming goes through pointer lock and `movementX` rather than
      // coordinates. A zero-sized rect (jsdom, and a display:none canvas)
      // falls back to 1:1 rather than dividing by zero.
      //
      // Two steps, not one: CSS pixels -> backing store, then backing store ->
      // design pixels, because `rects` is in the space the overlay was drawn
      // in. Stopping after the first step leaves every click landing at twice
      // its intended position at Sharp, which reads as "the buttons do not
      // work" rather than as a coordinate bug.
      const r = this.canvas.getBoundingClientRect();
      const sx = r.width > 0 ? this.canvas.width / r.width : 1;
      const sy = r.height > 0 ? this.canvas.height / r.height : 1;
      const x = ((e.clientX - r.left) * sx) / frame.scale;
      const y = ((e.clientY - r.top) * sy) / frame.scale;
      const hit = rects.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (hit !== -1) pick(hit);
    };

    window.addEventListener("keydown", onKey);
    this.canvas.addEventListener("mousedown", onMouseDown);

    // No engine is running while any of these overlays is up (either it
    // hasn't started yet, or `RaycasterEngine.stop()` already cancelled its
    // own rAF loop before firing the handler that shows this one) — so
    // there's no `InputController` polling gamepad state to piggyback on.
    // Poll for "any button just pressed" directly here instead, same
    // one-shot-per-frame edge-trigger shape as `InputController.pollGamepad`,
    // gated by the same `isLocked()` a keyboard/mouse press already is.
    //
    // With two buttons the "any button" reading would be ambiguous, so it
    // narrows to face buttons 0 and 1 (A/cross and B/circle) mapping to
    // primary and secondary. `prev` is updated every frame regardless of the
    // lock, exactly as the single-button latch was, so a button already held
    // down when the overlay appears is not an edge once the lock expires.
    const prev: boolean[] = handlers.map(() => false);
    let gamepadPollId = 0;
    const pollGamepadDismiss = (): void => {
      const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
      const pad = Array.from(pads).find((p): p is Gamepad => p !== null);
      const now =
        handlers.length === 1
          ? [pad?.buttons.some((b) => b.pressed) ?? false]
          : [pad?.buttons[0]?.pressed ?? false, pad?.buttons[1]?.pressed ?? false];
      const edge = now.findIndex((pressed, i) => pressed && !prev[i]);
      for (let i = 0; i < now.length; i++) prev[i] = now[i];
      if (edge !== -1) pick(edge);
      gamepadPollId = requestAnimationFrame(pollGamepadDismiss);
    };
    gamepadPollId = requestAnimationFrame(pollGamepadDismiss);
  }
}

/** Formats `M:SS` from a seconds count — used only for the stats screens'
 * "Time survived" row. */
function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Grouped label/value rows for a `StatsScreenInfo` — shared by the commit
 * summary and both run-end screens. Related sub-fields are combined into one
 * row's value string (rather than one row per raw field) so the box doesn't
 * grow to 15+ rows tall — see `drawOverlay`'s `layout()`. */
function statRows({ scoreBreakdown: b, playerStats: p }: StatsScreenInfo): [string, string][] {
  return [
    ["Kills", String(p.kills)],
    ["Weapon accuracy", `${p.weaponAccuracyPct}%`],
    ["Loot collected", String(p.lootCollectedTotal)],
    ["Time survived", formatDuration(p.timeSurvivedSec)],
    ["Closest call", `${Math.round(p.minHealthReached)}% health`],
    [
      "Damage taken",
      `Melee ${Math.round(p.damageTakenBySource.enemyMelee)} · Ranged ${Math.round(p.damageTakenBySource.enemyRanged)} · Traps ${Math.round(
        p.damageTakenBySource.trapSpike + p.damageTakenBySource.trapMine,
      )}`,
    ],
    ["Score bonuses", `Health ${b.healthBonus} · Ammo ${b.ammoBonus} · Speed ${b.speedBonus} · Accuracy ${b.accuracyBonus}`],
    ["Bonus features", `Path ${b.pathBonus} · Map ${b.mapCompletionBonus} · Lore ${b.loreBonus} · Secrets ${b.secretRoomBonus} · Streaks ${b.multikillBonus}`],
  ];
}

/** Minimum time (ms) an overlay must have been visible before any dismiss
 * trigger is honored — see `show()`'s doc comment. Long enough that a shot
 * fired (or the fire key already held) in the fight that ended the run can't
 * also instantly close the overlay it triggered, short enough not to read as
 * an artificial delay for a genuinely deliberate dismiss. */
const DISMISS_LOCK_MS = 1200;

/** Vertical layout constants shared between the box-height calculation and
 * the actual draw pass in `drawOverlay` — see its doc comment for why they
 * have to be the exact same numbers, not two independently-tuned formulas. */
const PAD_TOP = 40;
const LINE_GAP = 28;
const STATS_LEAD = 14;
const STAT_GAP = 20;
const PAD_BOTTOM = 26;
const BTN_W = 170;
const BTN_H = 32;
const PAD_AFTER_BTN = 22;
/** Space between the two buttons of a two-choice overlay. */
const BTN_GAP = 16;

/**
 * Width of a `wide` overlay's box.
 *
 * It was 620, which the `w - 48` clamp below then cut to 592 at Classic and
 * left at 620 at Sharp — so the "roomy" end-of-run box was two different
 * shapes depending on a render setting, and only one of them was the one it
 * was tuned against. Now that the overlay draws in a 640-wide design box the
 * clamp would produce 592 everywhere anyway; saying so directly is the point,
 * since a value that only ever arrives via a clamp reads as an accident. */
export const WIDE_BOX_W = DESIGN_WIDTH - 48;

/** Advance width of one character, as a fraction of the font size. Every
 * string on an overlay is set in `ui-monospace, monospace` — where all three
 * of the fonts below measure the same 0.602em per glyph regardless of weight
 * — so a character count *is* a width, and `overlayLayout` can size a box to
 * its content without ever calling `measureText`. That is what keeps it pure
 * (see its doc comment) and usable on a canvas with no 2D context.
 *
 * Rounded up from the measured 0.602 because the fallback font differs by
 * platform. The asymmetry is deliberate: an over-estimate pads the box by a
 * few pixels, while an under-estimate puts the squeeze back. And `fillText`'s
 * `maxWidth` still applies underneath, so even a badly wrong estimate here
 * degrades to the old squeezed rendering rather than letting text escape its
 * box. */
const CHAR_EM = 0.62;

/** The width `text` needs to render unsqueezed at `fontPx` — see `CHAR_EM`. */
function textWidth(fontPx: number, text: string): number {
  return text.length * fontPx * CHAR_EM;
}

/**
 * Greedy word-wrap of each of `lines` to `room` pixels at 13px.
 *
 * Measured with `textWidth` rather than `measureText` for the same reason
 * everything else here is: `overlayLayout` has to stay pure so `show()` can
 * hit-test without a 2D context. The overlay is monospace throughout, so the
 * estimate is exact up to the font's own advance width.
 *
 * A single word wider than `room` is kept intact rather than force-split —
 * same rule `drawLoreOverlay`'s `wrapText` follows, and for the same reason:
 * the words that trigger it are file paths, and breaking one mid-path makes it
 * unreadable in a way a slightly overhanging line does not. `overlayLayout`
 * already sizes the box to the longest word, so this is a backstop.
 */
function wrapOverlayLines(lines: readonly string[], room: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let current = "";
    for (const word of line.split(" ")) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (current !== "" && textWidth(13, candidate) > room) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
  }
  return out;
}

/** The largest of `STAT_VALUE_SIZES` at which `text` fits `room`, or the
 * smallest if none do — the caller's `maxWidth` still catches that last case,
 * so this narrows the squeeze rather than replacing the guard. */
function fittingSize(text: string, room: number): number {
  return STAT_VALUE_SIZES.find((size) => textWidth(size, text) <= room) ?? STAT_VALUE_SIZES[STAT_VALUE_SIZES.length - 1];
}

/** One button's rect, in design pixels (`overlayScale.ts`) — see
 * `overlayLayout`. The hit test in `show` converts a click into the same space
 * rather than the other way round. */
export interface OverlayButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything about an overlay's geometry, with nothing drawn. */
export interface OverlayGeometry {
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  contentEnd: number;
  /** Primary first, then the secondary if there is one. */
  buttons: OverlayButtonRect[];
  /** `content.lines`, wrapped to the box — what `drawOverlay` actually draws
   * and what the box height was computed from. One entry per drawn row, so a
   * caller counting rows and a caller drawing them cannot disagree. */
  lines: string[];
  /** Where a stats row's label ends and its value begins, as an offset from
   * `boxX`. `null` when the overlay has no stats. See `statsSplitFor`. */
  statsSplit: number | null;
}

/** Sizes a stat row's value may take, largest first — the same ladder idea
 * `hudLayout.ts`'s `NUMERAL_SIZES` uses, and for the same reason: the values
 * are content, not layout, so no single size serves both `42` and
 * `Path 250 · Map 100 · Lore 50 · Secrets 200 · Streaks 300`. Every row keeps
 * 13px unless it is the one that would otherwise be squeezed. */
const STAT_VALUE_SIZES = [13, 11] as const;

/** Padding inside the box, and the gap between a stat row's two columns. */
const STAT_INSET = 16;
const STAT_COL_GAP = 8;

/**
 * Where the label column ends, as an offset from `boxX`.
 *
 * **Content-driven rather than a fixed 50/50, because the halves wasted the
 * room the long values needed.** Labels here are short (`Kills`, `Closest
 * call`); values are sometimes a whole grouped sentence. Splitting the box in
 * two gave both sides 272px of a 592px box, which left the widest label 143px
 * of unused space while the widest value was cut off — and cut off *silently*,
 * since `fillText`'s `maxWidth` squeezes glyphs rather than eliding.
 *
 * This was already the behaviour at the Classic preset before the overlay layer
 * scaled; Sharp only looked correct because its box could grow to 757px. The
 * test that should have caught it ran at 1600x900, a canvas no preset produces.
 *
 * **The two columns together are still centred in the box**, which is the part
 * that is easy to lose: anchoring the label column at the left inset instead
 * gives each row the right *width* and the wrong *place*, leaving a short stats
 * block hard against the left edge under a centred title. Seen directly, on the
 * level-start briefing, whose three one- and two-digit rows occupy 80px of a
 * 420px box.
 */
function statsSplitFor(stats: readonly [string, string][], boxW: number): number {
  const labelW = Math.max(...stats.map(([label]) => textWidth(13, label)));
  // What is left for a value once the labels have their column. Also the width
  // the size ladder measures against — see `fittingSize`'s caller for why the
  // room actually available to the right of the split is never less than this
  // demands.
  const valueRoom = boxW - STAT_INSET * 2 - STAT_COL_GAP - labelW;
  const valueW = Math.max(...stats.map(([, value]) => textWidth(fittingSize(value, valueRoom), value)));
  const blockW = labelW + STAT_COL_GAP + valueW;
  return (boxW - blockW) / 2 + labelW;
}

/**
 * The overlay's geometry, as a pure function of canvas size and content.
 *
 * Split out of `drawOverlay` so `show()` can hit-test a mouse press against
 * the *same* rects that were drawn instead of recomputing them from its own
 * copy of the formula — the identical "one function, no drift" reason the
 * height is measured by running the content walk twice rather than by a
 * second hand-tuned formula (see `layout()` below).
 *
 * Pure, and deliberately so: nothing here touches the context, because the
 * content walk only accumulates constants and character counts, and never
 * calls `measureText` (the overlay is monospace throughout — see `CHAR_EM`).
 * That lets `show()` still wire up working input on a canvas whose 2D context
 * is unavailable, which is a real case the suite covers.
 */
export function overlayLayout(w: number, h: number, content: OverlayContent): OverlayGeometry {
  // Grow the box to what its content needs, rather than squeezing content
  // into a fixed box. `fillText`'s `maxWidth` (see `drawOverlay`) is a
  // backstop, not a layout — it compresses glyphs horizontally, so an
  // overrunning line renders legible but visibly squashed. That is what the
  // rollback death screen did in the shipped default: no stats rows means no
  // `wide`, leaving its 71-character lines 388px to live in and needing 556.
  // The two fixed sizes stay as *floors*, so nothing that already fits moves.
  const needed = Math.max(
    textWidth(22, content.title) + 32,
    // A line still asks for its full width, so nothing that fits today starts
    // wrapping — the box grows first, exactly as before. What changed is the
    // *fallback*: a line the box cannot grow far enough for used to be handed
    // to `fillText`'s `maxWidth` and squashed, and is now wrapped instead. Some
    // of them could never have been satisfied by a wider box at all —
    // `endReplay`'s balance-mismatch reason interpolates a file path and needs
    // 1,016px in a 592px design box.
    ...content.lines.map((line) => textWidth(13, line) + 32),
    // A stat row is a label column plus a value column, so what the box needs
    // is their sum — not twice the wider one, which is what a centred split
    // implied. The value is measured at the *smallest* size the ladder will
    // step down to: below that there is nothing left to give, so that is the
    // width at which "the box is too narrow" becomes true.
    ...(content.stats ?? []).map(
      ([label, value]) =>
        STAT_INSET * 2 +
        textWidth(13, label) +
        STAT_COL_GAP +
        textWidth(STAT_VALUE_SIZES[STAT_VALUE_SIZES.length - 1], value),
    ),
  );
  // `w - 48` is the last resort and stays last: past the canvas edge there is
  // no width left to give, and `maxWidth` squeezes as it always did.
  const boxW = Math.min(Math.max(content.wide ? WIDE_BOX_W : 420, needed), w - 48);

  const lines = wrapOverlayLines(content.lines, boxW - 32);
  let contentEnd = PAD_TOP;
  for (let i = 0; i < lines.length; i++) contentEnd += LINE_GAP;
  if (content.stats && content.stats.length > 0) {
    contentEnd += STATS_LEAD + (content.stats.length - 1) * STAT_GAP;
  }

  const boxH = contentEnd + PAD_BOTTOM + BTN_H + PAD_AFTER_BTN;
  const boxX = (w - boxW) / 2;
  const boxY = (h - boxH) / 2;

  // Branch-free on the button count: at one button this reproduces today's
  // `w / 2 - BTN_W / 2` exactly, so no existing overlay moves by a pixel. The
  // `Math.min` is the narrow-canvas clamp — it shrinks both buttons equally
  // rather than letting a two-button row run past its own box.
  const count = content.secondary ? 2 : 1;
  const btnW = Math.min(BTN_W, (boxW - 32 - (count - 1) * BTN_GAP) / count);
  const totalW = count * btnW + (count - 1) * BTN_GAP;
  const buttons = Array.from({ length: count }, (_, i) => ({
    x: w / 2 - totalW / 2 + i * (btnW + BTN_GAP),
    y: boxY + contentEnd + PAD_BOTTOM,
    w: btnW,
    h: BTN_H,
  }));

  const stats = content.stats ?? [];
  return {
    boxX,
    boxY,
    boxW,
    boxH,
    contentEnd,
    buttons,
    lines,
    statsSplit: stats.length > 0 ? statsSplitFor(stats, boxW) : null,
  };
}

/**
 * Paint a dark scrim + centered box over whatever's currently on the canvas
 * (the last rendered game frame, frozen since the engine either hasn't
 * started yet or has already stopped) — same "dim the frame behind it" look
 * the old DOM overlay had via its backdrop.
 */
function drawOverlay(ctx: CanvasRenderingContext2D, content: OverlayContent): void {
  withOverlayScale(ctx, (w, h) => {
    drawOverlayIn(ctx, w, h, content);
  });
}

/** `drawOverlay`'s body, in design space. Split out only so the wrapper stays
 * one line — the nested `layout` closure below is long enough already. */
function drawOverlayIn(ctx: CanvasRenderingContext2D, w: number, h: number, content: OverlayContent): void {
  const { boxX, boxY, boxW, boxH, buttons, lines, statsSplit } = overlayLayout(w, h, content);

  /**
   * Walks title -> lines -> stats, drawing at a running `y` offset from
   * `boxY`. The *measurement* half of this used to live here too, run with
   * `draw: false` purely to learn the content height; it now lives in
   * `overlayLayout` above, which is the one place the height is derived. The
   * hazard that split guards against is unchanged and worth restating: the
   * box height and the button position were once each computed by their own
   * hand-tuned formula that didn't match the real per-line/per-stat spacing,
   * so the button sometimes overlapped the last line of text above it.
   */
  function layout(y0: number): void {
    let y = y0 + PAD_TOP;
    ctx.font = "bold 22px ui-monospace, monospace";
    ctx.fillStyle = content.color;
    ctx.fillText(content.title, w / 2, y, boxW - 32);

    for (const line of lines) {
      y += LINE_GAP;
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillStyle = "#cdd3cd";
      ctx.fillText(line, w / 2, y, boxW - 32);
    }

    if (content.stats && content.stats.length > 0 && statsSplit !== null) {
      // Two columns that meet at `statsSplit` rather than at the box centre —
      // see `statsSplitFor`. Both still carry a `maxWidth`, so the "don't run
      // past the box" guarantee the title and lines get is unchanged; the
      // difference is that the value's share is now the room actually left
      // over instead of an arbitrary half.
      const labelX = boxX + statsSplit;
      const valueX = labelX + STAT_COL_GAP;
      const labelMaxWidth = statsSplit - STAT_INSET;
      // The room actually left to the right of the split. Centring the block
      // can only push the split *right* of the left inset, and it moves it by
      // half the slack, so this works out to at least the widest value's own
      // width — which is why sizing the ladder against the wider `valueRoom`
      // in `statsSplitFor` cannot pick a size that then fails to fit here.
      const valueMaxWidth = boxX + boxW - STAT_INSET - valueX;
      y += STATS_LEAD;
      for (const [label, value] of content.stats) {
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillStyle = "#8a9490";
        ctx.textAlign = "right";
        ctx.fillText(label, labelX, y, labelMaxWidth);

        // Step down only for a value that would not otherwise fit. Every row
        // on every shipped screen keeps 13px except `Bonus features`, whose
        // five grouped numbers need 451px against 423 — and a squeezed row is
        // less legible than a smaller one, because squeezing distorts glyph
        // shapes rather than scaling them.
        ctx.font = `bold ${fittingSize(value, valueMaxWidth)}px ui-monospace, monospace`;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.fillText(value, valueX, y, valueMaxWidth);
        ctx.textAlign = "center";
        y += STAT_GAP;
      }
    }
  }

  ctx.fillStyle = "rgba(2,3,4,0.88)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(4,6,8,0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = content.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  layout(boxY);

  // Primary filled, secondary outlined — that contrast *is* the "this one is
  // the default" cue, which is why there is no selection state to move around
  // and no redraw on input.
  const labels = [content.buttonLabel, ...(content.secondary ? [content.secondary.label] : [])];
  buttons.forEach((b, i) => {
    if (i === 0) {
      ctx.fillStyle = content.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#04120a";
    } else {
      ctx.strokeStyle = content.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      ctx.fillStyle = content.color;
    }
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.fillText(labels[i], b.x + b.w / 2, b.y + BTN_H / 2 + 4);
  });

  ctx.textAlign = "start";
}

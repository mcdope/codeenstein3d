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
    rollback?: { remaining: number; onRollback: () => void },
  ): void {
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
          : ["System stability reached 0%.", "The process was terminated."],
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
    const rects = overlayLayout(this.canvas.width, this.canvas.height, content).buttons;

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
      // `canvasFit.ts`, so client coordinates have to be scaled back into
      // canvas pixels — there is no other client-to-canvas mapping in the
      // codebase to reuse, since aiming goes through pointer lock and
      // `movementX` rather than coordinates. A zero-sized rect (jsdom, and a
      // display:none canvas) falls back to 1:1 rather than dividing by zero.
      const r = this.canvas.getBoundingClientRect();
      const sx = r.width > 0 ? this.canvas.width / r.width : 1;
      const sy = r.height > 0 ? this.canvas.height / r.height : 1;
      const x = (e.clientX - r.left) * sx;
      const y = (e.clientY - r.top) * sy;
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

/** One button's rect, in canvas pixels — see `overlayLayout`. */
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
 * content walk only accumulates constants and never calls `measureText`. That
 * lets `show()` still wire up working input on a canvas whose 2D context is
 * unavailable, which is a real case the suite covers.
 */
export function overlayLayout(w: number, h: number, content: OverlayContent): OverlayGeometry {
  const boxW = Math.min(content.wide ? 620 : 420, w - 48);

  let contentEnd = PAD_TOP;
  for (let i = 0; i < content.lines.length; i++) contentEnd += LINE_GAP;
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

  return { boxX, boxY, boxW, boxH, contentEnd, buttons };
}

/**
 * Paint a dark scrim + centered box over whatever's currently on the canvas
 * (the last rendered game frame, frozen since the engine either hasn't
 * started yet or has already stopped) — same "dim the frame behind it" look
 * the old DOM overlay had via its backdrop.
 */
function drawOverlay(ctx: CanvasRenderingContext2D, content: OverlayContent): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const { boxX, boxY, boxW, boxH, buttons } = overlayLayout(w, h, content);

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

    for (const line of content.lines) {
      y += LINE_GAP;
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillStyle = "#cdd3cd";
      ctx.fillText(line, w / 2, y, boxW - 32);
    }

    if (content.stats && content.stats.length > 0) {
      // Each side of the label/value split gets half the box, minus its own
      // padding and the 8px center gap — same "don't run past the box"
      // guarantee the title/lines above already get via their own maxWidth.
      const sideMaxWidth = boxW / 2 - 24;
      y += STATS_LEAD;
      for (const [label, value] of content.stats) {
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillStyle = "#8a9490";
        ctx.textAlign = "right";
        ctx.fillText(label, w / 2 - 8, y, sideMaxWidth);

        ctx.font = "bold 13px ui-monospace, monospace";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.fillText(value, w / 2 + 8, y, sideMaxWidth);
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

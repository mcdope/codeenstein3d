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

interface OverlayContent {
  title: string;
  /** Theme color for the title, box border, and button (a CSS color string). */
  color: string;
  lines: string[];
  stats?: [string, string][];
  buttonLabel: string;
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
  showKernelPanic(stats: StatsScreenInfo | undefined, onReturn: () => void): void {
    this.show(
      {
        title: "KERNEL PANIC",
        color: "#ff4d4d",
        lines: ["System stability reached 0%.", "The process was terminated."],
        stats: stats ? statRows(stats) : undefined,
        buttonLabel: "Return to file tree",
        wide: stats !== undefined,
      },
      onReturn,
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

    // Every one of these overlays can appear mid-fight (dying, or stepping on
    // the exit while still under fire) — with Space/mousedown also being the
    // fire controls, a player mashing the trigger the instant this appears
    // would otherwise dismiss it before they even see it. `shownAt` gates
    // every dismiss trigger below until `DISMISS_LOCK_MS` has actually
    // elapsed, rather than removing the listeners immediately.
    const shownAt = performance.now();
    const isLocked = (): boolean => performance.now() - shownAt < DISMISS_LOCK_MS;

    // Confirmable by the same triggers as firing a weapon in-game (Space,
    // mousedown — not "click", which only fires on release; a dialog should
    // dismiss the instant you pull the trigger, same as a shot would go off),
    // plus Enter/Escape for a conventional dialog feel. One-shot: every
    // listener removes itself the moment any of them fires (after the lock
    // above has expired).
    const dismiss = (): void => {
      if (isLocked()) return;
      window.removeEventListener("keydown", onKey);
      this.canvas.removeEventListener("mousedown", onMouseDown);
      cancelAnimationFrame(gamepadPollId);
      onAck();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === "Enter" || e.code === "Space" || e.code === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    const onMouseDown = (): void => dismiss();

    window.addEventListener("keydown", onKey);
    this.canvas.addEventListener("mousedown", onMouseDown);

    // No engine is running while any of these overlays is up (either it
    // hasn't started yet, or `RaycasterEngine.stop()` already cancelled its
    // own rAF loop before firing the handler that shows this one) — so
    // there's no `InputController` polling gamepad state to piggyback on.
    // Poll for "any button just pressed" directly here instead, same
    // one-shot-per-frame edge-trigger shape as `InputController.pollGamepad`,
    // gated by the same `isLocked()` a keyboard/mouse dismiss already is.
    let gamepadWasPressed = false;
    let gamepadPollId = 0;
    const pollGamepadDismiss = (): void => {
      const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
      const pad = Array.from(pads).find((p): p is Gamepad => p !== null);
      const pressed = pad?.buttons.some((b) => b.pressed) ?? false;
      if (pressed && !gamepadWasPressed) dismiss();
      gamepadWasPressed = pressed;
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

/**
 * Paint a dark scrim + centered box over whatever's currently on the canvas
 * (the last rendered game frame, frozen since the engine either hasn't
 * started yet or has already stopped) — same "dim the frame behind it" look
 * the old DOM overlay had via its backdrop.
 */
function drawOverlay(ctx: CanvasRenderingContext2D, content: OverlayContent): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const boxW = Math.min(content.wide ? 620 : 420, w - 48);

  /**
   * Walks title -> lines -> stats, advancing (and returning) a running `y`
   * offset from `y0`. Called twice: once with `draw: false` purely to learn
   * how tall the content actually is (so the box/button can be sized and
   * positioned correctly *before* anything is drawn), then again with
   * `draw: true` at the real box position. Using one function for both
   * means the measured height and the real drawing can never drift apart —
   * which a previous version did, with the box height and the button's
   * position each computed from their own separate, hand-tuned formula that
   * didn't actually match the real per-line/per-stat spacing, so the button
   * sometimes overlapped the last line of text above it.
   */
  function layout(y0: number, draw: boolean): number {
    let y = y0 + PAD_TOP;
    if (draw) {
      ctx.font = "bold 22px ui-monospace, monospace";
      ctx.fillStyle = content.color;
      ctx.fillText(content.title, w / 2, y, boxW - 32);
    }

    for (const line of content.lines) {
      y += LINE_GAP;
      if (draw) {
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillStyle = "#cdd3cd";
        ctx.fillText(line, w / 2, y, boxW - 32);
      }
    }

    if (content.stats && content.stats.length > 0) {
      // Each side of the label/value split gets half the box, minus its own
      // padding and the 8px center gap — same "don't run past the box"
      // guarantee the title/lines above already get via their own maxWidth.
      const sideMaxWidth = boxW / 2 - 24;
      y += STATS_LEAD;
      for (const [label, value] of content.stats) {
        if (draw) {
          ctx.font = "13px ui-monospace, monospace";
          ctx.fillStyle = "#8a9490";
          ctx.textAlign = "right";
          ctx.fillText(label, w / 2 - 8, y, sideMaxWidth);

          ctx.font = "bold 13px ui-monospace, monospace";
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "left";
          ctx.fillText(value, w / 2 + 8, y, sideMaxWidth);
          ctx.textAlign = "center";
        }
        y += STAT_GAP;
      }
      y -= STAT_GAP; // the last row doesn't need its own trailing gap
    }

    return y;
  }

  const contentEnd = layout(0, false);
  const boxH = contentEnd + PAD_BOTTOM + BTN_H + PAD_AFTER_BTN;
  const boxX = (w - boxW) / 2;
  const boxY = (h - boxH) / 2;

  ctx.fillStyle = "rgba(2,3,4,0.88)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(4,6,8,0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = content.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  layout(boxY, true);

  const btnY = boxY + contentEnd + PAD_BOTTOM;
  ctx.fillStyle = content.color;
  ctx.fillRect(w / 2 - BTN_W / 2, btnY, BTN_W, BTN_H);
  ctx.fillStyle = "#04120a";
  ctx.font = "bold 13px ui-monospace, monospace";
  ctx.fillText(content.buttonLabel, w / 2, btnY + BTN_H / 2 + 4);

  ctx.textAlign = "start";
}

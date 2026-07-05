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

/** AST/level stats shown on the pre-level briefing. */
export interface LevelStartInfo {
  campaign: string;
  levelName: string;
  roomCount: number;
  enemyCount: number;
}

/** Stats shown on the post-level commit summary. */
export interface CommitSummaryInfo {
  linesRefactored: number;
  bugsSquashed: number;
}

interface OverlayContent {
  title: string;
  /** Theme color for the title, box border, and button (a CSS color string). */
  color: string;
  lines: string[];
  stats?: [string, string][];
  buttonLabel: string;
}

export class GameHud {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  showKernelPanic(onReturn: () => void): void {
    this.show(
      {
        title: "KERNEL PANIC",
        color: "#ff4d4d",
        lines: ["System stability reached 0%.", "The process was terminated."],
        buttonLabel: "Return to file tree",
      },
      onReturn,
    );
  }

  showBuildSuccessful(onReturn: () => void): void {
    this.show(
      {
        title: "BUILD SUCCESSFUL",
        color: "#37d24a",
        lines: ["return statement reached. Exit code 0 —", "the module compiled clean."],
        buttonLabel: "Return to file tree",
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
        ],
        buttonLabel: "Continue",
      },
      onAck,
    );
  }

  private show(content: OverlayContent, onAck: () => void): void {
    const ctx = this.canvas.getContext("2d");
    if (ctx) drawOverlay(ctx, content);

    // Confirmable by the same triggers as firing a weapon in-game (Space,
    // mousedown — not "click", which only fires on release; a dialog should
    // dismiss the instant you pull the trigger, same as a shot would go off),
    // plus Enter/Escape for a conventional dialog feel. One-shot: every
    // listener removes itself the moment any of them fires.
    const dismiss = (): void => {
      window.removeEventListener("keydown", onKey);
      this.canvas.removeEventListener("mousedown", onMouseDown);
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
  }
}

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
  const boxW = Math.min(420, w - 48);

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
      y += STATS_LEAD;
      for (const [label, value] of content.stats) {
        if (draw) {
          ctx.font = "13px ui-monospace, monospace";
          ctx.fillStyle = "#8a9490";
          ctx.textAlign = "right";
          ctx.fillText(label, w / 2 - 8, y);

          ctx.font = "bold 13px ui-monospace, monospace";
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "left";
          ctx.fillText(value, w / 2 + 8, y);
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

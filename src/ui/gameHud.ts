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

/**
 * Paint a dark scrim + centered box over whatever's currently on the canvas
 * (the last rendered game frame, frozen since the engine either hasn't
 * started yet or has already stopped) — same "dim the frame behind it" look
 * the old DOM overlay had via its backdrop.
 */
function drawOverlay(ctx: CanvasRenderingContext2D, content: OverlayContent): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.fillStyle = "rgba(2,3,4,0.88)";
  ctx.fillRect(0, 0, w, h);

  const lineH = 18;
  const statH = 20;
  const statCount = content.stats?.length ?? 0;
  const boxH = 108 + content.lines.length * lineH + statCount * statH;
  const boxW = Math.min(420, w - 48);
  const boxX = (w - boxW) / 2;
  const boxY = (h - boxH) / 2;

  ctx.fillStyle = "rgba(4,6,8,0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = content.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let y = boxY + 40;

  ctx.font = "bold 22px ui-monospace, monospace";
  ctx.fillStyle = content.color;
  ctx.fillText(content.title, w / 2, y, boxW - 32);

  ctx.font = "13px ui-monospace, monospace";
  ctx.fillStyle = "#cdd3cd";
  for (const line of content.lines) {
    y += lineH + 10;
    ctx.fillText(line, w / 2, y, boxW - 32);
  }

  if (content.stats && content.stats.length > 0) {
    y += statH + 4;
    for (const [label, value] of content.stats) {
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillStyle = "#8a9490";
      ctx.textAlign = "right";
      ctx.fillText(label, w / 2 - 8, y);

      ctx.font = "bold 13px ui-monospace, monospace";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(value, w / 2 + 8, y);

      y += statH;
    }
    ctx.textAlign = "center";
  }

  const btnW = 170;
  const btnH = 32;
  const btnY = boxY + boxH - 22 - btnH;
  ctx.fillStyle = content.color;
  ctx.fillRect(w / 2 - btnW / 2, btnY, btnW, btnH);
  ctx.fillStyle = "#04120a";
  ctx.font = "bold 13px ui-monospace, monospace";
  ctx.fillText(content.buttonLabel, w / 2, btnY + btnH / 2 + 4);

  ctx.textAlign = "start";
}

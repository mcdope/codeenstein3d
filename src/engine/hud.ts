// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-world canvas overlay: the aiming crosshair. Player stats (stability,
 * heap, etc.) live in the HTML HUD (see src/ui/gameHud.ts).
 */

/**
 * Center crosshair; turns red when an enemy is targeted. When `spreadPx` > 0
 * (a cone weapon like the shotgun) faint ticks mark the pellet spread extent.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  hasTarget: boolean,
  spreadPx = 0,
): void {
  const cx = Math.floor(ctx.canvas.width / 2);
  const cy = Math.floor(ctx.canvas.height / 2);
  ctx.fillStyle = hasTarget ? "rgba(255,60,60,0.95)" : "rgba(255,255,255,0.6)";
  ctx.fillRect(cx - 6, cy, 13, 1);
  ctx.fillRect(cx, cy - 6, 1, 13);

  if (spreadPx > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(cx - spreadPx, cy - 4, 1, 9);
    ctx.fillRect(cx + spreadPx, cy - 4, 1, 9);
  }
}

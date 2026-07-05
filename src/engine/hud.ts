// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-world canvas overlay: the aiming crosshair and the retro status bar.
 * Both are drawn natively onto the 2D context after the 3D scene; only the
 * end-of-run overlays remain in the DOM (see src/ui/gameHud.ts).
 */
import type { EngineStats } from "./engine";

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

/** Height, in canvas pixels, of the native status bar at the bottom. */
const HUD_HEIGHT = 58;

/**
 * Doom/terminal-style status bar drawn across the bottom of the canvas. Call
 * this last (after the 3D scene, sprites and minimap) so it sits on top. Kept
 * deliberately minimal: System Stability (health), Heap (ammo), Keys, and
 * Score — no weapon name, enemy count, or targeted-entity name, so the UI
 * doesn't spoil source-code details while playing.
 */
export function drawHud(ctx: CanvasRenderingContext2D, stats: EngineStats): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const y0 = h - HUD_HEIGHT;

  // Panel background + top accent line.
  ctx.fillStyle = "rgba(4,8,4,0.92)";
  ctx.fillRect(0, y0, w, HUD_HEIGHT);
  ctx.fillStyle = "#1c5c24";
  ctx.fillRect(0, y0, w, 2);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const labelY = y0 + 17;
  const valueY = y0 + 41;

  // --- System Stability: label, bar, percentage ---
  const pct = Math.max(0, Math.min(100, (stats.health / stats.maxHealth) * 100));
  const low = pct <= 30;
  drawLabel(ctx, "SYSTEM STABILITY", 12, labelY);
  const barX = 12;
  const barY = y0 + 25;
  const barW = 120;
  const barH = 14;
  ctx.fillStyle = "#071007";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = low ? "#ff5a4a" : "#4cff6a";
  ctx.fillRect(barX, barY, (barW * pct) / 100, barH);
  ctx.strokeStyle = "#2f7a38";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  drawValue(ctx, `${stats.health}%`, barX + barW + 8, valueY, low ? "#ff6a5a" : "#4cff6a", 13);

  // --- Heap (ammo) ---
  drawLabel(ctx, "HEAP", 230, labelY);
  drawValue(ctx, String(stats.ammo), 230, valueY, stats.ammo <= 0 ? "#ff5a4a" : "#4cff6a", 22);

  // --- Keys ---
  drawLabel(ctx, "KEYS", 330, labelY);
  drawValue(ctx, `${stats.keysHeld}/${stats.keysTotal}`, 330, valueY, "#f2d64b", 22);

  // --- Score (right-aligned) ---
  ctx.textAlign = "right";
  drawLabel(ctx, "SCORE", w - 12, labelY);
  drawValue(ctx, String(stats.score), w - 12, valueY, "#4cff6a", 22);
  ctx.textAlign = "left";
}

/** Small uppercase caption; honors the current `textAlign`. */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = "9px ui-monospace, monospace";
  ctx.fillStyle = "#5aa869";
  ctx.fillText(text, x, y);
}

/** Bold value in `color` at `size` px; honors the current `textAlign`. */
function drawValue(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size: number,
): void {
  ctx.font = `bold ${size}px ui-monospace, monospace`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

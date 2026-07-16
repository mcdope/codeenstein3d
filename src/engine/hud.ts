// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-world canvas overlay: the aiming crosshair and the retro status bar.
 * Both are drawn natively onto the 2D context after the 3D scene; only the
 * end-of-run overlays remain in the DOM (see src/ui/gameHud.ts).
 */
import type { EngineStats } from "./engine";
import { WEAPONS } from "./weapons";

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

/**
 * Lightweight FPS/frame-time readout, top-right (clear of the top-left
 * minimap and the bottom status bar) — toggled by Right-Ctrl (see
 * `RaycasterEngine`'s `showFps`). Deliberately doesn't attempt CPU/GPU usage:
 * no standard browser API exposes that to page JS in a sandboxed context —
 * FPS and frame-time are the full, intentional scope.
 */
export function drawFpsOverlay(ctx: CanvasRenderingContext2D, fps: number, frameMs: number): void {
  const w = ctx.canvas.width;
  ctx.textAlign = "right";

  ctx.font = "9px ui-monospace, monospace";
  ctx.fillStyle = "#5aa869";
  ctx.fillText("FPS", w - 8, 14);

  ctx.font = "bold 13px ui-monospace, monospace";
  ctx.fillStyle = fps < 30 ? "#ff5a4a" : "#4cff6a";
  ctx.fillText(String(fps), w - 8, 30);

  ctx.font = "9px ui-monospace, monospace";
  ctx.fillStyle = "#5aa869";
  ctx.fillText(`${frameMs.toFixed(1)}ms`, w - 8, 44);

  ctx.textAlign = "start";
}

/**
 * Small top-center pill confirming a Doom cheat code just fired (see
 * `RaycasterEngine.applyCheat`) — transient feedback, not a blocking overlay;
 * `alpha` fades it out linearly as its frame-counted timer runs down.
 */
export function drawCheatToast(ctx: CanvasRenderingContext2D, text: string, alpha: number): void {
  const w = ctx.canvas.width;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.font = "bold 14px ui-monospace, monospace";
  const boxW = ctx.measureText(text).width + 24;
  const boxX = w / 2 - boxW / 2;
  ctx.fillStyle = "rgba(4,8,10,0.7)";
  ctx.fillRect(boxX, 26, boxW, 24);
  ctx.strokeStyle = "rgba(140,255,170,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 0.5, 26.5, boxW - 1, 23);
  ctx.fillStyle = "#8effa0";
  ctx.fillText(text, w / 2, 42);
  ctx.textAlign = "start";
  ctx.restore();
}

/**
 * "Multi Kill"/"Ultra Kill" banner (see
 * `RaycasterEngine.registerKillForStreak`) — a big, bold, Unreal-
 * Tournament-style announcement, deliberately not `drawCheatToast`'s small
 * top-corner confirmation pill: this is meant to read as a dramatic
 * mid-combat callout, not a quiet status confirmation. `big` (true for
 * "Ultra Kill") sizes and colors it more intensely than a "Multi Kill" —
 * same "smaller vs. bigger" relationship the streak's own SFX pair uses
 * (see `audio.ts`'s `playMultiKill`/`playUltraKill`). Same alpha-fade
 * convention as `drawCheatToast` — the caller ticks a frame counter down
 * and passes `framesLeft / totalFrames`. Positioned in the upper third of
 * the screen, clear of the crosshair and the bottom stat bar.
 */
export function drawKillStreakToast(ctx: CanvasRenderingContext2D, text: string, alpha: number, big: boolean): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.font = `bold ${big ? 48 : 36}px ui-monospace, monospace`;
  const y = h * 0.28;
  ctx.lineWidth = big ? 6 : 4;
  ctx.strokeStyle = big ? "#7a0d0d" : "#5a3d0d";
  ctx.strokeText(text, w / 2, y);
  ctx.fillStyle = big ? "#ff4d4d" : "#ffcf4d";
  ctx.fillText(text, w / 2, y);
  ctx.textAlign = "start";
  ctx.restore();
}

/**
 * Full-screen "PAUSED" scrim, drawn over one frozen frame of the scene —
 * triggered by the window losing focus or an Escape press (see
 * `RaycasterEngine`'s `isPaused`). Distinct from the Tab automap overlay,
 * though both freeze the sim the same way.
 */
export function drawPauseOverlay(ctx: CanvasRenderingContext2D): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  ctx.fillStyle = "rgba(0,4,2,0.72)";
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = "center";
  ctx.fillStyle = "#37d24a";
  ctx.font = "bold 28px ui-monospace, monospace";
  ctx.fillText("PAUSED", w / 2, h / 2 - 6);

  ctx.fillStyle = "#8effa0";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText("Click to resume, or press Esc again", w / 2, h / 2 + 20);
  ctx.textAlign = "start";
}

/**
 * Full-screen overlay showing a lore terminal's source comment — triggered by
 * "R" near a glowing wall (see `RaycasterEngine`'s `loreText`). Word-wraps the
 * raw comment text (delimiters and all) into a centered box that caps its own
 * height rather than growing off-screen; `scrollLines` (from the caller,
 * advanced by holding W/S while the overlay is up) picks which wrapped lines
 * are visible when the text doesn't fit. Returns the clamped max scroll
 * offset so the caller can keep its own scroll state in bounds.
 */
export function drawLoreOverlay(
  ctx: CanvasRenderingContext2D,
  text: string,
  scrollLines: number,
): { maxScrollLines: number } {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const boxW = Math.min(520, w - 48);
  const innerW = boxW - 48;

  ctx.font = "13px ui-monospace, monospace";
  const lines = wrapText(ctx, text, innerW);
  const lineH = 18;
  const boxH = Math.min(h - 40, 70 + lines.length * lineH);
  const maxVisibleLines = Math.floor((boxH - 58) / lineH);
  const maxScrollLines = Math.max(0, lines.length - maxVisibleLines);
  const scroll = Math.max(0, Math.min(Math.floor(scrollLines), maxScrollLines));

  ctx.fillStyle = "rgba(2,3,4,0.88)";
  ctx.fillRect(0, 0, w, h);

  const boxX = (w - boxW) / 2;
  const boxY = (h - boxH) / 2;
  ctx.fillStyle = "rgba(4,10,10,0.95)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "#3fd0e0";
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);

  ctx.textAlign = "center";
  ctx.fillStyle = "#3fd0e0";
  ctx.font = "bold 15px ui-monospace, monospace";
  ctx.fillText("LORE TERMINAL", w / 2, boxY + 24);

  ctx.textAlign = "left";
  ctx.font = "13px ui-monospace, monospace";
  ctx.fillStyle = "#cdd3cd";
  const textX = boxX + 24;
  let y = boxY + 48;
  for (const line of lines.slice(scroll, scroll + maxVisibleLines)) {
    ctx.fillText(line, textX, y);
    y += lineH;
  }

  // A slim scrollbar track + thumb along the box's right edge, only when the
  // text actually overflows — otherwise there's nothing to scroll.
  if (maxScrollLines > 0) {
    const trackX = boxX + boxW - 14;
    const trackY = boxY + 40;
    const trackH = boxH - 56;
    ctx.fillStyle = "rgba(63,208,224,0.2)";
    ctx.fillRect(trackX, trackY, 4, trackH);
    const thumbH = Math.max(16, trackH * (maxVisibleLines / lines.length));
    const thumbY = trackY + (trackH - thumbH) * (scroll / maxScrollLines);
    ctx.fillStyle = "#3fd0e0";
    ctx.fillRect(trackX, thumbY, 4, thumbH);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#7a9490";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText(
    maxScrollLines > 0 ? "W/S to scroll · R (or click) to close" : "Press R (or click) to close",
    w / 2,
    boxY + boxH - 12,
  );
  ctx.textAlign = "start";

  return { maxScrollLines };
}

/** Greedy word-wrap of `text` into lines no wider than `maxWidth`, honoring
 * existing newlines in the source comment as hard breaks. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Half-length, in canvas pixels, of the compass needle — sized to sit
 * comfortably inside the minimap's compass badge circle (see
 * `MinimapPanelRect.compassBadge`) with a little margin on every side. */
const COMPASS_NEEDLE_SIZE = 7;

/**
 * Exit compass: a small needle drawn centered in the minimap's own compass
 * badge (`compassBadge`, part of the `MinimapPanelRect` `renderMinimap`
 * returns) rather than a separate floating dial — the badge's own
 * background/border (drawn by `renderMinimap`, straddling the panel's
 * bottom-right corner) already separates it visually from the map itself.
 * Rotates to always point from the player's current position toward the exit
 * tile, *relative to the player's own facing* — so "dead ahead" always reads
 * as "up" on the needle, no matter which way the world-space player is
 * actually looking.
 *
 * An earlier version pointed its rest (bearing-zero) position along local +X
 * ("east"/3 o'clock) and only ever rotated from there — so a target dead
 * ahead of the player drew sideways instead of "up", and the left/right sense
 * of the sweep came out 90° off from what a glance expects (reported as an
 * inverted axis). Basing the needle geometry on local -Y ("up"/12 o'clock)
 * for bearing zero, then applying the exact same rotation this engine already
 * uses everywhere else (canvas `rotate()`/`Player.rotate()` are both
 * "positive angle = clockwise on screen", since the world grid and canvas
 * both put +Y down), fixes it: a target dead ahead now points up, one to the
 * right sweeps clockwise toward 3 o'clock, one to the left sweeps
 * counter-clockwise toward 9 o'clock.
 */
export function drawCompass(
  ctx: CanvasRenderingContext2D,
  badge: { cx: number; cy: number; r: number },
  playerX: number,
  playerY: number,
  playerAngle: number,
  exitX: number,
  exitY: number,
): void {
  const size = COMPASS_NEEDLE_SIZE;
  const cx = badge.cx;
  const cy = badge.cy;

  const angleToExit = Math.atan2(exitY - playerY, exitX - playerX);
  const bearing = angleToExit - playerAngle;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(bearing);
  ctx.fillStyle = "#8effa0";
  ctx.beginPath();
  ctx.moveTo(0, -size); // tip — bearing 0 ("dead ahead") points straight up
  ctx.lineTo(size * 0.55, size * 0.6);
  ctx.lineTo(0, size * 0.25);
  ctx.lineTo(-size * 0.55, size * 0.6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** Height, in canvas pixels, of the native status bar at the bottom. */
export const HUD_HEIGHT = 58;

/**
 * Doom/terminal-style status bar drawn across the bottom of the canvas. Call
 * this last (after the 3D scene, sprites and minimap) so it sits on top. Kept
 * deliberately minimal: System Stability (health), Swap, ammo for whichever
 * weapon is equipped, Keys, and Score — no weapon *name*, enemy count, or
 * targeted-entity name, so the UI doesn't spoil source-code details.
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
  const barW = 108;
  const barH = 14;
  ctx.fillStyle = "#071007";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = low ? "#ff5a4a" : "#4cff6a";
  ctx.fillRect(barX, barY, (barW * pct) / 100, barH);
  ctx.strokeStyle = "#2f7a38";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  drawValue(ctx, `${stats.health}%`, barX + barW + 8, valueY, low ? "#ff6a5a" : "#4cff6a", 13);

  // --- Swap ---
  drawLabel(ctx, "SWAP", 205, labelY);
  drawValue(ctx, String(stats.swap), 205, valueY, stats.swap > 0 ? "#4a7fff" : "#5a6a8a", 20);

  // --- Ammo for whichever weapon is equipped: melee shows an infinity mark,
  // otherwise the label/value swap to BULLETS, ROCKETS, SMG AMMO, or GAS as
  // the player switches weapons, so what's on screen always matches what
  // firing spends. ---
  const weapon = WEAPONS[stats.weaponIndex];
  if (weapon.ammoType === "rockets") {
    drawLabel(ctx, "ROCKETS", 275, labelY);
    drawValue(ctx, String(stats.rockets), 275, valueY, stats.rockets <= 0 ? "#ff5a4a" : "#ff9d3f", 22);
  } else if (weapon.ammoType === "bullets") {
    drawLabel(ctx, "BULLETS", 275, labelY);
    drawValue(ctx, String(stats.bullets), 275, valueY, stats.bullets <= 0 ? "#ff5a4a" : "#4cff6a", 22);
  } else if (weapon.ammoType === "smg") {
    drawLabel(ctx, "SMG AMMO", 275, labelY);
    drawValue(ctx, String(stats.smg), 275, valueY, stats.smg <= 0 ? "#ff5a4a" : "#3fa9ff", 22);
  } else if (weapon.ammoType === "gas") {
    drawLabel(ctx, "GAS", 275, labelY);
    // Friday Hotfix's ammoPerShot is fractional (2.5/shot), so stats.gas can
    // land on a half-unit — floor it here rather than showing "37.5".
    drawValue(ctx, String(Math.floor(stats.gas)), 275, valueY, stats.gas <= 0 ? "#ff5a4a" : "#ff8a4a", 22);
  } else {
    drawLabel(ctx, "MELEE", 275, labelY);
    drawValue(ctx, "∞", 275, valueY, "#d8dde3", 22);
  }

  // --- Keys ---
  drawLabel(ctx, "KEYS", 375, labelY);
  drawValue(ctx, `${stats.keysHeld}/${stats.keysTotal}`, 375, valueY, "#f2d64b", 22);

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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-world canvas overlay: the aiming crosshair and the retro status bar.
 * Both are drawn natively onto the 2D context after the 3D scene; only the
 * end-of-run overlays remain in the DOM (see src/ui/gameHud.ts).
 */
import { AMMO_META } from "./ammo";
import type { EngineStats, PlayerId } from "./engine";
import {
  HUD_HEIGHT,
  HUD_PAD,
  KEY_COLS,
  KEY_PIP,
  KEY_PIP_PITCH,
  KEY_ROWS,
  LABEL_AMMO,
  LABEL_KEYS,
  LABEL_SCORE,
  LABEL_STABIL,
  LABEL_TOOLS,
  LABEL_SWAP,
  layoutHud,
  type HudLayout,
  type HudPanelRect,
  TOOL_CELL,
  TOOL_GAP,
} from "./hudLayout";
import { faceGlyph, faceKeyFor } from "./hudFace";
import { drawGlyph, drawRotatedGlyph, outlineRect, type Glyph } from "./pathSprites";
import { COUNTDOWN_DISPLAY_HZ } from "./transitionConstants";
import { NUMBER_KEY_WEAPONS, WEAPONS, type AmmoType } from "./weapons";

/**
 * How much of `type` the player has left, out of `EngineStats`.
 *
 * `EngineStats` spells its pools out as flat sibling fields rather than
 * carrying an `AmmoPools`, so a pool cannot be looked up by name — this is the
 * one place that mapping is needed, and being a `switch` over `AmmoType` means
 * a future pool fails to compile here rather than silently reading nothing.
 */
function ammoRemaining(stats: EngineStats, type: AmmoType): number {
  switch (type) {
    case "bullets":
      return stats.bullets;
    case "shells":
      return stats.shells;
    case "rockets":
      return stats.rockets;
    case "smg":
      return stats.smg;
    case "gas":
      return stats.gas;
  }
}

/** Same one-line capitalization `main.ts`'s `multiplayerResultRows` uses for
 * a `PlayerId` — duplicated here rather than imported, since `main.ts`
 * itself depends on the engine, not the other way around. */
function playerIdLabel(id: PlayerId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

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
  outlineRect(ctx, boxX + 0.5, 26.5, boxW - 1, 23);
  ctx.fillStyle = "#8effa0";
  ctx.fillText(text, w / 2, 42);
  ctx.textAlign = "start";
  ctx.restore();
}

/**
 * Small top-center pill warning that the equipped weapon just dry-fired
 * (see `RaycasterEngine.fire`'s out-of-ammo branch) — same small-pill
 * geometry as `drawCheatToast` (so it doesn't compete with the big
 * mid-screen `drawKillStreakToast` banner) but with an urgent red palette
 * instead of the green confirmation one, since this is a warning, not a
 * success confirmation. Fades out quickly relative to the other toasts —
 * see `OUT_OF_AMMO_TOAST_FRAMES`'s doc comment for why. Message is fixed
 * (unlike the cheat/kill-streak toasts), so this function owns its own
 * string rather than taking one in.
 */
export function drawOutOfAmmoToast(ctx: CanvasRenderingContext2D, alpha: number): void {
  const w = ctx.canvas.width;
  const text = "Out of ammo!";
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.font = "bold 14px ui-monospace, monospace";
  const boxW = ctx.measureText(text).width + 24;
  const boxX = w / 2 - boxW / 2;
  ctx.fillStyle = "rgba(4,8,10,0.7)";
  ctx.fillRect(boxX, 26, boxW, 24);
  ctx.strokeStyle = "rgba(255,77,77,0.6)";
  ctx.lineWidth = 1;
  outlineRect(ctx, boxX + 0.5, 26.5, boxW - 1, 23);
  ctx.fillStyle = "#ff4d4d";
  ctx.fillText(text, w / 2, 42);
  ctx.textAlign = "start";
  ctx.restore();
}

/**
 * "Acid Overflow room started flooding" warning (see
 * `src/engine/acidOverflow.ts`). Same shape and fade convention as
 * `drawOutOfAmmoToast`, in the hazard tiles' own warm orange rather than the
 * out-of-ammo red, so the colour itself points at what changed underfoot.
 *
 * Sits one row below `drawOutOfAmmoToast`'s box rather than on top of it: both
 * are triggered by things the player did (walking in, pulling an empty
 * trigger) and can genuinely land in the same second.
 */
export function drawAcidOverflowToast(ctx: CanvasRenderingContext2D, alpha: number): void {
  const w = ctx.canvas.width;
  const text = "Memory leak — acid rising!";
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.font = "bold 14px ui-monospace, monospace";
  const boxW = ctx.measureText(text).width + 24;
  const boxX = w / 2 - boxW / 2;
  ctx.fillStyle = "rgba(4,8,10,0.7)";
  ctx.fillRect(boxX, 56, boxW, 24);
  ctx.strokeStyle = "rgba(255,157,31,0.6)";
  ctx.lineWidth = 1;
  outlineRect(ctx, boxX + 0.5, 56.5, boxW - 1, 23);
  ctx.fillStyle = "#ff9d1f";
  ctx.fillText(text, w / 2, 72);
  ctx.textAlign = "start";
  ctx.restore();
}

/** Gate tones for HUD use, by value rather than shared import — the same
 * "each renderer keeps its own thematically-matched constants" convention the
 * minimap and automap colours follow. Indexed by `Gate.colorIndex`; deliberately
 * no yellow, which already means "keyless branch door". */
const HUD_GATE_COLORS = ["#d63a30", "#3470d6", "#34b25c", "#a848d6"];
/** Matches `GATE_COLOR_NAMES` in `gateColors.ts` — the words a player reads. */
const HUD_GATE_NAMES = ["red", "blue", "green", "violet"];

/**
 * "You need the blue key!" — walked into a locked door without that gate's key
 * (see `RaycasterEngine.cueLockedDoorHint`). Same pill shape and fade
 * convention as the two toasts above, drawn in **that gate's** colour, which is
 * the exact colour the door itself is painted in the world, on the minimap and
 * on the automap. Naming the colour is most of the legibility this mechanic
 * buys: the message tells you which key, and the colour tells you which door.
 *
 * Third row (y=86), below the acid warning rather than sharing either of the
 * rows above it. Dry-firing while shoving a door is an entirely ordinary
 * thing to do, so this and `drawOutOfAmmoToast` genuinely land in the same
 * second — the same collision `drawAcidOverflowToast` was moved down to avoid.
 */
export function drawLockedDoorToast(
  ctx: CanvasRenderingContext2D,
  alpha: number,
  colorIndex: number,
  blockerColorIndex = -1,
): void {
  const w = ctx.canvas.width;
  const text = `You need the ${HUD_GATE_NAMES[colorIndex]} key!`;
  // The second line exists because naming the key was not enough: keys are
  // chained, so the one being asked for is usually behind another door and the
  // player was left with a colour and no lead (measured at 71% of doors at the
  // moment they are first met). `-1` is "the key you want is reachable" — the
  // case this toast has always covered, and it stays a single line.
  const lead = blockerColorIndex >= 0 ? `→ find the ${HUD_GATE_NAMES[blockerColorIndex]} key first` : null;
  const tone = HUD_GATE_COLORS[colorIndex];
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = "center";
  ctx.font = "bold 14px ui-monospace, monospace";
  const leadWidth = lead === null ? 0 : ctx.measureText(lead).width;
  const boxW = Math.max(ctx.measureText(text).width, leadWidth) + 24;
  const boxX = w / 2 - boxW / 2;
  const boxH = lead === null ? 24 : 42;
  ctx.fillStyle = "rgba(4,8,10,0.7)";
  ctx.fillRect(boxX, 86, boxW, boxH);
  ctx.strokeStyle = tone;
  ctx.lineWidth = 1;
  outlineRect(ctx, boxX + 0.5, 86.5, boxW - 1, boxH - 1);
  ctx.fillStyle = tone;
  ctx.fillText(text, w / 2, 102);
  if (lead !== null) {
    // Tinted as the *blocking* gate, not the asked-for one: the whole point of
    // the line is to send the player at a different door, and the colour is
    // what they will actually match against the world.
    ctx.fillStyle = HUD_GATE_COLORS[blockerColorIndex];
    ctx.fillText(lead, w / 2, 120);
  }
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
 * "Build finishing in Ns…" banner shown once any player touches the exit in
 * a multiplayer session (`RaycasterEngine.getExitCountdownRemaining`) — a
 * quiet top-of-screen readout, not a full scrim: unlike `drawPauseOverlay`
 * the sim keeps running underneath and stays fully visible/interactable
 * throughout. `remainingTicks` is whatever tick count the engine reports;
 * this function owns the ticks-to-seconds conversion (see
 * `COUNTDOWN_DISPLAY_HZ`'s own doc comment for why that rate is hand-kept in
 * sync with the real tick rate rather than imported).
 */
export function drawExitCountdownToast(ctx: CanvasRenderingContext2D, remainingTicks: number): void {
  const w = ctx.canvas.width;
  const seconds = Math.max(0, Math.ceil(remainingTicks / COUNTDOWN_DISPLAY_HZ));
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 22px ui-monospace, monospace";
  const y = 40;
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#0d3d1a";
  ctx.strokeText(`Build finishing in ${seconds}s…`, w / 2, y);
  ctx.fillStyle = "#8effa0";
  ctx.fillText(`Build finishing in ${seconds}s…`, w / 2, y);
  ctx.textAlign = "start";
  ctx.restore();
}

/**
 * "YOU DIED — spectating <teammate>" banner — a quiet, standing readout (same
 * shape as `drawExitCountdownToast`, but red-tinted rather than green) shown
 * whenever the local player is dead but the run keeps going, so a coop death
 * doesn't silently swap the camera to a teammate's POV with zero on-screen
 * explanation (see `RaycasterEngine.killPlayer`/`cycleSpectateTarget`).
 * `spectateTargetId` is `null` only when every teammate is also dead, which
 * is a one-frame state on the way to the run actually ending — still worth
 * a distinct message rather than a blank/incorrect name. Only ever called
 * for a multiplayer session — see `renderNormalFrame`'s call site.
 */
export function drawSpectatingBanner(ctx: CanvasRenderingContext2D, spectateTargetId: PlayerId | null): void {
  const w = ctx.canvas.width;
  const text =
    spectateTargetId === null
      ? "YOU DIED — no living teammates to spectate"
      : `YOU DIED — spectating ${playerIdLabel(spectateTargetId)}`;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 22px ui-monospace, monospace";
  const y = 40;
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#5a0d0d";
  ctx.strokeText(text, w / 2, y);
  ctx.fillStyle = "#ff8a8a";
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
  outlineRect(ctx, boxX + 1, boxY + 1, boxW - 2, boxH - 2);

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

/** The needle itself, at bearing zero — pre-rendered per rotation step rather
 * than path-filled live every frame; see `pathSprites.ts` for why. The
 * geometry is unchanged: tip on local -Y ("up"/12 o'clock), which is what
 * makes "dead ahead" read as "up" (see this function's doc comment). */
const COMPASS_NEEDLE_GLYPH: Glyph = {
  width: COMPASS_NEEDLE_SIZE * 2 + 4,
  height: COMPASS_NEEDLE_SIZE * 2 + 4,
  anchorX: COMPASS_NEEDLE_SIZE + 2,
  anchorY: COMPASS_NEEDLE_SIZE + 2,
  draw: (g, ox, oy) => {
    const size = COMPASS_NEEDLE_SIZE;
    g.fillStyle = "#8effa0";
    g.beginPath();
    g.moveTo(ox, oy - size); // tip — bearing 0 ("dead ahead") points straight up
    g.lineTo(ox + size * 0.55, oy + size * 0.6);
    g.lineTo(ox, oy + size * 0.25);
    g.lineTo(ox - size * 0.55, oy + size * 0.6);
    g.closePath();
    g.fill();
  },
};

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
  const angleToExit = Math.atan2(exitY - playerY, exitX - playerX);
  const bearing = angleToExit - playerAngle;

  drawRotatedGlyph(ctx, COMPASS_NEEDLE_GLYPH, bearing, badge.cx, badge.cy);
}

/** Re-exported so `automap.ts` and the tests keep importing it from here —
 * the value and its derivation live in `hudLayout.ts` with the rest of the
 * geometry. */
export { HUD_HEIGHT };

/**
 * Doom/terminal-style status bar drawn across the bottom of the canvas. Call
 * this last (after the 3D scene, sprites and minimap) so it sits on top. Kept
 * deliberately minimal: System Stability (health), Swap, ammo for whichever
 * weapon is equipped, Keys, and Score — no weapon *name*, enemy count, or
 * targeted-entity name, so the UI doesn't spoil source-code details.
 */
export function drawHud(ctx: CanvasRenderingContext2D, stats: EngineStats): void {
  const L = layoutHud(ctx.canvas.width, ctx.canvas.height);
  drawBarChrome(ctx, L);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  drawAmmoPanel(ctx, L.panels.ammo, stats);
  drawStabilPanel(ctx, L.panels.stabil, stats);
  drawSwapPanel(ctx, L.panels.swap, stats);
  drawKeysPanel(ctx, L.panels.keys, stats);
  drawToolsPanel(ctx, L.panels.tools, stats);
  drawFacePanel(ctx, L.panels.face, stats);
  drawScorePanel(ctx, L.panels.score, stats);
  drawAmmoTable(ctx, L.panels.table, stats);

  if (stats.cheatsUsed) drawCheatedRunBadge(ctx, L.bar.y);
}

/** Background, top accent and the bezel rules between panels. */
function drawBarChrome(ctx: CanvasRenderingContext2D, L: HudLayout): void {
  ctx.fillStyle = "rgba(4,8,4,0.92)";
  ctx.fillRect(L.bar.x, L.bar.y, L.bar.w, L.bar.h);
  ctx.fillStyle = "#1c5c24";
  ctx.fillRect(L.bar.x, L.bar.y, L.bar.w, 2);
  // Bezel rules. `fillRect` rather than a stroked line on purpose — see
  // `outlineRect`'s doc: the expensive class is anything Skia cannot emit as
  // an axis-aligned quad, and "always fills" is the version of that rule that
  // cannot be got wrong later.
  ctx.fillStyle = "#123f18";
  for (const x of L.dividers) ctx.fillRect(x, L.bar.y + 2, 1, L.bar.h - 2);
}

/** Baseline of a panel's 9px label row, relative to the bar's top. */
const LABEL_DY = 14;
/** Baseline of a panel's big numeral. */
const VALUE_DY = 44;
/** Top of the 14px strip band — stability bar, TOOLS cells, and the *bottom*
 * row of the KEYS grid, which grows upward out of the band. */
const STRIP_DY = 50;
const STRIP_H = 14;

/** A big numeral, right-aligned inside `rect` — DOOM's own habit, and what
 * keeps a panel that grew wider looking composed instead of leaving a gap.
 * Restores `textAlign` so the next panel starts from a known state. */
function drawNumeral(ctx: CanvasRenderingContext2D, text: string, rect: HudPanelRect, color: string, size: number): void {
  ctx.textAlign = "right";
  drawValue(ctx, text, rect.x + rect.w - HUD_PAD, rect.y + VALUE_DY, color, size);
  ctx.textAlign = "left";
}

/** Ammo for whichever weapon is equipped: melee shows an infinity mark,
 * otherwise the label/value swap to BULLETS, ROCKETS, SMG AMMO or GAS as the
 * player switches, so what is on screen always matches what firing spends.
 *
 * One readout driven by the active weapon's own pool rather than a branch per
 * pool — it was four hand-written branches differing only in which `stats`
 * field they read and which two strings they passed, and a fifth pool for the
 * shotgun would have made it five. `AMMO_META` already owned the label and now
 * owns the colour too. */
function drawAmmoPanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  const weapon = WEAPONS[stats.weaponIndex];
  if (!weapon.ammoType) {
    drawLabel(ctx, "MELEE", rect.x + HUD_PAD, rect.y + LABEL_DY);
    drawNumeral(ctx, "\u221e", rect, "#d8dde3", 22);
    return;
  }
  const meta = AMMO_META[weapon.ammoType];
  const owned = ammoRemaining(stats, weapon.ammoType);
  // Friday Hotfix's ammoPerShot is fractional (2.5/shot) so its pool can land
  // on a half-unit — floored rather than showing "37.5". Every other pool is
  // integral, so this is a no-op for them.
  //
  // `stats` reports the *total* owned, so the reserve shown beside the
  // magazine is that total minus what is already in the gun — the familiar
  // "9 / 31" split. A weapon with no magazine (Friday Hotfix) keeps the single
  // bare number it always had.
  const value = stats.magazineSize > 0 ? `${stats.magazine} / ${Math.floor(owned - stats.magazine)}` : String(Math.floor(owned));
  // The panel is labelled AMMO, not the pool's name. The pool used to be
  // spelled out here because nothing else on the bar said which one was being
  // spent — the table now does, by lighting that pool's row, so repeating it
  // would say the same thing twice and cost the width DOOM spends on a
  // four-letter word.
  drawLabel(ctx, stats.reloading ? "RELOADING" : LABEL_AMMO, rect.x + HUD_PAD, rect.y + LABEL_DY);
  // Dry means "nothing left to fire *and* nothing to reload with", not merely
  // an empty magazine — an empty gun with a full reserve is a one-second
  // problem, and colouring it as critical would cry wolf.
  drawNumeral(ctx, value, rect, owned <= 0 ? "#ff5a4a" : meta.hudColor, 22);
}

/** System Stability: label, big percentage, and a bar across the strip band. */
function drawStabilPanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  const pct = Math.max(0, Math.min(100, (stats.health / stats.maxHealth) * 100));
  const low = pct <= 30;
  drawLabel(ctx, LABEL_STABIL, rect.x + HUD_PAD, rect.y + LABEL_DY);
  drawNumeral(ctx, `${Math.round(stats.health)}%`, rect, low ? "#ff5a4a" : "#4cff6a", 22);
  const barX = rect.x + HUD_PAD;
  const barY = rect.y + STRIP_DY;
  const barW = rect.w - HUD_PAD * 2;
  ctx.fillStyle = "#071007";
  ctx.fillRect(barX, barY, barW, STRIP_H);
  ctx.fillStyle = low ? "#ff5a4a" : "#4cff6a";
  ctx.fillRect(barX, barY, (barW * pct) / 100, STRIP_H);
  ctx.strokeStyle = "#2f7a38";
  ctx.lineWidth = 1;
  outlineRect(ctx, barX + 0.5, barY + 0.5, barW - 1, STRIP_H - 1);
}

/** Swap — DOOM's ARMOR slot keeping this game's word. Structurally parallel to
 * stability: a numeral over a capacity strip, so the two read as a pair. */
function drawSwapPanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  drawLabel(ctx, LABEL_SWAP, rect.x + HUD_PAD, rect.y + LABEL_DY);
  drawNumeral(ctx, String(stats.swap), rect, stats.swap > 0 ? "#4a7fff" : "#5a6a8a", 22);
  const barX = rect.x + HUD_PAD;
  const barY = rect.y + STRIP_DY;
  const barW = rect.w - HUD_PAD * 2;
  const frac = stats.maxSwap > 0 ? Math.max(0, Math.min(1, stats.swap / stats.maxSwap)) : 0;
  ctx.fillStyle = "#070a10";
  ctx.fillRect(barX, barY, barW, STRIP_H);
  ctx.fillStyle = "#4a7fff";
  ctx.fillRect(barX, barY, barW * frac, STRIP_H);
  ctx.strokeStyle = "#2f4a7a";
  ctx.lineWidth = 1;
  outlineRect(ctx, barX + 0.5, barY + 0.5, barW - 1, STRIP_H - 1);
}

/** Keys: one pip per gate on the level, filled once held, on a 2x2 grid.
 *
 * A held/total count stopped meaning anything when keys became permanent
 * per-gate inventory: it degrades into "collected / collectable", a
 * completionist stat wearing a resource's clothes. Which *colours* you hold is
 * the thing that decides whether the door in front of you opens.
 *
 * Two columns, not one row. `MAX_GATE_ROOMS` is 4 and levels measure p50 2 /
 * p90 3, so a fixed block is still the right idiom and no count or scroll is
 * needed — but four in a row needs 68px and the Classic preset grants this
 * panel 47, which is how the violet pip came to hang into SCORE. The grid is
 * bounded by `KEY_COLS * KEY_ROWS` rather than by the gate count, so the width
 * `hudLayout` reserves is the width this can ever draw.
 *
 * It grows *upward*: the bottom row sits on the strip band, level with the
 * stability and swap bars and the TOOLS cells, so the median two-gate level
 * keeps the row it has always had and only a third key adds anything above.
 */
function drawKeysPanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  drawLabel(ctx, LABEL_KEYS, rect.x + HUD_PAD, rect.y + LABEL_DY);
  if (stats.gateColors.length === 0) {
    drawNumeral(ctx, "\u2014", rect, "#5a6a8a", 22);
    return;
  }
  const held = new Set(stats.heldGates);
  // Clamped by slicing rather than by a guard: generation caps gates at
  // `MAX_GATE_ROOMS`, so an `if` here would be a branch no test could reach.
  // Without it a fifth gate would open a third row straight through the label.
  const shown = stats.gateColors.slice(0, KEY_COLS * KEY_ROWS);
  const top = rect.y + STRIP_DY - (Math.ceil(shown.length / KEY_COLS) - 1) * KEY_PIP_PITCH;
  shown.forEach((colorIndex, gateId) => {
    const x = rect.x + HUD_PAD + (gateId % KEY_COLS) * KEY_PIP_PITCH;
    const y = top + Math.floor(gateId / KEY_COLS) * KEY_PIP_PITCH;
    ctx.fillStyle = HUD_GATE_COLORS[colorIndex];
    if (held.has(gateId)) {
      ctx.fillRect(x, y, KEY_PIP, KEY_PIP);
    } else {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      outlineRect(ctx, x + 0.5, y + 0.5, KEY_PIP - 1, KEY_PIP - 1);
    }
  });
}

/**
 * Display order for the ammo table's rows.
 *
 * **Deliberately not `AMMO_TYPES`.** That array's order is a replay
 * determinism constant (`ammo.ts`) — it decides the sequence a disconnecting
 * player's inventory converts to drops, which is why new pools are appended
 * and never inserted. Reordering it to suit a table would be a determinism
 * change dressed as a UI tidy-up. This is the renderer's own order, and a test
 * pins it so that swap can never happen silently.
 */
const HUD_AMMO_ROW_ORDER: readonly AmmoType[] = ["bullets", "shells", "smg", "rockets", "gas"];

/** Row pitch and first baseline for the ammo table, the pair `HUD_HEIGHT` was
 * derived from — see `hudLayout.ts`. */
const TABLE_ROW_PITCH = 12;
const TABLE_FIRST_BASELINE = 16;

/**
 * Every pool at once, DOOM's far-right column.
 *
 * **One number per row, no denominator.** DOOM prints `current / max` because
 * DOOM has per-type maxima that a backpack raises. This game has no cap
 * anywhere — nothing in `ammo.ts` or `lootApply.ts` clamps a pool, and the
 * only ceiling in the codebase is the `IDKFA` cheat's. Printing an invented
 * maximum would assert a mechanic that does not exist, and adding a real one
 * would change scores (`computeScore` measures leftover ammo), which changes
 * the shipped highscore board and every recorded replay. A balance change is
 * not a HUD change.
 *
 * The equipped weapon's row is lit in its own `hudColor` while the rest stay
 * dim, so the eye connects this column to the AMMO panel. Those two readouts
 * are consistent by construction rather than by coincidence: AMMO shows
 * `loaded / reserve` and this shows the pooled total, and loaded + reserve is
 * that total.
 */
function drawAmmoTable(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  const equipped = WEAPONS[stats.weaponIndex].ammoType;
  HUD_AMMO_ROW_ORDER.forEach((type, row) => {
    const meta = AMMO_META[type];
    const y = rect.y + TABLE_FIRST_BASELINE + row * TABLE_ROW_PITCH;
    const lit = type === equipped;
    drawLabel(ctx, meta.short, rect.x + HUD_PAD, y, lit ? meta.hudColor : "#3f6b46");
    ctx.textAlign = "right";
    // Floored: gas is fractional (Friday Hotfix spends 2.5 a shot). A no-op
    // for the four integral pools.
    drawValue(ctx, String(Math.floor(ammoRemaining(stats, type))), rect.x + rect.w - HUD_PAD, y, lit ? meta.hudColor : "#5a6a8a", 11);
    ctx.textAlign = "left";
  });
}

/** Cell geometry for the TOOLS grid. */

/**
 * DOOM's ARMS panel, keeping this game's word: which dev tools you are
 * carrying, and which one is in your hands.
 *
 * **Bound to `NUMBER_KEY_WEAPONS`, never to `WEAPONS` order.** They diverge for
 * everything past the knife — `WEAPONS[3]` is gdb but its number key is `3`,
 * not `4` — and a `WEAPONS`-indexed grid would light the wrong cell for three
 * of the five weapons. That exact off-by-one already shipped once in the bot's
 * key dispatch; `numberKeyCodeFor`'s doc comment records it.
 *
 * The cell count is the list's length rather than a literal 5, so a future
 * non-melee weapon grows the grid for free — which is the same reason
 * `NUMBER_KEY_WEAPONS` is derived rather than hardcoded.
 *
 * **Number-key weapons only — melee is deliberately absent.** It had a
 * trailing cell showing `K`, or `T` once the Toolchain replaced the knife.
 * That was wrong twice over. A letter in a grid of number keys reads as a
 * keybind, and `K` is not bound to anything — melee is on Space. And the cell
 * could only ever show one of the three states the grid exists to distinguish:
 * the knife is a starting weapon, so it is never not-owned, and melee is not
 * reachable by the number keys this grid depicts, so it is never the equipped
 * one either. It carried a single bit at the cost of the panel's whole
 * premise. Which melee weapon you hold is already legible from the AMMO panel,
 * which shows `MELEE` and an infinity mark whenever one is in your hands, and
 * from the weapon drawn on screen.
 */
function drawToolsPanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  drawLabel(ctx, LABEL_TOOLS, rect.x + HUD_PAD, rect.y + LABEL_DY);
  const owned = new Set(stats.ownedWeapons);
  const y = rect.y + STRIP_DY;
  let x = rect.x + HUD_PAD;

  const cell = (text: string, isOwned: boolean, isEquipped: boolean): void => {
    if (isEquipped) {
      ctx.fillStyle = "#1c5c24";
      ctx.fillRect(x, y, TOOL_CELL, TOOL_CELL);
    } else if (isOwned) {
      ctx.strokeStyle = "#5aa869";
      ctx.lineWidth = 1;
      outlineRect(ctx, x + 0.5, y + 0.5, TOOL_CELL - 1, TOOL_CELL - 1);
    }
    // Two channels carry the state, not one: a box *and* the digit's tone, so
    // neither has to be read on its own at 9px.
    ctx.textAlign = "center";
    drawValue(ctx, text, x + TOOL_CELL / 2, y + TOOL_CELL - 3, isEquipped ? "#8effa0" : isOwned ? "#5aa869" : "#2f4a33", 10);
    ctx.textAlign = "left";
    x += TOOL_CELL + TOOL_GAP;
  };

  NUMBER_KEY_WEAPONS.forEach((weaponIndex, slot) => {
    cell(String(slot + 1), owned.has(weaponIndex), stats.weaponIndex === weaponIndex);
  });
}

/**
 * The face — DOOM's `STFACE`, reacting to health, to a kill streak, and to the
 * direction the last hit came from.
 *
 * One `drawImage` per frame. Every expression is a pre-rendered glyph built on
 * first use (`hudFace.ts`), so which way the face is looking selects a
 * different sprite rather than doing more work — the direction costs nothing.
 */
function drawFacePanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  const glyph = faceGlyph(faceKeyFor(stats));
  // Centred in the bar's *full* height, not hung from the top. The first
  // version anchored the sprite two pixels under the accent, which put the
  // hair line hard against it and left a band of empty bezel underneath — the
  // face read as falling out of the bar rather than sitting in it. This is the
  // one panel with no label row to align to, so it centres on its own.
  drawGlyph(ctx, glyph, rect.x + rect.w / 2, rect.y + rect.h / 2);
}

/** Running campaign total. DOOM has no score panel; this keeps ours in the
 * numeral template so it reads as part of the bar rather than as a caption. */
function drawScorePanel(ctx: CanvasRenderingContext2D, rect: HudPanelRect, stats: EngineStats): void {
  drawLabel(ctx, LABEL_SCORE, rect.x + HUD_PAD, rect.y + LABEL_DY);
  drawNumeral(ctx, String(stats.score), rect, "#4cff6a", 22);
}

/**
 * Persistent "this run no longer counts" badge, drawn for the rest of the
 * campaign once any cheat has fired — distinct from `drawCheatToast`, which
 * confirms the keystroke and fades in about a second.
 *
 * It exists because the consequence used to be invisible until the run ended:
 * `recordRunHighscore` drops a cheated run *and its replay* entirely, and said
 * so only in a console line printed at game over. A playtest was lost to
 * exactly that. The game knows the moment the cheat fires; this is it saying
 * so.
 *
 * Sits on the HUD panel's own top edge rather than in the panel: every slot
 * inside it is spoken for, and the width between them varies with canvas size,
 * so anything placed among them would collide on some viewport. Top-center is
 * taken too — that is where the transient toasts appear, and this must not
 * compete with the very toast that precedes it.
 */
function drawCheatedRunBadge(ctx: CanvasRenderingContext2D, y0: number): void {
  const text = "⚠ CHEATS USED — RUN NOT RECORDED";
  const w = ctx.canvas.width;
  ctx.save();
  ctx.font = "bold 9px ui-monospace, monospace";
  ctx.textAlign = "right";
  const boxW = ctx.measureText(text).width + 12;
  const boxH = 13;
  const boxY = y0 - boxH - 2;
  ctx.fillStyle = "rgba(4,8,10,0.8)";
  ctx.fillRect(w - 12 - boxW, boxY, boxW, boxH);
  ctx.strokeStyle = "rgba(255,90,74,0.6)";
  ctx.lineWidth = 1;
  outlineRect(ctx, w - 12 - boxW + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
  ctx.fillStyle = "#ff5a4a";
  ctx.fillText(text, w - 18, boxY + 9);
  ctx.textAlign = "left";
  ctx.restore();
}

/** Small uppercase caption; honors the current `textAlign`. */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = "#5aa869"): void {
  ctx.font = "9px ui-monospace, monospace";
  ctx.fillStyle = color;
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

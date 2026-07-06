// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * First-person weapon viewmodel, drawn natively with Canvas 2D primitives
 * (`fillRect` + path `lineTo`) — no image assets. The engine computes the live
 * bob/recoil state (see head-bob and recoil handling in engine.ts) and passes
 * it in each frame; this module is a pure renderer. Each weapon gets its own
 * silhouette (see `WeaponViewKind`) so switching weapons is visible even
 * before the HUD's ammo label catches up.
 */
import type { WeaponViewKind } from "./weapons";

/** Per-frame weapon placement, in screen pixels / normalized recoil. */
export interface WeaponView {
  /** Horizontal head-bob offset. */
  bobX: number;
  /** Vertical head-bob offset. */
  bobY: number;
  /** Recoil amount, 1 = just fired, easing to 0 at rest. */
  recoil: number;
  /** Whether to draw the muzzle flash this frame (never true for melee). */
  flash: boolean;
  /** Which weapon's silhouette to draw. */
  kind: WeaponViewKind;
}

/** Draw the equipped weapon at the bottom center-right of the canvas. */
export function drawWeapon(ctx: CanvasRenderingContext2D, v: WeaponView): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Recoil kicks the gun down and back (toward the viewer): a downward push
  // plus a small drop that reads as the weapon recoiling into the corner.
  const recoilDown = v.recoil * 18;
  const recoilBack = v.recoil * 8;

  const cx = w * 0.52 + v.bobX; // gun center, biased right of screen center
  const baseY = h + v.bobY + recoilDown; // resting baseline sits on the bottom edge

  ctx.save();
  ctx.lineJoin = "round";

  switch (v.kind) {
    case "shotgun":
      drawShotgun(ctx, cx, baseY, recoilBack, v.flash);
      break;
    case "knife":
      drawKnife(ctx, cx, baseY, v.recoil);
      break;
    case "mp":
      drawMp(ctx, cx, baseY, recoilBack, v.flash);
      break;
    case "rocket":
      drawRocketLauncher(ctx, cx, baseY, recoilBack, v.flash);
      break;
    case "pistol":
    default:
      drawPistol(ctx, cx, baseY, recoilBack, v.flash);
      break;
  }

  ctx.restore();
}

/** The original blaster silhouette — a slim single barrel and boxy receiver. */
function drawPistol(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const barrelTop = baseY - 168 + recoilBack;
  ctx.fillStyle = "#1b1b21";
  ctx.fillRect(cx - 9, barrelTop, 18, baseY - 78 - barrelTop);
  ctx.fillStyle = "#3a3a46";
  ctx.fillRect(cx - 4, barrelTop + 4, 4, baseY - 92 - barrelTop); // inner highlight

  ctx.fillStyle = "#55555f";
  ctx.fillRect(cx - 13, barrelTop - 10, 26, 12);

  ctx.fillStyle = "#26262c";
  ctx.fillRect(cx - 36, baseY - 92, 72, 74);
  ctx.fillStyle = "#3d3d47";
  ctx.fillRect(cx - 36, baseY - 92, 72, 6);
  ctx.fillStyle = "#17171c";
  ctx.fillRect(cx + 24, baseY - 86, 8, 62);

  drawGrip(ctx, cx, baseY);

  if (flash) drawMuzzleFlash(ctx, cx, barrelTop - 8, 22, 9);
}

/** Wider, boxier, double-barrel silhouette. */
function drawShotgun(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const barrelTop = baseY - 180 + recoilBack;
  const barrelH = baseY - 84 - barrelTop;
  // Two parallel barrels, side by side.
  ctx.fillStyle = "#20201f";
  ctx.fillRect(cx - 17, barrelTop, 13, barrelH);
  ctx.fillRect(cx + 4, barrelTop, 13, barrelH);
  ctx.fillStyle = "#45443f";
  ctx.fillRect(cx - 14, barrelTop + 4, 3, barrelH - 10);
  ctx.fillRect(cx + 7, barrelTop + 4, 3, barrelH - 10);

  // Wood-toned pump/forend under the barrels.
  ctx.fillStyle = "#5a3f22";
  ctx.fillRect(cx - 20, baseY - 118, 40, 20);

  ctx.fillStyle = "#3a3226";
  ctx.fillRect(cx - 22, baseY - 26, 60, 20); // trigger-guard block, wide receiver

  ctx.fillStyle = "#2a2a24";
  ctx.fillRect(cx - 42, baseY - 96, 84, 70); // bulkier receiver than the pistol
  ctx.fillStyle = "#4a4a3f";
  ctx.fillRect(cx - 42, baseY - 96, 84, 6);

  drawGrip(ctx, cx, baseY);

  if (flash) {
    drawMuzzleFlash(ctx, cx - 10, barrelTop - 8, 24, 10);
    drawMuzzleFlash(ctx, cx + 10, barrelTop - 8, 24, 10);
  }
}

/** A held blade, angled to the lower-right — no barrel, no receiver, no
 * muzzle flash (a stab doesn't have one). Handle, crossguard, and blade are
 * one rigid shape stacked bottom-to-top and thrust together as a unit — they
 * used to be positioned from two different baselines (the handle fixed, the
 * blade/crossguard offset by the thrust animation), which left a visible gap
 * between the grip and the blade instead of a single connected knife. */
function drawKnife(ctx: CanvasRenderingContext2D, cx: number, baseY: number, recoil: number): void {
  // The stab thrusts the whole knife up instead of the gun's "kick back"
  // recoil — recoil 1 = fully extended, easing back to resting.
  const thrust = recoil * 46;
  const bx = cx + 34;
  const by = baseY - thrust;

  // Handle (grip), held low-right.
  ctx.fillStyle = "#2a2018";
  ctx.beginPath();
  ctx.moveTo(bx - 10, by - 4);
  ctx.lineTo(bx + 16, by - 4);
  ctx.lineTo(bx + 10, by - 46);
  ctx.lineTo(bx - 16, by - 46);
  ctx.closePath();
  ctx.fill();

  // Crossguard, sitting directly on top of the handle.
  ctx.fillStyle = "#55555f";
  ctx.fillRect(bx - 20, by - 54, 40, 8);

  // Blade: a tapered polygon rising from the crossguard, with a bright edge
  // highlight.
  ctx.fillStyle = "#c7ccd4";
  ctx.beginPath();
  ctx.moveTo(bx - 9, by - 54);
  ctx.lineTo(bx + 9, by - 54);
  ctx.lineTo(bx - 2, by - 140);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#eef1f5";
  ctx.fillRect(bx - 6, by - 132, 3, 76);
}

/** Slim, long-barreled submachine gun with a stick magazine underneath. */
function drawMp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const barrelTop = baseY - 190 + recoilBack;
  ctx.fillStyle = "#26282c";
  ctx.fillRect(cx - 5, barrelTop, 10, baseY - 90 - barrelTop); // slim, long barrel
  ctx.fillStyle = "#3a3d42";
  ctx.fillRect(cx - 2, barrelTop + 4, 2, baseY - 100 - barrelTop);

  ctx.fillStyle = "#1f2124";
  ctx.fillRect(cx - 28, baseY - 96, 56, 46); // compact receiver

  // Stick magazine, angled down.
  ctx.fillStyle = "#151719";
  ctx.beginPath();
  ctx.moveTo(cx - 6, baseY - 56);
  ctx.lineTo(cx + 10, baseY - 56);
  ctx.lineTo(cx + 4, baseY - 6);
  ctx.lineTo(cx - 12, baseY - 6);
  ctx.closePath();
  ctx.fill();

  // Folding stock hint, low and to the side.
  ctx.strokeStyle = "#3a3d42";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx + 26, baseY - 60);
  ctx.lineTo(cx + 46, baseY - 30);
  ctx.stroke();

  drawGrip(ctx, cx, baseY);

  if (flash) drawMuzzleFlash(ctx, cx, barrelTop - 6, 14, 6); // small, fast-cycling flash
}

/** A big shoulder-mounted tube — no pistol-grip silhouette at all. */
function drawRocketLauncher(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const tubeTop = baseY - 190 + recoilBack;
  const tubeH = baseY - 40 - tubeTop;

  // The tube itself: thick, dark, resting diagonally over the shoulder.
  ctx.fillStyle = "#2e3630";
  ctx.fillRect(cx - 26, tubeTop, 52, tubeH);
  ctx.fillStyle = "#454f47";
  ctx.fillRect(cx - 26, tubeTop, 52, 10); // front rim highlight
  ctx.fillStyle = "#1c211d";
  ctx.fillRect(cx + 16, tubeTop + 10, 10, tubeH - 20); // shadow side

  // Warning stripe near the muzzle.
  ctx.fillStyle = "#e0483a";
  ctx.fillRect(cx - 26, tubeTop + 14, 52, 6);

  // Rear grip/trigger housing under the tube.
  ctx.fillStyle = "#22271f";
  ctx.fillRect(cx - 16, baseY - 46, 34, 26);

  if (flash) drawMuzzleFlash(ctx, cx, tubeTop - 10, 30, 14); // biggest flash of the arsenal
}

/** Angled trigger-guard/grip polygon shared by the gun-shaped weapons. */
function drawGrip(ctx: CanvasRenderingContext2D, cx: number, baseY: number): void {
  ctx.fillStyle = "#22222a";
  ctx.beginPath();
  ctx.moveTo(cx - 12, baseY - 26);
  ctx.lineTo(cx + 20, baseY - 26);
  ctx.lineTo(cx + 8, baseY + 40);
  ctx.lineTo(cx - 26, baseY + 40);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#4a4a55";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, baseY - 30);
  ctx.lineTo(cx - 22, baseY - 12);
  ctx.stroke();
}

function drawMuzzleFlash(ctx: CanvasRenderingContext2D, fx: number, fy: number, outer: number, inner: number): void {
  ctx.fillStyle = "rgba(255,150,40,0.9)";
  star(ctx, fx, fy, outer, inner, 6);
  ctx.fillStyle = "rgba(255,240,150,0.95)";
  star(ctx, fx, fy, outer * 0.55, inner * 0.55, 6);
}

/** Fill a simple n-point star centered at (x,y) — used for the muzzle flash. */
function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outer: number,
  inner: number,
  points: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

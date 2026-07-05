// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * First-person weapon viewmodel, drawn natively with Canvas 2D primitives
 * (`fillRect` + path `lineTo`) — no image assets. The engine computes the live
 * bob/recoil state (see head-bob and recoil handling in engine.ts) and passes
 * it in each frame; this module is a pure renderer.
 */

/** Per-frame weapon placement, in screen pixels / normalized recoil. */
export interface WeaponView {
  /** Horizontal head-bob offset. */
  bobX: number;
  /** Vertical head-bob offset. */
  bobY: number;
  /** Recoil amount, 1 = just fired, easing to 0 at rest. */
  recoil: number;
  /** Whether to draw the muzzle flash this frame. */
  flash: boolean;
}

/** Draw the stylized blaster at the bottom center-right of the canvas. */
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

  // --- Barrel (points up toward the crosshair) ---
  const barrelTop = baseY - 168 + recoilBack;
  ctx.fillStyle = "#1b1b21";
  ctx.fillRect(cx - 9, barrelTop, 18, baseY - 78 - barrelTop);
  ctx.fillStyle = "#3a3a46";
  ctx.fillRect(cx - 4, barrelTop + 4, 4, baseY - 92 - barrelTop); // inner highlight

  // Muzzle block at the barrel tip.
  ctx.fillStyle = "#55555f";
  ctx.fillRect(cx - 13, barrelTop - 10, 26, 12);

  // --- Receiver / body ---
  ctx.fillStyle = "#26262c";
  ctx.fillRect(cx - 36, baseY - 92, 72, 74);
  ctx.fillStyle = "#3d3d47";
  ctx.fillRect(cx - 36, baseY - 92, 72, 6); // top edge highlight
  ctx.fillStyle = "#17171c";
  ctx.fillRect(cx + 24, baseY - 86, 8, 62); // right-side shadow

  // --- Grip (angled polygon via lineTo) ---
  ctx.fillStyle = "#22222a";
  ctx.beginPath();
  ctx.moveTo(cx - 12, baseY - 26);
  ctx.lineTo(cx + 20, baseY - 26);
  ctx.lineTo(cx + 8, baseY + 40);
  ctx.lineTo(cx - 26, baseY + 40);
  ctx.closePath();
  ctx.fill();

  // Trigger guard hint.
  ctx.strokeStyle = "#4a4a55";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 14, baseY - 30);
  ctx.lineTo(cx - 22, baseY - 12);
  ctx.stroke();

  // --- Muzzle flash ---
  if (v.flash) {
    const fx = cx;
    const fy = barrelTop - 8;
    ctx.fillStyle = "rgba(255,150,40,0.9)";
    star(ctx, fx, fy, 22, 9, 6);
    ctx.fillStyle = "rgba(255,240,150,0.95)";
    star(ctx, fx, fy, 12, 5, 6);
  }

  ctx.restore();
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

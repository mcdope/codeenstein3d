// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * First-person weapon viewmodel, drawn natively with Canvas 2D primitives
 * (`fillRect` + path `lineTo`) — no image assets. The engine computes the live
 * bob/recoil state (see head-bob and recoil handling in engine.ts) and passes
 * it in each frame; this module is a pure renderer. Each weapon gets its own
 * silhouette (see `WeaponViewKind`) so switching weapons is visible even
 * before the HUD's ammo label catches up. Every body shape gets a thin dark
 * outline stroke plus a top-highlight/bottom-shadow pair rather than one flat
 * fill, so silhouettes read with some bevel/depth against the dark backdrop
 * instead of as flat cutouts.
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

/** Gun center's horizontal position — dead-center of the canvas, matching the
 * fixed screen-bottom-center point `RaycasterEngine.fire()` fires its tracer/
 * flame-stream from (see `makeBulletTrace`/`spawnFlameStream` in effects.ts)
 * and the crosshair's own x. The gun used to be drawn 2% right of center,
 * which put its barrel visibly out of line with where shots actually
 * appeared to originate — the fix is to move the drawn weapon to match the
 * simulation's fixed muzzle point, not the other way around (the tracer
 * origin is simulation-adjacent and shared by every weapon; the viewmodel is
 * a cosmetic overlay, so it's the one that should conform). */
const WEAPON_CENTER_BIAS = 0.5;
const RECOIL_DOWN_PX = 18;
const RECOIL_BACK_PX = 8;

/** Thin dark outline stroke shared by every weapon's body shapes — gives
 * flat canvas-primitive fills a defined edge against the dark backdrop
 * instead of reading as a flat cutout. */
const OUTLINE_COLOR = "#0a0a0d";
const OUTLINE_WIDTH = 1.5;

/** A weapon's barrel/tube/nozzle length (from `baseY` up to its structural
 * top) and the further distance from there up to the actual muzzle mouth —
 * the exact point `drawMuzzleFlash`/`drawFlameBurst` fires from in each
 * draw* function below. Keeps each draw* function's own barrel-top
 * calculation and its muzzle-flash call reading from one shared number
 * instead of two separately-hardcoded literals that could drift apart. */
interface MuzzleGeometry {
  barrelLen: number;
  flashOffset: number;
}
type RangedViewKind = Exclude<WeaponViewKind, "knife" | "chainsaw">;
const MUZZLE_GEOMETRY: Record<RangedViewKind, MuzzleGeometry> = {
  pistol: { barrelLen: 168, flashOffset: 8 },
  shotgun: { barrelLen: 180, flashOffset: 8 },
  mp: { barrelLen: 190, flashOffset: 6 },
  rocket: { barrelLen: 190, flashOffset: 10 },
  flamethrower: { barrelLen: 130, flashOffset: 14 },
};

/** Draw the equipped weapon at the bottom center of the canvas. */
export function drawWeapon(ctx: CanvasRenderingContext2D, v: WeaponView): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Recoil kicks the gun down and back (toward the viewer): a downward push
  // plus a small drop that reads as the weapon recoiling into the corner.
  const recoilDown = v.recoil * RECOIL_DOWN_PX;
  const recoilBack = v.recoil * RECOIL_BACK_PX;

  const cx = w * WEAPON_CENTER_BIAS + v.bobX; // gun center, matching the tracer's fixed x origin
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
    case "chainsaw":
      drawChainsaw(ctx, cx, baseY, v.recoil);
      break;
    case "mp":
      drawMp(ctx, cx, baseY, recoilBack, v.flash);
      break;
    case "rocket":
      drawRocketLauncher(ctx, cx, baseY, recoilBack, v.flash);
      break;
    case "flamethrower":
      drawFlamethrower(ctx, cx, baseY, recoilBack, v.flash);
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
  const { barrelLen, flashOffset } = MUZZLE_GEOMETRY.pistol;
  const barrelTop = baseY - barrelLen + recoilBack;
  const barrelH = baseY - 78 - barrelTop;

  ctx.fillStyle = "#1b1b21";
  ctx.fillRect(cx - 9, barrelTop, 18, barrelH);
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeRect(cx - 9, barrelTop, 18, barrelH);
  ctx.fillStyle = "#3a3a46";
  ctx.fillRect(cx - 4, barrelTop + 4, 4, baseY - 92 - barrelTop); // inner highlight

  ctx.fillStyle = "#55555f";
  ctx.fillRect(cx - 13, barrelTop - 10, 26, 12); // rear sight block
  ctx.strokeRect(cx - 13, barrelTop - 10, 26, 12);

  ctx.fillStyle = "#26262c";
  ctx.fillRect(cx - 36, baseY - 92, 72, 74); // receiver
  ctx.fillStyle = "#3d3d47";
  ctx.fillRect(cx - 36, baseY - 92, 72, 6); // top highlight
  ctx.fillStyle = "#1a1a1f";
  ctx.fillRect(cx - 36, baseY - 24, 72, 6); // bottom shadow
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeRect(cx - 36, baseY - 92, 72, 74);

  ctx.fillStyle = "#17171c";
  ctx.fillRect(cx + 24, baseY - 86, 8, 62); // rear grip-tang detail

  drawGrip(ctx, cx, baseY);

  if (flash) drawMuzzleFlash(ctx, cx, barrelTop - flashOffset, 22, 9);
}

/** Wider, boxier, double-barrel silhouette. */
function drawShotgun(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const { barrelLen, flashOffset } = MUZZLE_GEOMETRY.shotgun;
  const barrelTop = baseY - barrelLen + recoilBack;
  const barrelH = baseY - 84 - barrelTop;

  // Two parallel barrels, side by side.
  ctx.fillStyle = "#20201f";
  ctx.fillRect(cx - 17, barrelTop, 13, barrelH);
  ctx.fillRect(cx + 4, barrelTop, 13, barrelH);
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeRect(cx - 17, barrelTop, 13, barrelH);
  ctx.strokeRect(cx + 4, barrelTop, 13, barrelH);
  ctx.fillStyle = "#45443f";
  ctx.fillRect(cx - 14, barrelTop + 4, 3, barrelH - 10);
  ctx.fillRect(cx + 7, barrelTop + 4, 3, barrelH - 10);

  // Wood-toned pump/forend under the barrels.
  ctx.fillStyle = "#5a3f22";
  ctx.fillRect(cx - 20, baseY - 118, 40, 20);
  ctx.strokeStyle = "#2e2110";
  ctx.strokeRect(cx - 20, baseY - 118, 40, 20);

  ctx.fillStyle = "#3a3226";
  ctx.fillRect(cx - 22, baseY - 26, 60, 20); // trigger-guard block, wide receiver
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeRect(cx - 22, baseY - 26, 60, 20);

  ctx.fillStyle = "#2a2a24";
  ctx.fillRect(cx - 42, baseY - 96, 84, 70); // bulkier receiver than the pistol
  ctx.fillStyle = "#4a4a3f";
  ctx.fillRect(cx - 42, baseY - 96, 84, 6); // top highlight
  ctx.fillStyle = "#1e1e19";
  ctx.fillRect(cx - 42, baseY - 32, 84, 6); // bottom shadow
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.strokeRect(cx - 42, baseY - 96, 84, 70);

  drawGrip(ctx, cx, baseY);

  if (flash) {
    drawMuzzleFlash(ctx, cx - 10, barrelTop - flashOffset, 24, 10);
    drawMuzzleFlash(ctx, cx + 10, barrelTop - flashOffset, 24, 10);
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
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();

  // Crossguard, sitting directly on top of the handle.
  ctx.fillStyle = "#55555f";
  ctx.fillRect(bx - 20, by - 54, 40, 8);
  ctx.strokeRect(bx - 20, by - 54, 40, 8);

  // Blade: a tapered polygon rising from the crossguard, with a bright edge
  // highlight and a mid-tone outline (a near-black stroke would muddy the
  // bright fill, unlike every other weapon's dark body shapes).
  ctx.fillStyle = "#c7ccd4";
  ctx.beginPath();
  ctx.moveTo(bx - 9, by - 54);
  ctx.lineTo(bx + 9, by - 54);
  ctx.lineTo(bx - 2, by - 140);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#8a8f97";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#eef1f5";
  ctx.fillRect(bx - 6, by - 132, 3, 76);
}

/** A bulkier two-handed alternative to the knife: a blocky motor housing and
 * rear grip with a long, tooth-notched guide bar thrusting forward — no
 * muzzle flash, same as the knife. Reuses the knife's up-thrust recoil
 * animation directly (each hold-to-fire swing sets `recoil` back to 1), so
 * holding the trigger reads as a repeated revving chug for free without any
 * extra animation state. */
function drawChainsaw(ctx: CanvasRenderingContext2D, cx: number, baseY: number, recoil: number): void {
  const thrust = recoil * 40;
  const bx = cx + 30;
  const by = baseY - thrust;

  // Rear grip, held low-right.
  ctx.fillStyle = "#2a2018";
  ctx.beginPath();
  ctx.moveTo(bx - 8, by - 2);
  ctx.lineTo(bx + 20, by - 2);
  ctx.lineTo(bx + 14, by - 40);
  ctx.lineTo(bx - 14, by - 40);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();

  // Motor housing: a blocky body sitting on top of the grip.
  ctx.fillStyle = "#3a3f36";
  ctx.fillRect(bx - 26, by - 78, 52, 42);
  ctx.fillStyle = "#565d51";
  ctx.fillRect(bx - 26, by - 78, 52, 6); // top rim highlight
  ctx.fillStyle = "#e0483a";
  ctx.fillRect(bx - 26, by - 46, 52, 6); // warning stripe, same idea as the rocket launcher's
  ctx.fillStyle = "#232821";
  ctx.fillRect(bx - 26, by - 40, 52, 4); // bottom shadow
  ctx.strokeRect(bx - 26, by - 78, 52, 42);

  // Guide bar, extending up-and-left from the housing.
  ctx.fillStyle = "#4c4f52";
  ctx.beginPath();
  ctx.moveTo(bx - 20, by - 74);
  ctx.lineTo(bx - 2, by - 74);
  ctx.lineTo(bx - 10, by - 156);
  ctx.lineTo(bx - 24, by - 156);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Chain teeth: a row of small triangular notches down the bar's leading edge.
  ctx.fillStyle = "#c7ccd4";
  const teeth = 6;
  for (let i = 0; i < teeth; i++) {
    const t = i / (teeth - 1);
    const ty = by - 82 - t * 68;
    const tx = bx - 22 - t * 1.5;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 8, ty - 3);
    ctx.lineTo(tx, ty - 8);
    ctx.closePath();
    ctx.fill();
  }
}

/** Slim, long-barreled submachine gun with a stick magazine underneath. */
function drawMp(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const { barrelLen, flashOffset } = MUZZLE_GEOMETRY.mp;
  const barrelTop = baseY - barrelLen + recoilBack;

  ctx.fillStyle = "#26282c";
  ctx.fillRect(cx - 5, barrelTop, 10, baseY - 90 - barrelTop); // slim, long barrel
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeRect(cx - 5, barrelTop, 10, baseY - 90 - barrelTop);
  ctx.fillStyle = "#3a3d42";
  ctx.fillRect(cx - 2, barrelTop + 4, 2, baseY - 100 - barrelTop);

  ctx.fillStyle = "#1f2124";
  ctx.fillRect(cx - 28, baseY - 96, 56, 46); // compact receiver
  ctx.fillStyle = "#33363b";
  ctx.fillRect(cx - 28, baseY - 96, 56, 5); // top highlight
  ctx.fillStyle = "#16171a";
  ctx.fillRect(cx - 28, baseY - 55, 56, 5); // bottom shadow
  ctx.strokeRect(cx - 28, baseY - 96, 56, 46);

  // Stick magazine, angled down.
  ctx.fillStyle = "#151719";
  ctx.beginPath();
  ctx.moveTo(cx - 6, baseY - 56);
  ctx.lineTo(cx + 10, baseY - 56);
  ctx.lineTo(cx + 4, baseY - 6);
  ctx.lineTo(cx - 12, baseY - 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Folding stock hint, low and to the side.
  ctx.strokeStyle = "#3a3d42";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx + 26, baseY - 60);
  ctx.lineTo(cx + 46, baseY - 30);
  ctx.stroke();

  drawGrip(ctx, cx, baseY);

  if (flash) drawMuzzleFlash(ctx, cx, barrelTop - flashOffset, 14, 6); // small, fast-cycling flash
}

/** A big shoulder-mounted tube — no pistol-grip silhouette at all. */
function drawRocketLauncher(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const { barrelLen, flashOffset } = MUZZLE_GEOMETRY.rocket;
  const tubeTop = baseY - barrelLen + recoilBack;
  const tubeH = baseY - 40 - tubeTop;

  // The tube itself: thick, dark, resting diagonally over the shoulder.
  ctx.fillStyle = "#2e3630";
  ctx.fillRect(cx - 26, tubeTop, 52, tubeH);
  ctx.fillStyle = "#454f47";
  ctx.fillRect(cx - 26, tubeTop, 52, 10); // front rim highlight
  ctx.fillStyle = "#1c211d";
  ctx.fillRect(cx + 16, tubeTop + 10, 10, tubeH - 20); // shadow side
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeRect(cx - 26, tubeTop, 52, tubeH);

  // Warning stripe near the muzzle.
  ctx.fillStyle = "#e0483a";
  ctx.fillRect(cx - 26, tubeTop + 14, 52, 6);

  // Rear grip/trigger housing under the tube.
  ctx.fillStyle = "#22271f";
  ctx.fillRect(cx - 16, baseY - 46, 34, 26);
  ctx.strokeRect(cx - 16, baseY - 46, 34, 26);

  if (flash) drawMuzzleFlash(ctx, cx, tubeTop - flashOffset, 30, 14); // biggest flash of the arsenal
}

/** A stubby, flared nozzle over a squat fuel tank strapped alongside the
 * receiver — no long barrel at all, the opposite silhouette from every other
 * ranged weapon here, so a switch to it reads instantly even before the HUD's
 * "GAS" label catches up. */
function drawFlamethrower(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  recoilBack: number,
  flash: boolean,
): void {
  const { barrelLen, flashOffset } = MUZZLE_GEOMETRY.flamethrower;
  const nozzleTop = baseY - barrelLen + recoilBack;

  // Squat, flared nozzle — wider at the muzzle than the base.
  ctx.fillStyle = "#2c2620";
  ctx.beginPath();
  ctx.moveTo(cx - 12, baseY - 90);
  ctx.lineTo(cx + 12, baseY - 90);
  ctx.lineTo(cx + 20, nozzleTop);
  ctx.lineTo(cx - 20, nozzleTop);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();
  ctx.fillStyle = "#4a3f30";
  ctx.fillRect(cx - 16, nozzleTop, 32, 6); // rim highlight

  // Squat receiver block.
  ctx.fillStyle = "#26221c";
  ctx.fillRect(cx - 34, baseY - 94, 68, 60);
  ctx.fillStyle = "#3f372a";
  ctx.fillRect(cx - 34, baseY - 94, 68, 6); // top highlight
  ctx.fillStyle = "#1c1913";
  ctx.fillRect(cx - 34, baseY - 40, 68, 6); // bottom shadow
  ctx.strokeRect(cx - 34, baseY - 94, 68, 60);

  // Fuel tank, strapped alongside the receiver — a rounded cylinder rendered
  // as a rect with a lighter cap, angled off to the side rather than a long
  // barrel.
  ctx.fillStyle = "#5a1e14";
  ctx.fillRect(cx + 30, baseY - 84, 26, 68);
  ctx.fillStyle = "#7a2c1c";
  ctx.fillRect(cx + 30, baseY - 84, 26, 8);
  ctx.strokeStyle = "#3a1008";
  ctx.lineWidth = 2;
  ctx.strokeRect(cx + 30, baseY - 84, 26, 68);

  // Small pilot-light glow at the nozzle tip, always lit (not just on flash).
  ctx.fillStyle = "rgba(255,150,50,0.8)";
  ctx.beginPath();
  ctx.arc(cx, nozzleTop - 2, 4, 0, Math.PI * 2);
  ctx.fill();

  drawGrip(ctx, cx, baseY);

  if (flash) drawFlameBurst(ctx, cx, nozzleTop - flashOffset);
}

/** A roaring gout of flame — layered teardrop blobs instead of the sharp
 * muzzle-flash star every gun-type weapon uses, since this fires a
 * continuous stream rather than a single muzzle spark. */
function drawFlameBurst(ctx: CanvasRenderingContext2D, fx: number, fy: number): void {
  ctx.fillStyle = "rgba(255,90,20,0.9)";
  flameBlob(ctx, fx, fy, 30, 44);
  ctx.fillStyle = "rgba(255,160,40,0.9)";
  flameBlob(ctx, fx, fy + 4, 20, 30);
  ctx.fillStyle = "rgba(255,230,140,0.95)";
  flameBlob(ctx, fx, fy + 8, 10, 16);
}

/** One teardrop-shaped flame blob, tapering upward from (x,y). */
function flameBlob(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - height);
  ctx.quadraticCurveTo(x + width / 2, y - height * 0.4, x + width / 3, y);
  ctx.quadraticCurveTo(x, y + height * 0.1, x - width / 3, y);
  ctx.quadraticCurveTo(x - width / 2, y - height * 0.4, x, y - height);
  ctx.closePath();
  ctx.fill();
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
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();

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

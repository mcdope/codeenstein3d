// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * First-person weapon viewmodel, drawn natively with Canvas 2D primitives
 * (`fillRect` + path `lineTo`) — no image assets. The engine computes the live
 * bob/recoil/reload state (see head-bob, recoil and reload handling in
 * engine.ts) and passes it in each frame; this module is a pure renderer. Each weapon gets its own
 * silhouette (see `WeaponViewKind`) so switching weapons is visible even
 * before the HUD's ammo label catches up. Every body shape gets a thin dark
 * outline stroke plus a top-highlight/bottom-shadow pair rather than one flat
 * fill, so silhouettes read with some bevel/depth against the dark backdrop
 * instead of as flat cutouts.
 *
 * Two rules keep that affordable, both from the 2026-08 perf audit (see
 * `pathSprites.ts`): the rectangles are drawn live and cost nothing, but every
 * *polygon* is a pre-rendered `Glyph` and every *outline* goes through
 * `outlineRect` rather than `strokeRect`. A single stroked or non-rectangular
 * draw per frame is enough to cost ~10ms of frame budget, so a new weapon must
 * follow the same split — see `doc/dev/adding-a-weapon.md`.
 */
import { withOverlayScale } from "./overlayScale";
import { drawGlyph, outlineRect, type Glyph } from "./pathSprites";
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
  /** 0 while not reloading; otherwise how far through the reload we are, 0 -> 1. */
  reloadProgress: number;
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

/** How far the weapon dips below its resting baseline, and how far across, at
 * the midpoint of a reload. The down offset is deliberately larger than every
 * receiver's own height (the tallest is the shotgun's 96px), so the body of
 * the weapon really does leave the screen at the bottom of the dip and only
 * the barrel stays in frame — a smaller dip reads as a stumble rather than as
 * the weapon being taken out of the fight. The sideways component pushes
 * toward the grip side, so the dip reads as lowering the weapon to the hip
 * rather than as the whole viewport sliding. */
const RELOAD_DOWN_PX = 96;
/** Measured, after a player reported never having seen a reload: the *downward*
 * travel saturates long before it reaches `RELOAD_DOWN_PX`. Sampling the
 * weapon's visible strip across a real reload, the fraction of it that changes
 * is 13% at 59px of dip, 12.5% at 73px and 11.7% at the 96px peak — flat,
 * because `HUD_HEIGHT` is 58 and the weapon only clears the bar by ~72px, so
 * everything past that is travel into a region the HUD already covers. The
 * sideways component is the half that moves inside visible screen area, so it
 * is what carries the motion; it used to be 24px, which read as a twitch. */
const RELOAD_SIDE_PX = 96;

/** Thin outline stroke shared by every weapon's body shapes — gives flat
 * canvas-primitive fills a defined edge against the dark backdrop instead of
 * reading as a flat cutout.
 *
 * It was `#0a0a0d`, which could not do that job: measured against the demo
 * campaign's floor, the weapon strip averages luminance ~30/255 and the
 * outline sat at ~10, so the silhouette dissolved into the floor and every
 * motion it made — the reload dip especially — went with it. Lifted to read
 * as an edge on a dark floor while still being far darker than any body fill,
 * so it still reads as a drawn outline rather than a highlight. */
const OUTLINE_COLOR = "#4a505a";
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

/**
 * Draw the equipped weapon at the bottom center of the canvas.
 *
 * Every literal from here down — barrel lengths, `RECOIL_DOWN_PX`, the muzzle
 * geometry table, the glyph boxes — is in design pixels (see
 * `overlayScale.ts`), which is what makes the viewmodel the same size at every
 * render preset. Adding a weapon means adding numbers in that space; see
 * `doc/dev/adding-a-weapon.md`.
 */
export function drawWeapon(ctx: CanvasRenderingContext2D, v: WeaponView): void {
  withOverlayScale(ctx, (w, h) => {
    // Recoil kicks the gun down and back (toward the viewer): a downward push
    // plus a small drop that reads as the weapon recoiling into the corner.
    const recoilDown = v.recoil * RECOIL_DOWN_PX;
    const recoilBack = v.recoil * RECOIL_BACK_PX;

    const cx = w * WEAPON_CENTER_BIAS + v.bobX; // gun center, matching the tracer's fixed x origin
    const baseY = h + v.bobY + recoilDown; // resting baseline sits on the bottom edge

    // A reload dips the weapon out of view and brings it back: one smooth
    // down-and-up over the progress range, peaking at the halfway point.
    // `Math.sin(p * PI)` gives that in one term, and gives it *zero slope at
    // both ends*, so the pose the dip starts from and returns to is exactly the
    // resting pose — no visible jump on the frame the reload begins or ends.
    //
    // Like `recoil` above, the normalized progress is converted to pixels once
    // here and each draw* function receives an already-offset anchor; none of
    // them ever sees `reloadProgress` itself. That is what makes the three
    // magazine-less weapons (knife, chainsaw, flamethrower) *structurally*
    // immune to this field rather than merely ignoring it by convention.
    //
    // The motion is a pure translation of that anchor on purpose. A tilt, or a
    // magazine swinging out of the well, would change a weapon's *geometry* per
    // frame, and by this module's perf rule that means pre-rendering every
    // affected shape at every quantised step (the `flameNozzleGlyph` treatment).
    // Translating the anchor costs nothing at all — the live rectangles take a
    // different origin and the pre-rendered glyphs blit to a different point.
    const reloading = v.reloadProgress > 0;
    const dip = reloading ? Math.sin(Math.min(v.reloadProgress, 1) * Math.PI) : 0;
    const reloadCx = cx + dip * RELOAD_SIDE_PX;
    const reloadBaseY = baseY + dip * RELOAD_DOWN_PX;
    // A weapon that is being reloaded is by definition not firing, so a flash
    // arriving in the same frame as a reload is stale state, not a shot.
    const reloadFlash = v.flash && !reloading;

    ctx.save();
    ctx.lineJoin = "round";

    switch (v.kind) {
      case "shotgun":
        drawShotgun(ctx, reloadCx, reloadBaseY, recoilBack, reloadFlash);
        break;
      case "knife":
        drawKnife(ctx, cx, baseY, v.recoil);
        break;
      case "chainsaw":
        drawChainsaw(ctx, cx, baseY, v.recoil);
        break;
      case "mp":
        drawMp(ctx, reloadCx, reloadBaseY, recoilBack, reloadFlash);
        break;
      case "rocket":
        drawRocketLauncher(ctx, reloadCx, reloadBaseY, recoilBack, reloadFlash);
        break;
      case "flamethrower":
        drawFlamethrower(ctx, cx, baseY, recoilBack, v.flash);
        break;
      case "pistol":
      default:
        drawPistol(ctx, reloadCx, reloadBaseY, recoilBack, reloadFlash);
        break;
    }

    ctx.restore();
  });
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
  outlineRect(ctx, cx - 9, barrelTop, 18, barrelH);
  ctx.fillStyle = "#3a3a46";
  ctx.fillRect(cx - 4, barrelTop + 4, 4, baseY - 92 - barrelTop); // inner highlight

  ctx.fillStyle = "#55555f";
  ctx.fillRect(cx - 13, barrelTop - 10, 26, 12); // rear sight block
  outlineRect(ctx, cx - 13, barrelTop - 10, 26, 12);

  ctx.fillStyle = "#26262c";
  ctx.fillRect(cx - 36, baseY - 92, 72, 74); // receiver
  ctx.fillStyle = "#3d3d47";
  ctx.fillRect(cx - 36, baseY - 92, 72, 6); // top highlight
  ctx.fillStyle = "#1a1a1f";
  ctx.fillRect(cx - 36, baseY - 24, 72, 6); // bottom shadow
  ctx.strokeStyle = OUTLINE_COLOR;
  outlineRect(ctx, cx - 36, baseY - 92, 72, 74);

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
  outlineRect(ctx, cx - 17, barrelTop, 13, barrelH);
  outlineRect(ctx, cx + 4, barrelTop, 13, barrelH);
  ctx.fillStyle = "#45443f";
  ctx.fillRect(cx - 14, barrelTop + 4, 3, barrelH - 10);
  ctx.fillRect(cx + 7, barrelTop + 4, 3, barrelH - 10);

  // Wood-toned pump/forend under the barrels.
  ctx.fillStyle = "#5a3f22";
  ctx.fillRect(cx - 20, baseY - 118, 40, 20);
  ctx.strokeStyle = "#2e2110";
  outlineRect(ctx, cx - 20, baseY - 118, 40, 20);

  ctx.fillStyle = "#3a3226";
  ctx.fillRect(cx - 22, baseY - 26, 60, 20); // trigger-guard block, wide receiver
  ctx.strokeStyle = OUTLINE_COLOR;
  outlineRect(ctx, cx - 22, baseY - 26, 60, 20);

  ctx.fillStyle = "#2a2a24";
  ctx.fillRect(cx - 42, baseY - 96, 84, 70); // bulkier receiver than the pistol
  ctx.fillStyle = "#4a4a3f";
  ctx.fillRect(cx - 42, baseY - 96, 84, 6); // top highlight
  ctx.fillStyle = "#1e1e19";
  ctx.fillRect(cx - 42, baseY - 32, 84, 6); // bottom shadow
  ctx.strokeStyle = OUTLINE_COLOR;
  outlineRect(ctx, cx - 42, baseY - 96, 84, 70);

  drawGrip(ctx, cx, baseY);

  if (flash) {
    drawMuzzleFlash(ctx, cx - 10, barrelTop - flashOffset, 24, 10);
    drawMuzzleFlash(ctx, cx + 10, barrelTop - flashOffset, 24, 10);
  }
}

/** The knife's whole silhouette at rest, anchored at the grip's base — every
 * part of it is rigid relative to that point (the thrust animation moves the
 * anchor, not the shape), so the entire weapon pre-renders as one glyph. */
const KNIFE_GLYPH: Glyph = {
  width: 44,
  height: 146,
  anchorX: 22,
  anchorY: 142,
  draw: (g, bx, by) => {
    // Handle (grip), held low-right.
    g.fillStyle = "#2a2018";
    g.beginPath();
    g.moveTo(bx - 10, by - 4);
    g.lineTo(bx + 16, by - 4);
    g.lineTo(bx + 10, by - 46);
    g.lineTo(bx - 16, by - 46);
    g.closePath();
    g.fill();
    g.lineJoin = "round"; // drawWeapon's own join; the offscreen context does not inherit it
    g.strokeStyle = OUTLINE_COLOR;
    g.lineWidth = OUTLINE_WIDTH;
    g.stroke();

    // Crossguard, sitting directly on top of the handle.
    g.fillStyle = "#55555f";
    g.fillRect(bx - 20, by - 54, 40, 8);
    g.strokeRect(bx - 20, by - 54, 40, 8);

    // Blade: a tapered polygon rising from the crossguard, with a bright edge
    // highlight and a mid-tone outline (a near-black stroke would muddy the
    // bright fill, unlike every other weapon's dark body shapes).
    g.fillStyle = "#c7ccd4";
    g.beginPath();
    g.moveTo(bx - 9, by - 54);
    g.lineTo(bx + 9, by - 54);
    g.lineTo(bx - 2, by - 140);
    g.closePath();
    g.fill();
    g.strokeStyle = "#8a8f97";
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "#eef1f5";
    g.fillRect(bx - 6, by - 132, 3, 76);
  },
};

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
  drawGlyph(ctx, KNIFE_GLYPH, cx + 34, baseY - thrust);
}

/** A bulkier two-handed alternative to the knife: a blocky motor housing and
 * rear grip with a long, tooth-notched guide bar thrusting forward — no
 * muzzle flash, same as the knife. Reuses the knife's up-thrust recoil
 * animation directly (each hold-to-fire swing sets `recoil` back to 1), so
 * holding the trigger reads as a repeated revving chug for free without any
 * extra animation state. */
function drawChainsaw(ctx: CanvasRenderingContext2D, cx: number, baseY: number, recoil: number): void {
  const thrust = recoil * 40;
  drawGlyph(ctx, CHAINSAW_GLYPH, cx + 30, baseY - thrust);
}

/** The chainsaw's whole silhouette, anchored at the rear grip's base — rigid
 * relative to that point exactly like `KNIFE_GLYPH`, so the thrust animation
 * moves the anchor and the shape pre-renders once. */
const CHAINSAW_GLYPH: Glyph = {
  width: 60,
  height: 162,
  anchorX: 32,
  anchorY: 160,
  draw: (g, bx, by) => {
    // Rear grip, held low-right.
    g.fillStyle = "#2a2018";
    g.beginPath();
    g.moveTo(bx - 8, by - 2);
    g.lineTo(bx + 20, by - 2);
    g.lineTo(bx + 14, by - 40);
    g.lineTo(bx - 14, by - 40);
    g.closePath();
    g.fill();
    g.lineJoin = "round"; // drawWeapon's own join; the offscreen context does not inherit it
    g.strokeStyle = OUTLINE_COLOR;
    g.lineWidth = OUTLINE_WIDTH;
    g.stroke();

    // Motor housing: a blocky body sitting on top of the grip.
    g.fillStyle = "#3a3f36";
    g.fillRect(bx - 26, by - 78, 52, 42);
    g.fillStyle = "#565d51";
    g.fillRect(bx - 26, by - 78, 52, 6); // top rim highlight
    g.fillStyle = "#e0483a";
    g.fillRect(bx - 26, by - 46, 52, 6); // warning stripe, same idea as the rocket launcher's
    g.fillStyle = "#232821";
    g.fillRect(bx - 26, by - 40, 52, 4); // bottom shadow
    g.strokeRect(bx - 26, by - 78, 52, 42);

    // Guide bar, extending up-and-left from the housing.
    g.fillStyle = "#4c4f52";
    g.beginPath();
    g.moveTo(bx - 20, by - 74);
    g.lineTo(bx - 2, by - 74);
    g.lineTo(bx - 10, by - 156);
    g.lineTo(bx - 24, by - 156);
    g.closePath();
    g.fill();
    g.stroke();

    // Chain teeth: a row of small triangular notches down the bar's leading edge.
    g.fillStyle = "#c7ccd4";
    const teeth = 6;
    for (let i = 0; i < teeth; i++) {
      const t = i / (teeth - 1);
      const ty = by - 82 - t * 68;
      const tx = bx - 22 - t * 1.5;
      g.beginPath();
      g.moveTo(tx, ty);
      g.lineTo(tx - 8, ty - 3);
      g.lineTo(tx, ty - 8);
      g.closePath();
      g.fill();
    }
  },
};

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
  outlineRect(ctx, cx - 5, barrelTop, 10, baseY - 90 - barrelTop);
  ctx.fillStyle = "#3a3d42";
  ctx.fillRect(cx - 2, barrelTop + 4, 2, baseY - 100 - barrelTop);

  ctx.fillStyle = "#1f2124";
  ctx.fillRect(cx - 28, baseY - 96, 56, 46); // compact receiver
  ctx.fillStyle = "#33363b";
  ctx.fillRect(cx - 28, baseY - 96, 56, 5); // top highlight
  ctx.fillStyle = "#16171a";
  ctx.fillRect(cx - 28, baseY - 55, 56, 5); // bottom shadow
  outlineRect(ctx, cx - 28, baseY - 96, 56, 46);

  drawGlyph(ctx, MP_UNDERSIDE_GLYPH, cx, baseY);

  drawGrip(ctx, cx, baseY);

  if (flash) drawMuzzleFlash(ctx, cx, barrelTop - flashOffset, 14, 6); // small, fast-cycling flash
}

/** The submachine gun's stick magazine and folding-stock hint — both rigid
 * relative to (`cx`, `baseY`), unlike the barrel above them, which shortens
 * with recoil and therefore stays live rectangle drawing. */
const MP_UNDERSIDE_GLYPH: Glyph = {
  width: 64,
  height: 62,
  anchorX: 14,
  anchorY: 63,
  draw: (g, cx, baseY) => {
    // Stick magazine, angled down.
    g.fillStyle = "#151719";
    g.lineJoin = "round"; // drawWeapon's own join; the offscreen context does not inherit it
    g.strokeStyle = OUTLINE_COLOR;
    g.lineWidth = OUTLINE_WIDTH;
    g.beginPath();
    g.moveTo(cx - 6, baseY - 56);
    g.lineTo(cx + 10, baseY - 56);
    g.lineTo(cx + 4, baseY - 6);
    g.lineTo(cx - 12, baseY - 6);
    g.closePath();
    g.fill();
    g.stroke();

    // Folding stock hint, low and to the side.
    g.strokeStyle = "#3a3d42";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx + 26, baseY - 60);
    g.lineTo(cx + 46, baseY - 30);
    g.stroke();
  },
};

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
  outlineRect(ctx, cx - 26, tubeTop, 52, tubeH);

  // Warning stripe near the muzzle.
  ctx.fillStyle = "#e0483a";
  ctx.fillRect(cx - 26, tubeTop + 14, 52, 6);

  // Rear grip/trigger housing under the tube.
  ctx.fillStyle = "#22271f";
  ctx.fillRect(cx - 16, baseY - 46, 34, 26);
  outlineRect(ctx, cx - 16, baseY - 46, 34, 26);

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
  // The nozzle is the one weapon shape whose *geometry* (not just position)
  // moves with recoil: its flared top edge tracks `nozzleTop` while its base
  // stays put. Quantising the recoil offset to whole pixels gives it a small
  // fixed set of pre-renderable shapes; the rounding moves the top edge by at
  // most half a pixel, and the rim highlight is baked in alongside it so the
  // two can never separate into a hairline seam.
  const recoilStep = Math.round(recoilBack);
  const nozzleTop = baseY - barrelLen + recoilStep;

  drawGlyph(ctx, flameNozzleGlyph(recoilStep), cx, baseY);

  // Squat receiver block. The nozzle's stroke state now lives inside its
  // glyph, so the outline this rect wants is set explicitly rather than
  // inherited from the drawing above it.
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.fillStyle = "#26221c";
  ctx.fillRect(cx - 34, baseY - 94, 68, 60);
  ctx.fillStyle = "#3f372a";
  ctx.fillRect(cx - 34, baseY - 94, 68, 6); // top highlight
  ctx.fillStyle = "#1c1913";
  ctx.fillRect(cx - 34, baseY - 40, 68, 6); // bottom shadow
  outlineRect(ctx, cx - 34, baseY - 94, 68, 60);

  // Fuel tank, strapped alongside the receiver — a rounded cylinder rendered
  // as a rect with a lighter cap, angled off to the side rather than a long
  // barrel.
  ctx.fillStyle = "#5a1e14";
  ctx.fillRect(cx + 30, baseY - 84, 26, 68);
  ctx.fillStyle = "#7a2c1c";
  ctx.fillRect(cx + 30, baseY - 84, 26, 8);
  ctx.strokeStyle = "#3a1008";
  ctx.lineWidth = 2;
  outlineRect(ctx, cx + 30, baseY - 84, 26, 68);

  // Small pilot-light glow at the nozzle tip, always lit (not just on flash).
  drawGlyph(ctx, FLAME_PILOT_GLYPH, cx, nozzleTop - 2);

  drawGrip(ctx, cx, baseY);

  if (flash) drawFlameBurst(ctx, cx, nozzleTop - flashOffset);
}

/** Nozzle glyphs by whole-pixel recoil offset — see `drawFlamethrower`. At
 * most `RECOIL_BACK_PX + 1` entries ever exist. */
const flameNozzleGlyphs = new Map<number, Glyph>();

function flameNozzleGlyph(recoilStep: number): Glyph {
  const cached = flameNozzleGlyphs.get(recoilStep);
  if (cached) return cached;
  const top = -MUZZLE_GEOMETRY.flamethrower.barrelLen + recoilStep;
  const glyph: Glyph = {
    width: 44,
    height: 44,
    anchorX: 22,
    anchorY: 131,
    draw: (g, cx, baseY) => {
      // Squat, flared nozzle — wider at the muzzle than the base.
      g.fillStyle = "#2c2620";
      g.beginPath();
      g.moveTo(cx - 12, baseY - 90);
      g.lineTo(cx + 12, baseY - 90);
      g.lineTo(cx + 20, baseY + top);
      g.lineTo(cx - 20, baseY + top);
      g.closePath();
      g.fill();
      g.lineJoin = "round"; // drawWeapon's own join; the offscreen context does not inherit it
      g.strokeStyle = OUTLINE_COLOR;
      g.lineWidth = OUTLINE_WIDTH;
      g.stroke();
      g.fillStyle = "#4a3f30";
      g.fillRect(cx - 16, baseY + top, 32, 6); // rim highlight
    },
  };
  flameNozzleGlyphs.set(recoilStep, glyph);
  return glyph;
}

/** The always-lit pilot flame at the nozzle tip. */
const FLAME_PILOT_GLYPH: Glyph = {
  width: 12,
  height: 12,
  anchorX: 6,
  anchorY: 6,
  draw: (g, ox, oy) => {
    g.fillStyle = "rgba(255,150,50,0.8)";
    g.beginPath();
    g.arc(ox, oy, 4, 0, Math.PI * 2);
    g.fill();
  },
};

/** A roaring gout of flame — layered teardrop blobs instead of the sharp
 * muzzle-flash star every gun-type weapon uses, since this fires a
 * continuous stream rather than a single muzzle spark. */
function drawFlameBurst(ctx: CanvasRenderingContext2D, fx: number, fy: number): void {
  drawGlyph(ctx, FLAME_BURST_GLYPH, fx, fy);
}

const FLAME_BURST_GLYPH: Glyph = {
  width: 32,
  height: 56,
  anchorX: 16,
  anchorY: 45,
  draw: (g, fx, fy) => {
    g.fillStyle = "rgba(255,90,20,0.9)";
    flameBlob(g, fx, fy, 30, 44);
    g.fillStyle = "rgba(255,160,40,0.9)";
    flameBlob(g, fx, fy + 4, 20, 30);
    g.fillStyle = "rgba(255,230,140,0.95)";
    flameBlob(g, fx, fy + 8, 10, 16);
  },
};

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
  drawGlyph(ctx, GRIP_GLYPH, cx, baseY);
}

const GRIP_GLYPH: Glyph = {
  width: 52,
  height: 76,
  anchorX: 28,
  anchorY: 32,
  draw: (g, cx, baseY) => {
    g.fillStyle = "#22222a";
    g.beginPath();
    g.moveTo(cx - 12, baseY - 26);
    g.lineTo(cx + 20, baseY - 26);
    g.lineTo(cx + 8, baseY + 40);
    g.lineTo(cx - 26, baseY + 40);
    g.closePath();
    g.fill();
    g.lineJoin = "round"; // drawWeapon's own join; the offscreen context does not inherit it
    g.strokeStyle = OUTLINE_COLOR;
    g.lineWidth = OUTLINE_WIDTH;
    g.stroke();

    g.strokeStyle = "#4a4a55";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - 14, baseY - 30);
    g.lineTo(cx - 22, baseY - 12);
    g.stroke();
  },
};

function drawMuzzleFlash(ctx: CanvasRenderingContext2D, fx: number, fy: number, outer: number, inner: number): void {
  drawGlyph(ctx, muzzleFlashGlyph(outer, inner), fx, fy);
}

/** Muzzle-flash glyphs by (outer, inner) radius pair — one per weapon, four
 * distinct pairs across the whole arsenal. */
const muzzleFlashGlyphs = new Map<string, Glyph>();

function muzzleFlashGlyph(outer: number, inner: number): Glyph {
  const key = `${outer},${inner}`;
  const cached = muzzleFlashGlyphs.get(key);
  if (cached) return cached;
  const glyph: Glyph = {
    width: outer * 2 + 4,
    height: outer * 2 + 4,
    anchorX: outer + 2,
    anchorY: outer + 2,
    draw: (g, fx, fy) => {
      g.fillStyle = "rgba(255,150,40,0.9)";
      star(g, fx, fy, outer, inner, 6);
      g.fillStyle = "rgba(255,240,150,0.95)";
      star(g, fx, fy, outer * 0.55, inner * 0.55, 6);
    },
  };
  muzzleFlashGlyphs.set(key, glyph);
  return glyph;
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

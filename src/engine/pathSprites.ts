// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { contextScale } from "./overlayScale";

/**
 * Pre-rendered glyphs for every non-rectangular shape the renderer used to
 * draw straight onto the scene canvas each frame.
 *
 * **Why this module exists.** On a GPU-accelerated Canvas 2D, rectangle fills
 * and image blits batch into one quad stream, but an anti-aliased
 * *non-rectangular* path fill or stroke cannot: it needs a coverage pass,
 * which forces the batch to flush and the render target to resolve. With the
 * raycaster's ~2,600 quads plus a full-canvas `putImageData` already pending,
 * that flush pushes the frame past the vsync deadline and the next
 * `requestAnimationFrame` slips a whole interval.
 *
 * The penalty is **fixed per frame and all-or-nothing** — measured on the
 * reference machine, one `arc()`+`fill()` per frame costs as much as
 * sixty-four, while three thousand extra `fillRect`s cost nothing at all.
 * That is the load-bearing fact: a partial fix buys nothing. Every shape
 * drawn on a normal frame has to come through here, or the frame still pays.
 * See `doc/dev/perf-review-2026-08-02.md` (finding P1) for the full
 * measurement.
 *
 * **What it does.** A `Glyph` is a small drawing routine plus its box. The
 * first time one is drawn it is rendered once into a detached offscreen
 * canvas (or, for a glyph drawn at varying angles, into a strip of
 * `ROTATION_STEPS` pre-rotated copies); every frame after that is a single
 * axis-aligned `drawImage` — a plain quad, which batches.
 *
 * **The fallback is not decoration.** When no usable offscreen surface exists
 * (`OFFSCREEN_AVAILABLE` below), every entry point falls straight back to
 * running the glyph's own `draw` against the target context under the same
 * transform the pre-render would have used — i.e. exactly the drawing this
 * module replaced, pixel for pixel. A cosmetic optimisation must never be the
 * reason the weapon or the compass silently stops being drawn.
 */

/**
 * Whether a detached canvas can actually be created *and* produce pixels.
 *
 * Both halves matter, and the second one is the point: `getContext("2d")`
 * returning a non-null object does not mean drawing into it produces
 * anything (a lost context, a blocked/uninstrumented canvas, or a headless
 * DOM shim all return an object that quietly swallows every call). Blitting
 * the resulting blank sprite would make the weapon, compass and player marker
 * invisible — a far worse failure than the per-frame path cost this module
 * exists to avoid — so the probe fills a pixel and reads it back, and anything
 * short of a real opaque pixel means "use the direct-draw fallback".
 *
 * Evaluated once at module load rather than lazily, so the decision is made
 * before any renderer has drawn a frame and cannot vary by call order.
 */
const OFFSCREEN_AVAILABLE = probeOffscreenCanvas();

function probeOffscreenCanvas(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 2, 2);
    return ctx.getImageData(0, 0, 2, 2).data[3] !== 0;
  } catch {
    // A browser that refuses the allocation outright (canvas disabled,
    // out of memory) throws rather than returning null.
    return false;
  }
}

/**
 * One pre-renderable shape. `draw` takes the anchor point as an explicit
 * offset rather than relying on a transform, so the same routine serves the
 * offscreen pre-render (anchor placed inside the sprite box) and the
 * direct-draw fallback (anchor placed at the real target point) — and the
 * fallback issues **exactly** the canvas calls the pre-glyph code did, with
 * no wrapping `save`/`translate`/`restore` of its own. That matters: the
 * fallback is this module's correctness reference, so it should differ from
 * the drawing it replaced in nothing at all, not even in call sequence.
 */
export interface Glyph {
  /** Sprite box width in *design* pixels (see `overlayScale.ts`) — must cover
   * the shape plus any stroke width, or the pre-rendered copy is clipped where
   * the live drawing was not. The pre-render allocates `width * s` device
   * pixels for it, so a glyph stays as sharp as the canvas allows. */
  readonly width: number;
  readonly height: number;
  /** Where the anchor point sits inside the sprite box. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Draws the shape with its anchor at (`ox`, `oy`). */
  readonly draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void;
}

/**
 * Pre-rotated copies per full turn, for `drawRotatedGlyph`. 128 steps is
 * 2.8° of quantisation; on the largest glyph drawn this way (the compass
 * needle, 7 design px from anchor to tip) that moves the tip by 0.34 design px
 * — below the canvas's own pixel grid at Classic, and 0.68 device px at Sharp,
 * where the needle is twice as many pixels across. The alternative (one sprite
 * plus a live `rotate()`) would hand the rasteriser a rotated quad, which is
 * exactly the non-axis-aligned geometry this module exists to avoid.
 *
 * Every glyph keeps all 128 steps at every preset — see `MAX_ATLAS_WIDTH`.
 */
const ROTATION_STEPS = 128;

/**
 * Widest atlas strip we will allocate *per unit of scale*; a glyph whose strip
 * would exceed it gets proportionally fewer rotation steps rather than a failed
 * allocation.
 *
 * **Multiplied by the scale, not held fixed.** A fixed cap is measured in device
 * pixels, so doubling the resolution doubles every tile and halves the step
 * count — the compass needle drops from 128 steps to 73, making the needle snap
 * more coarsely at exactly the preset that exists to look better. Letting the
 * cap grow with the scale keeps the step count identical at every preset, so
 * quantisation stays a fixed fraction of the glyph rather than a fixed number
 * of device pixels, which is how every other part of this change behaves. The
 * strip is one tile tall, so even the widest case here is a few hundred
 * thousand pixels — the cap is a guard against a pathologically large glyph,
 * not a memory budget.
 */
const MAX_ATLAS_WIDTH = 4096;

interface RotationAtlas {
  canvas: HTMLCanvasElement;
  /** Square tile side in *device* pixels; every step occupies one tile. */
  tile: number;
  steps: number;
  /** Device pixels per design pixel this strip was baked at — the divisor that
   * turns `tile` back into the design-space size to blit at. */
  scale: number;
}

/**
 * Built sprites, keyed by glyph identity and then by the scale they were baked
 * at — glyphs are module constants or memoised factory results, so identity is
 * stable for the process. A `null` entry records "this one could not be
 * pre-rendered", so a failed build is attempted once rather than on every frame.
 *
 * **The scale has to be part of the key, not folded into the glyph.** A sprite
 * baked for Classic and blitted at Sharp is the pixel-doubled, blurry thing
 * this whole change exists to avoid; and the second key level rather than a
 * cache-wide reset means switching render preset mid-session (or a screenshot
 * script capturing both) re-bakes once and then keeps both sets warm, instead
 * of thrashing. In practice the inner map holds exactly one entry, because
 * `renderRes` does not change without a reload.
 */
const spriteCache = new Map<Glyph, Map<number, HTMLCanvasElement | null>>();
const atlasCache = new Map<Glyph, Map<number, RotationAtlas | null>>();

/** The per-scale slot for `key` in a two-level cache, created on first use. */
function scaleSlot<K, V>(cache: Map<K, Map<number, V>>, key: K): Map<number, V> {
  let slot = cache.get(key);
  if (!slot) {
    slot = new Map<number, V>();
    cache.set(key, slot);
  }
  return slot;
}

/** A detached canvas of the given size with a context, or `null` if either
 * step fails. Never appended to the DOM. */
function makeSurface(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  } catch {
    return null;
  }
}

function spriteFor(glyph: Glyph, scale: number): HTMLCanvasElement | null {
  const slot = scaleSlot(spriteCache, glyph);
  const cached = slot.get(scale);
  if (cached !== undefined) return cached;
  let sprite: HTMLCanvasElement | null = null;
  const surface = makeSurface(glyph.width * scale, glyph.height * scale);
  if (surface) {
    // The glyph's own `draw` never learns about the scale — it keeps drawing in
    // design pixels, exactly as it does in the direct-draw fallback. That is
    // what keeps the fallback this module's correctness reference: the two
    // paths run identical code against identically-transformed contexts.
    surface.ctx.scale(scale, scale);
    glyph.draw(surface.ctx, glyph.anchorX, glyph.anchorY);
    sprite = surface.canvas;
  }
  slot.set(scale, sprite);
  return sprite;
}

/**
 * Square tile side in device pixels, and how many of them fit the strip.
 *
 * A rotated glyph sweeps its whole box around the anchor, so the tile has to
 * be square and wide enough for the box's furthest corner in any orientation —
 * the diagonal of the anchor-to-edge extents.
 *
 * Both the tile and the cap are in device pixels and both scale together, so
 * the step count a glyph gets is the same at every preset — see
 * `MAX_ATLAS_WIDTH`. Rotation steps still give way for a pathologically large
 * glyph; that is why this is a shared function with a test seam rather than
 * arithmetic inlined at the one call site that needs it.
 */
function atlasMetrics(glyph: Glyph, scale: number): { tile: number; steps: number } {
  const reachX = Math.max(glyph.anchorX, glyph.width - glyph.anchorX);
  const reachY = Math.max(glyph.anchorY, glyph.height - glyph.anchorY);
  const tile = Math.ceil((Math.ceil(2 * Math.hypot(reachX, reachY)) + 2) * scale);
  const budget = MAX_ATLAS_WIDTH * scale;
  return { tile, steps: Math.max(1, Math.min(ROTATION_STEPS, Math.floor(budget / tile))) };
}

function atlasFor(glyph: Glyph, scale: number): RotationAtlas | null {
  const slot = scaleSlot(atlasCache, glyph);
  const cached = slot.get(scale);
  if (cached !== undefined) return cached;
  const { tile: deviceTile, steps } = atlasMetrics(glyph, scale);
  let atlas: RotationAtlas | null = null;
  const surface = makeSurface(deviceTile * steps, deviceTile);
  if (surface) {
    for (let i = 0; i < steps; i++) {
      surface.ctx.save();
      surface.ctx.translate(i * deviceTile + deviceTile / 2, deviceTile / 2);
      surface.ctx.scale(scale, scale);
      surface.ctx.rotate((i / steps) * Math.PI * 2);
      glyph.draw(surface.ctx, 0, 0);
      surface.ctx.restore();
    }
    atlas = { canvas: surface.canvas, tile: deviceTile, steps, scale };
  }
  slot.set(scale, atlas);
  return atlas;
}

/**
 * Draw `glyph` with its anchor at (`x`, `y`), in design pixels.
 *
 * The scale is read off the context rather than passed in, because every
 * caller is already inside `withOverlayScale` and threading a factor through
 * ten call sites is ten chances to pass the wrong one. The destination size
 * comes from the sprite's own device dimensions divided by that scale, not
 * from `glyph.width`: `makeSurface` rounds the allocation up, so at s=1 this
 * reproduces the bare `drawImage(sprite, dx, dy)` it replaced exactly, rather
 * than quietly squeezing a ceil'd sprite into a fractional box.
 *
 * The destination is deliberately **not** rounded to whole device pixels.
 * Sub-pixel blit origins are what the shipped Classic renderer already does
 * (`drawFlameBurst` and `drawMuzzleFlash` carry bob and recoil), so rounding
 * here would change Classic as well as Sharp — losing the unchanged-preset
 * control that the before/after screenshots depend on — to fix an artefact
 * that no one has reported at the resolution where it already occurs.
 */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number): void {
  const scale = contextScale(ctx);
  const sprite = OFFSCREEN_AVAILABLE ? spriteFor(glyph, scale) : null;
  if (!sprite) {
    glyph.draw(ctx, x, y);
    return;
  }
  ctx.drawImage(sprite, x - glyph.anchorX, y - glyph.anchorY, sprite.width / scale, sprite.height / scale);
}

/**
 * Draw `glyph` rotated by `angle` radians about its anchor, placed at
 * (`x`, `y`) — the pre-rotated equivalent of
 * `translate(x, y); rotate(angle); draw()`, which is exactly what the
 * fallback does.
 */
export function drawRotatedGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, angle: number, x: number, y: number): void {
  const scale = contextScale(ctx);
  const atlas = OFFSCREEN_AVAILABLE ? atlasFor(glyph, scale) : null;
  if (!atlas) {
    // Undone with inverse transforms rather than save/restore, so the
    // fallback borrows nothing from the caller's state stack — several
    // callers assert their own save/restore pairing, and a fallback has no
    // business showing up in that count.
    ctx.translate(x, y);
    ctx.rotate(angle);
    glyph.draw(ctx, 0, 0);
    ctx.rotate(-angle);
    ctx.translate(-x, -y);
    return;
  }
  const turns = angle / (Math.PI * 2);
  // `%` keeps the sign of its left operand, so a negative bearing needs the
  // extra `+ steps` before the second wrap.
  const step = ((Math.round(turns * atlas.steps) % atlas.steps) + atlas.steps) % atlas.steps;
  // Source rect in the strip's device pixels; destination in the caller's
  // design pixels. Confusing the two is silent at s=1 and draws the compass
  // needle at twice its size at Sharp.
  const side = atlas.tile / atlas.scale;
  const half = side / 2;
  ctx.drawImage(atlas.canvas, step * atlas.tile, 0, atlas.tile, atlas.tile, x - half, y - half, side, side);
}

/**
 * `ctx.strokeRect(x, y, w, h)` drawn as four `fillRect`s instead — same
 * centred-stroke geometry, same `strokeStyle` and `lineWidth`, drop-in at the
 * call site.
 *
 * **`strokeRect` on its own is fine** — injected on a clean frame at up to 24
 * per frame, any size, any alignment, any line width, it measures free. What
 * is not fine is a `strokeRect` drawn while **`lineJoin` is `"round"`**: one
 * per frame costs 48.0fps against 59.0 with the default miter join, the same
 * fixed count-independent penalty a path fill carries, because a round-joined
 * outline stops being four axis-aligned quads. `viewmodel.ts`'s `drawWeapon`
 * sets exactly that join for every weapon it draws, which is where the ~10ms
 * came from; reverting this helper to `ctx.strokeRect` measured a 10fps
 * regression on the live game.
 *
 * Using this everywhere rather than only under a round join is deliberate:
 * the expensive case is invisible at the call site — it depends on a context
 * flag set by whatever drew before you — so "always four fills" is the only
 * version of this rule that cannot be got wrong later.
 *
 * Sub-pixel placement is *not* a trigger, which is worth recording because it
 * is the obvious suspect: rounding every coordinate and the line width to
 * whole pixels in situ changed nothing.
 */
export function outlineRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const lineWidth = ctx.lineWidth;
  const half = lineWidth / 2;
  const previousFill = ctx.fillStyle;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(x - half, y - half, w + lineWidth, lineWidth);
  ctx.fillRect(x - half, y + h - half, w + lineWidth, lineWidth);
  // The two side bars stop short of the corners the bars above already
  // covered; a rect shorter than its own outline has no gap left to fill.
  const sideHeight = h - lineWidth;
  if (sideHeight > 0) {
    ctx.fillRect(x - half, y + half, lineWidth, sideHeight);
    ctx.fillRect(x + w - half, y + half, lineWidth, sideHeight);
  }
  ctx.fillStyle = previousFill;
}

/**
 * A straight line of `width` px from (`x1`,`y1`) to (`x2`,`y2`), rasterised as
 * one `fillRect` per pixel along its major axis — the batchable replacement
 * for `beginPath`/`moveTo`/`lineTo`/`stroke` (bullet tracers).
 *
 * Steps whole pixels along the major axis so the rects tile edge-to-edge
 * rather than overlapping: tracers are drawn at partial alpha, and overlapping
 * translucent squares would band the line into visibly darker blotches where
 * they double-blend.
 */
export function fillLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const half = width / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const from = Math.round(x1);
    const to = Math.round(x2);
    const step = to >= from ? 1 : -1;
    const slope = dx === 0 ? 0 : dy / dx;
    for (let x = from; step > 0 ? x <= to : x >= to; x += step) {
      ctx.fillRect(x, y1 + (x - x1) * slope - half, 1, width);
    }
    return;
  }
  const from = Math.round(y1);
  const to = Math.round(y2);
  const step = to >= from ? 1 : -1;
  const slope = dx / dy;
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    ctx.fillRect(x1 + (y - y1) * slope - half, y, width, 1);
  }
}

/** Radius the disc sprites below are rendered at, in design pixels. Large
 * enough that scaling one up to a point-blank explosion still reads as a
 * circle, small enough to stay a trivial allocation. Baked at `radius * s`, so
 * a disc keeps the same source-pixels-per-device-pixel ratio at every preset
 * rather than getting softer as the canvas gets sharper. */
const DISC_SPRITE_RADIUS = 64;

/** Opaque disc sprites by `"r,g,b"`, then by the scale they were baked at —
 * one per colour the game blends. */
const discSprites = new Map<string, Map<number, HTMLCanvasElement | null>>();

function discSprite(rgb: string, scale: number): HTMLCanvasElement | null {
  const slot = scaleSlot(discSprites, rgb);
  const cached = slot.get(scale);
  if (cached !== undefined) return cached;
  let sprite: HTMLCanvasElement | null = null;
  const radius = DISC_SPRITE_RADIUS * scale;
  const surface = makeSurface(radius * 2, radius * 2);
  if (surface) {
    surface.ctx.fillStyle = `rgb(${rgb})`;
    surface.ctx.beginPath();
    surface.ctx.arc(radius, radius, radius, 0, Math.PI * 2);
    surface.ctx.fill();
    sprite = surface.canvas;
  }
  slot.set(scale, sprite);
  return sprite;
}

/**
 * A filled circle of radius `r` at (`cx`,`cy`) in `rgb` (an `"r,g,b"` triple)
 * at `alpha` — the batchable replacement for `beginPath`/`arc`/`fill`
 * (explosion blast rings).
 *
 * Blitting an opaque disc under `globalAlpha` is exactly equivalent to filling
 * a path with `rgba(rgb, alpha)`, since a solid fill composites the same way
 * whether the alpha rides on the source pixels or on the global multiplier.
 * Smoothing is enabled for the blit specifically — the sprite is a smooth
 * shape being scaled to an arbitrary radius, so nearest-neighbour sampling
 * would give it a visibly stepped edge, and the scene canvas otherwise runs
 * with smoothing off for the chunky wall-texture look.
 */
export function drawDisc(ctx: CanvasRenderingContext2D, rgb: string, alpha: number, cx: number, cy: number, r: number): void {
  const sprite = OFFSCREEN_AVAILABLE ? discSprite(rgb, contextScale(ctx)) : null;
  if (!sprite) {
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const previousAlpha = ctx.globalAlpha;
  const previousSmoothing = ctx.imageSmoothingEnabled;
  ctx.globalAlpha = previousAlpha * alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sprite, cx - r, cy - r, r * 2, r * 2);
  ctx.imageSmoothingEnabled = previousSmoothing;
  ctx.globalAlpha = previousAlpha;
}

/** Test seam: whether the pre-rendered fast path is active in this
 * environment. Exported for `pathSprites.test.ts` to assert which branch a
 * given environment takes, rather than inferring it from draw calls. */
export function offscreenSpritesAvailable(): boolean {
  return OFFSCREEN_AVAILABLE;
}

/**
 * Test seam: how many pre-rotated copies `glyph` would get at `scale`, without
 * allocating anything.
 *
 * Exists because both the tile and the strip cap are in device pixels, so it is
 * easy to scale one and not the other — and getting it wrong costs rotation
 * steps *as the canvas gets sharper*, which is the wrong direction and is
 * invisible in any assertion about draw calls. The test that uses this pins the
 * step count as equal at both presets.
 */
export function atlasStepsAt(glyph: Glyph, scale: number): number {
  return atlasMetrics(glyph, scale).steps;
}

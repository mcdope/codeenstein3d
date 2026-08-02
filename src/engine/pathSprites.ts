// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

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
  /** Sprite box width in canvas pixels — must cover the shape plus any
   * stroke width, or the pre-rendered copy is clipped where the live drawing
   * was not. */
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
 * needle, 7px from anchor to tip) that moves the tip by 0.34px — below the
 * canvas's own pixel grid, and the alternative (one sprite plus a live
 * `rotate()`) would hand the rasteriser a rotated quad, which is exactly the
 * non-axis-aligned geometry this module exists to avoid.
 */
const ROTATION_STEPS = 128;

/** Widest atlas strip we will allocate; a glyph whose strip would exceed this
 * gets proportionally fewer rotation steps rather than a failed allocation. */
const MAX_ATLAS_WIDTH = 4096;

interface RotationAtlas {
  canvas: HTMLCanvasElement;
  /** Square tile side; every step occupies one tile of the strip. */
  tile: number;
  steps: number;
}

/** Built sprites, keyed by glyph identity — glyphs are module constants or
 * memoised factory results, so identity is stable for the process. A `null`
 * entry records "this one could not be pre-rendered", so a failed build is
 * attempted once rather than on every frame. */
const spriteCache = new Map<Glyph, HTMLCanvasElement | null>();
const atlasCache = new Map<Glyph, RotationAtlas | null>();

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

function spriteFor(glyph: Glyph): HTMLCanvasElement | null {
  const cached = spriteCache.get(glyph);
  if (cached !== undefined) return cached;
  let sprite: HTMLCanvasElement | null = null;
  const surface = makeSurface(glyph.width, glyph.height);
  if (surface) {
    glyph.draw(surface.ctx, glyph.anchorX, glyph.anchorY);
    sprite = surface.canvas;
  }
  spriteCache.set(glyph, sprite);
  return sprite;
}

function atlasFor(glyph: Glyph): RotationAtlas | null {
  const cached = atlasCache.get(glyph);
  if (cached !== undefined) return cached;
  // A rotated glyph sweeps its whole box around the anchor, so the tile has
  // to be square and wide enough for the box's furthest corner in any
  // orientation — the diagonal of the anchor-to-edge extents.
  const reachX = Math.max(glyph.anchorX, glyph.width - glyph.anchorX);
  const reachY = Math.max(glyph.anchorY, glyph.height - glyph.anchorY);
  const tile = Math.ceil(2 * Math.hypot(reachX, reachY)) + 2;
  const steps = Math.max(1, Math.min(ROTATION_STEPS, Math.floor(MAX_ATLAS_WIDTH / tile)));
  let atlas: RotationAtlas | null = null;
  const surface = makeSurface(tile * steps, tile);
  if (surface) {
    for (let i = 0; i < steps; i++) {
      surface.ctx.save();
      surface.ctx.translate(i * tile + tile / 2, tile / 2);
      surface.ctx.rotate((i / steps) * Math.PI * 2);
      glyph.draw(surface.ctx, 0, 0);
      surface.ctx.restore();
    }
    atlas = { canvas: surface.canvas, tile, steps };
  }
  atlasCache.set(glyph, atlas);
  return atlas;
}

/** Draw `glyph` with its anchor at (`x`, `y`). */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number): void {
  const sprite = OFFSCREEN_AVAILABLE ? spriteFor(glyph) : null;
  if (!sprite) {
    glyph.draw(ctx, x, y);
    return;
  }
  ctx.drawImage(sprite, x - glyph.anchorX, y - glyph.anchorY);
}

/**
 * Draw `glyph` rotated by `angle` radians about its anchor, placed at
 * (`x`, `y`) — the pre-rotated equivalent of
 * `translate(x, y); rotate(angle); draw()`, which is exactly what the
 * fallback does.
 */
export function drawRotatedGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, angle: number, x: number, y: number): void {
  const atlas = OFFSCREEN_AVAILABLE ? atlasFor(glyph) : null;
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
  const half = atlas.tile / 2;
  ctx.drawImage(atlas.canvas, step * atlas.tile, 0, atlas.tile, atlas.tile, x - half, y - half, atlas.tile, atlas.tile);
}

/**
 * `ctx.strokeRect(x, y, w, h)` drawn as four `fillRect`s instead — same
 * centred-stroke geometry, same `strokeStyle` and `lineWidth`, drop-in at the
 * call site.
 *
 * A rect *outline* is not a rect, and the rasteriser treats it like any other
 * path: measured on the reference machine, the six `strokeRect`s a normal
 * frame issued cost ~10ms of frame budget, while the ~2,000 `fillRect`s
 * alongside them cost nothing, and swapping those six for their fillRect
 * equivalent took the live game from 47.0 to 59.2fps. The budget is brutally
 * small — one `strokeRect` per frame measured fine (58.5fps), two did not
 * (47.3fps) — so this is not a "hot path only" optimisation: anything drawn
 * every frame has to come through here.
 *
 * Sub-pixel placement is *not* the trigger, which is worth recording because
 * it is the obvious suspect: rounding every coordinate and the line width to
 * whole pixels in situ changed nothing (47.5fps against a 49.0 baseline).
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

/** Radius the disc sprites below are rendered at. Large enough that scaling
 * one up to a point-blank explosion still reads as a circle, small enough to
 * stay a trivial allocation. */
const DISC_SPRITE_RADIUS = 64;

/** Opaque disc sprites by `"r,g,b"` — one per colour the game blends. */
const discSprites = new Map<string, HTMLCanvasElement | null>();

function discSprite(rgb: string): HTMLCanvasElement | null {
  const cached = discSprites.get(rgb);
  if (cached !== undefined) return cached;
  let sprite: HTMLCanvasElement | null = null;
  const size = DISC_SPRITE_RADIUS * 2;
  const surface = makeSurface(size, size);
  if (surface) {
    surface.ctx.fillStyle = `rgb(${rgb})`;
    surface.ctx.beginPath();
    surface.ctx.arc(DISC_SPRITE_RADIUS, DISC_SPRITE_RADIUS, DISC_SPRITE_RADIUS, 0, Math.PI * 2);
    surface.ctx.fill();
    sprite = surface.canvas;
  }
  discSprites.set(rgb, sprite);
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
  const sprite = OFFSCREEN_AVAILABLE ? discSprite(rgb) : null;
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The overlay layer's coordinate system, and the one transform that maps it
 * onto whatever the canvas happens to be.
 *
 * **The design space is not a new unit.** It is `SCENE_WIDTH × SCENE_HEIGHT`
 * (640×400) — the space aim, shot columns, `zBuffer` indices, `spreadPx` and
 * `MAX_CONE_DEVIATION_PX` already live in (see `doc/dev/history.md`'s "shot/aim
 * resolution stays on the fixed 640" entry). Every pixel literal in the overlay
 * layer is *already correct* in that space, which is precisely why Classic
 * looks right today and Sharp does not: `applyRenderResolution` doubles the
 * backing store while `canvasFit.ts` keeps the display box the same, so a
 * fixed-device-pixel overlay renders at half its intended visual weight.
 *
 * So the fix is not "scale the HUD". It is: the overlay layer stops drawing in
 * device pixels and starts drawing in the space the simulation always used,
 * with one `ctx.scale()` mapping it onto the canvas.
 *
 * **The simulation never enters the scaled block, and that is load-bearing
 * rather than incidental.** It means a scale factor cannot leak into aim, so
 * replays and mixed-quality multiplayer sessions stay deterministic by
 * construction instead of by review. Nothing in this module may ever be
 * imported by shot resolution.
 *
 * **`withOverlayScale` is the only thing in the codebase that calls
 * `ctx.scale`.** Keeping that true is what makes the layer's one real hazard —
 * double-scaling — a single-place invariant that a test can assert, rather than
 * a property of ~470 call sites.
 *
 * **Caveat worth knowing before changing render resolutions.**
 * `watchCanvasSizing` (`main.ts:732`) is handed the *initial* `renderRes` and
 * is never re-called, so the CSS display box keeps whatever aspect ratio was
 * captured at startup. That is harmless today because every shipped preset is
 * 8:5, and this module is deliberately a function of the backing store rather
 * than of the display box — but it does add one more thing that quietly
 * depends on that ratio holding. A future preset at another aspect must
 * re-drive `watchCanvasSizing`, not just change the two numbers.
 */

/** The width every overlay literal is expressed in. `main.ts`'s `SCENE_WIDTH`. */
export const DESIGN_WIDTH = 640;
/** The height every overlay literal is expressed in. `main.ts`'s `SCENE_HEIGHT`. */
export const DESIGN_HEIGHT = 400;

/** The scaled frame an overlay draws into: the factor, and the design-space
 * dimensions that factor implies for this canvas. */
export interface OverlayFrame {
  /** Device pixels per design pixel. Never below 1 — see `overlayFrame`. */
  scale: number;
  /** Canvas width in design pixels (`canvasW / scale`). */
  w: number;
  /** Canvas height in design pixels (`canvasH / scale`). */
  h: number;
}

/**
 * The overlay frame for a canvas of this size. Pure.
 *
 * `min(w / 640, h / 400)` is the letterbox factor — the same arithmetic
 * `canvasFit.ts` already does to fit the canvas into its area — so the design
 * box is never *smaller* than 640×400 on either axis and a wide non-8:5
 * `?renderRes` cannot produce a 640×100 box in which a 72px status bar is most
 * of the frame.
 *
 * **The `max(1, …)` is the part that is easy to leave out, and leaving it out
 * re-creates the exact defect this module exists to fix.** `parseRenderRes`
 * clamps width and height independently (160-2560 × 100-1600), so `320x800` is
 * reachable; bare `min()` gives 0.5 there, which would render the status bar at
 * 36 device pixels in an 800-pixel frame where today it is 72. Clamping at 1
 * means a canvas smaller than the design box on either axis is simply drawn as
 * it is today, which is the honest behaviour: there are no device pixels
 * available to spend, so there is nothing to scale up into.
 *
 * The clamp also means `scale !== 1` is reachable only when the canvas is at
 * least 640×400 on *both* axes — i.e. Classic (1) and Sharp (2) in practice,
 * with every `?renderRes` override and every small test fixture landing on 1
 * and behaving byte-identically to before this module existed.
 */
export function overlayFrame(canvasW: number, canvasH: number): OverlayFrame {
  const scale = Math.max(1, Math.min(canvasW / DESIGN_WIDTH, canvasH / DESIGN_HEIGHT));
  return { scale, w: canvasW / scale, h: canvasH / scale };
}

/**
 * Run `body` with the context scaled into design space, then restore.
 *
 * Higher-order rather than a `beginOverlay`/`endOverlay` pair on purpose: the
 * `restore` becomes structural, so it cannot be skipped by an early return.
 * Overlay draws do have them — `drawDamageFlash` bails on zero intensity
 * (`effects.ts:273`), and `drawAmmoPanel`/`drawKeysPanel` return early from
 * inside `drawHud` — and a missed `restore` would leak the scale into the
 * *next* frame's scene render, which reads as a rendering bug rather than as a
 * missing brace.
 *
 * Generic in the body's return type because not every overlay draw is a pure
 * side effect: `drawLoreOverlay` hands back `{ maxScrollLines }`, which its
 * caller needs to clamp scrolling.
 *
 * `body` receives the design-space dimensions and the factor. **Use those, not
 * `ctx.canvas.width`** — the canvas is unchanged inside a scaled context, so a
 * `ctx.canvas.width` read here yields device pixels and lands at twice the
 * intended coordinate at Sharp. That mistake is silent: it compiles, and every
 * test that runs at scale 1 still passes.
 */
export function withOverlayScale<T>(
  ctx: CanvasRenderingContext2D,
  body: (w: number, h: number, scale: number) => T,
): T {
  const { scale, w, h } = overlayFrame(ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  try {
    return body(w, h, scale);
  } finally {
    ctx.restore();
  }
}

/**
 * The scale a context is currently drawing at, read back from its own
 * transform — for code that is handed a context rather than a frame, notably
 * `pathSprites.ts` deciding what resolution to pre-render a glyph at.
 *
 * **`Math.hypot(a, b)`, not `a`.** `a` is the x-basis vector's x-component, so
 * under a rotation it is `scale · cos θ` — and `drawAutomap` rotates the context
 * before drawing the player marker when the automap is set to turn with the
 * player. Reading `a` alone is correct at every angle *except* the one the
 * feature exists for, which is the worst possible failure shape. The hypot is
 * the length of that basis vector and is rotation-invariant.
 *
 * `getTransform` is called optionally because it is absent from older contexts
 * and from any test double that has not been taught about it; a plain call
 * would throw before a `?? 1` fallback could run.
 */
export function contextScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform?.();
  return m ? Math.hypot(m.a, m.b) : 1;
}

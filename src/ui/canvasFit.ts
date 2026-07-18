// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** On by default since the 2026-07 perf audit — responsive canvas sizing in
 * windowed mode (see `watchCanvasSizing`): the scene grows to fill the
 * available window instead of capping at its intrinsic 640×400. Measured
 * twice (`npm run perf:bench -- --flag scaling`): zero engine-side busy-time
 * delta headless, and a user-attended on-screen headed A/B showed identical
 * frame distributions (6.70 vs 6.70ms busy median) — the compositor upscale
 * is free at desktop window sizes, and the per-resize work is event-driven,
 * not per-frame. When off, `.scene-canvas`'s own CSS (`width/height: auto` +
 * `max-width/max-height: 100%` + `aspect-ratio`) still governs sizing — it
 * just can only ever *shrink* the canvas to fit a small viewport, never grow
 * it (the pre-feature fixed-max-size behavior). Fullscreen is entirely
 * unaffected either way — that state is sized by the separate
 * `.scene-canvas:fullscreen` CSS rule, never by this. Same pattern as
 * `DECORATIONS_ENABLED`/`PLAYER_STATS_ENABLED`/
 * `WALL_EDGE_ANTIALIASING_ENABLED`. */
export const RESPONSIVE_CANVAS_SCALING_ENABLED = true;

/**
 * Sizes `canvas` to the largest `sceneWidth`:`sceneHeight` box that fits
 * inside `canvasArea`'s current content box, via explicit inline
 * `width`/`height` — CSS alone can't do this for a replaced element like
 * `<canvas>`: `width: auto` just falls back to its intrinsic size (from the
 * canvas's own `width`/`height` attributes) rather than growing to fill
 * available space, so `max-width`/`max-height`/`aspect-ratio` alone only
 * ever *shrinks* it, never grows it. A no-op while `canvas` is the
 * Fullscreen API's target — that state is sized entirely by the
 * `.scene-canvas:fullscreen` CSS rule instead, and an inline style here
 * (higher specificity than any class selector) would otherwise fight it.
 */
export function fitCanvasToArea(canvas: HTMLCanvasElement, canvasArea: HTMLElement, sceneWidth: number, sceneHeight: number): void {
  if (document.fullscreenElement === canvas) return;
  const availW = canvasArea.clientWidth;
  const availH = canvasArea.clientHeight;
  if (availW <= 0 || availH <= 0) return; // canvasArea is hidden (display:none) — nothing to size yet
  const targetRatio = sceneWidth / sceneHeight;
  let width = availW;
  let height = width / targetRatio;
  if (height > availH) {
    height = availH;
    width = height * targetRatio;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

/** Wires up `fitCanvasToArea` to re-run on every size change to
 * `canvasArea` (window resizes, the sidebar layout changing, or
 * `canvasArea` itself flipping from hidden (0×0) to shown at a level
 * launch) and on exiting fullscreen (a `ResizeObserver` doesn't fire for
 * that transition on its own, since `canvasArea`'s own box is unaffected by
 * the fullscreen element's cross-document popout/return — entering
 * fullscreen needs no equivalent call, already a no-op inside
 * `fitCanvasToArea` itself).
 *
 * Deliberately does *not* check `RESPONSIVE_CANVAS_SCALING_ENABLED` itself —
 * the caller (`main.ts`) does, so a test can flip the flag via `vi.doMock`
 * on this module and see `main.ts`'s own (freshly re-imported) call site
 * react to it. A same-module check here couldn't be overridden that way: a
 * mocked export only changes what *other* modules importing it see, not
 * what this module's own already-compiled functions read internally. */
export function watchCanvasSizing(canvas: HTMLCanvasElement, canvasArea: HTMLElement, sceneWidth: number, sceneHeight: number): void {
  const refit = (): void => fitCanvasToArea(canvas, canvasArea, sceneWidth, sceneHeight);
  new ResizeObserver(refit).observe(canvasArea);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) refit();
  });
}

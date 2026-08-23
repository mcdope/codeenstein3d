// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { DESIGN_HEIGHT, DESIGN_WIDTH, contextScale, overlayFrame, withOverlayScale } from "./overlayScale";

/** Widths spanning both shipped presets and the `?renderRes` clamp range. */
const WIDTHS = [160, 320, 640, 800, 1280, 2560];

/** Canvases that must keep today's behaviour exactly — every one of them is
 * below the design box on at least one axis, so the `max(1, …)` clamp holds
 * them at scale 1. Named so a failure says which case broke. */
const UNSCALED: [string, number, number][] = [
  ["a wide `?renderRes` override", 2560, 400],
  ["a tall `?renderRes` override", 320, 800],
  ["the `?renderRes` floor", 160, 100],
  ["the lore-overlay test fixture", 800, 200],
  ["the raycaster minimap test fixture", 40, 30],
];

function ctx(w: number, h: number): MockCanvasContext {
  return createMockCanvasContext({ width: w, height: h } as HTMLCanvasElement);
}
const asCtx = (c: MockCanvasContext): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D;

describe("overlayFrame", () => {
  it("maps both shipped presets onto the same design box", () => {
    // The whole point of the module: identical design space, one of them drawn
    // at twice the device resolution.
    expect(overlayFrame(640, 400), "Classic").toEqual({ scale: 1, w: 640, h: 400 });
    expect(overlayFrame(1280, 800), "Sharp").toEqual({ scale: 2, w: 640, h: 400 });
  });

  it.each(WIDTHS)("an 8:5 canvas %ipx wide collapses onto the design box once it is big enough", (w) => {
    // 8:5 is the ratio `canvasFit.ts` preserves, so this is the family of
    // canvases the game actually renders into. At or above the design box the
    // scale absorbs the whole difference and every preset presents the same
    // 640x400 to the overlay; below it, the clamp hands back the canvas as-is.
    const h = (w * 5) / 8;
    const frame = overlayFrame(w, h);
    expect([frame.w, frame.h], `${w}x${h} design box`).toEqual([
      Math.min(w, DESIGN_WIDTH),
      Math.min(h, DESIGN_HEIGHT),
    ]);
    // The frame must describe the *whole* canvas — a design box that does not
    // multiply back up to it would leave an unreachable margin.
    expect(frame.w * frame.scale, `${w}x${h} must cover the canvas width`).toBeCloseTo(w, 10);
    expect(frame.h * frame.scale, `${w}x${h} must cover the canvas height`).toBeCloseTo(h, 10);
  });

  it.each(UNSCALED)("%s (%ix%i) stays at scale 1 — today's behaviour, unchanged", (_name, w, h) => {
    // The `max(1, …)` clamp. Without it these all produce scale < 1 and the
    // overlay renders *smaller* than it does today, re-creating the very defect
    // this module exists to fix at the other end of the range. A canvas below
    // the design box has no spare device pixels to scale up into.
    const frame = overlayFrame(w, h);
    expect(frame.scale, `${w}x${h} must not scale the overlay down`).toBe(1);
    expect([frame.w, frame.h], `${w}x${h} must draw into its own canvas`).toEqual([w, h]);
  });

  it("never scales below 1 anywhere in the reachable render-resolution range", () => {
    // `parseRenderRes` clamps width and height independently, so all four
    // corners of that rectangle are reachable and none may shrink the overlay.
    for (const w of [160, 640, 1280, 2560]) {
      for (const h of [100, 400, 800, 1600]) {
        expect(overlayFrame(w, h).scale, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never squeezes an axis below its design size while the canvas has room for it", () => {
    // What stops a wide non-8:5 canvas producing a 640x100 box, in which a 72px
    // status bar would be most of the frame: scaling by `w / 640` alone would
    // give 2560x400 a factor of 4. Taking the `min` of both axes means the axis
    // with the least room sets the factor, so neither can be over-scaled.
    //
    // The converse is *not* asserted, and deliberately: a canvas smaller than
    // the design box on an axis yields a design box smaller than 640x400 there.
    // That is today's behaviour under the `max(1, …)` clamp, and the honest one
    // — there are no device pixels to spend.
    for (const [w, h] of [
      [2560, 400],
      [2560, 1600],
      [320, 800],
      [1280, 800],
      [640, 400],
    ]) {
      const frame = overlayFrame(w, h);
      if (w >= DESIGN_WIDTH) {
        expect(frame.w, `${w}x${h} design width`).toBeGreaterThanOrEqual(DESIGN_WIDTH);
      }
      if (h >= DESIGN_HEIGHT) {
        expect(frame.h, `${w}x${h} design height`).toBeGreaterThanOrEqual(DESIGN_HEIGHT);
      }
    }
  });
});

describe("withOverlayScale", () => {
  it.each(WIDTHS)("at %ipx wide: scales exactly once, and restores", (w) => {
    // Exactly once is the anti-double-scale guard — the single real hazard of a
    // wrapper design, and why this module owns the only `ctx.scale` call there is.
    const c = ctx(w, (w * 5) / 8);
    withOverlayScale(asCtx(c), () => {});
    expect(c.scale.mock.calls, `one scale at ${w}px`).toHaveLength(1);
    expect(c.save, `save at ${w}px`).toHaveBeenCalledTimes(1);
    expect(c.restore, `restore at ${w}px`).toHaveBeenCalledTimes(1);
  });

  it("scales both axes by the same factor", () => {
    // A non-uniform scale would make `contextScale`'s single return value a lie
    // and distort every circle the overlay draws.
    const c = ctx(1280, 800);
    withOverlayScale(asCtx(c), () => {});
    expect(c.scale, "uniform scale").toHaveBeenCalledWith(2, 2);
  });

  it("hands the body design dimensions rather than the canvas's", () => {
    // The mistake this signature exists to prevent: reading `ctx.canvas.width`
    // inside the scaled block yields device pixels and lands at twice the
    // intended coordinate at Sharp — silently, and green in every test at s=1.
    const c = ctx(1280, 800);
    let seen: number[] = [];
    withOverlayScale(asCtx(c), (w, h, s) => {
      seen = [w, h, s];
    });
    expect(seen, "Sharp must present itself to the body as 640x400 at 2x").toEqual([640, 400, 2]);
  });

  it("returns the body's value", () => {
    // Not every overlay draw is a pure side effect: `drawLoreOverlay` hands back
    // `{ maxScrollLines }`, which its caller needs in order to clamp scrolling.
    // A `void` wrapper would have silently swallowed it.
    const c = ctx(1280, 800);
    const out = withOverlayScale(asCtx(c), (w, h) => ({ maxScrollLines: Math.floor(h / w) }));
    expect(out, "the body's return value must survive the wrapper").toEqual({ maxScrollLines: 0 });
  });

  it("leaves the transform as it found it", () => {
    const c = ctx(1280, 800);
    withOverlayScale(asCtx(c), () => {
      expect(contextScale(asCtx(c)), "scaled inside the body").toBe(2);
    });
    expect(contextScale(asCtx(c)), "identity again after the body").toBe(1);
  });

  it("restores even when the body throws", () => {
    // A leaked scale would corrupt the *next* frame's scene render, which reads
    // as a rendering bug rather than as a missing restore.
    const c = ctx(1280, 800);
    expect(() =>
      withOverlayScale(asCtx(c), () => {
        throw new Error("overlay blew up");
      }),
    ).toThrow("overlay blew up");
    expect(c.restore, "the transform must not leak out of a throwing body").toHaveBeenCalledTimes(1);
    expect(contextScale(asCtx(c)), "identity again after a throwing body").toBe(1);
  });
});

describe("contextScale", () => {
  it("reads the scale back off the transform", () => {
    const c = asCtx(ctx(1280, 800));
    c.scale(2, 2);
    expect(contextScale(c)).toBe(2);
  });

  it("survives a rotation, which a bare `a` read does not", () => {
    // The trap this function exists for. `drawAutomap` rotates the context
    // before drawing the player marker when the map turns with the player, and
    // there `a` is `s · cos θ` — correct at every angle except the ones the
    // feature is for.
    const c = asCtx(ctx(1280, 800));
    c.scale(2, 2);
    c.rotate(Math.PI / 3);
    expect(c.getTransform().a, "a bare `a` read would report this instead").toBeCloseTo(1, 10);
    expect(contextScale(c), "hypot recovers the real scale under rotation").toBeCloseTo(2, 10);
  });

  it("reports 1 for an untouched context", () => {
    expect(contextScale(asCtx(ctx(1280, 800)))).toBe(1);
  });

  it("falls back to 1 on a context with no getTransform", () => {
    // Older contexts, and any test double not taught about it. A plain
    // `ctx.getTransform()` would throw here before a `?? 1` could ever run.
    const bare = { canvas: { width: 640, height: 400 } } as unknown as CanvasRenderingContext2D;
    expect(contextScale(bare)).toBe(1);
  });
});

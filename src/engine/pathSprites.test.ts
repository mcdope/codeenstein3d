// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import type { Glyph } from "./pathSprites";

/** A target context to draw glyphs *onto* — deliberately built directly
 * rather than through `getContext`, so it stays a distinct object from
 * whatever offscreen context the module gets for its own pre-rendering. */
function target(): MockCanvasContext {
  return createMockCanvasContext({ width: 640, height: 400 } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

/** A triangle glyph in the same shape every real caller uses: absolute
 * coordinates offset from the anchor the module hands it. */
function triangleGlyph(): Glyph {
  return {
    width: 20,
    height: 20,
    anchorX: 10,
    anchorY: 10,
    draw: (g, ox, oy) => {
      g.fillStyle = "#fff";
      g.beginPath();
      g.moveTo(ox, oy - 8);
      g.lineTo(ox + 6, oy + 6);
      g.lineTo(ox - 6, oy + 6);
      g.closePath();
      g.fill();
    },
  };
}

/**
 * Installs a `getContext` stub for the offscreen canvases the module creates.
 * `paints` decides what the readback probe sees: a real opaque pixel (the
 * pre-render fast path is usable) or the all-transparent buffer a context
 * that silently swallows drawing returns (fall back to direct drawing).
 */
function stubOffscreen(paints: boolean): { restore: () => void; contexts: MockCanvasContext[] } {
  const contexts: MockCanvasContext[] = [];
  const original = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = function (this: HTMLCanvasElement) {
    const ctx = createMockCanvasContext(this);
    ctx.getImageData = vi.fn((_sx: number, _sy: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      if (paints) data.fill(255);
      return { width: w, height: h, data };
    });
    contexts.push(ctx);
    return ctx;
  };
  return { restore: () => { HTMLCanvasElement.prototype.getContext = original; }, contexts };
}

/** Loads a fresh copy of the module so its load-time capability probe re-runs
 * against whatever `getContext` stub is currently installed. */
async function loadModule() {
  vi.resetModules();
  return import("./pathSprites");
}

let stub: { restore: () => void; contexts: MockCanvasContext[] };

afterEach(() => stub?.restore());

describe("pathSprites — no usable offscreen surface", () => {
  beforeEach(() => {
    stub = stubOffscreen(false);
  });

  it("reports the fast path as unavailable when the probe reads back nothing", async () => {
    const { offscreenSpritesAvailable } = await loadModule();
    expect(offscreenSpritesAvailable()).toBe(false);
  });

  it("draws the glyph straight onto the target, with no extra canvas calls of its own", async () => {
    const { drawGlyph } = await loadModule();
    const c = target();
    drawGlyph(asCtx(c), triangleGlyph(), 100, 50);

    // The glyph's own drawing, at the requested anchor — and nothing else.
    expect(c.fill).toHaveBeenCalledTimes(1);
    expect(c.moveTo).toHaveBeenCalledWith(100, 42);
    expect(c.drawImage).not.toHaveBeenCalled();
    // No wrapping transform: the fallback has to be call-for-call identical
    // to the drawing it replaced.
    expect(c.save).not.toHaveBeenCalled();
    expect(c.translate).not.toHaveBeenCalled();
  });

  it("rotates via the transform, and undoes it without touching the state stack", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const c = target();
    drawRotatedGlyph(asCtx(c), triangleGlyph(), Math.PI / 2, 30, 40);

    expect(c.translate).toHaveBeenNthCalledWith(1, 30, 40);
    expect(c.rotate).toHaveBeenNthCalledWith(1, Math.PI / 2);
    expect(c.fill).toHaveBeenCalledTimes(1);
    // Exactly inverted afterwards, so the caller's transform is where it was.
    expect(c.rotate).toHaveBeenNthCalledWith(2, -Math.PI / 2);
    expect(c.translate).toHaveBeenNthCalledWith(2, -30, -40);
    // Callers pair their own save/restore and assert the count; the fallback
    // must not appear in it.
    expect(c.save).not.toHaveBeenCalled();
    expect(c.restore).not.toHaveBeenCalled();
    expect(c.drawImage).not.toHaveBeenCalled();
  });

  it("falls back when a canvas can be made but yields no 2D context at all", async () => {
    stub.restore();
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
    stub = { restore: () => { HTMLCanvasElement.prototype.getContext = original; }, contexts: [] };

    const { drawGlyph, offscreenSpritesAvailable } = await loadModule();
    expect(offscreenSpritesAvailable()).toBe(false);
    const c = target();
    drawGlyph(asCtx(c), triangleGlyph(), 5, 5);
    expect(c.fill).toHaveBeenCalledTimes(1);
    expect(c.drawImage).not.toHaveBeenCalled();
  });

  it("falls back when creating the canvas throws outright", async () => {
    const createSpy = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("canvas disabled");
    });
    try {
      const { offscreenSpritesAvailable } = await loadModule();
      expect(offscreenSpritesAvailable()).toBe(false);
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("outlineRect", () => {
  it("draws a centred rect outline as four fillRects, restoring fillStyle", async () => {
    const { outlineRect } = await loadModule();
    const c = target();
    c.fillStyle = "#123456";
    c.strokeStyle = "#abcdef";
    c.lineWidth = 2;
    outlineRect(asCtx(c), 10, 20, 30, 40);

    expect(c.strokeRect).not.toHaveBeenCalled();
    expect(c.fillRect.mock.calls).toEqual([
      [9, 19, 32, 2], // top
      [9, 59, 32, 2], // bottom
      [9, 21, 2, 38], // left
      [39, 21, 2, 38], // right
    ]);
    expect(c.fillStyle).toBe("#123456");
  });

  it("omits the side bars when the rect is no taller than its own outline", async () => {
    const { outlineRect } = await loadModule();
    const c = target();
    c.lineWidth = 4;
    outlineRect(asCtx(c), 0, 0, 20, 3); // 3px tall, 4px stroke — top and bottom already meet
    expect(c.fillRect).toHaveBeenCalledTimes(2);
  });
});

describe("fillLine", () => {
  it("steps one rect per column for a shallow line, covering both endpoints once", async () => {
    const { fillLine } = await loadModule();
    const c = target();
    fillLine(asCtx(c), 10, 5, 20, 8, 2); // dx 10 > dy 3 -> column-stepped
    const columns = c.fillRect.mock.calls.map((call) => call[0] as number);
    expect(columns[0]).toBe(10);
    expect(columns.at(-1)).toBe(20);
    expect(new Set(columns).size).toBe(columns.length);
    // Each rect is 1px wide and `width` tall, centred on the line.
    expect(c.fillRect.mock.calls[0].slice(2)).toEqual([1, 2]);
  });

  it("steps one rect per row for a steep line, and runs backwards when it descends", async () => {
    const { fillLine } = await loadModule();
    const c = target();
    fillLine(asCtx(c), 4, 30, 6, 10, 3); // dy 20 > dx 2, and y decreases
    const rows = c.fillRect.mock.calls.map((call) => call[1] as number);
    expect(rows[0]).toBe(30);
    expect(rows.at(-1)).toBe(10);
    expect(rows).toHaveLength(21);
    expect(c.fillRect.mock.calls[0].slice(2)).toEqual([3, 1]);
  });

  it("runs backwards for a shallow line that goes right-to-left", async () => {
    const { fillLine } = await loadModule();
    const c = target();
    fillLine(asCtx(c), 20, 8, 10, 5, 2);
    const columns = c.fillRect.mock.calls.map((call) => call[0] as number);
    expect(columns[0]).toBe(20);
    expect(columns.at(-1)).toBe(10);
  });

  it("keeps a perfectly vertical line one column wide", async () => {
    const { fillLine } = await loadModule();
    const c = target();
    fillLine(asCtx(c), 15, 0, 15, 6, 2); // dx === 0 — no slope to divide by
    const xs = new Set(c.fillRect.mock.calls.map((call) => call[0] as number));
    expect([...xs]).toEqual([14]); // 15 - width/2
  });

  it("still marks a single pixel for a zero-length line", async () => {
    const { fillLine } = await loadModule();
    const c = target();
    fillLine(asCtx(c), 7, 7, 7, 7, 2);
    expect(c.fillRect).toHaveBeenCalledTimes(1);
  });
});

describe("drawDisc", () => {
  it("falls back to an arc fill when no offscreen surface is usable", async () => {
    stub?.restore();
    stub = stubOffscreen(false);
    const { drawDisc } = await loadModule();
    const c = target();
    drawDisc(asCtx(c), "255,150,40", 0.5, 100, 60, 12);
    expect(c.fillStyle).toBe("rgba(255,150,40,0.5)");
    expect(c.arc).toHaveBeenCalledWith(100, 60, 12, 0, Math.PI * 2);
    expect(c.fill).toHaveBeenCalledTimes(1);
    expect(c.drawImage).not.toHaveBeenCalled();
  });

  it("blits a scaled sprite under globalAlpha, restoring alpha and smoothing", async () => {
    stub?.restore();
    stub = stubOffscreen(true);
    const { drawDisc } = await loadModule();
    const c = target();
    c.globalAlpha = 0.5;
    c.imageSmoothingEnabled = false;
    drawDisc(asCtx(c), "255,150,40", 0.4, 100, 60, 12);

    expect(c.arc).not.toHaveBeenCalled();
    expect(c.fill).not.toHaveBeenCalled();
    // Destination box is the circle's bounding square.
    expect(c.drawImage.mock.calls[0].slice(1)).toEqual([88, 48, 24, 24]);
    // Composed with whatever alpha the caller already had, then put back.
    expect(c.globalAlpha).toBe(0.5);
    expect(c.imageSmoothingEnabled).toBe(false);
  });

  it("pre-renders one sprite per colour and reuses it", async () => {
    stub?.restore();
    stub = stubOffscreen(true);
    const { drawDisc } = await loadModule();
    const createSpy = vi.spyOn(document, "createElement");
    drawDisc(asCtx(target()), "1,2,3", 1, 0, 0, 5);
    drawDisc(asCtx(target()), "1,2,3", 1, 0, 0, 9);
    expect(createSpy.mock.calls.filter((a) => a[0] === "canvas")).toHaveLength(1);
    drawDisc(asCtx(target()), "4,5,6", 1, 0, 0, 5); // different colour -> its own sprite
    expect(createSpy.mock.calls.filter((a) => a[0] === "canvas")).toHaveLength(2);
    createSpy.mockRestore();
  });

  it("falls back per colour when that sprite cannot be built", async () => {
    stub?.restore();
    stub = stubOffscreen(true);
    const { drawDisc } = await loadModule();
    const createSpy = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("out of memory");
    });
    try {
      const c1 = target();
      drawDisc(asCtx(c1), "9,9,9", 1, 0, 0, 5);
      expect(c1.fill).toHaveBeenCalledTimes(1);
      const after = createSpy.mock.calls.length;
      const c2 = target();
      drawDisc(asCtx(c2), "9,9,9", 1, 0, 0, 5);
      expect(c2.fill).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls).toHaveLength(after); // failure cached
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("pathSprites — pre-rendered fast path", () => {
  beforeEach(() => {
    stub = stubOffscreen(true);
  });

  it("reports the fast path as available once the probe reads back a real pixel", async () => {
    const { offscreenSpritesAvailable } = await loadModule();
    expect(offscreenSpritesAvailable()).toBe(true);
  });

  it("blits a pre-rendered sprite instead of path-filling onto the target", async () => {
    const { drawGlyph } = await loadModule();
    const c = target();
    const glyph = triangleGlyph();
    drawGlyph(asCtx(c), glyph, 100, 50);

    // Nothing non-rectangular reaches the target — that is the whole point.
    expect(c.fill).not.toHaveBeenCalled();
    expect(c.beginPath).not.toHaveBeenCalled();
    // Anchor-corrected destination.
    expect(c.drawImage).toHaveBeenCalledTimes(1);
    expect(c.drawImage.mock.calls[0].slice(1)).toEqual([90, 40]);
  });

  it("pre-renders a given glyph once and reuses it on every later frame", async () => {
    const { drawGlyph } = await loadModule();
    const glyph = triangleGlyph();
    const createSpy = vi.spyOn(document, "createElement");

    drawGlyph(asCtx(target()), glyph, 10, 10);
    const afterFirst = createSpy.mock.calls.filter((a) => a[0] === "canvas").length;
    expect(afterFirst).toBe(1);

    drawGlyph(asCtx(target()), glyph, 20, 20);
    drawGlyph(asCtx(target()), glyph, 30, 30);
    expect(createSpy.mock.calls.filter((a) => a[0] === "canvas").length).toBe(afterFirst);
    createSpy.mockRestore();
  });

  it("blits one pre-rotated tile per angle, with no live rotate on the target", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const c = target();
    const glyph = triangleGlyph();
    drawRotatedGlyph(asCtx(c), glyph, 0, 50, 50);

    expect(c.rotate).not.toHaveBeenCalled();
    expect(c.fill).not.toHaveBeenCalled();
    expect(c.drawImage).toHaveBeenCalledTimes(1);
    // (atlas, sx, sy, sw, sh, dx, dy, dw, dh) — the first tile, centred.
    const [, sx, sy, sw, sh] = c.drawImage.mock.calls[0];
    expect(sx).toBe(0);
    expect(sy).toBe(0);
    expect(sw).toBe(sh); // square tiles
  });

  it("selects the same tile for equivalent positive and negative bearings", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const glyph = triangleGlyph();
    const cNeg = target();
    const cPos = target();
    drawRotatedGlyph(asCtx(cNeg), glyph, -Math.PI / 2, 0, 0);
    drawRotatedGlyph(asCtx(cPos), glyph, (3 * Math.PI) / 2, 0, 0);
    expect(cNeg.drawImage.mock.calls[0][1]).toBe(cPos.drawImage.mock.calls[0][1]);
  });

  it("builds the rotation atlas once and reuses it across angles", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const glyph = triangleGlyph();
    const createSpy = vi.spyOn(document, "createElement");
    drawRotatedGlyph(asCtx(target()), glyph, 0, 0, 0);
    const afterFirst = createSpy.mock.calls.filter((a) => a[0] === "canvas").length;
    expect(afterFirst).toBe(1);
    drawRotatedGlyph(asCtx(target()), glyph, 1, 0, 0);
    drawRotatedGlyph(asCtx(target()), glyph, 2, 0, 0);
    expect(createSpy.mock.calls.filter((a) => a[0] === "canvas").length).toBe(afterFirst);
    createSpy.mockRestore();
  });

  it("keeps the atlas strip within the maximum width for an oversized glyph", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const c = target();
    // Reach ~1000px -> a full 128-step strip would be far past the cap, so
    // the step count drops instead of the allocation failing.
    const big: Glyph = { width: 2000, height: 2000, anchorX: 1000, anchorY: 1000, draw: (g, ox, oy) => g.fillRect(ox, oy, 1, 1) };
    drawRotatedGlyph(asCtx(c), big, 0, 0, 0);
    const tile = c.drawImage.mock.calls[0][3] as number;
    expect(tile).toBeGreaterThan(0);
    expect(stub.contexts.at(-1)!.canvas.width).toBeLessThanOrEqual(4096);
  });

  it("caches a failed pre-render so a broken glyph is not retried every frame", async () => {
    const { drawGlyph } = await loadModule();
    const glyph = triangleGlyph();
    // Probe succeeded at load time; make later canvas creation fail so the
    // sprite build cannot complete.
    const createSpy = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("out of memory");
    });
    try {
      const c1 = target();
      drawGlyph(asCtx(c1), glyph, 0, 0);
      expect(c1.fill).toHaveBeenCalledTimes(1); // fell back
      const callsAfterFirst = createSpy.mock.calls.length;
      const c2 = target();
      drawGlyph(asCtx(c2), glyph, 0, 0);
      expect(c2.fill).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls.length).toBe(callsAfterFirst); // no retry
    } finally {
      createSpy.mockRestore();
    }
  });

  it("falls back if the context is lost between the load-time probe and a build", async () => {
    const { drawGlyph, offscreenSpritesAvailable } = await loadModule();
    expect(offscreenSpritesAvailable()).toBe(true);
    // The probe passed at load; a later `getContext` returning null is a real
    // reachable state (a lost/reclaimed context), not just a defensive branch.
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
    try {
      const c = target();
      drawGlyph(asCtx(c), triangleGlyph(), 0, 0);
      expect(c.fill).toHaveBeenCalledTimes(1);
      expect(c.drawImage).not.toHaveBeenCalled();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("caches a failed atlas build the same way", async () => {
    const { drawRotatedGlyph } = await loadModule();
    const glyph = triangleGlyph();
    const createSpy = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("out of memory");
    });
    try {
      const c1 = target();
      drawRotatedGlyph(asCtx(c1), glyph, 0, 0, 0);
      expect(c1.fill).toHaveBeenCalledTimes(1);
      const callsAfterFirst = createSpy.mock.calls.length;
      const c2 = target();
      drawRotatedGlyph(asCtx(c2), glyph, 0, 0, 0);
      expect(createSpy.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      createSpy.mockRestore();
    }
  });
});

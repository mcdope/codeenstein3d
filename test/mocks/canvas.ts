// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-rolled `CanvasRenderingContext2D` test double. Not an npm package —
 * this repo prefers a small object literal over a dependency for something
 * this narrow (see `doc/dev/decisions.md`'s dependency-minimalism stance).
 *
 * Covers exactly the surface the engine/ui layers call (confirmed via a
 * grep across `src/engine/*.ts`, `src/ui/*.ts`, `src/map/debugView.ts`) —
 * every method is a `vi.fn()` so tests can assert *which calls happened with
 * which args*, not pixel output. Real rendering/visual correctness stays the
 * job of the existing Playwright verify scripts (`scripts/verify-wad-textures.mjs`
 * et al.), not this suite.
 */
import { vi } from "vitest";

export type MockCanvasContext = {
  [K in
    | "save"
    | "restore"
    | "translate"
    | "rotate"
    | "scale"
    | "beginPath"
    | "closePath"
    | "moveTo"
    | "lineTo"
    | "quadraticCurveTo"
    | "arc"
    | "rect"
    | "clip"
    | "fill"
    | "stroke"
    | "fillRect"
    | "strokeRect"
    | "fillText"
    | "strokeText"
    | "drawImage"
    | "putImageData"
    | "getTransform"] : ReturnType<typeof vi.fn>;
} & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  canvas: HTMLCanvasElement;
  getImageData: ReturnType<typeof vi.fn>;
  createImageData: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
};

/** A blank, all-transparent `ImageData`-shaped object of the given size. */
function blankImageData(width: number, height: number) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createMockCanvasContext(canvas: HTMLCanvasElement): MockCanvasContext {
  // The *linear* part of the CTM — `a b c d`, no translation — with a
  // save/restore stack. Tracked rather than stubbed because `pathSprites.ts`
  // reads it back to decide what resolution to pre-render a glyph at, via
  // `Math.hypot(m.a, m.b)`. A stub returning identity would make every
  // scale-aware test vacuously green; one returning `{ a: s }` alone would hide
  // the bug that actually matters, because under `drawAutomap`'s facing-up
  // rotate `a` is `s·cos θ` and only the hypot recovers `s`. Translation is
  // deliberately not tracked: nothing reads `e`/`f`, and carrying it would
  // invite tests that assert on the transform instead of on the recorded draw
  // arguments, which is the house rule (see this file's header).
  let m = { a: 1, b: 0, c: 0, d: 1 };
  const stack: (typeof m)[] = [];
  const ctx = {
    save: vi.fn(() => {
      stack.push({ ...m });
    }),
    restore: vi.fn(() => {
      m = stack.pop() ?? { a: 1, b: 0, c: 0, d: 1 };
    }),
    translate: vi.fn(),
    rotate: vi.fn((angle: number) => {
      // Post-multiplied, matching the real 2D context: M' = M · R.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      m = {
        a: m.a * cos + m.c * sin,
        b: m.b * cos + m.d * sin,
        c: -m.a * sin + m.c * cos,
        d: -m.b * sin + m.d * cos,
      };
    }),
    scale: vi.fn((sx: number, sy: number) => {
      m = { a: m.a * sx, b: m.b * sx, c: m.c * sy, d: m.d * sy };
    }),
    getTransform: vi.fn(() => ({ ...m, e: 0, f: 0 })),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    // Returns the font it was called with. The real `fillText` returns void,
    // and nothing reads this in production — it is here so a test can tell
    // *which* font a given draw used, via `mock.results[i].value`. Recording
    // it through the return value rather than a parallel array keeps it
    // index-aligned with `mock.calls` by construction, including across
    // `vi.clearAllMocks()`, which clears both together.
    fillText: vi.fn(() => ctx.font),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    getImageData: vi.fn((_sx: number, _sy: number, w: number, h: number) => blankImageData(w, h)),
    createImageData: vi.fn((w: number, h: number) => blankImageData(w, h)),
    // Font-aware, because HUD panels now *choose* a size from what fits: a
    // flat 6px per character reported the same width at 22px as at 14px, so a
    // fit-to-width rule could not be tested through this mock at all. Every
    // font the engine sets here is `ui-monospace`, whose advance is 0.602em
    // across sizes (measured in Chromium: 13.25px at 22, 6.62px at 11, 5.42px
    // at 9), so length x size x 0.602 is the real thing rather than a stand-in.
    measureText: vi.fn((text: string) => {
      const px = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
      return { width: text.length * (px ? Number(px[1]) : 10) * 0.602 } as TextMetrics;
    }),
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "10px sans-serif",
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    canvas,
  };
  return ctx as unknown as MockCanvasContext;
}

/**
 * Patches `HTMLCanvasElement.prototype.getContext` (jsdom stubs it to return
 * `null` by default) so any code under test that calls `canvas.getContext("2d")`
 * gets a fresh mock context back. Returns the context for direct assertions,
 * plus a restore function to undo the patch.
 */
export function stubCanvasGetContext(canvas: HTMLCanvasElement): {
  ctx: MockCanvasContext;
  restore: () => void;
} {
  const ctx = createMockCanvasContext(canvas);
  const original = HTMLCanvasElement.prototype.getContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ctx);
  return {
    ctx,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

/** jsdom's `HTMLCanvasElement.prototype.toBlob` is unimplemented (throws a
 * "Not implemented" virtual-console error and never invokes its callback at
 * all) — needed by the "Export Map as PNG" button (`main.ts`). Patches it to
 * synchronously call back with a real (tiny, content-irrelevant) `Blob`, or
 * `null` if `returnNull` is set, to exercise the "toBlob handed back nothing"
 * branch a real browser can also produce. Returns a restore function. */
export function stubCanvasToBlob(returnNull = false): { restore: () => void } {
  const original = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback): void {
    callback(returnNull ? null : new Blob(["fake-png-bytes"], { type: "image/png" }));
  };
  return {
    restore: () => {
      HTMLCanvasElement.prototype.toBlob = original;
    },
  };
}

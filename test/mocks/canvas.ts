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
    | "drawImage"
    | "putImageData"] : ReturnType<typeof vi.fn>;
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
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
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
    fillText: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    getImageData: vi.fn((_sx: number, _sy: number, w: number, h: number) => blankImageData(w, h)),
    createImageData: vi.fn((w: number, h: number) => blankImageData(w, h)),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 }) as TextMetrics),
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

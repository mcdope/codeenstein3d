// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it, vi } from "vitest";
import { stubCanvasGetContext } from "../../test/mocks/canvas";
import type { WadLoadResult } from "../wad/loadWad";

const loadWadTexturesMock = vi.fn();
vi.mock("../wad/loadWad", () => ({ loadWadTextures: (bytes: ArrayBuffer) => loadWadTexturesMock(bytes) }));

// textures.ts's module scope constructs a `TextureManager` singleton
// (`export const textures = new TextureManager()`), which builds every
// procedural default texture via `document.createElement("canvas")` +
// `canvas.getContext("2d")` at import time — before any test setup (even
// beforeAll) can run, since ES module imports are hoisted ahead of all
// other top-level code. Stub the canvas context first, then dynamically
// import textures.ts. Same gotcha as raycaster.ts (see its test notes).
let TextureManager: typeof import("./textures").TextureManager;
let TEXTURE_SIZE: number;
let LORE_BASE: readonly [number, number, number];

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ TextureManager, TEXTURE_SIZE, LORE_BASE } = await import("./textures"));
});

function emptyWadResult(overrides: Partial<WadLoadResult> = {}): WadLoadResult {
  return {
    ok: true,
    error: null,
    wallName: null,
    bonusWallName: null,
    doorName: null,
    floorName: null,
    bonusFloorName: null,
    loreWallName: null,
    hazardFloorName: null,
    teleporterFloorName: null,
    spikeSafeFloorName: null,
    spikeActiveFloorName: null,
    wallTexture: null,
    bonusWallTexture: null,
    doorTexture: null,
    floorTexture: null,
    bonusFloorTexture: null,
    loreWallTexture: null,
    hazardFloorTexture: null,
    teleporterFloorTexture: null,
    spikeSafeFloorTexture: null,
    spikeActiveFloorTexture: null,
    ...overrides,
  };
}

/** A tiny 2x2 WAD texture: one fully opaque pixel (top-left) and one
 * fully-transparent "hole" pixel (top-right) so bitmapFromWadPixels's
 * alpha-hole-fill branch (and its pass-through branch) both get exercised. */
function wadTexture(): { width: number; height: number; rgba: Uint8ClampedArray } {
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  // Pixel (0,0): opaque red.
  rgba.set([200, 10, 10, 255], 0);
  // Pixel (1,0): a hole (alpha 0) — content doesn't matter, gets overwritten.
  rgba.set([0, 0, 0, 0], 4);
  // Row 2: opaque again, arbitrary.
  rgba.set([50, 50, 50, 255], 8);
  rgba.set([50, 50, 50, 255], 12);
  return { width: 2, height: 2, rgba };
}

describe("module constants", () => {
  it("exposes the documented texture size and lore base tone", () => {
    expect(TEXTURE_SIZE).toBe(64);
    expect(LORE_BASE).toEqual([120, 200, 210]);
  });
});

describe("TextureManager — defaults", () => {
  it("builds all 10 procedural default slots, each at TEXTURE_SIZE", () => {
    const manager = new TextureManager();
    const set = manager.getActiveSet();
    const slots = [
      set.wall,
      set.bonusWall,
      set.door,
      set.floor,
      set.bonusFloor,
      set.loreWall,
      set.hazardFloor,
      set.teleporterFloor,
      set.spikeSafeFloor,
      set.spikeActiveFloor,
    ];
    expect(slots).toHaveLength(10);
    for (const tex of slots) {
      expect(tex.width).toBe(TEXTURE_SIZE);
      expect(tex.height).toBe(TEXTURE_SIZE);
      expect(tex.pixels.length).toBe(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    }
  });

  it("throws when no 2D canvas context is available at all", () => {
    const getContext = HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>;
    getContext.mockImplementationOnce(() => null);
    expect(() => new TextureManager()).toThrow("2D canvas context unavailable for procedural texture generation");
  });
});

describe("TextureManager.loadFromWad — parse failure", () => {
  it("leaves the active set on defaults and returns an all-null summary", () => {
    const manager = new TextureManager();
    const before = manager.getActiveSet();
    loadWadTexturesMock.mockReturnValueOnce({ ok: false, error: "bad WAD magic" } as WadLoadResult);
    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.ok).toBe(false);
    expect(summary.error).toBe("bad WAD magic");
    expect(summary.wallName).toBeNull();
    expect(manager.getActiveSet()).toBe(before); // unchanged
  });
});

describe("TextureManager.loadFromWad — success", () => {
  it("uses a WAD-provided texture for every slot that has one", () => {
    const manager = new TextureManager();
    const tex = wadTexture();
    loadWadTexturesMock.mockReturnValueOnce(
      emptyWadResult({
        wallName: "BRICK1",
        bonusWallName: "STEEL1",
        doorName: "DOOR1",
        floorName: "FLAT1",
        bonusFloorName: "FLAT2",
        loreWallName: "FLAT3",
        hazardFloorName: "FLAT4",
        teleporterFloorName: "FLAT5",
        spikeSafeFloorName: "FLAT6",
        spikeActiveFloorName: "FLAT7",
        wallTexture: tex,
        bonusWallTexture: tex,
        doorTexture: tex,
        floorTexture: tex,
        bonusFloorTexture: tex,
        loreWallTexture: tex,
        hazardFloorTexture: tex,
        teleporterFloorTexture: tex,
        spikeSafeFloorTexture: tex,
        spikeActiveFloorTexture: tex,
      }),
    );
    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.ok).toBe(true);
    expect(summary.wallName).toBe("BRICK1");
    const set = manager.getActiveSet();
    expect(set.wall.width).toBe(2); // the WAD fixture's size, not TEXTURE_SIZE
    expect(set.spikeActiveFloor.width).toBe(2);
  });

  it("falls back to the procedural default for every slot the WAD doesn't have", () => {
    const manager = new TextureManager();
    const before = manager.getActiveSet();
    loadWadTexturesMock.mockReturnValueOnce(emptyWadResult()); // ok:true, every texture null
    manager.loadFromWad(new ArrayBuffer(0));
    const after = manager.getActiveSet();
    expect(after.wall).toBe(before.wall);
    expect(after.spikeActiveFloor).toBe(before.spikeActiveFloor);
  });

  it("fills transparent WAD pixels with the slot's base color, leaving opaque pixels untouched", () => {
    const manager = new TextureManager();
    const tex = wadTexture();
    loadWadTexturesMock.mockReturnValueOnce(emptyWadResult({ wallName: "BRICK1", wallTexture: tex }));
    manager.loadFromWad(new ArrayBuffer(0));
    const pixels = manager.getActiveSet().wall.pixels;
    // Opaque pixel (0,0) unchanged.
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([200, 10, 10, 255]);
    // Hole pixel (1,0) filled with the wall's base color (WALL_BASE), opaque.
    expect(pixels[7]).toBe(255); // alpha forced opaque
    expect([pixels[4], pixels[5], pixels[6]]).not.toEqual([0, 0, 0]); // no longer transparent-black
  });

  it("throws when no 2D canvas context is available for a WAD texture conversion", () => {
    const manager = new TextureManager();
    const tex = wadTexture();
    loadWadTexturesMock.mockReturnValueOnce(emptyWadResult({ wallName: "BRICK1", wallTexture: tex }));
    const getContext = HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>;
    getContext.mockImplementationOnce(() => null);
    expect(() => manager.loadFromWad(new ArrayBuffer(0))).toThrow("2D canvas context unavailable for WAD texture conversion");
  });
});

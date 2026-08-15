// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it, vi } from "vitest";
import { stubCanvasGetContext } from "../../test/mocks/canvas";
import { STYLE_SET_IDS, type StyleSetId } from "../map/types";
import type { WadLoadResult, WadSlot } from "../wad/loadWad";

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
let TOTAL_WAD_SLOTS: number;
let LORE_BASE: readonly [number, number, number];

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ TextureManager, TEXTURE_SIZE, TOTAL_WAD_SLOTS, LORE_BASE } = await import("./textures"));
});

function emptySlot(): WadSlot {
  return { name: null, texture: null };
}

function emptyWadResult(overrides: Partial<WadLoadResult> = {}): WadLoadResult {
  const styles = {} as WadLoadResult["styles"];
  for (const id of STYLE_SET_IDS) {
    styles[id] = { wall: emptySlot(), floor: emptySlot(), door: emptySlot() };
  }
  return {
    ok: true,
    error: null,
    styles,
    signals: {
      loreWall: emptySlot(),
      hazardFloor: emptySlot(),
      teleporterFloor: emptySlot(),
      spikeSafeFloor: emptySlot(),
      spikeActiveFloor: emptySlot(),
    },
    ...overrides,
  };
}

/** A tiny 2x2 WAD texture: one fully opaque pixel (top-left) and one
 * fully-transparent "hole" pixel (top-right) so bitmapFromWadPixels's
 * alpha-hole-fill branch (and its pass-through branch) both get exercised.
 * A fresh buffer per call, matching what `loadWadTextures` really returns —
 * it re-composites per styleset precisely so no two callers share one. */
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

function wadSlot(name: string): WadSlot {
  return { name, texture: wadTexture() };
}

describe("module constants", () => {
  it("exposes the documented texture size and lore base tone", () => {
    expect(TEXTURE_SIZE).toBe(64);
    expect(LORE_BASE).toEqual([120, 200, 210]);
  });

  it("counts 3 structural slots per styleset plus the 5 shared signal slots", () => {
    expect(TOTAL_WAD_SLOTS).toBe(STYLE_SET_IDS.length * 3 + 5);
  });
});

describe("TextureManager — defaults", () => {
  it("builds all 8 procedural default slots for every styleset, each at TEXTURE_SIZE", () => {
    const manager = new TextureManager();
    for (const id of STYLE_SET_IDS) {
      const set = manager.getStyle(id).textures;
      const slots = [
        set.wall,
        set.floor,
        set.door,
        set.loreWall,
        set.hazardFloor,
        set.teleporterFloor,
        set.spikeSafeFloor,
        set.spikeActiveFloor,
      ];
      expect(slots).toHaveLength(8);
      for (const tex of slots) {
        expect(tex.width).toBe(TEXTURE_SIZE);
        expect(tex.height).toBe(TEXTURE_SIZE);
        expect(tex.pixels.length).toBe(TEXTURE_SIZE * TEXTURE_SIZE * 4);
      }
    }
  });

  it("gives every styleset its own id, ceiling tone and automap color", () => {
    const manager = new TextureManager();
    const ceilings = new Set<string>();
    const automapColors = new Set<string>();
    for (const id of STYLE_SET_IDS) {
      const style = manager.getStyle(id);
      expect(style.id).toBe(id);
      ceilings.add(style.ceiling.join(","));
      automapColors.add(style.automapWall);
    }
    expect(ceilings.size).toBe(STYLE_SET_IDS.length);
    expect(automapColors.size).toBe(STYLE_SET_IDS.length);
  });

  it("shares one bitmap per gameplay-signal slot across every styleset", () => {
    // Not an optimisation detail — it's the enforcement of "a hazard tile
    // looks the same on every level", which the whole styleset design rests on.
    const manager = new TextureManager();
    const first = manager.getStyle("stone").textures;
    for (const id of STYLE_SET_IDS) {
      const set = manager.getStyle(id).textures;
      expect(set.hazardFloor).toBe(first.hazardFloor);
      expect(set.teleporterFloor).toBe(first.teleporterFloor);
      expect(set.spikeSafeFloor).toBe(first.spikeSafeFloor);
      expect(set.spikeActiveFloor).toBe(first.spikeActiveFloor);
      expect(set.loreWall).toBe(first.loreWall);
    }
  });

  it("gives every styleset its own structural bitmaps", () => {
    const manager = new TextureManager();
    const walls = STYLE_SET_IDS.map((id) => manager.getStyle(id).textures.wall);
    expect(new Set(walls).size).toBe(STYLE_SET_IDS.length);
    const floors = STYLE_SET_IDS.map((id) => manager.getStyle(id).textures.floor);
    expect(new Set(floors).size).toBe(STYLE_SET_IDS.length);
  });

  it("throws when no 2D canvas context is available at all", () => {
    const getContext = HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>;
    getContext.mockImplementationOnce(() => null);
    expect(() => new TextureManager()).toThrow("2D canvas context unavailable for procedural texture generation");
  });
});

describe("TextureManager.loadFromWad — parse failure", () => {
  it("leaves the active styles on defaults and returns an all-null summary", () => {
    const manager = new TextureManager();
    const before = manager.getStyle("stone");
    loadWadTexturesMock.mockReturnValueOnce({ ok: false, error: "bad WAD magic" } as WadLoadResult);
    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.ok).toBe(false);
    expect(summary.error).toBe("bad WAD magic");
    expect(summary.matchedSlots).toBe(0);
    expect(summary.styles.stone.wall).toBeNull();
    expect(manager.getStyle("stone")).toBe(before); // unchanged
  });
});

describe("TextureManager.loadFromWad — success", () => {
  it("uses a WAD-provided texture for every slot that has one", () => {
    const manager = new TextureManager();
    const result = emptyWadResult();
    for (const id of STYLE_SET_IDS) {
      result.styles[id] = { wall: wadSlot(`WALL_${id}`), floor: wadSlot(`FLAT_${id}`), door: wadSlot(`DOOR_${id}`) };
    }
    result.signals = {
      loreWall: wadSlot("COMPUTE2"),
      hazardFloor: wadSlot("NUKAGE3"),
      teleporterFloor: wadSlot("GATE1"),
      spikeSafeFloor: wadSlot("FLOOR7_1"),
      spikeActiveFloor: wadSlot("BLOOD1"),
    };
    loadWadTexturesMock.mockReturnValueOnce(result);

    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.ok).toBe(true);
    expect(summary.styles.stone.wall).toBe("WALL_stone");
    expect(summary.signals.hazardFloor).toBe("NUKAGE3");
    expect(summary.matchedSlots).toBe(TOTAL_WAD_SLOTS);
    expect(summary.totalSlots).toBe(TOTAL_WAD_SLOTS);
    for (const id of STYLE_SET_IDS) {
      const set = manager.getStyle(id).textures;
      expect(set.wall.width).toBe(2); // the WAD fixture's size, not TEXTURE_SIZE
      expect(set.spikeActiveFloor.width).toBe(2);
    }
  });

  it("keeps a WAD's signal textures shared across every styleset", () => {
    const manager = new TextureManager();
    const result = emptyWadResult();
    result.signals.hazardFloor = wadSlot("NUKAGE3");
    loadWadTexturesMock.mockReturnValueOnce(result);
    manager.loadFromWad(new ArrayBuffer(0));

    const first = manager.getStyle("stone").textures.hazardFloor;
    for (const id of STYLE_SET_IDS) expect(manager.getStyle(id).textures.hazardFloor).toBe(first);
  });

  it("falls back to that styleset's own procedural default for every slot the WAD doesn't have", () => {
    const manager = new TextureManager();
    const before = STYLE_SET_IDS.map((id) => manager.getStyle(id).textures);
    loadWadTexturesMock.mockReturnValueOnce(emptyWadResult()); // ok:true, every texture null
    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.matchedSlots).toBe(0);
    STYLE_SET_IDS.forEach((id, i) => {
      const after = manager.getStyle(id).textures;
      expect(after.wall).toBe(before[i].wall);
      expect(after.floor).toBe(before[i].floor);
      expect(after.spikeActiveFloor).toBe(before[i].spikeActiveFloor);
    });
  });

  it("swaps only the slots the WAD actually had, leaving the rest per-styleset default", () => {
    const manager = new TextureManager();
    const stoneWallBefore = manager.getStyle("stone").textures.wall;
    const result = emptyWadResult();
    result.styles.tech.wall = wadSlot("STARTAN3");
    loadWadTexturesMock.mockReturnValueOnce(result);

    const summary = manager.loadFromWad(new ArrayBuffer(0));
    expect(summary.matchedSlots).toBe(1);
    expect(manager.getStyle("tech").textures.wall.width).toBe(2);
    expect(manager.getStyle("stone").textures.wall).toBe(stoneWallBefore);
  });

  it("fills transparent WAD pixels with the styleset's base color, leaving opaque pixels untouched", () => {
    const manager = new TextureManager();
    const result = emptyWadResult();
    result.styles.stone.wall = wadSlot("BRICK1");
    loadWadTexturesMock.mockReturnValueOnce(result);
    manager.loadFromWad(new ArrayBuffer(0));

    const pixels = manager.getStyle("stone").textures.wall.pixels;
    // Opaque pixel (0,0) unchanged.
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([200, 10, 10, 255]);
    // Hole pixel (1,0) filled with `stone`'s wall base color, opaque.
    expect(pixels[7]).toBe(255); // alpha forced opaque
    expect([pixels[4], pixels[5], pixels[6]]).toEqual([186, 152, 116]);
  });

  it("fills holes with each styleset's own base color, not one shared tone", () => {
    const manager = new TextureManager();
    const result = emptyWadResult();
    result.styles.stone.wall = wadSlot("SHARED");
    result.styles.rust.wall = wadSlot("SHARED");
    loadWadTexturesMock.mockReturnValueOnce(result);
    manager.loadFromWad(new ArrayBuffer(0));

    const stone = manager.getStyle("stone").textures.wall.pixels;
    const rust = manager.getStyle("rust").textures.wall.pixels;
    expect([stone[4], stone[5], stone[6]]).toEqual([186, 152, 116]);
    expect([rust[4], rust[5], rust[6]]).toEqual([150, 86, 58]);
  });

  it("throws when no 2D canvas context is available for a WAD texture conversion", () => {
    const manager = new TextureManager();
    const result = emptyWadResult();
    result.styles.stone.wall = wadSlot("BRICK1");
    loadWadTexturesMock.mockReturnValueOnce(result);
    const getContext = HTMLCanvasElement.prototype.getContext as ReturnType<typeof vi.fn>;
    getContext.mockImplementationOnce(() => null);
    expect(() => manager.loadFromWad(new ArrayBuffer(0))).toThrow("2D canvas context unavailable for WAD texture conversion");
  });
});

describe("TextureManager.resetToDefaults", () => {
  it("puts the procedural textures back, byte-identically", () => {
    const manager = new TextureManager();
    // Captured before any WAD is applied — the exact objects a fresh manager
    // hands out, which is what "back to the built-in textures" has to mean.
    const before = STYLE_SET_IDS.map((id) => manager.getStyle(id).textures.wall);

    const result = emptyWadResult();
    for (const id of STYLE_SET_IDS) {
      result.styles[id] = { wall: wadSlot(`WALL_${id}`), floor: wadSlot(`FLAT_${id}`), door: wadSlot(`DOOR_${id}`) };
    }
    loadWadTexturesMock.mockReturnValueOnce(result);
    expect(manager.loadFromWad(new ArrayBuffer(0)).ok).toBe(true);
    expect(manager.getStyle("stone").textures.wall).not.toBe(before[0]);

    manager.resetToDefaults();

    // Identity, not equality: the defaults were never rebuilt, which is the
    // whole reason this is cheap enough to call from a button.
    STYLE_SET_IDS.forEach((id, i) => expect(manager.getStyle(id).textures.wall).toBe(before[i]));
  });

  it("is a no-op on a manager that never loaded a WAD", () => {
    const manager = new TextureManager();
    const before = manager.getStyle("stone").textures.wall;
    manager.resetToDefaults();
    expect(manager.getStyle("stone").textures.wall).toBe(before);
  });
});

describe("TextureManager.getStyle", () => {
  it("returns a fully-populated style for every id", () => {
    const manager = new TextureManager();
    for (const id of STYLE_SET_IDS as StyleSetId[]) {
      const style = manager.getStyle(id);
      expect(style.textures.wall).toBeDefined();
      expect(style.textures.floor).toBeDefined();
      expect(style.textures.door).toBeDefined();
      expect(style.ceiling).toHaveLength(3);
      expect(style.automapWall).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

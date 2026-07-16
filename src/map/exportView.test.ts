// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvasGetContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "./types";
import { DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, SPIKE_TRAP_TILE, TELEPORTER_TILE } from "./types";
import type { TextureBitmap, TextureSet } from "../engine/textures";
import { renderExportMap } from "./exportView";

// Each fake texture's `canvas` carries a unique `label` so tests can tell
// *which* texture actually got drawn — every real TextureBitmap.canvas is a
// distinct object too, but two bare `{}` placeholders would be deep-equal
// to each other regardless of which one was passed to drawImage, silently
// defeating a wrong-texture-selected bug.
function fakeTexture(label: string): TextureBitmap {
  return { canvas: { label } as unknown as HTMLCanvasElement, pixels: new Uint8ClampedArray(4), width: 1, height: 1 };
}

function fakeTextureSet(): TextureSet {
  return {
    wall: fakeTexture("wall"),
    bonusWall: fakeTexture("bonusWall"),
    door: fakeTexture("door"),
    floor: fakeTexture("floor"),
    bonusFloor: fakeTexture("bonusFloor"),
    loreWall: fakeTexture("loreWall"),
    hazardFloor: fakeTexture("hazardFloor"),
    teleporterFloor: fakeTexture("teleporterFloor"),
    spikeSafeFloor: fakeTexture("spikeSafeFloor"),
    spikeActiveFloor: fakeTexture("spikeActiveFloor"),
  };
}

function fakeMap(overrides: Partial<GameMap> = {}): GameMap {
  const grid: Tile[][] = Array.from({ length: 4 }, () => [1, 0, 0, 1] as Tile[]);
  return {
    width: 4,
    height: 4,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: 2, y: 2 },
    shortestPathTiles: 0,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
    ...overrides,
  };
}

describe("renderExportMap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sizes the canvas to width/height * clamped cell size", () => {
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderExportMap(fakeMap(), fakeTextureSet());
      // targetPixels 1200 / max(4,4) = 300, clamped to maxCell 48.
      expect(result.width).toBe(4 * 48);
      expect(result.height).toBe(4 * 48);
      expect(result.className).toBe("export-map");
    } finally {
      restore();
    }
  });

  it("clamps the cell size to minCell for a huge map", () => {
    const map = fakeMap({ width: 500, height: 500, grid: Array.from({ length: 500 }, () => new Array(500).fill(0) as Tile[]) });
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderExportMap(map, fakeTextureSet());
      expect(result.width).toBe(500 * 16); // minCell
    } finally {
      restore();
    }
  });

  it("respects custom ExportViewOptions", () => {
    const map = fakeMap({ width: 10, height: 10, grid: Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]) });
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderExportMap(map, fakeTextureSet(), { targetPixels: 100, minCell: 1, maxCell: 20 });
      // 100 / 10 = 10, within [1,20].
      expect(result.width).toBe(10 * 10);
    } finally {
      restore();
    }
  });

  it("stamps the correct texture for every tile kind, including bonus-level variants", () => {
    const grid: Tile[][] = [[1, 0, HAZARD_TILE, DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE]];
    const map = fakeMap({ width: 8, height: 1, grid, spawn: { x: 1, y: 0 }, exit: { x: 1, y: 0 } });
    const textureSet = fakeTextureSet();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderExportMap(map, textureSet);
      const drawn = ctx.drawImage.mock.calls.map((call) => call[0]);
      expect(drawn).toEqual([
        textureSet.wall.canvas,
        textureSet.floor.canvas,
        textureSet.hazardFloor.canvas,
        textureSet.door.canvas,
        textureSet.teleporterFloor.canvas,
        textureSet.spikeSafeFloor.canvas,
        textureSet.wall.canvas, // unopened secret wall == plain wall
        textureSet.loreWall.canvas,
      ]);
    } finally {
      restore();
    }
  });

  it("uses bonusWall/bonusFloor instead of wall/floor on a bonus level", () => {
    const grid: Tile[][] = [[1, 0, SECRET_WALL_TILE]];
    const map = fakeMap({ width: 3, height: 1, grid, bonusLevel: true, spawn: { x: 1, y: 0 }, exit: { x: 1, y: 0 } });
    const textureSet = fakeTextureSet();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderExportMap(map, textureSet);
      const drawn = ctx.drawImage.mock.calls.map((call) => call[0]);
      expect(drawn).toEqual([textureSet.bonusWall.canvas, textureSet.bonusFloor.canvas, textureSet.bonusWall.canvas]);
    } finally {
      restore();
    }
  });

  it("an already-opened secret wall (now plain floor tile) renders as floor, not wall", () => {
    // debugView/types.ts: an opened secret becomes tile 0 permanently — the
    // renderer needs no special-casing for this, it's just an ordinary floor
    // tile by the time a level is won.
    const grid: Tile[][] = [[0]];
    const map = fakeMap({ width: 1, height: 1, grid, spawn: { x: 0, y: 0 }, exit: { x: 0, y: 0 } });
    const textureSet = fakeTextureSet();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderExportMap(map, textureSet);
      expect(ctx.drawImage).toHaveBeenCalledWith(textureSet.floor.canvas, 0, 0, expect.any(Number), expect.any(Number));
    } finally {
      restore();
    }
  });

  it("draws spawn and exit markers as filled arcs", () => {
    const map = fakeMap();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderExportMap(map, fakeTextureSet());
      expect(ctx.arc).toHaveBeenCalledTimes(2);
      expect(ctx.fill).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("crops the canvas to the content's bounding box (content + its 1-tile wall border) instead of the full generated grid", () => {
    // MapGenerator allocates a full width*height grid of solid wall and
    // carves rooms out of it — most of a real map's grid is filler never
    // seen in first-person play. Here, a 2x2 floor room sits in the middle
    // of a much larger all-wall grid; the export should crop tightly
    // around it rather than rendering the whole 10x6 grid.
    const width = 10;
    const height = 6;
    const grid: Tile[][] = Array.from({ length: height }, () => new Array(width).fill(1) as Tile[]);
    grid[2][4] = 0;
    grid[2][5] = 0;
    grid[3][4] = 0;
    grid[3][5] = 0;
    const map = fakeMap({ width, height, grid, spawn: { x: 4, y: 2 }, exit: { x: 5, y: 3 } });
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderExportMap(map, fakeTextureSet());
      // Content spans x:[4,5] y:[2,3]; its 1-tile wall border ring extends
      // that to x:[3,6] y:[1,4] => a 4x4 box, clamped cell =
      // clamp(floor(1200/4), 16, 48) = 48.
      expect(result.width).toBe(4 * 48);
      expect(result.height).toBe(4 * 48);
    } finally {
      restore();
    }
  });

  it("skips deep filler wall tiles even within the cropped bounding box (two rooms with a gap between them)", () => {
    // The crop's bounding box can still contain tiles that are neither real
    // content nor within one tile of it (e.g. the empty stretch between two
    // separate rooms) — those must still be skipped individually, not just
    // tiles outside the crop.
    const width = 12;
    const height = 3;
    const grid: Tile[][] = Array.from({ length: height }, () => new Array(width).fill(1) as Tile[]);
    grid[1][1] = 0; // room A
    grid[1][10] = 0; // room B, far enough that their 1-tile borders never touch
    const map = fakeMap({ width, height, grid, spawn: { x: 1, y: 1 }, exit: { x: 10, y: 1 } });
    const textureSet = fakeTextureSet();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderExportMap(map, textureSet);
      // 2 content tiles + up to 8 wall neighbors each (no overlap) = 18 draws,
      // out of the cropped box's full 12*3 = 36 cells — the untouched gap
      // tiles in between are genuinely skipped, not just cropped away.
      expect(ctx.drawImage.mock.calls.length).toBe(18);
    } finally {
      restore();
    }
  });

  it("throws when the 2D canvas context is unavailable", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => null);
    try {
      expect(() => renderExportMap(fakeMap(), fakeTextureSet())).toThrow("2D canvas context unavailable");
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

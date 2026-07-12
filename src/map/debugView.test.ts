// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvasGetContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "./types";
import { renderDebugMap } from "./debugView";

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

describe("renderDebugMap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sizes the canvas to width/height * clamped cell size", () => {
    const map = fakeMap();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    // stubCanvasGetContext patches the prototype globally; renderDebugMap
    // creates its own canvas internally, so grab that mock's ctx afterward.
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderDebugMap(map);
      // targetPixels 640 / max(4,4) = 160, clamped to maxCell 12.
      expect(result.width).toBe(4 * 12);
      expect(result.height).toBe(4 * 12);
      expect(result.className).toBe("debug-map");
      void ctx;
    } finally {
      restore();
      canvas.remove();
    }
  });

  it("clamps the cell size to minCell for a huge map", () => {
    const map = fakeMap({ width: 500, height: 500, grid: Array.from({ length: 500 }, () => new Array(500).fill(0) as Tile[]) });
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderDebugMap(map);
      expect(result.width).toBe(500 * 3); // minCell
    } finally {
      restore();
    }
  });

  it("respects custom DebugViewOptions", () => {
    const map = fakeMap({ width: 10, height: 10, grid: Array.from({ length: 10 }, () => new Array(10).fill(0) as Tile[]) });
    const canvas = document.createElement("canvas");
    const { restore } = stubCanvasGetContext(canvas);
    try {
      const result = renderDebugMap(map, { targetPixels: 100, minCell: 1, maxCell: 20 });
      // 100 / 10 = 10, within [1,20].
      expect(result.width).toBe(10 * 10);
    } finally {
      restore();
    }
  });

  it("paints a black square for every wall tile and leaves floor tiles unpainted with fillRect", () => {
    const map = fakeMap(); // grid rows: [1,0,0,1]
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderDebugMap(map);
      // Background fill (1 call) + one fillRect per wall tile (8 walls: 2 per row * 4 rows).
      const wallFillCalls = ctx.fillRect.mock.calls.length - 1; // minus the background fill
      expect(wallFillCalls).toBe(8);
    } finally {
      restore();
    }
  });

  it("draws the spawn marker as a filled arc", () => {
    const map = fakeMap();
    const canvas = document.createElement("canvas");
    const { ctx, restore } = stubCanvasGetContext(canvas);
    try {
      renderDebugMap(map);
      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("throws when the 2D canvas context is unavailable", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => null);
    try {
      expect(() => renderDebugMap(fakeMap())).toThrow("2D canvas context unavailable");
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

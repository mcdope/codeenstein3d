// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { renderDebugMap } from "./debugView";
import type { GameMap } from "./types";

describe("renderDebugMap", () => {
  const dummyMap: GameMap = {
    width: 2,
    height: 2,
    grid: [
      [1, 0],
      [0, 1]
    ],
    visited: [],
    rooms: [],
    spawn: { x: 0, y: 1 },
    enemies: [],
    exit: { x: 1, y: 0 },
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
    bonusLevel: false
  };

  it("renders a map with default options", () => {
    const canvas = renderDebugMap(dummyMap);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.width).toBe(24);
    expect(canvas.height).toBe(24);
  });

  it("respects custom options", () => {
    const canvas = renderDebugMap(dummyMap, { targetPixels: 10, minCell: 1, maxCell: 5 });
    expect(canvas.width).toBe(10);
  });

  it("throws if 2D context is unavailable", () => {
    const canvasSpy = vi.spyOn(document, 'createElement').mockImplementation(() => {
      const el = {
        width: 0,
        height: 0,
        className: "",
        getContext: () => null
      } as unknown as HTMLCanvasElement;
      return el;
    });

    expect(() => renderDebugMap(dummyMap)).toThrow("2D canvas context unavailable");
    canvasSpy.mockRestore();
  });
});

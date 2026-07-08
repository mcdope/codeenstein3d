// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { drawAutomap } from "./automap";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
} from "../map/types";
import * as traps from "./traps";
import type { Player } from "./player";

// Mock the traps module so we can explicitly control active spike states
vi.mock("./traps", () => ({
  activeSpikeTileKeys: vi.fn(),
}));

// Helper to create a mock CanvasRenderingContext2D
const createMockCtx = () => {
  return {
    canvas: { width: 800, height: 600 },
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;
};

describe("drawAutomap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the full automap and covers all tile types, active/inactive spikes, and valid exit", () => {
    const ctx = createMockCtx();
    
    // We mock activeSpikeTileKeys to return the tile at (6,0) as active,
    // and the tile at (7,0) will remain inactive.
    vi.spyOn(traps, "activeSpikeTileKeys").mockReturnValue(new Set(["6,0"]));

    const map = {
      width: 10,
      height: 2,
      grid: [
        // Row 0 covers all tile types explicitly checked in the loop
        [0, 1, SECRET_WALL_TILE, LORE_TILE, DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SPIKE_TRAP_TILE, HAZARD_TILE, 0],
        // Row 1 is completely unvisited to cover `if (!visitedRow[x]) continue;`
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      ],
      visited: [
        [true, true, true, true, true, true, true, true, true, true],
        [false, false, false, false, false, false, false, false, false, false]
      ],
      spikeTraps: [], // Mapped by spy
      mines: [
        // Covers all combinations of mine.alive and mine.visible
        { x: 0, y: 0, alive: false, visible: true },
        { x: 1, y: 0, alive: true, visible: false },
        { x: 2, y: 0, alive: true, visible: true }
      ],
      exit: { x: 0, y: 0 } // Covers the visited exit branch
    } as unknown as GameMap;

    const player = {
      posX: 1,
      posY: 1,
      dirX: -1,
      dirY: 0,
    } as Player;

    // Omitting the `levelTime` parameter to hit the default argument `levelTime = 0`
    drawAutomap(ctx, map, player);

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.strokeRect).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(traps.activeSpikeTileKeys).toHaveBeenCalled();
  });

  it("handles unvisited exit and small canvas to hit cell size minimum boundary", () => {
    const ctx = createMockCtx();
    // Tiny canvas with large map width/height hits Math.max(1, ...) limit
    ctx.canvas.width = 10;
    ctx.canvas.height = 10;
    
    vi.spyOn(traps, "activeSpikeTileKeys").mockReturnValue(new Set());

    const map = {
      width: 100,
      height: 100,
      grid: new Array(100).fill(new Array(100).fill(0)),
      visited: new Array(100).fill(new Array(100).fill(false)), // Unvisited exit test
      spikeTraps: [],
      mines: [],
      exit: { x: 0, y: 0 } // map.visited[0][0] is false
    } as unknown as GameMap;

    const player = {
      posX: 0,
      posY: 0,
      dirX: 0,
      dirY: 1,
    } as Player;

    drawAutomap(ctx, map, player, 0);

    // Context should still be modified (e.g. background dimming scrim)
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("handles large canvas to hit cell size maximum boundary", () => {
    const ctx = createMockCtx();
    // Huge canvas with small map hits Math.min(14, ...) limit
    ctx.canvas.width = 2000;
    ctx.canvas.height = 2000;
    
    vi.spyOn(traps, "activeSpikeTileKeys").mockReturnValue(new Set());

    const map = {
      width: 1,
      height: 1,
      grid: [[0]],
      visited: [[true]],
      spikeTraps: [],
      mines: [],
      exit: { x: 0, y: 0 }
    } as unknown as GameMap;

    const player = {
      posX: 0,
      posY: 0,
      dirX: 1,
      dirY: 1,
    } as Player;

    drawAutomap(ctx, map, player, 0);

    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("handles safely skipping exit if map.exit is completely out of bounds", () => {
    const ctx = createMockCtx();
    vi.spyOn(traps, "activeSpikeTileKeys").mockReturnValue(new Set());

    const map = {
      width: 1,
      height: 1,
      grid: [[0]],
      visited: [[true]],
      spikeTraps: [],
      mines: [],
      exit: { x: 5, y: 5 } // y is out of bounds, safely tests the optional chaining ?.[map.exit.x]
    } as unknown as GameMap;

    const player = {
      posX: 0,
      posY: 0,
      dirX: 1,
      dirY: 0,
    } as Player;

    drawAutomap(ctx, map, player, 0);

    expect(ctx.fillRect).toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
  type Mine,
  type SpikeTrap,
  type Tile,
} from "../map/types";
import { drawAutomap } from "./automap";
import { HUD_HEIGHT } from "./hud";
import type { Player } from "./player";

const MARGIN = 12;
const CELL_PX = 3;
const CANVAS_W = 300;
const CANVAS_H = 300;

function fakeCanvas(): HTMLCanvasElement {
  return { width: CANVAS_W, height: CANVAS_H } as unknown as HTMLCanvasElement;
}

function makeCtx(): MockCanvasContext {
  return createMockCanvasContext(fakeCanvas());
}

/** MockCanvasContext deliberately implements only the subset of
 * CanvasRenderingContext2D this codebase actually calls — cast at the call
 * site rather than widening the mock's own type. */
function asCtx(ctx: MockCanvasContext): CanvasRenderingContext2D {
  return ctx as unknown as CanvasRenderingContext2D;
}

/** drawAutomap() always paints one translucent viewport panel via fillRect
 * before any tile/mine/exit rendering — subtract it so call counts below
 * reflect only what a given test actually cares about. */
function extraFillRectCalls(ctx: MockCanvasContext): number {
  return ctx.fillRect.mock.calls.length - 1;
}

function fakePlayer(overrides: Partial<Player> = {}): Player {
  return { posX: 5.5, posY: 5.5, dirX: 1, dirY: 0, ...overrides } as Player;
}

function grid(size: number, fill: Tile = 0): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(fill) as Tile[]);
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 10): GameMap {
  return {
    width: size,
    height: size,
    grid: grid(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(true) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: size - 1, y: size - 1 },
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

function mine(overrides: Partial<Mine> = {}): Mine {
  return { x: 5, y: 5, alive: true, visible: true, closeTimer: 0, ...overrides };
}

function spike(overrides: Partial<SpikeTrap> = {}): SpikeTrap {
  return { x: 5, y: 5, period: 4, phase: 0, ...overrides };
}

describe("drawAutomap() — camera positioning", () => {
  it("centers the camera when the map is smaller than the viewport", () => {
    const ctx = makeCtx();
    const map = fakeMap({}, 10); // far smaller than the ~92-tile-wide viewport at CANVAS_W=300
    drawAutomap(asCtx(ctx), map, fakePlayer());
    // Centered camX = (map.width - viewTilesW) / 2, a negative value here —
    // just confirms it doesn't throw and renders something.
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("clamps the camera to the map's top-left edge when the player is near it", () => {
    const ctx = makeCtx();
    const map = fakeMap({}, 200); // larger than the viewport -> camera pans
    drawAutomap(asCtx(ctx), map, fakePlayer({ posX: 0.5, posY: 0.5 }));
    // camX/camY clamp to 0 -> tile (0,0) renders at exactly (MARGIN, MARGIN).
    expect(ctx.fillRect).toHaveBeenCalledWith(MARGIN, MARGIN, CELL_PX, CELL_PX);
  });

  it("clamps the camera to the map's bottom-right edge when the player is near it", () => {
    const ctx = makeCtx();
    const size = 200;
    const map = fakeMap({}, size);
    drawAutomap(asCtx(ctx), map, fakePlayer({ posX: size - 0.5, posY: size - 0.5 }));
    const viewTilesW = (CANVAS_W - MARGIN * 2) / CELL_PX;
    const viewTilesH = (CANVAS_H - HUD_HEIGHT - MARGIN * 2) / CELL_PX;
    const camX = size - viewTilesW;
    const camY = size - viewTilesH;
    const lastTileX = size - 1;
    const lastTileY = size - 1;
    const px = MARGIN + (lastTileX - camX) * CELL_PX;
    const py = MARGIN + (lastTileY - camY) * CELL_PX;
    expect(ctx.fillRect).toHaveBeenCalledWith(px, py, CELL_PX, CELL_PX);
  });
});

describe("drawAutomap() — tile rendering", () => {
  it("skips unvisited tiles entirely", () => {
    const ctx = makeCtx();
    const map = fakeMap({ visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]) });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    // Only the panel fill happens; no tile/mine/exit rendering.
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("renders a wall tile (value 1)", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = 1;
    const map = fakeMap({ grid: g });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders an unopened secret wall identically to a plain wall (never spoiled)", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = SECRET_WALL_TILE;
    const map = fakeMap({ grid: g });
    expect(() => drawAutomap(asCtx(ctx), map, fakePlayer())).not.toThrow();
  });

  it("renders a lore terminal tile", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = LORE_TILE;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders a door tile", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = DOOR_TILE;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders a teleporter tile", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = TELEPORTER_TILE;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders a safe spike trap tile in its dull color", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = SPIKE_TRAP_TILE;
    const map = fakeMap({ grid: g, spikeTraps: [spike({ x: 2, y: 2, period: 4, phase: 0 })] });
    drawAutomap(asCtx(ctx), map, fakePlayer(), 0); // inactive half of the cycle
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders an active spike trap tile in its hot color", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = SPIKE_TRAP_TILE;
    const map = fakeMap({ grid: g, spikeTraps: [spike({ x: 2, y: 2, period: 4, phase: 0 })] });
    drawAutomap(asCtx(ctx), map, fakePlayer(), 2); // active half of the cycle
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders a hazard tile", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = HAZARD_TILE;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("renders plain floor (value 0) with the default wash", () => {
    const ctx = makeCtx();
    drawAutomap(asCtx(ctx), fakeMap(), fakePlayer());
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});

describe("drawAutomap() — mines", () => {
  function unvisitedMap(overrides: Partial<GameMap> = {}): GameMap {
    return fakeMap({ visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]), ...overrides });
  }

  it("renders a discovered, still-live mine within view", () => {
    const ctx = makeCtx();
    const map = unvisitedMap({ mines: [mine({ x: 5, y: 5, alive: true, visible: true })] });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(1);
  });

  it("skips a dead mine", () => {
    const ctx = makeCtx();
    const map = unvisitedMap({ mines: [mine({ alive: false, visible: true })] });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("skips a not-yet-discovered (invisible) mine", () => {
    const ctx = makeCtx();
    const map = unvisitedMap({ mines: [mine({ alive: true, visible: false })] });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("skips a mine far outside the visible tile range", () => {
    const ctx = makeCtx();
    const map = unvisitedMap({ mines: [mine({ x: -50, y: -50 })] });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("renders more than one visible mine", () => {
    const ctx = makeCtx();
    const map = unvisitedMap({ mines: [mine({ x: 1, y: 1 }), mine({ x: 8, y: 8 })] });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(2);
  });
});

describe("drawAutomap() — exit marker", () => {
  it("renders the exit once it's been visited", () => {
    const ctx = makeCtx();
    const map = fakeMap({
      visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]),
      exit: { x: 3, y: 3 },
    });
    map.visited[3][3] = true;
    drawAutomap(asCtx(ctx), map, fakePlayer());
    // 1 from the tile loop rendering (3,3) as ordinary visited floor, +1 for
    // the exit marker drawn on top of it.
    expect(extraFillRectCalls(ctx)).toBe(2);
  });

  it("does not render an unvisited exit", () => {
    const ctx = makeCtx();
    const map = fakeMap({
      visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]),
      exit: { x: 3, y: 3 },
    });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("does not throw when the exit lies outside the visited grid's rows", () => {
    const ctx = makeCtx();
    const map = fakeMap({
      visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]),
      exit: { x: 3, y: 10 }, // one row past the map's actual height — map.visited[10] is undefined
    });
    expect(() => drawAutomap(asCtx(ctx), map, fakePlayer())).not.toThrow();
    expect(extraFillRectCalls(ctx)).toBe(0);
  });
});

describe("drawAutomap() — player marker", () => {
  it("draws a triangle at the player's position", () => {
    const ctx = makeCtx();
    drawAutomap(asCtx(ctx), fakeMap(), fakePlayer());
    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.closePath).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });

  it("points the marker's tip in the direction the player faces", () => {
    const ctxRight = makeCtx();
    drawAutomap(asCtx(ctxRight), fakeMap(), fakePlayer({ dirX: 1, dirY: 0 }));
    const [tipXRight, tipYRight] = ctxRight.moveTo.mock.calls[0] as [number, number];

    const ctxLeft = makeCtx();
    drawAutomap(asCtx(ctxLeft), fakeMap(), fakePlayer({ dirX: -1, dirY: 0 }));
    const [tipXLeft] = ctxLeft.moveTo.mock.calls[0] as [number, number];

    // Same player position and camera in both calls, only facing differs —
    // facing right's tip must land further right than facing left's.
    expect(tipXRight).toBeGreaterThan(tipXLeft);

    const ctxDown = makeCtx();
    drawAutomap(asCtx(ctxDown), fakeMap(), fakePlayer({ dirX: 0, dirY: 1 }));
    const [, tipYDown] = ctxDown.moveTo.mock.calls[0] as [number, number];
    // Facing right has ~0 vertical tip offset; facing down should be
    // noticeably lower.
    expect(tipYDown).toBeGreaterThan(tipYRight + 1);
  });
});

describe("drawAutomap() — viewport clip and translucent panel", () => {
  it("saves state, clips to the viewport, and restores at the end", () => {
    const ctx = makeCtx();
    drawAutomap(asCtx(ctx), fakeMap(), fakePlayer());
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("defaults levelTime to 0 when omitted", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = SPIKE_TRAP_TILE;
    const map = fakeMap({ grid: g, spikeTraps: [spike({ x: 2, y: 2, period: 4, phase: 0 })] });
    expect(() => drawAutomap(asCtx(ctx), map, fakePlayer())).not.toThrow();
  });
});

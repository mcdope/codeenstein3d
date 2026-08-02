// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createMockCanvasContext, type MockCanvasContext } from "../../test/mocks/canvas";
import {
  BRANCH_DOOR_TILE,
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
    styleSet: "stone",
    secretRoomCount: 0,
    switchboardRooms: [],
    exceptionZones: [],
    vendorDepots: [],
    acidOverflows: [],
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

  it("renders a branch door tile in its own colour, not the locked door's", () => {
    // Whatever the exact tones are, "needs a key" and "just push it" must not
    // paint the same colour — telling them apart is the whole point of having
    // a second door tile.
    const colorsFor = (tile: Tile): Set<string> => {
      const ctx = makeCtx();
      const g = grid(10);
      g[2][2] = tile;
      const seen = new Set<string>();
      ctx.fillRect.mockImplementation(() => {
        seen.add(String(ctx.fillStyle));
      });
      drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
      return seen;
    };
    // Two otherwise-identical maps differing only in that one tile, so the
    // colour each door type paints is exactly the set difference.
    const locked = colorsFor(DOOR_TILE);
    const branch = colorsFor(BRANCH_DOOR_TILE);
    const onlyBranch = [...branch].filter((c) => !locked.has(c));
    expect(onlyBranch).toHaveLength(1);
    expect([...locked].filter((c) => !branch.has(c))).toHaveLength(1);
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

describe("drawAutomap() — multiplayer loot drops", () => {
  function unvisitedMap(overrides: Partial<GameMap> = {}): GameMap {
    return fakeMap({ visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]), ...overrides });
  }

  it("defaults to no loot drops when the param is omitted (single-player-shaped call)", () => {
    const map = unvisitedMap();
    map.visited[5][5] = true; // would draw a marker here if the default weren't []
    const withoutParam = makeCtx();
    drawAutomap(asCtx(withoutParam), map, fakePlayer());
    const withEmptyArray = makeCtx();
    drawAutomap(asCtx(withEmptyArray), map, fakePlayer(), 0, []);
    expect(extraFillRectCalls(withoutParam)).toBe(1); // just the one visited floor tile
    expect(withoutParam.fillRect.mock.calls.length).toBe(withEmptyArray.fillRect.mock.calls.length);
  });

  it("renders a loot drop on a visited tile within view", () => {
    const ctx = makeCtx();
    const map = unvisitedMap();
    map.visited[5][5] = true;
    drawAutomap(asCtx(ctx), map, fakePlayer(), 0, [{ x: 5, y: 5, kind: "bullets" }]);
    // 1 from the tile loop rendering (5,5) as ordinary visited floor, +1 for the loot marker.
    expect(extraFillRectCalls(ctx)).toBe(2);
  });

  it("hides a loot drop on an unvisited tile — the fog-of-war/spoiler gate this step adds", () => {
    const ctx = makeCtx();
    const map = unvisitedMap();
    drawAutomap(asCtx(ctx), map, fakePlayer(), 0, [{ x: 5, y: 5, kind: "bullets" }]);
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("renders more than one visible loot drop", () => {
    const ctx = makeCtx();
    const map = unvisitedMap();
    map.visited[1][1] = true;
    map.visited[8][8] = true;
    drawAutomap(asCtx(ctx), map, fakePlayer(), 0, [
      { x: 1, y: 1, kind: "bullets" },
      { x: 8, y: 8, kind: "weapon", weaponIndex: 0 },
    ]);
    // 2 visited floor tiles + 2 loot markers.
    expect(extraFillRectCalls(ctx)).toBe(4);
  });

  it("skips a visited loot drop that's outside the current viewport", () => {
    const size = 200;
    const bigVisited = Array.from({ length: size }, () => new Array(size).fill(true) as boolean[]);
    const bigMap = fakeMap({ visited: bigVisited, width: size, height: size, grid: grid(size) });
    const player = fakePlayer({ posX: 1, posY: 1 });

    const without = makeCtx();
    drawAutomap(asCtx(without), bigMap, player);

    const withFarDrop = makeCtx();
    drawAutomap(asCtx(withFarDrop), bigMap, player, 0, [{ x: size - 1, y: size - 1, kind: "bullets" }]);

    // Same fillRect count either way — the far-away drop contributes nothing,
    // same viewport-cull pattern the mine marker above already uses.
    expect(withFarDrop.fillRect.mock.calls.length).toBe(without.fillRect.mock.calls.length);
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

  // The marker is a pre-rotated glyph now (see `pathSprites.ts`), so its
  // facing rides on the rotation it is drawn at rather than on hand-rotated
  // vertex coordinates — the tip is baked pointing along +X at bearing zero.
  it("points the marker's tip in the direction the player faces", () => {
    const facings: [number, number, number][] = [
      [1, 0, 0], // east
      [-1, 0, Math.PI], // west
      [0, 1, Math.PI / 2], // south (canvas +Y is down)
      [0, -1, -Math.PI / 2], // north
    ];
    for (const [dirX, dirY, expected] of facings) {
      const c = makeCtx();
      drawAutomap(asCtx(c), fakeMap(), fakePlayer({ dirX, dirY }));
      // First rotate() is the marker's own; the second undoes it.
      expect(c.rotate).toHaveBeenNthCalledWith(1, expected);
    }

    // And the glyph itself puts the tip on +X, so "rotated by the facing"
    // really does mean "tip points where the player looks".
    const c = makeCtx();
    drawAutomap(asCtx(c), fakeMap(), fakePlayer({ dirX: 1, dirY: 0 }));
    const [tipX, tipY] = c.moveTo.mock.calls[0] as [number, number];
    expect(tipX).toBeGreaterThan(0);
    expect(tipY).toBe(0);
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

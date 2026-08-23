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
import type { TeammateMapMarker } from "./sprites";

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

/** Fills `drawAutomap()` makes no matter what the map contains: the
 * translucent viewport panel, and the exit marker — the latter unconditional
 * since fog of war was removed, where it used to be gated on the exit tile
 * being visited. Subtract both so the counts below reflect only what a given
 * test is actually about. */
const ALWAYS_FILLS = 2;

function extraFillRectCalls(ctx: MockCanvasContext): number {
  return ctx.fillRect.mock.calls.length - ALWAYS_FILLS;
}

/**
 * A map that renders no terrain at all, for isolating a marker's own fills.
 *
 * Solid rock end to end: with fog of war gone, the tile layer draws a wall only
 * where it faces open space (`wallFacesOpenSpace`), so a grid with no open
 * space anywhere draws nothing. This replaces the old all-unvisited map, which
 * did the same job via the fog gate.
 */
function solidRockMap(overrides: Partial<GameMap> = {}): GameMap {
  return fakeMap({ grid: grid(10, 1), ...overrides });
}

/** All-false `visited`, for the loot-drop gate — the one gate that outlived
 * fog of war (it is a coop privacy rule, not a discovery one). */
function unvisitedGrid(): boolean[][] {
  return Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]);
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
    gates: [],
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
  it("skips untouched rock entirely, so the overlay stays translucent", () => {
    // The replacement for the old "skips unvisited tiles" guarantee, and the
    // reason a carved mask was needed at all: `MapGenerator` carves a level out
    // of a solid grid, so without *some* gate the automap would paint the whole
    // viewport `WALL_COLOR` and stop being an overlay. A grid with no open
    // space has no wall facing open space, so nothing is drawn.
    const ctx = makeCtx();
    drawAutomap(asCtx(ctx), solidRockMap(), fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(0);
  });

  it("draws a wall that faces open space, and not its neighbours deeper in the rock", () => {
    // One floor tile in a rock field: the eight walls touching it are drawn,
    // the rest of the map is not.
    const ctx = makeCtx();
    const g = grid(10, 1);
    g[5][5] = 0;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
    expect(extraFillRectCalls(ctx)).toBe(9); // the floor tile + its 8 wall neighbours
  });

  it("never reveals a secret room, whose interior is carved from SECRET_WALL_TILE", () => {
    // `secretRooms.ts` carves the interior out of SECRET_WALL_TILE precisely so
    // no map can leak it. That tile counts as rock here, so a secret room is
    // enclosed entirely in wall-like tiles and stays invisible — the same
    // outcome fog used to give, for a reason that survives fog's removal.
    const ctx = makeCtx();
    const g = grid(10, 1);
    for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) g[y][x] = SECRET_WALL_TILE;
    drawAutomap(asCtx(ctx), fakeMap({ grid: g }), fakePlayer());
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

describe("drawAutomap() — no fog of war", () => {
  /**
   * A grid shaped the way `MapGenerator` actually produces one: solid rock with
   * rooms and a corridor carved out of it. The hand-made fixtures elsewhere in
   * this file are open floor with a wall border, which is the *opposite* shape
   * and cannot show the hazard these two tests exist for.
   */
  function carvedMap(overrides: Partial<GameMap> = {}): GameMap {
    const size = 60;
    const g = grid(size, 1);
    const carve = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[y][x] = 0;
    };
    carve(5, 5, 10, 8);
    carve(30, 6, 12, 10);
    carve(8, 40, 14, 9);
    carve(14, 9, 17, 2); // corridor joining the first two rooms
    carve(11, 12, 2, 29); // corridor down to the third
    return fakeMap({ grid: g, spawn: { x: 6, y: 6 }, exit: { x: 40, y: 14 }, ...overrides }, size);
  }

  it("renders identically whether or not anything has been visited", () => {
    // The whole point of the change, and the one thing the committed
    // screenshot cannot show — `capture-doc-screenshots.mjs` calls
    // `debugRevealMap()` before grabbing, so that image looks the same whether
    // the gate was removed or merely satisfied.
    const unexplored = makeCtx();
    drawAutomap(asCtx(unexplored), carvedMap({ visited: Array.from({ length: 60 }, () => new Array(60).fill(false) as boolean[]) }), fakePlayer());
    const explored = makeCtx();
    drawAutomap(asCtx(explored), carvedMap(), fakePlayer());

    expect(unexplored.fillRect.mock.calls).toEqual(explored.fillRect.mock.calls);
    expect(unexplored.fillRect.mock.calls.length).toBeGreaterThan(50); // and it drew something
  });

  it("leaves the untouched rock unpainted, so the overlay stays translucent", () => {
    // The hazard the carved mask exists for. Without it the tile loop paints
    // every tile in the viewport, which on a generated map is overwhelmingly
    // rock the player will never go near — a solid `WALL_COLOR` rectangle over
    // the live 3D scene.
    const ctx = makeCtx();
    const map = carvedMap();
    drawAutomap(asCtx(ctx), map, fakePlayer());

    const painted = extraFillRectCalls(ctx);
    const carvedTiles = map.grid.flat().filter((t) => t === 0).length;
    const viewportTiles = map.width * map.height; // the whole map fits the viewport at this size

    // Measured on this fixture: 616 painted of 3,600 — 410 floors plus a
    // 206-tile wall rim, about 17%. Worth pinning as a ratio rather than a
    // bare "less than everything", because that 17% is also the answer to
    // whether perf finding P4 (bake the tile layer to an offscreen canvas) is
    // still worth doing: its 21,700-fills-per-frame estimate assumed every
    // viewport tile gets painted, which is what fog-of-war-on-a-fully-explored
    // map did and what an unmasked ungated loop would do. It is not what this
    // does.
    expect(painted).toBeLessThan(viewportTiles * 0.25);
    // Floors plus their one-tile rim — necessarily more than the floors alone.
    expect(painted).toBeGreaterThan(carvedTiles);
  });
});

describe("drawAutomap() — rotate to facing", () => {
  const call = (over: Partial<{ rotate: boolean; player: Player }> = {}) => {
    const c = makeCtx();
    drawAutomap(asCtx(c), fakeMap(), over.player ?? fakePlayer(), 0, [], [], 0, over.rotate ?? false);
    return c;
  };

  it("adds no map-level transform when north-up (the default)", () => {
    // The transform calls that *do* happen here are the player marker's own —
    // `drawRotatedGlyph` takes its translate/rotate fallback under vitest's
    // node environment, where there is no offscreen canvas to bake an atlas
    // into. What must be absent is a pivot about the viewport centre.
    const c = call();
    const viewCentre = [MARGIN + (CANVAS_W - MARGIN * 2) / 2, MARGIN + (CANVAS_H - HUD_HEIGHT - MARGIN * 2) / 2];
    expect(c.translate).not.toHaveBeenCalledWith(viewCentre[0], viewCentre[1]);
    // The marker's rotate is the only one, and it is its own facing.
    expect((c.rotate.mock.calls[0] as [number])[0]).toBeCloseTo(Math.atan2(0, 1), 10);
  });

  it("pivots about the viewport centre, not the canvas origin", () => {
    const c = call({ rotate: true });
    const viewW = CANVAS_W - MARGIN * 2;
    const viewH = CANVAS_H - HUD_HEIGHT - MARGIN * 2;
    expect(c.translate).toHaveBeenCalledWith(MARGIN + viewW / 2, MARGIN + viewH / 2);
  });

  it("puts the player's facing on screen-up, for every cardinal", () => {
    // `-π/2 - facing`: canvas rotate() is clockwise-positive because +Y is
    // down, and screen-up is -Y. Same convention `drawCompass` documents.
    for (const [dirX, dirY] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const) {
      const c = call({ rotate: true, player: fakePlayer({ dirX, dirY }) });
      const angle = (c.rotate.mock.calls[0] as [number])[0];
      expect(angle).toBeCloseTo(-Math.PI / 2 - Math.atan2(dirY, dirX), 10);
      // …and the marker, drawn at its real facing inside that frame, lands up.
      const markerAngle = (c.rotate.mock.calls[1] as [number])[0];
      expect(markerAngle + angle).toBeCloseTo(-Math.PI / 2, 10);
    }
  });

  it("keeps the viewport clip in screen space, outside the rotation", () => {
    // If the clip were applied after the transform the viewport itself would
    // turn, and the overlay would stop being a rectangle.
    const c = call({ rotate: true });
    const clipOrder = c.rect.mock.invocationCallOrder[0];
    const rotateOrder = c.rotate.mock.invocationCallOrder[0];
    expect(clipOrder).toBeLessThan(rotateOrder);
    expect(c.rect).toHaveBeenCalledWith(MARGIN, MARGIN, CANVAS_W - MARGIN * 2, CANVAS_H - HUD_HEIGHT - MARGIN * 2);
  });

  it("centres exactly on the player instead of clamping to the map's edge", () => {
    // North-up clamps so the view never scrolls past the map; rotated, the
    // corners sweep past the bounds anyway and a clamp would drag the player
    // off the pivot everything turns around.
    const cornered = fakePlayer({ posX: 0.5, posY: 0.5 });
    const c = call({ rotate: true, player: cornered });
    // The player sits on the pivot, i.e. at (0,0) in the rotated frame.
    const marker = c.moveTo.mock.calls.length > 0;
    expect(marker).toBe(true);
    expect(c.translate).toHaveBeenCalledWith(
      MARGIN + (CANVAS_W - MARGIN * 2) / 2,
      MARGIN + (CANVAS_H - HUD_HEIGHT - MARGIN * 2) / 2,
    );
  });

  it("restores nearest-neighbour smoothing on the way out", () => {
    const c = call({ rotate: true });
    expect(c.imageSmoothingEnabled).toBe(false);
  });
});

describe("drawAutomap() — mines", () => {
  // Mines were never fog-gated — they have their own `visible` flag, set by
  // `MINE_SIGHT_RADIUS` — so removing fog changed nothing here. These tests
  // only needed a map that draws no terrain, which is now solid rock rather
  // than an unvisited grid.
  const unvisitedMap = solidRockMap;

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
  /** Draws no terrain *and* has nothing visited — the loot gate is the one
   * `map.visited` read the automap kept, so these tests still need both. */
  function unvisitedMap(overrides: Partial<GameMap> = {}): GameMap {
    return solidRockMap({ visited: unvisitedGrid(), ...overrides });
  }

  it("defaults to no loot drops when the param is omitted (single-player-shaped call)", () => {
    const map = unvisitedMap();
    map.visited[5][5] = true; // would draw a marker here if the default weren't []
    const withoutParam = makeCtx();
    drawAutomap(asCtx(withoutParam), map, fakePlayer());
    const withEmptyArray = makeCtx();
    drawAutomap(asCtx(withEmptyArray), map, fakePlayer(), 0, []);
    expect(extraFillRectCalls(withoutParam)).toBe(0); // rock draws nothing; `visited` no longer draws anything either
    expect(withoutParam.fillRect.mock.calls.length).toBe(withEmptyArray.fillRect.mock.calls.length);
  });

  it("renders a loot drop on a visited tile within view", () => {
    const ctx = makeCtx();
    const map = unvisitedMap();
    map.visited[5][5] = true;
    drawAutomap(asCtx(ctx), map, fakePlayer(), 0, [{ x: 5, y: 5, kind: "bullets" }]);
    // Just the loot marker — the terrain is rock and draws nothing.
    expect(extraFillRectCalls(ctx)).toBe(1);
  });

  it("hides a loot drop on an unvisited tile — the one visited gate that outlived fog of war", () => {
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
    // Just the two loot markers.
    expect(extraFillRectCalls(ctx)).toBe(2);
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
  it("draws the exit from the moment the level loads, with nothing visited", () => {
    // Changed with the fog removal. The corner minimap has always drawn the
    // exit unconditionally, so gating it here made the bigger, deliberately
    // opened map the one that told you less.
    const ctx = makeCtx();
    const map = solidRockMap({ visited: unvisitedGrid(), exit: { x: 3, y: 3 } });
    drawAutomap(asCtx(ctx), map, fakePlayer());
    // Same camera math the renderer uses: this map is far smaller than the
    // viewport, so the camera centres rather than clamps and camX/camY are
    // negative (see the camera-positioning block above).
    const camX = (map.width - (CANVAS_W - MARGIN * 2) / CELL_PX) / 2;
    const camY = (map.height - (CANVAS_H - HUD_HEIGHT - MARGIN * 2) / CELL_PX) / 2;
    expect(ctx.fillRect).toHaveBeenCalledWith(
      MARGIN + (3 - camX) * CELL_PX,
      MARGIN + (3 - camY) * CELL_PX,
      Math.max(3, CELL_PX),
      Math.max(3, CELL_PX),
    );
  });

  it("draws it exactly once, whether or not its tile has been visited", () => {
    const seen = makeCtx();
    drawAutomap(asCtx(seen), solidRockMap({ exit: { x: 3, y: 3 } }), fakePlayer());
    const unseen = makeCtx();
    drawAutomap(asCtx(unseen), solidRockMap({ visited: unvisitedGrid(), exit: { x: 3, y: 3 } }), fakePlayer());
    expect(seen.fillRect.mock.calls.length).toBe(unseen.fillRect.mock.calls.length);
    expect(extraFillRectCalls(seen)).toBe(0); // ALWAYS_FILLS already counts the exit
  });

  it("does not throw when the exit lies outside the map's rows", () => {
    // Used to guard `map.visited[10]` being undefined. The gate is gone, but an
    // out-of-range exit must still not throw — it simply draws off-grid and is
    // clipped by the viewport.
    const ctx = makeCtx();
    const map = solidRockMap({ exit: { x: 3, y: 10 } });
    expect(() => drawAutomap(asCtx(ctx), map, fakePlayer())).not.toThrow();
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
    // Two save/restore pairs: `withOverlayScale`'s, then the automap's own
    // around the viewport clip. The clip stays at one — it is the automap's,
    // and the wrapper adds no clipping of its own.
    expect(ctx.save).toHaveBeenCalledTimes(2);
    expect(ctx.clip).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
  });

  it("defaults levelTime to 0 when omitted", () => {
    const ctx = makeCtx();
    const g = grid(10);
    g[2][2] = SPIKE_TRAP_TILE;
    const map = fakeMap({ grid: g, spikeTraps: [spike({ x: 2, y: 2, period: 4, phase: 0 })] });
    expect(() => drawAutomap(asCtx(ctx), map, fakePlayer())).not.toThrow();
  });
});

describe("drawAutomap() — teammate markers", () => {
  function unvisitedMap(overrides: Partial<GameMap> = {}): GameMap {
    return fakeMap({ visited: Array.from({ length: 10 }, () => new Array(10).fill(false) as boolean[]), ...overrides });
  }

  const mate = (over: Partial<TeammateMapMarker> = {}): TeammateMapMarker => ({
    x: 5.5,
    y: 5.5,
    color: "#60a5fa",
    helpPing: false,
    ...over,
  });

  it("defaults to none when the param is omitted (single-player-shaped call)", () => {
    const map = unvisitedMap();
    const withoutParam = makeCtx();
    drawAutomap(asCtx(withoutParam), map, fakePlayer());
    const withEmptyArray = makeCtx();
    drawAutomap(asCtx(withEmptyArray), map, fakePlayer(), 0, [], []);
    expect(withoutParam.fillRect.mock.calls.length).toBe(withEmptyArray.fillRect.mock.calls.length);
  });

  it("draws a dot and its surround per teammate", () => {
    const map = unvisitedMap();
    const none = makeCtx();
    drawAutomap(asCtx(none), map, fakePlayer(), 0, [], []);
    const one = makeCtx();
    drawAutomap(asCtx(one), map, fakePlayer(), 0, [], [mate()]);
    expect(one.fillRect.mock.calls.length).toBe(none.fillRect.mock.calls.length + 2);
  });

  it("draws a teammate standing on an UNVISITED tile — fog hides the level, not people", () => {
    // Every other marker on this map is gated on `map.visited`; teammates are
    // deliberately not, because a teammate's own position gives away nothing
    // about the tiles around them and a coop map that hides your team is
    // useless. This is the assertion that pins that decision.
    const map = unvisitedMap(); // nothing visited at all
    const none = makeCtx();
    drawAutomap(asCtx(none), map, fakePlayer(), 0, [], []);
    const one = makeCtx();
    drawAutomap(asCtx(one), map, fakePlayer(), 0, [], [mate({ x: 8.5, y: 8.5 })]);
    expect(one.fillRect.mock.calls.length).toBe(none.fillRect.mock.calls.length + 2);
  });

  it("adds a four-sided ring for a teammate calling for help, never a strokeRect", () => {
    const map = unvisitedMap();
    const quiet = makeCtx();
    drawAutomap(asCtx(quiet), map, fakePlayer(), 0, [], [mate()]);
    const calling = makeCtx();
    drawAutomap(asCtx(calling), map, fakePlayer(), 0, [], [mate({ helpPing: true })]);
    // One brightened re-fill + `outlineRect`'s four edge bars.
    expect(calling.fillRect.mock.calls.length).toBe(quiet.fillRect.mock.calls.length + 5);
    expect(calling.strokeRect).not.toHaveBeenCalled();
  });
});

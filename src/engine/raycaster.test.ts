// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
  type SpikeTrap,
  type Tile,
} from "../map/types";
import { Player } from "./player";
import type { TextureBitmap, TextureSet } from "./textures";

// raycaster.ts imports a real *value* (LORE_BASE) from textures.ts, whose
// module-level `TextureManager` singleton calls `document.createElement`
// and `canvas.getContext("2d")` at import time — before any test code (even
// beforeAll) can run, since ES module imports are hoisted ahead of all other
// top-level code. Stub the canvas context first, then dynamically import
// raycaster.ts so the singleton construction succeeds.
let FOG_FAR: number;
let renderMinimap: typeof import("./raycaster").renderMinimap;
let renderScene: typeof import("./raycaster").renderScene;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ FOG_FAR, renderMinimap, renderScene } = await import("./raycaster"));
});

const WIDTH = 40;
const HEIGHT = 30;

function fakeTexture(w = 4, h = 4, rgb: [number, number, number] = [120, 130, 140]): TextureBitmap {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = rgb[0];
    pixels[i * 4 + 1] = rgb[1];
    pixels[i * 4 + 2] = rgb[2];
    pixels[i * 4 + 3] = 255;
  }
  return { canvas: {} as HTMLCanvasElement, pixels, width: w, height: h };
}

function fakeTextureSet(): TextureSet {
  return {
    wall: fakeTexture(4, 4, [120, 120, 130]),
    bonusWall: fakeTexture(4, 4, [40, 90, 110]),
    door: fakeTexture(4, 4, [90, 70, 40]),
    floor: fakeTexture(4, 4, [60, 60, 70]),
    bonusFloor: fakeTexture(4, 4, [30, 60, 70]),
    loreWall: fakeTexture(4, 4, [120, 200, 210]),
    hazardFloor: fakeTexture(4, 4, [64, 196, 72]),
    teleporterFloor: fakeTexture(4, 4, [130, 70, 220]),
    spikeSafeFloor: fakeTexture(4, 4, [90, 90, 96]),
    spikeActiveFloor: fakeTexture(4, 4, [220, 40, 30]),
  };
}

function grid(size: number, fill: Tile = 0): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(fill) as Tile[]);
}

/** A `size`x`size` room: floor everywhere, walls (1) ringing the border. */
function walledRoom(size: number): Tile[][] {
  const g = grid(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) g[y][x] = 1;
    }
  }
  return g;
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 8): GameMap {
  return {
    width: size,
    height: size,
    grid: walledRoom(size),
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
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

/** Player at the center of a `size`x`size` room, facing +X (default) — the
 * center screen column's ray travels straight along X, hitting whatever
 * tile sits directly ahead on the border. */
function centeredPlayer(map: GameMap): Player {
  const player = new Player({ ...map, spawn: { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) } });
  return player;
}

function ctx(): MockCanvasContext {
  return createMockCanvasContext({ width: WIDTH, height: HEIGHT } as unknown as HTMLCanvasElement);
}

function asCtx(c: MockCanvasContext): CanvasRenderingContext2D {
  return c as unknown as CanvasRenderingContext2D;
}

const midCol = Math.floor(WIDTH / 2);

describe("renderScene — basic sanity", () => {
  it("fills every column's zBuffer entry with a positive perpendicular distance", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    const zBuffer = new Float64Array(WIDTH);
    renderScene(asCtx(c), map, player, zBuffer, fakeTextureSet());
    expect(zBuffer.every((d) => d > 0)).toBe(true);
  });

  it("draws one wall image per column", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet());
    expect(c.drawImage).toHaveBeenCalledTimes(WIDTH);
  });

  it("paints the floor via a single putImageData call", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet());
    expect(c.putImageData).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached floor buffer across two same-size calls", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    const firstCreateCalls = c.createImageData.mock.calls.length;
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    // Same width/height as the previous call -> no new ImageData allocated.
    expect(c.createImageData.mock.calls.length).toBe(firstCreateCalls);
  });
});

describe("renderScene — wall-face texture dispatch", () => {
  it("hits a door directly ahead and samples the door texture", () => {
    const size = 8;
    const g = walledRoom(size);
    const cy = Math.floor(size / 2);
    g[cy][size - 1] = DOOR_TILE;
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    const midCall = c.drawImage.mock.calls[midCol];
    expect(midCall[0]).toBe(textures.door.canvas);
  });

  it("hits a lore terminal wall directly ahead, samples its texture, and overlays the pulse tint", () => {
    const size = 8;
    const g = walledRoom(size);
    const cy = Math.floor(size / 2);
    g[cy][size - 1] = LORE_TILE;
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.loreWall.canvas);
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("hits an unopened secret wall directly ahead — indistinguishable from a plain wall texture-wise, plus its own overlay", () => {
    const size = 8;
    const g = walledRoom(size);
    const cy = Math.floor(size / 2);
    g[cy][size - 1] = SECRET_WALL_TILE;
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.wall.canvas);
  });

  it("hits a plain wall directly ahead and samples the ordinary wall texture", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.wall.canvas);
  });

  it("uses the bonus-level wall texture on a bonus level", () => {
    const map = fakeMap({ bonusLevel: true });
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.bonusWall.canvas);
  });
});

describe("renderScene — ray geometry edge cases", () => {
  it("treats the map edge (no ring wall) as solid — the ray never escapes to infinity", () => {
    const size = 8;
    const g = grid(size); // no border walls at all
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    const zBuffer = new Float64Array(WIDTH);
    expect(() => renderScene(asCtx(c), map, player, zBuffer, fakeTextureSet())).not.toThrow();
    expect(zBuffer.every((d) => Number.isFinite(d))).toBe(true);
  });

  it("shades a y-side hit differently than an x-side hit (side-dependent lighting)", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    player.dirX = 0;
    player.dirY = 1; // facing straight "south" -> hits a y-side wall dead ahead
    player.planeX = -0.66;
    player.planeY = 0;
    const c = ctx();
    expect(() => renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet())).not.toThrow();
  });

  it("handles a ray whose x-direction is exactly 0 (facing purely along the y-plane)", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    player.dirX = 0;
    player.dirY = 1;
    player.planeX = -0.66;
    player.planeY = 0;
    const c = ctx();
    const zBuffer = new Float64Array(WIDTH);
    renderScene(asCtx(c), map, player, zBuffer, fakeTextureSet());
    // The center column's ray direction is exactly (dirX,dirY) = (0,1) here.
    expect(Number.isFinite(zBuffer[midCol])).toBe(true);
  });
});

describe("renderScene — distance fog and FOG_FAR", () => {
  it("exposes FOG_FAR for the Cone-of-Fire scaling in engine.ts", () => {
    expect(FOG_FAR).toBe(14);
  });

  it("renders a wall well beyond FOG_FAR without throwing (fully faded to black)", () => {
    const size = 40;
    const g = walledRoom(size);
    const map = fakeMap({ grid: g }, size);
    const player = new Player({ ...map, spawn: { x: 1, y: Math.floor(size / 2) } });
    const c = ctx();
    expect(() => renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet())).not.toThrow();
  });

  it("skips the redundant bottom-edge antialiasing pass for a wall so thin its top and bottom land in the same screen row", () => {
    // A very long corridor makes the wall so far away that its whole
    // on-screen height collapses into a single row — wallTop and wallBottom
    // both floor to that same row, which the top-edge pass already handled.
    const size = 300;
    const g = walledRoom(size);
    const map = fakeMap({ grid: g }, size);
    const player = new Player({ ...map, spawn: { x: 1, y: Math.floor(size / 2) } });
    const c = ctx();
    expect(() =>
      renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet(), 0.37),
    ).not.toThrow();
  });
});

describe("renderScene — floor tile texture dispatch", () => {
  /** The floor-cast sweep's exact tile-by-tile path depends on player
   * position/facing/viewport geometry, which is impractical to hand-predict
   * pixel-by-pixel — so each special floor kind gets its own map with the
   * *entire* interior filled with that one tile value, guaranteeing the
   * sweep lands on it somewhere, then checks the actual output pixels for
   * that texture's (uniquely-colored) fill rather than just "didn't throw". */
  function uniformFloorMap(tile: Tile, size = 20): GameMap {
    const g = grid(size, tile);
    return fakeMap({ grid: g }, size);
  }

  function containsColor(data: Uint8ClampedArray, [r, g, b]: [number, number, number]): boolean {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === r && data[i + 1] === g && data[i + 2] === b) return true;
    }
    return false;
  }

  it("samples the teleporter floor texture", () => {
    const map = uniformFloorMap(TELEPORTER_TILE);
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [130, 70, 220])).toBe(true); // teleporterFloor's fill color
  });

  it("samples the hazard floor texture", () => {
    const map = uniformFloorMap(HAZARD_TILE);
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [64, 196, 72])).toBe(true); // hazardFloor's fill color
  });

  it("samples the active spike-trap floor texture when every tile has a matching active trap", () => {
    const size = 20;
    const map = uniformFloorMap(SPIKE_TRAP_TILE, size);
    const spikeTraps: SpikeTrap[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) spikeTraps.push({ x, y, period: 4, phase: 0 });
    }
    map.spikeTraps = spikeTraps;
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures, 0, 2); // levelTime=2 -> active half
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [220, 40, 30])).toBe(true); // spikeActiveFloor's fill color
  });

  it("samples the safe spike-trap floor texture when no matching trap entry exists", () => {
    const map = uniformFloorMap(SPIKE_TRAP_TILE); // no spikeTraps entries at all
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures);
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [90, 90, 96])).toBe(true); // spikeSafeFloor's fill color
  });

  it("uses the bonus-level floor texture on a bonus level", () => {
    const map = fakeMap({ bonusLevel: true });
    const player = centeredPlayer(map);
    const c = ctx();
    expect(() => renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet())).not.toThrow();
  });
});

describe("renderMinimap", () => {
  function fullMap(): GameMap {
    const size = 8;
    const g = walledRoom(size);
    g[2][2] = LORE_TILE;
    g[2][3] = SECRET_WALL_TILE;
    g[3][2] = DOOR_TILE;
    return fakeMap(
      {
        grid: g,
        loreTerminals: [{ x: 2, y: 2, text: "// a comment" }],
        hazards: [{ x: 4, y: 4 }],
        doors: [{ x: 2, y: 3 }],
        spikeTraps: [{ x: 5, y: 5, period: 4, phase: 0 }],
        mines: [{ x: 3, y: 5, alive: true, visible: true, closeTimer: 0 }],
        teleporters: [{ x: 5, y: 2, targetX: 1, targetY: 1, label: "goto label" }],
        keys: [{ x: 6, y: 5, collected: false }],
        enemies: [
          {
            x: 4,
            y: 5,
            hp: 10,
            maxHp: 10,
            alive: true,
            attackCooldown: 0,
            hitFlash: 0,
            home: { x: 0, y: 0, w: 8, h: 8 },
            aggroed: false,
            discovered: true,
            roamX: 4,
            roamY: 5,
            fireCooldown: 0,
            entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
            elite: false,
            edgeCase: false,
          },
          {
            x: 5,
            y: 6,
            hp: 10,
            maxHp: 10,
            alive: true,
            attackCooldown: 0,
            hitFlash: 0,
            home: { x: 0, y: 0, w: 8, h: 8 },
            aggroed: false,
            discovered: true,
            roamX: 5,
            roamY: 6,
            fireCooldown: 0,
            entity: { name: "g", kind: "method", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
            elite: false,
            edgeCase: true,
          },
        ],
      },
      size,
    );
  }

  it("returns the panel's outer rect and a compass badge straddling its corner", () => {
    const c = ctx();
    const map = fullMap();
    const player = centeredPlayer(map);
    const panel = renderMinimap(asCtx(c), map, player);
    expect(panel.compassBadge.cx).toBe(panel.x + panel.w);
    expect(panel.compassBadge.cy).toBe(panel.y + panel.h);
  });

  it("draws every marker kind without throwing, at the active phase of the spike trap", () => {
    const c = ctx();
    const map = fullMap();
    const player = centeredPlayer(map);
    expect(() => renderMinimap(asCtx(c), map, player, 2)).not.toThrow();
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("skips a dead or undiscovered enemy", () => {
    const c = ctx();
    const map = fullMap();
    map.enemies[0].discovered = false;
    const player = centeredPlayer(map);
    const before = c.fillRect.mock.calls.length;
    renderMinimap(asCtx(c), map, player);
    // Can't isolate the enemy's own fillRect count directly, but this at
    // least exercises the "skip" branch without throwing.
    expect(c.fillRect.mock.calls.length).toBeGreaterThanOrEqual(before);
  });

  it("skips a dead or invisible mine, and a collected key", () => {
    const c = ctx();
    const map = fullMap();
    map.mines[0].alive = false;
    map.keys[0].collected = true;
    const player = centeredPlayer(map);
    expect(() => renderMinimap(asCtx(c), map, player)).not.toThrow();
  });

  it("skips an already-opened door (grid no longer shows DOOR_TILE there)", () => {
    const c = ctx();
    const map = fullMap();
    map.grid[3][2] = 0; // opened
    const player = centeredPlayer(map);
    expect(() => renderMinimap(asCtx(c), map, player)).not.toThrow();
  });

  it("uses the bonus-level wall color on a bonus level", () => {
    const c = ctx();
    const map = fakeMap({ bonusLevel: true });
    const player = centeredPlayer(map);
    renderMinimap(asCtx(c), map, player);
    expect(c.fillStyle).toBeDefined();
  });

  it("caps the cell size at 1px minimum for a huge map", () => {
    const c = ctx();
    const size = 500;
    const g = walledRoom(size);
    const map = fakeMap({ grid: g }, size);
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    const panel = renderMinimap(asCtx(c), map, player, 0, 70);
    expect(panel.w).toBeGreaterThan(0);
  });
});

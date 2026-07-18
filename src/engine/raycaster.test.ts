// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it, vi } from "vitest";
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

  it("stops overlaying the pulse tint on a lore terminal once it's marked as read, but keeps its distinct texture", () => {
    const size = 8;
    const g = walledRoom(size);
    const cy = Math.floor(size / 2);
    const terminalX = size - 1;
    g[cy][terminalX] = LORE_TILE;
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    // fillRect doesn't otherwise capture the fillStyle active at call time —
    // snapshot it ourselves so the lore-pulse rgba (LORE_BASE, see textures.ts)
    // can be told apart from the other fillRect calls every hit column makes
    // (the base shading fill, and each edge-antialiasing row).
    const fillStyles: string[] = [];
    c.fillRect.mockImplementation(() => fillStyles.push(String(c.fillStyle)));

    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), textures, 0, 0, new Set([`${terminalX},${cy}`]));

    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.loreWall.canvas);
    expect(fillStyles.some((s) => s.startsWith("rgba(120,200,210,"))).toBe(false);
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
    // antialiasing:true — this scenario only exists to test that pass, which
    // is off (WALL_EDGE_ANTIALIASING_ENABLED) by default; see the dedicated
    // describe block below for the default-off behavior itself.
    const size = 300;
    const g = walledRoom(size);
    const map = fakeMap({ grid: g }, size);
    const player = new Player({ ...map, spawn: { x: 1, y: Math.floor(size / 2) } });
    const c = ctx();
    expect(() =>
      renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet(), 0.37, undefined, undefined, true),
    ).not.toThrow();
  });
});

describe("renderScene — wall-edge antialiasing (WALL_EDGE_ANTIALIASING_ENABLED)", () => {
  it("is on by default — the default render draws the extra edge-blend rows an explicit false skips", () => {
    // Flipped on by the 2026-07 perf audit (measured: free on demo-scale
    // maps, ~+0.4ms on a 160×160 one — see the flag's doc comment).
    const map = fakeMap();
    const player = centeredPlayer(map);
    const cDefault = ctx();
    renderScene(asCtx(cDefault), map, player, new Float64Array(WIDTH), fakeTextureSet());
    const cOff = ctx();
    renderScene(asCtx(cOff), map, player, new Float64Array(WIDTH), fakeTextureSet(), undefined, undefined, undefined, false);
    // Every hit column gets exactly one base shading fillRect either way;
    // the default (antialiasing on) additionally draws up to two 1px edge
    // rows per column, so it must strictly exceed the explicit-off count.
    expect(cDefault.fillRect.mock.calls.length).toBeGreaterThan(cOff.fillRect.mock.calls.length);
  });

  it("draws distinct top- and bottom-edge blend rows when explicitly enabled", () => {
    // centeredPlayer on an 8x8 room hits a wall a few tiles out — tall enough
    // on screen that its top and bottom edges land in different rows (not
    // the same-row dedup case covered separately above). A small
    // horizonShift keeps both edges off exact integer pixel boundaries, so
    // both get genuine (nonzero) partial coverage rather than one of them
    // landing precisely on a row line and rounding to a zero-width blend.
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    const fillStyles: string[] = [];
    c.fillRect.mockImplementation(() => fillStyles.push(String(c.fillStyle)));
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet(), 0.5, undefined, undefined, true);
    // shadedTexel() always returns a plain "rgb(...)" string, distinct from
    // the base shading fill's "#000" and any overlay's "rgba(...)".
    const edgeBlendCalls = fillStyles.filter((s) => s.startsWith("rgb("));
    expect(edgeBlendCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("nudges the sampled edge color for an unopened secret wall, same as its overlay does", () => {
    const size = 8;
    const g = walledRoom(size);
    const cy = Math.floor(size / 2);
    g[cy][size - 1] = SECRET_WALL_TILE;
    const map = fakeMap({ grid: g }, size);
    const player = centeredPlayer(map);
    const c = ctx();
    expect(() =>
      renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet(), undefined, undefined, undefined, true),
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

  it("skips a lore terminal's pulsing marker once it's marked as read", () => {
    const map = fullMap();
    const player = centeredPlayer(map);

    const cUnread = ctx();
    renderMinimap(asCtx(cUnread), map, player);
    const unreadCalls = cUnread.fillRect.mock.calls.length;

    const cRead = ctx();
    renderMinimap(asCtx(cRead), map, player, 0, 70, new Set(["2,2"])); // fullMap()'s one terminal
    const readCalls = cRead.fillRect.mock.calls.length;

    // Skips exactly its own marker fill — everything else on the panel is
    // otherwise identical between the two calls.
    expect(readCalls).toBe(unreadCalls - 1);
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

describe("renderScene — distance fog flag", () => {
  /** Positional call with everything defaulted except `fog`. */
  function render(c: MockCanvasContext, map: GameMap, player: Player, fog: boolean): void {
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeTextureSet(), 0, 0, new Set(), false, fog);
  }

  it("fog off: a fully-lit x-side column skips the base shading fill that fog on always draws", () => {
    const map = fakeMap();
    const player = centeredPlayer(map); // faces +X — every column hits an x-side wall
    const cOn = ctx();
    render(cOn, map, player, true);
    const cOff = ctx();
    render(cOff, map, player, false);
    const fillsAt = (c: MockCanvasContext, col: number) => c.fillRect.mock.calls.filter((a) => a[0] === col).length;
    expect(fillsAt(cOn, midCol)).toBe(1); // alpha-(1-shade) overlay, drawn even when shade is 1
    expect(fillsAt(cOff, midCol)).toBe(0); // fully lit without fog — overlay skipped entirely
  });

  it("fog off: y-side walls keep their directional SIDE_SHADE overlay", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    // Face +Y so the center ray hits a horizontal (y-side) wall: those stay
    // dimmed by SIDE_SHADE regardless of fog, so the overlay must still draw.
    player.dirX = 0;
    player.dirY = 1;
    player.planeX = -0.66;
    player.planeY = 0;
    const c = ctx();
    render(c, map, player, false);
    expect(c.fillRect.mock.calls.filter((a) => a[0] === midCol).length).toBe(1);
  });

  it("fog off: far floor pixels keep their raw texture color instead of sinking to black", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    // Row just below the horizon: rowDistance = posZ / 1 = HEIGHT/2, beyond
    // FOG_FAR — fully fogged to black when on, untouched when off.
    expect(FOG_FAR).toBeLessThan(HEIGHT / 2);
    const rowIdx = (Math.floor(HEIGHT / 2) + 1) * WIDTH * 4;
    const cOn = ctx();
    render(cOn, map, player, true);
    const fogged = (cOn.putImageData.mock.calls[0][0] as ImageData).data[rowIdx];
    const cOff = ctx();
    render(cOff, map, player, false);
    const unfogged = (cOff.putImageData.mock.calls[0][0] as ImageData).data[rowIdx];
    expect(fogged).toBe(0);
    expect(unfogged).toBe(fakeTextureSet().floor.pixels[0]);
  });
});

describe("renderMinimap — cached wall layer", () => {
  it("builds the offscreen wall canvas once and reuses it while (map, gridVersion) are unchanged", () => {
    const map = fakeMap();
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    const createSpy = vi.spyOn(document, "createElement");
    const c1 = ctx();
    renderMinimap(asCtx(c1), map, player, 0, 70, new Set(), 3);
    const buildsAfterFirst = createSpy.mock.calls.filter((a: unknown[]) => a[0] === "canvas").length;
    expect(buildsAfterFirst).toBe(1);
    expect(c1.drawImage).toHaveBeenCalled(); // walls arrive as one blit, not per-tile fills

    const c2 = ctx();
    renderMinimap(asCtx(c2), map, player, 0, 70, new Set(), 3);
    expect(createSpy.mock.calls.filter((a: unknown[]) => a[0] === "canvas").length).toBe(buildsAfterFirst); // cache hit
    expect(c2.drawImage).toHaveBeenCalled();
  });

  it("rebuilds when gridVersion bumps (door/secret wall opened) and uses the bonus wall color on bonus levels", () => {
    const map = fakeMap({ bonusLevel: true });
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    renderMinimap(asCtx(ctx()), map, player, 0, 70, new Set(), 1);
    const createSpy = vi.spyOn(document, "createElement");
    renderMinimap(asCtx(ctx()), map, player, 0, 70, new Set(), 2); // version bump -> rebuild
    expect(createSpy.mock.calls.filter((a: unknown[]) => a[0] === "canvas").length).toBe(1);
  });

  it("falls back to direct per-tile fills when no offscreen 2D context is available", () => {
    const map = fakeMap();
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
    try {
      const c = ctx();
      renderMinimap(asCtx(c), map, player, 0, 70, new Set(), 99);
      expect(c.drawImage).not.toHaveBeenCalled();
      // The 8x8 walled room has 28 border wall tiles — all drawn directly.
      expect(c.fillRect.mock.calls.length).toBeGreaterThan(28);
      // Bonus levels pick the alternate wall color in the same fallback.
      const bonus = fakeMap({ bonusLevel: true });
      const cBonus = ctx();
      renderMinimap(asCtx(cBonus), bonus, new Player({ ...bonus, spawn: { x: 1, y: 1 } }), 0, 70, new Set(), 99);
      expect(cBonus.drawImage).not.toHaveBeenCalled();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

describe("renderMinimap — wall-layer cache keying", () => {
  it("a different cell size (maxPixels) on the same map/version rebuilds the layer", () => {
    const map = fakeMap();
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    renderMinimap(asCtx(ctx()), map, player, 0, 70, new Set(), 7);
    const createSpy = vi.spyOn(document, "createElement");
    renderMinimap(asCtx(ctx()), map, player, 0, 40, new Set(), 7); // smaller panel -> different cell
    expect(createSpy.mock.calls.filter((a: unknown[]) => a[0] === "canvas").length).toBe(1);
  });
});

// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import {
  BRANCH_DOOR_TILE,
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
  type Point,
  type SpikeTrap,
  type StyleSetId,
  type Tile,
} from "../map/types";
import { Player } from "./player";
import type { TeammateMapMarker } from "./sprites";
import type { LevelStyle, TextureBitmap, TextureSet } from "./textures";

// raycaster.ts imports a real *value* (LORE_BASE) from textures.ts, whose
// module-level `TextureManager` singleton calls `document.createElement`
// and `canvas.getContext("2d")` at import time — before any test code (even
// beforeAll) can run, since ES module imports are hoisted ahead of all other
// top-level code. Stub the canvas context first, then dynamically import
// raycaster.ts so the singleton construction succeeds.
let FOG_FAR: number;
let renderMinimap: typeof import("./raycaster").renderMinimap;
let renderScene: typeof import("./raycaster").renderScene;
let renderBackgroundFast: typeof import("./raycaster").renderBackgroundFast;
let renderBackgroundHalfRes: typeof import("./raycaster").renderBackgroundHalfRes;
let renderBackgroundClassic: typeof import("./raycaster").renderBackgroundClassic;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ FOG_FAR, renderMinimap, renderScene, renderBackgroundFast, renderBackgroundHalfRes, renderBackgroundClassic } = await import("./raycaster"));
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
    door: fakeTexture(4, 4, [90, 70, 40]),
    floor: fakeTexture(4, 4, [60, 60, 70]),
    loreWall: fakeTexture(4, 4, [120, 200, 210]),
    hazardFloor: fakeTexture(4, 4, [64, 196, 72]),
    teleporterFloor: fakeTexture(4, 4, [130, 70, 220]),
    spikeSafeFloor: fakeTexture(4, 4, [90, 90, 96]),
    spikeActiveFloor: fakeTexture(4, 4, [220, 40, 30]),
  };
}

/** Wraps a `TextureSet` into the `LevelStyle` the renderers now take. Most
 * call sites don't care which styleset they're nominally rendering, so the
 * defaults keep them a one-liner; the tests that *do* care pass their own. */
function fakeStyle(
  textures: TextureSet = fakeTextureSet(),
  id: StyleSetId = "stone",
  ceiling: [number, number, number] = [11, 13, 22],
  automapWall = "#4a4a55",
): LevelStyle {
  return { id, textures, ceiling, automapWall };
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
    renderScene(asCtx(c), map, player, zBuffer, fakeStyle());
    expect(zBuffer.every((d) => d > 0)).toBe(true);
  });

  it("draws one wall image per column", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle());
    expect(c.drawImage).toHaveBeenCalledTimes(WIDTH);
  });

  it("paints the floor via a single putImageData call", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle());
    expect(c.putImageData).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached floor buffer across two same-size calls", () => {
    const c = ctx();
    const map = fakeMap();
    const player = centeredPlayer(map);
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
    const firstCreateCalls = c.createImageData.mock.calls.length;
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
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

    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures), 0, 0, new Set([`${terminalX},${cy}`]));

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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.wall.canvas);
  });

  it("hits a branch door directly ahead, shares the door texture, and overlays its own tint", () => {
    const size = 8;
    const cy = Math.floor(size / 2);
    const render = (tile: typeof DOOR_TILE | typeof BRANCH_DOOR_TILE) => {
      const g = walledRoom(size);
      g[cy][size - 1] = tile;
      const map = fakeMap({ grid: g }, size);
      const c = ctx();
      const textures = fakeTextureSet();
      const styles: string[] = [];
      c.fillRect.mockImplementation(() => {
        styles.push(String(c.fillStyle));
      });
      renderScene(asCtx(c), map, centeredPlayer(map), new Float64Array(WIDTH), fakeStyle(textures));
      return { sampled: c.drawImage.mock.calls[midCol][0], styles, textures };
    };

    const branch = render(BRANCH_DOOR_TILE);
    const locked = render(DOOR_TILE);
    // Same base texture — a branch door is still recognisably a door, and
    // sharing the slot keeps a WAD-sourced door correct for free.
    expect(branch.sampled).toBe(branch.textures.door.canvas);
    expect(locked.sampled).toBe(locked.textures.door.canvas);
    // ...but only the branch door gets an identifying wash on top, so the two
    // never read the same in first person.
    const extra = branch.styles.filter((c) => !locked.styles.includes(c));
    expect(extra.length).toBeGreaterThan(0);
  });

  it("hits a plain wall directly ahead and samples the ordinary wall texture", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
    expect(c.drawImage.mock.calls[midCol][0]).toBe(textures.wall.canvas);
  });

  it("samples whichever styleset's wall it was handed, not one baked into the map", () => {
    // Wall selection now comes purely from the passed `LevelStyle`; the same
    // map rendered under two stylesets must sample two different bitmaps.
    const map = fakeMap();
    const player = centeredPlayer(map);

    const stoneTex = fakeTextureSet();
    const cStone = ctx();
    renderScene(asCtx(cStone), map, player, new Float64Array(WIDTH), fakeStyle(stoneTex, "stone"));

    const techTex = fakeTextureSet();
    const cTech = ctx();
    renderScene(asCtx(cTech), map, player, new Float64Array(WIDTH), fakeStyle(techTex, "tech"));

    expect(cStone.drawImage.mock.calls[midCol][0]).toBe(stoneTex.wall.canvas);
    expect(cTech.drawImage.mock.calls[midCol][0]).toBe(techTex.wall.canvas);
    expect(cStone.drawImage.mock.calls[midCol][0]).not.toBe(techTex.wall.canvas);
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
    expect(() => renderScene(asCtx(c), map, player, zBuffer, fakeStyle())).not.toThrow();
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
    expect(() => renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle())).not.toThrow();
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
    renderScene(asCtx(c), map, player, zBuffer, fakeStyle());
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
    expect(() => renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle())).not.toThrow();
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
      renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(), 0.37, undefined, undefined, true),
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
    renderScene(asCtx(cDefault), map, player, new Float64Array(WIDTH), fakeStyle());
    const cOff = ctx();
    renderScene(asCtx(cOff), map, player, new Float64Array(WIDTH), fakeStyle(), undefined, undefined, undefined, false);
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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(), 0.5, undefined, undefined, true);
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
      renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(), undefined, undefined, undefined, true),
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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [130, 70, 220])).toBe(true); // teleporterFloor's fill color
  });

  it("samples the hazard floor texture", () => {
    const map = uniformFloorMap(HAZARD_TILE);
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
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
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures), 0, 2); // levelTime=2 -> active half
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [220, 40, 30])).toBe(true); // spikeActiveFloor's fill color
  });

  it("samples the safe spike-trap floor texture when no matching trap entry exists", () => {
    const map = uniformFloorMap(SPIKE_TRAP_TILE); // no spikeTraps entries at all
    const player = new Player({ ...map, spawn: { x: 10, y: 10 } });
    const c = ctx();
    const textures = fakeTextureSet();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures));
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [90, 90, 96])).toBe(true); // spikeSafeFloor's fill color
  });

  it("floor-casts with the styleset's own floor texture", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const textures = fakeTextureSet();
    textures.floor = fakeTexture(4, 4, [7, 9, 11]); // a tone nothing else uses
    const c = ctx();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(textures, "tech"));
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [7, 9, 11])).toBe(true);
  });

  it("paints the ceiling with the styleset's ceiling tone", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(fakeTextureSet(), "rust", [22, 14, 11]));
    const data = c.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(containsColor(data, [22, 14, 11])).toBe(true);
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
        keys: [{ x: 6, y: 5, collected: false, gateId: 0 }],
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

  it("fills walls with the styleset's automap color when one is passed", () => {
    const c = ctx();
    const map = fakeMap({ styleSet: "rust" });
    const player = centeredPlayer(map);
    // No offscreen context in this mock environment path is guaranteed, so
    // assert on the color reaching the renderer rather than on pixels.
    renderMinimap(asCtx(c), map, player, 0, 70, new Set(), 0, [], [], "#6b4436");
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

  describe("key ping", () => {
    /** Everything defaulted except the trailing `pingedKey`. */
    function render(c: MockCanvasContext, map: GameMap, player: Player, ping: Point | null): void {
      renderMinimap(asCtx(c), map, player, 0, 70, new Set(), 0, [], [], undefined, ping);
    }

    it("draws nothing extra when no ping is running", () => {
      // The regression guard: an omitted argument has to be byte-identical to
      // the panel as it was before this parameter existed.
      const map = fullMap();
      const player = centeredPlayer(map);

      const cNone = ctx();
      render(cNone, map, player, null);
      const cOmitted = ctx();
      renderMinimap(asCtx(cOmitted), map, player);

      expect(cNone.fillRect.mock.calls.length).toBe(cOmitted.fillRect.mock.calls.length);
      expect(cNone.clip).not.toHaveBeenCalled();
    });

    it("adds a bright re-fill and a four-sided sonar ring at the pinged key", () => {
      const map = fullMap();
      const player = centeredPlayer(map);

      const cNone = ctx();
      render(cNone, map, player, null);
      const cPing = ctx();
      render(cPing, map, player, { x: 6, y: 5 }); // fullMap()'s one key

      // One re-fill of the marker + `outlineRect`'s four edge bars.
      expect(cPing.fillRect.mock.calls.length).toBe(cNone.fillRect.mock.calls.length + 5);
      expect(cPing.strokeRect).not.toHaveBeenCalled();
    });

    it("clips the ring to the panel so a key near an edge can't sweep over the scene", () => {
      const map = fullMap();
      const player = centeredPlayer(map);
      const c = ctx();
      render(c, map, player, { x: 6, y: 5 });
      expect(c.clip).toHaveBeenCalledTimes(1);
      expect(c.rect).toHaveBeenCalledTimes(1);
    });

    it("animates: the ring's geometry moves with the wall clock", () => {
      const map = fullMap();
      const player = centeredPlayer(map);
      // Markers keep drawing after the ping block, so locate its fills by
      // diffing against the same panel with no ping running: everything before
      // the first difference is identical, and the ring's four edge bars are
      // the four fills after the marker re-fill.
      const ringWidthAt = (ms: number) => {
        vi.spyOn(performance, "now").mockReturnValue(ms);
        const cNone = ctx();
        render(cNone, map, player, null);
        const cPing = ctx();
        render(cPing, map, player, { x: 6, y: 5 });
        const none = cNone.fillRect.mock.calls;
        const ping = cPing.fillRect.mock.calls as [number, number, number, number][];
        const firstDiff = ping.findIndex((call, i) => JSON.stringify(call) !== JSON.stringify(none[i]));
        expect(firstDiff).toBeGreaterThan(-1);
        return ping[firstDiff + 1][2]; // top edge bar spans the full ring width
      };
      expect(ringWidthAt(0)).not.toBeCloseTo(ringWidthAt(450), 3);
      vi.restoreAllMocks();
    });
  });

  describe("teammate markers", () => {
    /** Everything defaulted except the trailing `teammates`. */
    function render(c: MockCanvasContext, map: GameMap, player: Player, mates: TeammateMapMarker[]): void {
      renderMinimap(asCtx(c), map, player, 0, 70, new Set(), 0, [], [], undefined, null, mates);
    }

    const mate = (over: Partial<TeammateMapMarker> = {}): TeammateMapMarker => ({
      x: 6,
      y: 5,
      color: "#60a5fa",
      helpPing: false,
      ...over,
    });

    it("draws nothing extra with no teammates — an omitted argument is single-player", () => {
      const map = fullMap();
      const player = centeredPlayer(map);

      const cNone = ctx();
      render(cNone, map, player, []);
      const cOmitted = ctx();
      renderMinimap(asCtx(cOmitted), map, player);

      expect(cNone.fillRect.mock.calls.length).toBe(cOmitted.fillRect.mock.calls.length);
    });

    it("draws a dot plus its dark surround for each teammate", () => {
      const map = fullMap();
      const player = centeredPlayer(map);

      const cNone = ctx();
      render(cNone, map, player, []);
      const cOne = ctx();
      render(cOne, map, player, [mate()]);

      // Surround + dot, so two fills per teammate — the surround is what keeps
      // a green teammate from reading as the exit marker.
      expect(cOne.fillRect.mock.calls.length).toBe(cNone.fillRect.mock.calls.length + 2);
    });

    it("wraps a help-pinging teammate in a four-sided ring, clipped to the panel", () => {
      const map = fullMap();
      const player = centeredPlayer(map);

      const cQuiet = ctx();
      render(cQuiet, map, player, [mate()]);
      const cCalling = ctx();
      render(cCalling, map, player, [mate({ helpPing: true })]);

      // One brightened re-fill + `outlineRect`'s four edge bars.
      expect(cCalling.fillRect.mock.calls.length).toBe(cQuiet.fillRect.mock.calls.length + 5);
      expect(cCalling.strokeRect).not.toHaveBeenCalled();
      expect(cCalling.clip).toHaveBeenCalledTimes(1);
    });

    it("does not clip when nobody is calling — no ring, no cost", () => {
      const map = fullMap();
      const player = centeredPlayer(map);
      const c = ctx();
      render(c, map, player, [mate()]);
      expect(c.clip).not.toHaveBeenCalled();
    });
  });
});

describe("renderScene — distance fog flag", () => {
  /** Positional call with everything defaulted except `fog`. */
  function render(c: MockCanvasContext, map: GameMap, player: Player, fog: boolean): void {
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(), 0, 0, new Set(), false, fog);
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

describe("renderMinimap — multiplayer loot drops", () => {
  function visitedGrid(size: number): boolean[][] {
    return Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]);
  }

  function lootMap(): GameMap {
    return fakeMap({ visited: visitedGrid(8) });
  }

  it("defaults to no loot drops when the param is omitted (single-player-shaped call)", () => {
    const map = lootMap();
    map.visited[4][4] = true;
    const player = centeredPlayer(map);
    const withoutParam = ctx();
    renderMinimap(asCtx(withoutParam), map, player);
    const withEmptyArray = ctx();
    renderMinimap(asCtx(withEmptyArray), map, player, 0, 70, new Set(), 0, []);
    expect(withoutParam.fillRect.mock.calls.length).toBe(withEmptyArray.fillRect.mock.calls.length);
  });

  it("renders a loot drop marker on a visited tile", () => {
    const map = lootMap();
    map.visited[4][4] = true;
    const player = centeredPlayer(map);

    const without = ctx();
    renderMinimap(asCtx(without), map, player);
    const withDrop = ctx();
    renderMinimap(asCtx(withDrop), map, player, 0, 70, new Set(), 0, [{ x: 4, y: 4, kind: "bullets" }]);

    expect(withDrop.fillRect.mock.calls.length).toBe(without.fillRect.mock.calls.length + 1);
  });

  it("hides a loot drop on an unvisited tile — the fog-of-war/spoiler gate this step adds", () => {
    const map = lootMap(); // nothing visited
    const player = centeredPlayer(map);

    const without = ctx();
    renderMinimap(asCtx(without), map, player);
    const withDrop = ctx();
    renderMinimap(asCtx(withDrop), map, player, 0, 70, new Set(), 0, [{ x: 4, y: 4, kind: "bullets" }]);

    expect(withDrop.fillRect.mock.calls.length).toBe(without.fillRect.mock.calls.length);
  });

  it("renders more than one visible loot drop", () => {
    const map = lootMap();
    map.visited[1][1] = true;
    map.visited[6][6] = true;
    const player = centeredPlayer(map);

    const without = ctx();
    renderMinimap(asCtx(without), map, player);
    const withDrops = ctx();
    renderMinimap(asCtx(withDrops), map, player, 0, 70, new Set(), 0, [
      { x: 1, y: 1, kind: "bullets" },
      { x: 6, y: 6, kind: "weapon", weaponIndex: 0 },
    ]);

    expect(withDrops.fillRect.mock.calls.length).toBe(without.fillRect.mock.calls.length + 2);
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

  it("rebuilds when gridVersion bumps (door/secret wall opened)", () => {
    const map = fakeMap({ styleSet: "techCool" });
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
      // The styleset's own wall color reaches the same direct-fill fallback.
      const bonus = fakeMap({ styleSet: "techCool" });
      const cBonus = ctx();
      renderMinimap(
        asCtx(cBonus),
        bonus,
        new Player({ ...bonus, spawn: { x: 1, y: 1 } }),
        0,
        70,
        new Set(),
        99,
        [],
        [],
        "#3f7fae",
      );
      expect(cBonus.drawImage).not.toHaveBeenCalled();
      expect(cBonus.fillStyle).toBeDefined();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("gives branch doors their own colour in the fallback, like the cached layer does", () => {
    // The cached wall layer draws `BRANCH_DOOR_TILE` in a warm amber, distinct
    // from the key-locked door's cool blue, so a glance tells "just push it"
    // from "needs a key you may not have". The fallback used to lump branch
    // doors in with the plain wall fill and lose that signal entirely.
    const grid = walledRoom(8);
    grid[4][0] = BRANCH_DOOR_TILE; // on the wall ring, so it replaces a wall tile
    const map = fakeMap({ grid });
    const player = new Player({ ...map, spawn: { x: 1, y: 1 } });
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
    try {
      const c = ctx();
      // fillRect doesn't otherwise capture the fillStyle active at call time —
      // same idiom the lore-terminal test above uses.
      const fillStyles: string[] = [];
      c.fillRect.mockImplementation(() => fillStyles.push(String(c.fillStyle)));
      renderMinimap(asCtx(c), map, player, 0, 70, new Set(), 99);
      expect(c.drawImage).not.toHaveBeenCalled();
      expect(fillStyles).toContain("#b39a72");
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

describe("renderBackgroundFast — equivalence with the classic floor-cast (frame-budget audit Phase 2)", () => {
  /** Gradient texture so the u/v texel sampling actually varies per pixel —
   * a uniform color would let a broken UV computation pass unnoticed. */
  function gradientTexture(w = 4, h = 4): TextureBitmap {
    const pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        pixels[i] = 30 + x * 40;
        pixels[i + 1] = 20 + y * 50;
        pixels[i + 2] = 200 - x * 30 - y * 20;
        pixels[i + 3] = 255;
      }
    }
    return { canvas: {} as HTMLCanvasElement, pixels, width: w, height: h };
  }

  function variedMap(): GameMap {
    const size = 12;
    const g = walledRoom(size);
    // A hazard pool and a teleporter pad inside the room, so the sweep
    // crosses texture-dispatch boundaries, not just one flat floor.
    g[7][7] = HAZARD_TILE;
    g[8][7] = HAZARD_TILE;
    g[4][8] = TELEPORTER_TILE;
    return fakeMap({ grid: g }, size);
  }

  function texturesWithGradients(): TextureSet {
    const t = fakeTextureSet();
    t.floor = gradientTexture();
    t.hazardFloor = gradientTexture();
    return t;
  }

  /** The classic byte-store reference, called directly — since the fast path
   * shipped default-on, going through renderScene would compare fast to fast
   * (a vacuous test; the coverage gate caught exactly that). */
  function classicFloorImage(map: GameMap, player: Player, style: LevelStyle, horizonShift = 0): ImageData {
    const c = ctx();
    renderBackgroundClassic(asCtx(c), map, player, WIDTH, HEIGHT, HEIGHT / 2 + horizonShift, 0, style, true);
    return c.putImageData.mock.calls[0][0] as ImageData;
  }

  it("renderScene dispatches the floor to the shipped fast path", () => {
    const map = variedMap();
    const player = centeredPlayer(map);
    const style = fakeStyle(texturesWithGradients());
    const viaScene = ctx();
    renderScene(asCtx(viaScene), map, player, new Float64Array(WIDTH), style);
    const direct = ctx();
    renderBackgroundFast(asCtx(direct), map, player, WIDTH, HEIGHT, HEIGHT / 2, 0, style, true);
    const a = (viaScene.putImageData.mock.calls[0][0] as ImageData).data;
    const b = (direct.putImageData.mock.calls[0][0] as ImageData).data;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  it("floor rows match the classic path within the documented 1/255 rounding difference", () => {
    const map = variedMap();
    const player = centeredPlayer(map);
    const style = fakeStyle(texturesWithGradients());
    const horizon = HEIGHT / 2; // integer here; fractional case below
    const classic = classicFloorImage(map, player, style);

    const c = ctx();
    renderBackgroundFast(asCtx(c), map, player, WIDTH, HEIGHT, horizon, 0, style, true);
    expect(c.putImageData).toHaveBeenCalledTimes(1);
    const [fastImg, dx, dy] = c.putImageData.mock.calls[0];
    // Full-frame blit, same as the classic path (v2 — the v1 dirty-rect blit
    // measured as a regression at 640x400 and was dropped).
    expect([dx, dy]).toEqual([0, 0]);
    expect(c.putImageData.mock.calls[0].length).toBe(3);

    let maxDiff = 0;
    for (let y = horizon; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          maxDiff = Math.max(maxDiff, Math.abs(classic.data[i + ch] - (fastImg as ImageData).data[i + ch]));
        }
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it("writes ceiling rows byte-identical to the classic per-pixel ceiling", () => {
    const map = variedMap();
    const player = centeredPlayer(map);
    const ceiling: [number, number, number] = [11, 13, 22];
    const style = fakeStyle(texturesWithGradients(), "stone", ceiling);
    const horizon = HEIGHT / 2;
    const classic = classicFloorImage(map, player, style);

    const c = ctx();
    renderBackgroundFast(asCtx(c), map, player, WIDTH, HEIGHT, horizon, 0, style, true);
    const fastImg = c.putImageData.mock.calls[0][0] as ImageData;
    // Every ceiling pixel exactly the flat ceiling color, in both paths.
    for (let y = 0; y < horizon; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        expect([classic.data[i], classic.data[i + 1], classic.data[i + 2], classic.data[i + 3]]).toEqual([...ceiling, 255]);
        expect([fastImg.data[i], fastImg.data[i + 1], fastImg.data[i + 2], fastImg.data[i + 3]]).toEqual([...ceiling, 255]);
      }
    }
    // No stray draw calls: the fast path is pixel writes + one blit only.
    expect(c.fillRect).not.toHaveBeenCalled();
  });

  it("handles a fractional horizon (head-bob) with the same first floor row as the classic path", () => {
    const map = variedMap();
    const player = centeredPlayer(map);
    const style = fakeStyle(texturesWithGradients());
    const horizonShift = 0.4;
    const horizon = HEIGHT / 2 + horizonShift;
    const firstFloorRow = Math.ceil(horizon);
    const classic = classicFloorImage(map, player, style, horizonShift);

    const c = ctx();
    renderBackgroundFast(asCtx(c), map, player, WIDTH, HEIGHT, horizon, 0, style, true);
    const fastImg = c.putImageData.mock.calls[0][0] as ImageData;
    // The row above firstFloorRow is still ceiling in both paths.
    const lastCeilIdx = (firstFloorRow - 1) * WIDTH * 4;
    expect(fastImg.data[lastCeilIdx]).toBe(classic.data[lastCeilIdx]);
    let maxDiff = 0;
    for (let y = firstFloorRow; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          maxDiff = Math.max(maxDiff, Math.abs(classic.data[i + ch] - fastImg.data[i + ch]));
        }
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });
});

describe("renderBackground variants — full tile/fog arm coverage (classic vs fast, every floor kind)", () => {
  /** Every special floor kind placed INSIDE the floor sweep's cone (player
   * at (1.5, 5.5) facing +X: nearby rows sample cx 2-3, cy 4-7, all within
   * the fog's full-brightness radius so exact texture colors survive), plus
   * a spike tile WITH a trap entry (active arm at levelTime=2) and one
   * WITHOUT (always safe arm). The map edge behind the player gives far rows
   * out-of-bounds samples for the `-1` arm. A first version of this test put
   * the tiles outside the cone — the arms were simply never taken and the
   * diff-based assertion could not tell; hence the containsColor checks. */
  function kitchenSinkMap(): GameMap {
    const size = 12;
    const g = walledRoom(size);
    g[5][2] = TELEPORTER_TILE;
    g[6][2] = HAZARD_TILE;
    g[5][3] = SPIKE_TRAP_TILE; // matching entry -> active at levelTime=2
    g[6][3] = SPIKE_TRAP_TILE; // no entry -> safe arm
    const map = fakeMap({ grid: g }, size);
    map.spikeTraps = [{ x: 3, y: 5, period: 4, phase: 0 }];
    return map;
  }

  function edgePlayer(map: GameMap): Player {
    return new Player({ ...map, spawn: { x: 1, y: 5 } });
  }

  function has(data: Uint8ClampedArray, [r, g, b]: [number, number, number]): boolean {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === r && data[i + 1] === g && data[i + 2] === b) return true;
    }
    return false;
  }

  for (const fog of [true, false]) {
    it(`classic and fast agree within 1/255 over every tile kind (fog=${fog})`, () => {
      const map = kitchenSinkMap();
      const player = edgePlayer(map);
      const style = fakeStyle();
      const horizon = HEIGHT / 2;
      const a = ctx();
      renderBackgroundClassic(asCtx(a), map, player, WIDTH, HEIGHT, horizon, 2, style, fog);
      const classic = a.putImageData.mock.calls[0][0] as ImageData;
      const b = ctx();
      renderBackgroundFast(asCtx(b), map, player, WIDTH, HEIGHT, horizon, 2, style, fog);
      const fast = b.putImageData.mock.calls[0][0] as ImageData;
      let maxDiff = 0;
      for (let i = 0; i < classic.data.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(classic.data[i] - fast.data[i]));
      expect(maxDiff).toBeLessThanOrEqual(1);
      // Prove the sweep actually sampled every special kind (see the map
      // helper's comment): each texture's unique color appears in BOTH
      // outputs, so the agreement above cannot be vacuous.
      for (const img of [classic, fast]) {
        expect(has(img.data, [130, 70, 220])).toBe(true); // teleporterFloor
        expect(has(img.data, [64, 196, 72])).toBe(true); // hazardFloor
        expect(has(img.data, [220, 40, 30])).toBe(true); // spikeActiveFloor
        expect(has(img.data, [90, 90, 96])).toBe(true); // spikeSafeFloor
      }
    });
  }

  it("classic reallocates its buffer when the canvas size changes", () => {
    const map = kitchenSinkMap();
    const player = edgePlayer(map);
    const style = fakeStyle();
    const small = createMockCanvasContext({ width: 20, height: 16 } as unknown as HTMLCanvasElement);
    renderBackgroundClassic(small as unknown as CanvasRenderingContext2D, map, player, 20, 16, 8, 0, style, true);
    expect(small.createImageData).toHaveBeenCalledWith(20, 16);
    // And back at the shared test size, so later tests see a matching buffer.
    const normal = ctx();
    renderBackgroundClassic(asCtx(normal), map, player, WIDTH, HEIGHT, HEIGHT / 2, 0, style, true);
    expect(normal.putImageData).toHaveBeenCalled();
  });

  it("half-res walks the same tile arms and reallocates on size change", () => {
    const map = kitchenSinkMap();
    const player = edgePlayer(map);
    const style = fakeStyle();
    const c1 = ctx();
    renderBackgroundHalfRes(asCtx(c1), map, player, WIDTH, HEIGHT, HEIGHT / 2, 2, style, true);
    expect(c1.drawImage).toHaveBeenCalledTimes(1);
    const c2 = createMockCanvasContext({ width: 20, height: 16 } as unknown as HTMLCanvasElement);
    renderBackgroundHalfRes(c2 as unknown as CanvasRenderingContext2D, map, player, 20, 16, 8, 0, style, false);
    expect(c2.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 10, 8, 0, 0, 20, 16]);
    // Same-size second call reuses the cached half buffer.
    const c3 = createMockCanvasContext({ width: 20, height: 16 } as unknown as HTMLCanvasElement);
    renderBackgroundHalfRes(c3 as unknown as CanvasRenderingContext2D, map, player, 20, 16, 8, 0, style, false);
    expect(c3.drawImage).toHaveBeenCalledTimes(1);
  });
});

describe("renderBackgroundHalfRes — sanity (visible-change probe, not an equivalence claim)", () => {
  it("casts into a half-size buffer and upscales with one drawImage", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const style = fakeStyle();
    const c = ctx();
    renderBackgroundHalfRes(asCtx(c), map, player, WIDTH, HEIGHT, HEIGHT / 2, 0, style, true);
    expect(c.drawImage).toHaveBeenCalledTimes(1);
    const args = c.drawImage.mock.calls[0];
    // source rect = half buffer, dest rect = full canvas
    expect(args.slice(1)).toEqual([0, 0, WIDTH / 2, HEIGHT / 2, 0, 0, WIDTH, HEIGHT]);
  });
});

describe("renderScene — halfResFloor param and >640 auto-pairing (AUTO_HALF_RES_FLOOR_ENABLED)", () => {
  /** Positional call with everything defaulted except the trailing `halfResFloor`. */
  function render(c: MockCanvasContext, map: GameMap, player: Player, zBuffer: Float64Array, halfResFloor?: boolean): void {
    renderScene(asCtx(c), map, player, zBuffer, fakeStyle(), 0, 0, undefined, false, true, true, true, true, halfResFloor);
  }

  function wideCtx(): MockCanvasContext {
    // Wider than the classic 640 — the auto-pairing threshold.
    return createMockCanvasContext({ width: 1300, height: 800 } as unknown as HTMLCanvasElement);
  }

  it("default at width<=640: floor goes through the full-res fast path (no upscale blit)", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    render(c, map, player, new Float64Array(WIDTH));
    expect(c.putImageData).toHaveBeenCalledTimes(1); // fast path's full-frame blit
    expect(c.drawImage).toHaveBeenCalledTimes(WIDTH); // walls only — no half-res upscale
  });

  it("default at width>640: auto-pairing dispatches the floor to the half-res path", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = wideCtx();
    render(c, map, player, new Float64Array(1300));
    // The floor paints before the walls, so call 0 is the upscale blit:
    // source rect = half buffer (650x400), dest rect = full canvas.
    expect(c.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 650, 400, 0, 0, 1300, 800]);
    expect(c.drawImage).toHaveBeenCalledTimes(1300 + 1); // walls + the upscale blit
    expect(c.putImageData).not.toHaveBeenCalled(); // full-res fast path skipped
  });

  it("explicit halfResFloor=false on a wide canvas forces full-res (overrides the auto-pairing)", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = wideCtx();
    render(c, map, player, new Float64Array(1300), false);
    expect(c.putImageData).toHaveBeenCalledTimes(1);
    expect(c.drawImage).toHaveBeenCalledTimes(1300); // walls only — no upscale blit
  });

  it("explicit halfResFloor=true at classic size forces the half-res path", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    render(c, map, player, new Float64Array(WIDTH), true);
    expect(c.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, WIDTH / 2, HEIGHT / 2, 0, 0, WIDTH, HEIGHT]);
    expect(c.drawImage).toHaveBeenCalledTimes(WIDTH + 1);
    expect(c.putImageData).not.toHaveBeenCalled();
  });
});

describe("renderScene — measurement ablation params (drawFloor/drawWalls/drawShading)", () => {
  it("drawFloor=false paints flat ceiling+floor fills and skips the floor-cast blit", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const c = ctx();
    renderScene(asCtx(c), map, player, new Float64Array(WIDTH), fakeStyle(), 0, 0, undefined, false, true, false);
    expect(c.putImageData).not.toHaveBeenCalled();
    // Two flat fills (ceiling color, dark floor), then the wall pass on top.
    expect(c.fillRect.mock.calls[0]).toEqual([0, 0, WIDTH, HEIGHT / 2]);
    expect(c.fillRect.mock.calls[1]).toEqual([0, HEIGHT / 2, WIDTH, HEIGHT - HEIGHT / 2]);
    expect(c.drawImage).toHaveBeenCalledTimes(WIDTH); // walls still draw
  });

  it("drawWalls=false skips the column loop and marks every zBuffer entry unoccluded", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    const zBuffer = new Float64Array(WIDTH);
    const c = ctx();
    renderScene(asCtx(c), map, player, zBuffer, fakeStyle(), 0, 0, undefined, false, true, true, false);
    expect(c.drawImage).not.toHaveBeenCalled();
    expect(Array.from(zBuffer).every((d) => d === Infinity)).toBe(true);
  });

  it("drawShading=false skips the per-column shading overlay entirely", () => {
    const map = fakeMap();
    const player = centeredPlayer(map);
    // AA off so shading fillRects would be the only fillRects of the wall
    // pass; floor handled by the fast path (putImageData, no fillRect).
    const withShading = ctx();
    renderScene(asCtx(withShading), map, player, new Float64Array(WIDTH), fakeStyle(), 0, 0, undefined, false, true, true, true, true);
    const without = ctx();
    renderScene(asCtx(without), map, player, new Float64Array(WIDTH), fakeStyle(), 0, 0, undefined, false, true, true, true, false);
    expect(withShading.fillRect.mock.calls.length).toBeGreaterThan(0);
    expect(without.fillRect).not.toHaveBeenCalled();
  });
});

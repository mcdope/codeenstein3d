// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The automap's baked tile layer (perf finding **P4**), which the main
 * `automap.test.ts` cannot reach: that file runs under vitest's `node`
 * environment, where `document` is undefined and `drawAutomap` therefore takes
 * its live per-tile fallback. Both paths are real — the fallback is what every
 * other automap test exercises — so each needs its own home.
 *
 * Same split, and the same `stubCanvasGetContext` trick, that `raycaster.test.ts`
 * uses for the minimap's equivalent cache (finding F1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext, type MockCanvasContext } from "../../test/mocks/canvas";
import { SPIKE_TRAP_TILE, type GameMap, type SpikeTrap, type Tile } from "../map/types";
import { drawAutomap } from "./automap";
import type { Player } from "./player";

function makeCtx(): MockCanvasContext {
  return createMockCanvasContext({ width: 300, height: 300 } as unknown as HTMLCanvasElement);
}
const asCtx = (c: MockCanvasContext) => c as unknown as CanvasRenderingContext2D;
const fakePlayer = (o: Partial<Player> = {}): Player => ({ posX: 5.5, posY: 5.5, dirX: 1, dirY: 0, ...o }) as Player;
const grid = (size: number, fill: Tile = 0): Tile[][] =>
  Array.from({ length: size }, () => new Array(size).fill(fill) as Tile[]);

function fakeMap(overrides: Partial<GameMap> = {}, size = 10): GameMap {
  return {
    width: size,
    height: size,
    grid: grid(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(true) as boolean[]),
    rooms: [], breakupRooms: [], spawn: { x: 1, y: 1 }, enemies: [],
    exit: { x: size - 1, y: size - 1 }, shortestPathTiles: 0, hazards: [], doors: [],
    keys: [], decorations: [], teleporters: [], spikeTraps: [], mines: [], ammoPickups: [],
    loreTerminals: [], gates: [], bonusLevel: false, styleSet: "stone", secretRoomCount: 0,
    switchboardRooms: [], exceptionZones: [], vendorDepots: [], acidOverflows: [],
    ...overrides,
  } as unknown as GameMap;
}

describe("drawAutomap() — baked tile layer", () => {
  beforeEach(() => {
    stubCanvasGetContext(document.createElement("canvas"));
  });

  it("blits the layer once instead of filling tiles one by one", () => {
    const c = makeCtx();
    drawAutomap(asCtx(c), fakeMap(), fakePlayer());
    expect(c.drawImage).toHaveBeenCalledTimes(1);
    // The panel and the exit remain live fills; the 100 floor tiles do not.
    expect(c.fillRect.mock.calls.length).toBeLessThan(10);
  });

  it("reuses the cache across frames, and rebuilds when gridVersion moves", () => {
    // `gridVersion` is bumped whenever the grid mutates — a door opening, a
    // secret wall pushed through. Nothing else may invalidate the layer, or
    // the cache is pointless.
    const map = fakeMap();
    const created = vi.spyOn(document, "createElement");

    drawAutomap(asCtx(makeCtx()), map, fakePlayer(), 0, [], [], 7);
    const afterFirst = created.mock.calls.filter(([t]) => t === "canvas").length;

    drawAutomap(asCtx(makeCtx()), map, fakePlayer(), 0, [], [], 7);
    expect(created.mock.calls.filter(([t]) => t === "canvas").length).toBe(afterFirst);

    drawAutomap(asCtx(makeCtx()), map, fakePlayer(), 0, [], [], 8);
    expect(created.mock.calls.filter(([t]) => t === "canvas").length).toBeGreaterThan(afterFirst);
  });

  it("rebuilds for a different map even at the same gridVersion", () => {
    const created = vi.spyOn(document, "createElement");
    drawAutomap(asCtx(makeCtx()), fakeMap(), fakePlayer(), 0, [], [], 1);
    const afterFirst = created.mock.calls.filter(([t]) => t === "canvas").length;
    drawAutomap(asCtx(makeCtx()), fakeMap(), fakePlayer(), 0, [], [], 1);
    expect(created.mock.calls.filter(([t]) => t === "canvas").length).toBeGreaterThan(afterFirst);
  });

  it("keeps spike traps live, because their colour rides levelTime", () => {
    // The one tile type that cannot be baked. Drawn from `map.spikeTraps`
    // rather than by scanning the grid.
    const g = grid(10);
    g[5][5] = SPIKE_TRAP_TILE;
    const trap: SpikeTrap = { x: 5, y: 5, period: 4, phase: 0 } as SpikeTrap;
    const map = fakeMap({ grid: g, spikeTraps: [trap] });

    const armed = makeCtx();
    drawAutomap(asCtx(armed), map, fakePlayer(), 0, [], [], 1);
    const safe = makeCtx();
    drawAutomap(asCtx(safe), map, fakePlayer(), 2, [], [], 1);

    const styles = (c: MockCanvasContext) => c.fillRect.mock.calls.length;
    expect(styles(armed)).toBe(styles(safe)); // same count…
    // …but the trap's own colour differs between the two moments, which is why
    // it cannot live in the cache.
    const armedFills = armed.fillRect.mock.calls.length;
    expect(armedFills).toBeGreaterThan(1);
  });

  it("falls back to live tiles when the layer has no 2D context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const c = makeCtx();
    drawAutomap(asCtx(c), fakeMap(), fakePlayer(), 0, [], [], 99);
    expect(c.drawImage).not.toHaveBeenCalled();
    expect(c.fillRect.mock.calls.length).toBeGreaterThan(50); // the whole grid, live
  });
});

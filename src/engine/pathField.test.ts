// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { GameMap, Tile } from "../map/types";
import { PathField } from "./pathField";

function openGrid(size: number): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
}

function fakeMap(grid: Tile[][]): GameMap {
  return {
    width: grid[0]?.length ?? 0,
    height: grid.length,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn: { x: 1, y: 1 },
    enemies: [],
    exit: { x: 0, y: 0 },
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
  };
}

describe("PathField", () => {
  it("has distance 0 at the player's own tile", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    expect(pf.distAt(5, 5)).toBe(0);
  });

  it("increases distance by 1 per orthogonal step from the player", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    expect(pf.distAt(6, 5)).toBe(1);
    expect(pf.distAt(7, 5)).toBe(2);
  });

  it("returns -1 for an unreached (walled-off) tile", () => {
    const grid = openGrid(10);
    for (let y = 0; y < 10; y++) grid[y][5] = 1; // wall column splits the map
    const map = fakeMap(grid);
    const pf = new PathField();
    pf.ensure(map, 2, 5, 0);
    expect(pf.distAt(8, 5)).toBe(-1);
  });

  it("returns -1 for out-of-bounds coordinates", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    expect(pf.distAt(-1, 0)).toBe(-1);
    expect(pf.distAt(0, -1)).toBe(-1);
    expect(pf.distAt(10, 0)).toBe(-1);
    expect(pf.distAt(0, 10)).toBe(-1);
  });

  it("leaves the field entirely unreached when the player's own tile is a wall (noClip)", () => {
    const grid = openGrid(10);
    grid[5][5] = 1;
    const map = fakeMap(grid);
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    expect(pf.distAt(5, 5)).toBe(-1);
    expect(pf.distAt(6, 5)).toBe(-1);
  });

  it("does not reflood when the player's tile and grid version are unchanged", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    // Mutate the grid without bumping gridVersion — ensure() should skip
    // reflooding, so the stale distance from before the mutation remains.
    map.grid[5][6] = 1;
    pf.ensure(map, 5, 5, 0);
    expect(pf.distAt(6, 5)).toBe(1); // still the pre-mutation distance
  });

  it("refloods when the player moves to a different tile", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    pf.ensure(map, 2, 2, 0);
    expect(pf.distAt(2, 2)).toBe(0);
    expect(pf.distAt(5, 5)).toBe(6);
  });

  it("refloods when the grid version changes even if the player's tile didn't", () => {
    const map = fakeMap(openGrid(10));
    const pf = new PathField();
    pf.ensure(map, 5, 5, 0);
    map.grid[5][6] = 1; // wall off the immediate east neighbor
    pf.ensure(map, 5, 5, 1); // bump gridVersion
    expect(pf.distAt(6, 5)).toBe(-1); // now unreachable directly
  });

  it("reallocates and refloods when the map size changes", () => {
    const pf = new PathField();
    pf.ensure(fakeMap(openGrid(10)), 5, 5, 0);
    const bigMap = fakeMap(openGrid(20));
    pf.ensure(bigMap, 5, 5, 0);
    expect(pf.distAt(15, 5)).toBe(10);
  });
});

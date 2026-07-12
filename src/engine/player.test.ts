// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { GameMap, Tile } from "../map/types";
import { collidesWithWall, isHazard, isWall, Player } from "./player";

function fakeMap(grid: Tile[][], spawn = { x: 5, y: 5 }): GameMap {
  return {
    width: grid[0]?.length ?? 0,
    height: grid.length,
    grid,
    visited: [],
    rooms: [],
    breakupRooms: [],
    spawn,
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

function openGrid(size: number): Tile[][] {
  return Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
}

describe("Player", () => {
  it("spawns at the center of the map's spawn tile", () => {
    const map = fakeMap(openGrid(10), { x: 3, y: 4 });
    const player = new Player(map);
    expect(player.posX).toBe(3.5);
    expect(player.posY).toBe(4.5);
  });

  it("defaults radius to 0.2", () => {
    const map = fakeMap(openGrid(10));
    expect(new Player(map).radius).toBe(0.2);
  });

  it("accepts a custom radius", () => {
    const map = fakeMap(openGrid(10));
    expect(new Player(map, { radius: 0.4 }).radius).toBe(0.4);
  });

  it("rotate() turns the facing and plane vectors", () => {
    const map = fakeMap(openGrid(10));
    const player = new Player(map);
    player.rotate(Math.PI / 2);
    expect(player.dirX).toBeCloseTo(0, 10);
    expect(player.dirY).toBeCloseTo(1, 10);
  });

  it("moveForward() advances along the facing direction in open space", () => {
    const map = fakeMap(openGrid(20), { x: 10, y: 10 });
    const player = new Player(map);
    const before = { x: player.posX, y: player.posY };
    player.moveForward(1, map);
    expect(player.posX).toBeCloseTo(before.x + 1, 10);
    expect(player.posY).toBeCloseTo(before.y, 10);
  });

  it("moveForward() is blocked by a wall directly ahead", () => {
    const grid = openGrid(10);
    grid[5][6] = 1; // wall just east of spawn
    const map = fakeMap(grid, { x: 4, y: 4 });
    const player = new Player(map);
    player.posX = 5.5;
    player.posY = 5.5;
    player.moveForward(1, map); // facing +X by default
    expect(player.posX).toBeCloseTo(5.5, 5); // unchanged, blocked
  });

  it("strafe() moves perpendicular to facing without turning", () => {
    const map = fakeMap(openGrid(20), { x: 10, y: 10 });
    const player = new Player(map);
    const beforeDir = { x: player.dirX, y: player.dirY };
    player.strafe(1, map);
    expect(player.dirX).toBe(beforeDir.x);
    expect(player.dirY).toBe(beforeDir.y);
    expect(player.posY).toBeCloseTo(11.5, 10); // strafe right of facing +X is +Y
  });

  it("slides along a wall: one axis blocked, the other still moves", () => {
    const grid = openGrid(10);
    grid[5][6] = 1; // wall east of (5,5)
    const map = fakeMap(grid, { x: 4, y: 4 });
    const player = new Player(map);
    player.posX = 5.5;
    player.posY = 5.5;
    player.rotate(Math.PI / 4); // face diagonally into the wall
    const beforeY = player.posY;
    player.moveForward(1, map);
    // X axis should be blocked (or heavily constrained) while Y still moves.
    expect(player.posY).not.toBeCloseTo(beforeY, 5);
  });

  it("noClip bypasses wall collision entirely", () => {
    const grid = openGrid(10);
    grid[5][6] = 1;
    const map = fakeMap(grid, { x: 4, y: 4 });
    const player = new Player(map);
    player.posX = 5.5;
    player.posY = 5.5;
    player.noClip = true;
    player.moveForward(1, map);
    expect(player.posX).toBeCloseTo(6.5, 5);
  });
});

describe("collidesWithWall", () => {
  it("returns false in open space", () => {
    const map = fakeMap(openGrid(10));
    expect(collidesWithWall(map, 5.5, 5.5, 0.2)).toBe(false);
  });

  it("returns true when the box overlaps a wall cell", () => {
    const grid = openGrid(10);
    grid[5][6] = 1;
    const map = fakeMap(grid);
    expect(collidesWithWall(map, 6.1, 5.5, 0.3)).toBe(true);
  });

  it("checks every cell the radius spans, not just the center cell", () => {
    const grid = openGrid(10);
    grid[4][5] = 1; // diagonally adjacent to center cell (5,5)
    const map = fakeMap(grid);
    expect(collidesWithWall(map, 5.5, 5.1, 0.3)).toBe(true);
  });
});

describe("isWall", () => {
  it("treats out-of-bounds cells as solid", () => {
    const map = fakeMap(openGrid(5));
    expect(isWall(map, -1, 0)).toBe(true);
    expect(isWall(map, 0, -1)).toBe(true);
    expect(isWall(map, 5, 0)).toBe(true);
    expect(isWall(map, 0, 5)).toBe(true);
  });

  it("treats plain wall (1) as solid", () => {
    const grid = openGrid(5);
    grid[2][2] = 1;
    expect(isWall(fakeMap(grid), 2, 2)).toBe(true);
  });

  it("treats a door, secret wall, and lore terminal as solid", () => {
    const grid = openGrid(5);
    grid[1][1] = 3; // DOOR_TILE
    grid[1][2] = 6; // SECRET_WALL_TILE
    grid[1][3] = 7; // LORE_TILE
    const map = fakeMap(grid);
    expect(isWall(map, 1, 1)).toBe(true);
    expect(isWall(map, 2, 1)).toBe(true);
    expect(isWall(map, 3, 1)).toBe(true);
  });

  it("treats floor and hazard tiles as non-solid", () => {
    const grid = openGrid(5);
    grid[3][3] = 2; // HAZARD_TILE
    const map = fakeMap(grid);
    expect(isWall(map, 0, 0)).toBe(false);
    expect(isWall(map, 3, 3)).toBe(false);
  });
});

describe("isHazard", () => {
  it("returns false out of bounds", () => {
    const map = fakeMap(openGrid(5));
    expect(isHazard(map, -1, 0)).toBe(false);
    expect(isHazard(map, 5, 5)).toBe(false);
  });

  it("returns true only for a hazard tile", () => {
    const grid = openGrid(5);
    grid[2][2] = 2;
    const map = fakeMap(grid);
    expect(isHazard(map, 2, 2)).toBe(true);
    expect(isHazard(map, 0, 0)).toBe(false);
  });
});

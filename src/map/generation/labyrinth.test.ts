// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Room, Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { carveLabyrinth, MAZE_THRESHOLD } from "./labyrinth";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

/** True if every floor tile inside `room` is reachable from every other —
 * the invariant carveLabyrinth's own doc comment guarantees. */
function isFullyConnected(g: Tile[][], room: Room): boolean {
  const floorTiles: string[] = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (g[y][x] === 0) floorTiles.push(`${x},${y}`);
    }
  }
  if (floorTiles.length === 0) return true;

  const visited = new Set<string>();
  const stack = [floorTiles[0]];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const [x, y] = cur.split(",").map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < room.x || nx >= room.x + room.w || ny < room.y || ny >= room.y + room.h) continue;
      if (g[ny][nx] !== 0) continue;
      stack.push(`${nx},${ny}`);
    }
  }
  return visited.size === floorTiles.length;
}

describe("carveLabyrinth", () => {
  it("leaves a room fully connected after carving a maze", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 14, 14, entity());
    carveRoom(g, room);
    carveLabyrinth(g, room, 6, mulberry32(1));
    expect(isFullyConnected(g, room)).toBe(true);
  });

  it("is deterministic for the same rng seed", () => {
    const g1 = grid(20);
    const g2 = grid(20);
    const room = makeRoom(1, 1, 14, 14, entity());
    carveRoom(g1, room);
    carveRoom(g2, room);
    carveLabyrinth(g1, room, 4, mulberry32(99));
    carveLabyrinth(g2, room, 4, mulberry32(99));
    expect(g1).toEqual(g2);
  });

  it("adds walls (a real maze) for a nesting depth at/above MAZE_THRESHOLD", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 14, 14, entity());
    carveRoom(g, room);
    carveLabyrinth(g, room, MAZE_THRESHOLD + 2, mulberry32(5));
    let wallCount = 0;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (g[y][x] === 1) wallCount++;
      }
    }
    expect(wallCount).toBeGreaterThan(0);
  });

  it("does nothing (stays fully open) at nesting depth 0", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    carveLabyrinth(g, room, 0, mulberry32(1));
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        expect(g[y][x]).toBe(0);
      }
    }
  });

  it("caps the recursion budget at 6 even for a very deep nesting depth", () => {
    const gShallow = grid(20);
    const gDeep = grid(20);
    const room = makeRoom(1, 1, 16, 16, entity());
    carveRoom(gShallow, room);
    carveRoom(gDeep, room);
    carveLabyrinth(gShallow, room, 6, mulberry32(3));
    carveLabyrinth(gDeep, room, 50, mulberry32(3));
    expect(gShallow).toEqual(gDeep);
  });

  it("handles a room too small to split on either axis without error", () => {
    const g = grid(10);
    const room = makeRoom(1, 1, 2, 2, entity());
    carveRoom(g, room);
    expect(() => carveLabyrinth(g, room, 6, mulberry32(1))).not.toThrow();
    expect(isFullyConnected(g, room)).toBe(true);
  });

  it("handles a room splittable on only one axis (narrow strip)", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 2, 10, entity());
    carveRoom(g, room);
    expect(() => carveLabyrinth(g, room, 6, mulberry32(2))).not.toThrow();
    expect(isFullyConnected(g, room)).toBe(true);
  });

  it("handles a square room where horizontal/vertical choice is rng-tied", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 8, 8, entity());
    carveRoom(g, room);
    carveLabyrinth(g, room, 4, mulberry32(4));
    expect(isFullyConnected(g, room)).toBe(true);
  });
});

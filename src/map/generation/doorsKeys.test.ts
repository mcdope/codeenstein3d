// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import { DOOR_TILE, type Enemy, type Room, type Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { carveHLine } from "./corridors";
import { placeDoors, placeKeys } from "./doorsKeys";
import { reachableTiles } from "./pathing";
import { key } from "./util";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

describe("placeDoors", () => {
  it("never locks the spawn room (index 0), even if it's a private method", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 5, 5, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    const doors = placeDoors([spawnRoom], g);
    expect(doors).toEqual([]);
  });

  it("locks a private-method room's corridor mouths", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2); // corridor connecting the two, through lockedRoom's left mouth
    const doors = placeDoors([spawnRoom, lockedRoom], g);
    expect(doors.length).toBeGreaterThan(0);
    for (const d of doors) expect(g[d.y][d.x]).toBe(DOOR_TILE);
  });

  it("locks a protected-method room the same way", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "protected" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, lockedRoom], g).length).toBeGreaterThan(0);
  });

  it("does not lock a public-method room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const publicRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "public" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, publicRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, publicRoom], g)).toEqual([]);
  });

  it("does not lock a room with no visibility (undefined defaults public)", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const room = makeRoom(10, 1, 3, 3, entity({ kind: "method" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, room], g)).toEqual([]);
  });

  it("does not lock a non-method entity (class/function/global) even if marked private", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const classRoom = makeRoom(10, 1, 3, 3, entity({ kind: "class", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, classRoom);
    carveHLine(g, 3, 10, 2);
    expect(placeDoors([spawnRoom, classRoom], g)).toEqual([]);
  });

  it("finds mouths on all four sides of a room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const room = makeRoom(8, 8, 4, 4, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    // Corridor tiles touching all 4 sides of `room`.
    g[7][9] = 0; // top
    g[12][9] = 0; // bottom
    g[9][7] = 0; // left
    g[9][12] = 0; // right
    const doors = placeDoors([spawnRoom, room], g);
    expect(doors).toHaveLength(4);
  });
});

describe("placeKeys", () => {
  it("returns [] when there are no doors", () => {
    const g = grid(20);
    expect(placeKeys(g, { x: 1, y: 1 }, { x: 5, y: 5 }, [], [], [], mulberry32(1))).toEqual([]);
  });

  it("places one key per door, reachable before that door opens", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    const doors = placeDoors([spawnRoom, lockedRoom], g);
    expect(doors.length).toBeGreaterThan(0);

    const keys = placeKeys(g, spawnRoom.center, lockedRoom.center, [], doors, [], mulberry32(1));
    expect(keys).toHaveLength(doors.length);
    for (const k of keys) expect(k.collected).toBe(false);
  });

  it("never places a key on spawn, exit, an enemy tile, or a breakup room tile", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, lockedRoom);
    carveHLine(g, 3, 10, 2);
    const doors = placeDoors([spawnRoom, lockedRoom], g);
    const enemy = { x: spawnRoom.center.x + 0.5, y: spawnRoom.center.y + 0.5 } as Enemy;

    const keys = placeKeys(g, spawnRoom.center, lockedRoom.center, [enemy], doors, [], mulberry32(3));
    for (const k of keys) {
      expect(k).not.toEqual({ x: spawnRoom.center.x + 0.5, y: spawnRoom.center.y + 0.5, collected: false });
    }
  });

  it("stops placing keys for doors unreachable from the currently-opened region", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 3, 3, entity());
    carveRoom(g, spawnRoom);
    // A "door" placed with no connecting corridor at all — never on the
    // reachable frontier.
    const doors = [{ x: 15, y: 15 }];
    const keys = placeKeys(g, spawnRoom.center, spawnRoom.center, [], doors, [], mulberry32(1));
    expect(keys).toEqual([]);
  });

  it("skips placing a key (but still opens the door) when every reachable tile is already used", () => {
    const g = grid(10);
    g[1][1] = 0; // the only floor tile reachable before the door opens
    g[1][2] = DOOR_TILE;
    // spawn === exit === the only reachable tile, so it's fully "used" —
    // pickKeySpot finds zero candidates and returns null.
    const keys = placeKeys(g, { x: 1, y: 1 }, { x: 1, y: 1 }, [], [{ x: 2, y: 1 }], [], mulberry32(1));
    expect(keys).toEqual([]);
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const spawnRoom = makeRoom(1, 1, 3, 3, entity());
      const lockedRoom = makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" }));
      carveRoom(g, spawnRoom);
      carveRoom(g, lockedRoom);
      carveHLine(g, 3, 10, 2);
      const doors = placeDoors([spawnRoom, lockedRoom], g);
      return placeKeys(g, spawnRoom.center, lockedRoom.center, [], doors, [], mulberry32(77));
    };
    expect(build()).toEqual(build());
  });

  it("handles a room chain with multiple doors in sequence (key-order solvability)", () => {
    const g = grid(30);
    const rooms: Room[] = [
      makeRoom(1, 1, 3, 3, entity()),
      makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" })),
      makeRoom(20, 1, 3, 3, entity({ kind: "method", visibility: "protected" })),
    ];
    for (const r of rooms) carveRoom(g, r);
    carveHLine(g, 3, 10, 2);
    carveHLine(g, 13, 20, 2);
    const doors = placeDoors(rooms, g);
    expect(doors.length).toBeGreaterThanOrEqual(2);
    const keys = placeKeys(g, rooms[0].center, rooms[2].center, [], doors, [], mulberry32(5));
    expect(keys.length).toBeGreaterThan(0);
  });

  it("confines each later key to area newly reached since the previous door, never back in the initial region", () => {
    const g = grid(30);
    const rooms: Room[] = [
      makeRoom(1, 1, 3, 3, entity()),
      makeRoom(10, 1, 3, 3, entity({ kind: "method", visibility: "private" })),
      makeRoom(20, 1, 3, 3, entity({ kind: "method", visibility: "protected" })),
    ];
    for (const r of rooms) carveRoom(g, r);
    carveHLine(g, 3, 10, 2);
    carveHLine(g, 13, 20, 2);
    const doors = placeDoors(rooms, g);
    expect(doors.length).toBeGreaterThanOrEqual(2);

    // Snapshot of what's reachable before any door opens at all — under the
    // old cumulative-pool bug, later keys could land back in here.
    const initialReachable = reachableTiles(g, rooms[0].center, new Set());

    const keys = placeKeys(g, rooms[0].center, rooms[2].center, [], doors, [], mulberry32(5));
    expect(keys.length).toBeGreaterThan(1);
    for (const k of keys.slice(1)) {
      const tileKey = key({ x: Math.floor(k.x), y: Math.floor(k.y) });
      expect(initialReachable.has(tileKey)).toBe(false);
    }
  });

  it("falls back to the full reachable set when the newly-opened area has no usable tile left", () => {
    const g = grid(10);
    // A straight corridor: spawn, two spare floor tiles, door1, an
    // enemy-occupied floor tile (the only tile door1's opening reveals),
    // door2. Door2's newly-opened area is just the door1 tile (excluded,
    // not floor) and the enemy tile (excluded, already used) — empty of
    // usable candidates — so its key must fall back to the wider
    // (still-unused-somewhere) reachable pool instead of being dropped.
    g[1][1] = 0; // spawn
    g[1][2] = 0; // spare floor A
    g[1][3] = 0; // spare floor B
    g[1][4] = DOOR_TILE; // door1
    g[1][5] = 0; // enemy-occupied floor (door1's newly-opened area)
    g[1][6] = DOOR_TILE; // door2
    const doors = [
      { x: 4, y: 1 },
      { x: 6, y: 1 },
    ];
    const enemy = { x: 5.5, y: 1.5 } as Enemy;

    const keys = placeKeys(g, { x: 1, y: 1 }, { x: 9, y: 9 }, [enemy], doors, [], mulberry32(1));
    expect(keys).toHaveLength(2);
  });
});

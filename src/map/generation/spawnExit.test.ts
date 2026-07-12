// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { CodeEntity } from "../../parser/types";
import { makeRoom } from "./geometry";
import { pickExit, pickSafeSpawn } from "./spawnExit";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

describe("pickSafeSpawn", () => {
  it("returns the default corner for zero rooms", () => {
    expect(pickSafeSpawn([])).toEqual({ x: 1, y: 1 });
  });

  it("returns the first candidate corner when there are no enemy-bearing rooms", () => {
    const room = makeRoom(1, 1, 8, 8, entity({ kind: "class" }));
    expect(pickSafeSpawn([room])).toEqual({ x: room.x + 1, y: room.y + 1 });
  });

  it("picks the corner farthest from the nearest enemy room center", () => {
    const spawnRoom = makeRoom(1, 1, 10, 10, entity({ kind: "class" }));
    // An enemy room whose center sits near spawnRoom's top-left corner —
    // the bottom-right corner should be picked instead.
    const enemyRoom = makeRoom(2, 2, 2, 2, entity({ kind: "function" }));
    const spawn = pickSafeSpawn([spawnRoom, enemyRoom]);
    expect(spawn).toEqual({ x: spawnRoom.x + spawnRoom.w - 2, y: spawnRoom.y + spawnRoom.h - 2 });
  });

  it("treats a method-kind room as enemy-bearing too", () => {
    const spawnRoom = makeRoom(1, 1, 10, 10, entity({ kind: "class" }));
    const enemyRoom = makeRoom(2, 2, 2, 2, entity({ kind: "method" }));
    const spawn = pickSafeSpawn([spawnRoom, enemyRoom]);
    expect(spawn).toEqual({ x: spawnRoom.x + spawnRoom.w - 2, y: spawnRoom.y + spawnRoom.h - 2 });
  });

  it("only considers rooms[0]'s own corners, regardless of how many other rooms exist", () => {
    const spawnRoom = makeRoom(1, 1, 6, 6, entity({ kind: "class" }));
    const other = makeRoom(20, 20, 6, 6, entity({ kind: "function" }));
    const spawn = pickSafeSpawn([spawnRoom, other]);
    const isOneOfSpawnRoomCorners = [
      { x: spawnRoom.x + 1, y: spawnRoom.y + 1 },
      { x: spawnRoom.x + spawnRoom.w - 2, y: spawnRoom.y + 1 },
      { x: spawnRoom.x + 1, y: spawnRoom.y + spawnRoom.h - 2 },
      { x: spawnRoom.x + spawnRoom.w - 2, y: spawnRoom.y + spawnRoom.h - 2 },
    ].some((c) => c.x === spawn.x && c.y === spawn.y);
    expect(isOneOfSpawnRoomCorners).toBe(true);
  });
});

describe("pickExit", () => {
  it("returns the spawn point for zero rooms", () => {
    expect(pickExit([], { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it("picks the room center furthest from spawn", () => {
    const near = makeRoom(1, 1, 4, 4, entity());
    const far = makeRoom(50, 50, 4, 4, entity());
    const exit = pickExit([near, far], { x: 1, y: 1 });
    expect(exit).toEqual(far.center);
  });

  it("returns rooms[0]'s center when there's only one room", () => {
    const room = makeRoom(10, 10, 4, 4, entity());
    expect(pickExit([room], { x: 1, y: 1 })).toEqual(room.center);
  });

  it("keeps the first room found on an exact distance tie", () => {
    const a = makeRoom(1, 1, 4, 4, entity()); // center (3, 3)
    const b = makeRoom(1, 17, 4, 4, entity()); // center (3, 19) — mirrors `a` around spawn.y=11
    const spawn = { x: 1, y: 11 };
    const exit = pickExit([a, b], spawn);
    expect(exit).toEqual(a.center);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { CodeEntity } from "../../parser/types";
import { makeRoom } from "./geometry";
import { pickExit, pickMultiplayerSpawns, pickSafeSpawn } from "./spawnExit";

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

describe("pickMultiplayerSpawns", () => {
  it("returns the exit point itself for zero rooms", () => {
    expect(pickMultiplayerSpawns([], { x: 5, y: 5 }, 3)).toEqual([{ x: 5, y: 5 }]);
  });

  it("returns [] when count is 0", () => {
    const room = makeRoom(1, 1, 2, 2, entity()); // center (2, 2)
    expect(pickMultiplayerSpawns([room], { x: 99, y: 99 }, 0)).toEqual([]);
  });

  it("returns the single room's safe corner when there's exactly one eligible room", () => {
    // Non-enemy-bearing (no function/method room at all) — every 2x2 room's
    // own first corner candidate {x+1,y+1} coincidentally equals its center,
    // so this stays a simple "just the one room" case, distinct from the
    // enemy-avoidance behavior covered by its own describe block below.
    const room = makeRoom(1, 1, 2, 2, entity({ kind: "class" })); // center (2, 2) == first corner candidate
    expect(pickMultiplayerSpawns([room], { x: 99, y: 99 }, 1)).toEqual([room.center]);
  });

  it("excludes the exit's own tile from the candidate pool", () => {
    const room = makeRoom(1, 1, 2, 2, entity({ kind: "class" })); // center (2, 2) == first corner candidate
    expect(pickMultiplayerSpawns([room], { x: 2, y: 2 }, 1)).toEqual([]);
  });

  it("greedily disperses picks by maximizing distance from the exit and from each other", () => {
    // Non-enemy-bearing, same "corner coincides with center" 2x2 shape as
    // above — isolates the dispersion logic from the corner-selection logic.
    const a = makeRoom(1, 1, 2, 2, entity({ kind: "class" })); // center (2, 2)
    const b = makeRoom(19, 1, 2, 2, entity({ kind: "class" })); // center (20, 2)
    const c = makeRoom(10, 1, 2, 2, entity({ kind: "class" })); // center (11, 2)
    const exit = { x: 2, y: 20 };
    // First pick maximizes raw distance to the exit -> b (farthest at (20,2)).
    // Second pick maximizes the *minimum* of (distance to exit, distance to b)
    // among the remainder -> a, since c sits close to b while a doesn't.
    const spawns = pickMultiplayerSpawns([a, b, c], exit, 2);
    expect(spawns).toEqual([b.center, a.center]);
  });

  it("returns fewer than count points when there aren't enough eligible rooms, without padding or duplicates", () => {
    const a = makeRoom(1, 1, 2, 2, entity({ kind: "class" }));
    const b = makeRoom(19, 1, 2, 2, entity({ kind: "class" }));
    const spawns = pickMultiplayerSpawns([a, b], { x: 99, y: 99 }, 5);
    expect(spawns).toHaveLength(2);
    expect(spawns).toEqual(expect.arrayContaining([a.center, b.center]));
  });

  it("only ever returns points drawn from each room's own four corner candidates", () => {
    const rooms = [makeRoom(1, 1, 4, 4, entity()), makeRoom(10, 10, 4, 4, entity()), makeRoom(30, 5, 4, 4, entity())];
    const cornersOf = (r: (typeof rooms)[number]): { x: number; y: number }[] => [
      { x: r.x + 1, y: r.y + 1 },
      { x: r.x + r.w - 2, y: r.y + 1 },
      { x: r.x + 1, y: r.y + r.h - 2 },
      { x: r.x + r.w - 2, y: r.y + r.h - 2 },
    ];
    const allCorners = rooms.flatMap(cornersOf);
    const spawns = pickMultiplayerSpawns(rooms, { x: 99, y: 99 }, 3);
    for (const s of spawns) expect(allCorners).toContainEqual(s);
  });

  it("avoids a room's own anchor enemy (its first pack member always spawns dead center — enemyPositions) by picking a far corner instead of the room's center", () => {
    // A real bug this fixes: `enemyPositions` anchors a room's first enemy
    // at the exact room center — the same point this function used to
    // return outright, landing a real player on top of an already-aggroed
    // enemy from tick one. w=8,h=8 so the center and every corner are
    // clearly distinct (unlike the 2x2 rooms above).
    const room = makeRoom(1, 1, 8, 8, entity()); // function-kind: enemy-bearing, center (5, 5)
    const spawns = pickMultiplayerSpawns([room], { x: 99, y: 99 }, 1);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).not.toEqual(room.center);
  });

  it("picks whichever room's corner is farthest from the nearest enemy room center, same spirit as pickSafeSpawn", () => {
    const spawnRoom = makeRoom(1, 1, 10, 10, entity({ kind: "class" }));
    // An enemy room whose center sits near spawnRoom's top-left corner —
    // the bottom-right corner should be picked instead.
    const enemyRoom = makeRoom(2, 2, 2, 2, entity({ kind: "function" }));
    // count=2 (both rooms) so the assertion doesn't depend on which of the
    // two the dispersion pass happens to favor first.
    const spawns = pickMultiplayerSpawns([spawnRoom, enemyRoom], { x: 99, y: 99 }, 2);
    expect(spawns).toContainEqual({ x: spawnRoom.x + spawnRoom.w - 2, y: spawnRoom.y + spawnRoom.h - 2 });
  });
});

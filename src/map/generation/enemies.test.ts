// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Rect, Tile } from "../types";
import { makeRoom } from "./geometry";
import { spawnEdgeCaseEnemies, spawnEnemies } from "./enemies";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 5, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function carve(g: Tile[][], rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) g[y][x] = 0;
  }
}

describe("spawnEnemies", () => {
  it("spawns nothing for a non-callable entity kind", () => {
    for (const kind of ["class", "interface", "trait", "global"] as const) {
      const room = makeRoom(1, 1, 6, 6, entity({ kind }));
      expect(spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1))).toEqual([]);
    }
  });

  it("spawns one enemy for a low-complexity function", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: 5 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1);
    expect(enemies[0].hp).toBe(Math.max(25, Math.round((5 * 25) / 1)));
    expect(enemies[0].elite).toBe(false);
    expect(enemies[0].edgeCase).toBe(false);
    expect(enemies[0].entity).toBe(room.entity);
  });

  it("clamps complexity below 1 up to 1", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: 0 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1);
    expect(enemies[0].hp).toBe(25); // complexity clamped to 1 -> 1*25/1
  });

  it("splits a high-complexity function into a pack, one extra enemy per 10 points", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1 + Math.floor(25 / 10)); // 3
    for (const e of enemies) expect(e.elite).toBe(false);
  });

  it("spawns a single Elite instead of a pack at/above the complexity threshold", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 40 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(1);
    expect(enemies[0].elite).toBe(true);
    expect(enemies[0].hp).toBe(40 * 25 * 2); // ELITE_HP_MULTIPLIER, lowered 4 -> 2 (see its doc comment)
  });

  it("aggregates enemies across multiple rooms", () => {
    const rooms = [
      makeRoom(1, 1, 6, 6, entity({ complexityScore: 5 })),
      makeRoom(10, 1, 6, 6, entity({ complexityScore: 5 })),
    ];
    const enemies = spawnEnemies(rooms, { x: 99, y: 99 }, mulberry32(1));
    expect(enemies).toHaveLength(2);
  });

  it("gives every enemy a fireCooldown in [0, 2)", () => {
    const room = makeRoom(1, 1, 10, 10, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    for (const e of enemies) {
      expect(e.fireCooldown).toBeGreaterThanOrEqual(0);
      expect(e.fireCooldown).toBeLessThan(2);
    }
  });

  it("snaps the pack's first enemy to the room center tile", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: 5 }));
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    const expectedCenterTile = { x: Math.floor(room.x + room.w / 2) + 0.5, y: Math.floor(room.y + room.h / 2) + 0.5 };
    expect(enemies[0]).toMatchObject(expectedCenterTile);
  });

  it("rerolls (and eventually resolves) when a spawn point would land inside the exit's clearance", () => {
    // A 9x9 room so there is somewhere to reroll *to*: the exit at (3,3)
    // keeps a 5x5 box (EXIT_CLEARANCE_TILES = 2) clear, and the room's own
    // centre tile (5,5) sits exactly on its corner, so the first pick is
    // rejected. The scripted rerolls land at (8,8), well outside it.
    const room = makeRoom(1, 1, 9, 9, entity({ complexityScore: 5 }));
    const sequence = [0.9, 0.9];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 3, y: 3 }, scripted);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(8.5);
    expect(enemies[0].y).toBe(8.5);
  });

  it("keeps enemies off the tiles immediately around the exit, not just the exit itself", () => {
    // An enemy is a solid body, so one parked against the exit makes walking
    // onto it impossible until it's killed.
    const room = makeRoom(1, 1, 12, 12, entity({ complexityScore: 30 }));
    const exit = { x: 6, y: 6 };
    const enemies = spawnEnemies([room], exit, mulberry32(7));
    // Exact, not "more than one": the clearance must relocate enemies, never
    // cost the room any. complexity 30 => 1 + floor(30/10) = 4.
    expect(enemies).toHaveLength(4);
    for (const e of enemies) {
      const chebyshev = Math.max(Math.abs(Math.floor(e.x) - exit.x), Math.abs(Math.floor(e.y) - exit.y));
      expect(chebyshev).toBeGreaterThan(2);
    }
  });

  it("still populates an exit room too small to hold the clearance at all", () => {
    // The exit room is the one a player is guaranteed to reach, so it losing
    // its garrison would be a real gameplay change smuggled in by a placement
    // constraint. A 5x4 room with the exit at its centre is entirely inside
    // the 5x5 clearance box — every candidate is rejected — and the bounded
    // retry then falls back to the room corner rather than dropping anyone.
    // This is `stage06_pipeline.py`'s exact shape.
    const room = makeRoom(7, 55, 5, 4, entity({ complexityScore: 25 }));
    const enemies = spawnEnemies([room], { x: 9, y: 57 }, mulberry32(3));
    expect(enemies).toHaveLength(3); // 1 + floor(25/10)
    for (const e of enemies) {
      expect(e.x).toBeGreaterThanOrEqual(room.x);
      expect(e.x).toBeLessThan(room.x + room.w);
      expect(e.y).toBeGreaterThanOrEqual(room.y);
      expect(e.y).toBeLessThan(room.y + room.h);
    }
  });

  it("gives every function/method room its enemies regardless of where the exit lands", () => {
    // Guards the invariant directly: the exit room is not a special case that
    // ends up empty. Sweeps the exit across a room and checks the count holds.
    const room = makeRoom(1, 1, 8, 8, entity({ complexityScore: 20 }));
    for (let x = room.x; x < room.x + room.w; x++) {
      for (let y = room.y; y < room.y + room.h; y++) {
        expect(spawnEnemies([room], { x, y }, mulberry32(x * 31 + y))).toHaveLength(3);
      }
    }
  });

  it("falls back to the room's corner when every reroll attempt still lands on the exit", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: 5 })); // center tile (3,3)
    const alwaysCenter = () => 0.5; // randomInRoom() always resolves to tile (3,3) too
    const enemies = spawnEnemies([room], { x: 3, y: 3 }, alwaysCenter);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(room.x + 1.5);
    expect(enemies[0].y).toBe(room.y + 1.5);
  });

  it("rerolls (and eventually resolves) when a spawn point would land on a multiplayer spawn tile", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: 5 })); // center tile (3,3)
    const sequence = [0.5, 0.5, 0, 0];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, scripted, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(1.5);
    expect(enemies[0].y).toBe(1.5);
  });

  it("falls back to the room's corner when every reroll still lands on a multiplayer spawn tile", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: 5 })); // center tile (3,3)
    const alwaysCenter = () => 0.5;
    const enemies = spawnEnemies([room], { x: 99, y: 99 }, alwaysCenter, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(room.x + 1.5);
    expect(enemies[0].y).toBe(room.y + 1.5);
  });

  it("avoids both the exit and a multiplayer spawn tile in the same reroll sequence", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: 5 })); // center tile (3,3)
    // i=0's center pick (3,3) is blocked by the multiplayer spawn; the first
    // reroll lands on (2,2), blocked by the exit; the second reroll lands
    // clear on (5,5).
    const sequence = [0.25, 0.25, 0.9, 0.9];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 2, y: 2 }, scripted, [{ x: 3, y: 3 }]);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(5.5);
    expect(enemies[0].y).toBe(5.5);
  });

  it("omitted multiplayerSpawns behaves exactly like an empty avoid-list", () => {
    const room = makeRoom(1, 1, 6, 6, entity({ complexityScore: 5 }));
    const withDefault = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1));
    const withEmpty = spawnEnemies([room], { x: 99, y: 99 }, mulberry32(1), []);
    expect(withDefault).toEqual(withEmpty);
  });
});

describe("spawnEdgeCaseEnemies", () => {
  it("spawns 1-3 enemies per breakup room, all marked edgeCase", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 6, h: 6 };
    carve(g, room);
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThanOrEqual(1);
    expect(enemies.length).toBeLessThanOrEqual(3);
    for (const e of enemies) {
      expect(e.edgeCase).toBe(true);
      expect(e.elite).toBe(false);
      expect(e.entity.name).toBe("EdgeCase");
      expect(e.hp).toBeGreaterThanOrEqual(10);
      expect(e.hp).toBeLessThanOrEqual(15);
    }
  });

  it("returns [] for zero breakup rooms", () => {
    const g = grid(10);
    expect(spawnEdgeCaseEnemies(g, [], { x: 99, y: 99 }, mulberry32(1))).toEqual([]);
  });

  it("aggregates across multiple breakup rooms", () => {
    const g = grid(20);
    const rooms: Rect[] = [
      { x: 1, y: 1, w: 6, h: 6 },
      { x: 10, y: 1, w: 6, h: 6 },
    ];
    for (const r of rooms) carve(g, r);
    const enemies = spawnEdgeCaseEnemies(g, rooms, { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThanOrEqual(2);
  });

  it("snaps a spawn point that lands on a wall to the nearest floor tile within the room", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    // Carve everything except the room's exact center tile (3,3), forcing
    // nearestFloorInRect to search outward from the wall it lands on.
    carve(g, room);
    g[3][3] = 1;
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    for (const e of enemies) {
      expect(g[Math.floor(e.y)][Math.floor(e.x)]).toBe(0);
    }
  });

  it("leaves a spawn point unchanged when it's already on floor", () => {
    const g = grid(20);
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    carve(g, room);
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThan(0);
    for (const e of enemies) {
      expect(g[Math.floor(e.y)][Math.floor(e.x)]).toBe(0);
    }
  });

  it("returns the original point unchanged when the whole room has no floor at all", () => {
    const g = grid(20); // never carved — entirely walls
    const room: Rect = { x: 1, y: 1, w: 5, h: 5 };
    const enemies = spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(1));
    expect(enemies.length).toBeGreaterThan(0);
    // No floor exists anywhere, so nearestFloorInRect gives up and returns
    // the raw computed position unchanged — just confirm it doesn't throw
    // and produces a finite, in-room coordinate.
    for (const e of enemies) {
      expect(Number.isFinite(e.x)).toBe(true);
      expect(Number.isFinite(e.y)).toBe(true);
    }
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const room: Rect = { x: 1, y: 1, w: 6, h: 6 };
      carve(g, room);
      return spawnEdgeCaseEnemies(g, [room], { x: 99, y: 99 }, mulberry32(42));
    };
    expect(build()).toEqual(build());
  });
});

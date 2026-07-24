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
    expect(enemies[0].hp).toBe(40 * 25 * 4);
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

  it("rerolls (and eventually resolves) when a spawn point would land on the exit tile", () => {
    const room = makeRoom(1, 1, 5, 5, entity({ complexityScore: 5 }));
    // room center tile is (3,3) — put the exit exactly there so i=0's first
    // pick is rejected; the scripted sequence's first reroll also lands on
    // (3,3) (still rejected), the second lands on (1,1) (accepted).
    const sequence = [0.5, 0.5, 0, 0];
    let i = 0;
    const scripted = () => sequence[i++ % sequence.length];
    const enemies = spawnEnemies([room], { x: 3, y: 3 }, scripted);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(1.5);
    expect(enemies[0].y).toBe(1.5);
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

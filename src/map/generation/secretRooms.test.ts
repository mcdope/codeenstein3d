// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity, SecretTrigger } from "../../parser/types";
import { SECRET_WALL_TILE, type Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { placeSecretRooms } from "./secretRooms";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 10, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function trigger(overrides: Partial<SecretTrigger> = {}): SecretTrigger {
  return { kind: "deadCode", startLine: 5, endLine: 5, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function countSecretWallTiles(g: Tile[][]): number {
  let count = 0;
  for (const row of g) for (const t of row) if (t === SECRET_WALL_TILE) count++;
  return count;
}

describe("placeSecretRooms", () => {
  it("returns no loot for zero triggers", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity());
    carveRoom(g, room);
    const result = placeSecretRooms([room], g, 30, [], mulberry32(1), false, []);
    expect(result.secretLoot).toEqual([]);
  });

  it("carves a secret room and places one loot item for a single trigger with ample space", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    const result = placeSecretRooms([room], g, 30, [trigger({ startLine: 5 })], mulberry32(1), false, []);
    expect(result.secretLoot).toHaveLength(1);
    expect(result.secretLoot[0].collected).toBe(false);
    expect(countSecretWallTiles(g)).toBeGreaterThan(0);
  });

  it("caps the number of secret rooms at MAX_SECRET_ROOMS (5), even with many triggers on distinct anchors", () => {
    const g = grid(60);
    const rooms = Array.from({ length: 8 }, (_, i) =>
      makeRoom(2 + i * 7, 2, 5, 5, entity({ startLine: i * 10 + 1, endLine: i * 10 + 5 })),
    );
    for (const r of rooms) carveRoom(g, r);
    const triggers = rooms.map((_, i) => trigger({ startLine: i * 10 + 2 }));
    const result = placeSecretRooms(rooms, g, 60, triggers, mulberry32(1), false, []);
    expect(result.secretLoot.length).toBeLessThanOrEqual(5);
  });

  it("places at most one secret room per anchor room, even with multiple triggers on it", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    const triggers = [trigger({ startLine: 3 }), trigger({ startLine: 5 }), trigger({ startLine: 8 })];
    const result = placeSecretRooms([room], g, 30, triggers, mulberry32(1), false, []);
    expect(result.secretLoot).toHaveLength(1);
  });

  it("falls back to rooms[0] as the anchor when no room contains the trigger's line", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 5 }));
    carveRoom(g, room);
    const result = placeSecretRooms([room], g, 30, [trigger({ startLine: 999 })], mulberry32(1), false, []);
    expect(result.secretLoot).toHaveLength(1);
  });

  it("skips a trigger whose anchor room has no free space on any side", () => {
    const g = grid(12);
    // Room fills nearly the entire tiny map — no room for a secret room
    // patch (plus its 1-tile clearance buffer) on any of its 4 sides.
    const room = makeRoom(1, 1, 10, 10, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    const result = placeSecretRooms([room], g, 12, [trigger({ startLine: 5 })], mulberry32(1), false, []);
    expect(result.secretLoot).toEqual([]);
  });

  it("never rolls a rockets loot kind when there's no rocket launcher owned", () => {
    const g = grid(60);
    const rooms = Array.from({ length: 5 }, (_, i) => makeRoom(2 + i * 10, 2, 5, 5, entity({ startLine: i * 10 + 1, endLine: i * 10 + 5 })));
    for (const r of rooms) carveRoom(g, r);
    const triggers = rooms.map((_, i) => trigger({ startLine: i * 10 + 2 }));
    const result = placeSecretRooms(rooms, g, 60, triggers, mulberry32(2), false, []);
    expect(result.secretLoot.every((l) => l.kind !== "rockets")).toBe(true);
  });

  it("never rolls a weapon loot kind when missingWeaponIndices is empty", () => {
    const g = grid(60);
    const rooms = Array.from({ length: 5 }, (_, i) => makeRoom(2 + i * 10, 2, 5, 5, entity({ startLine: i * 10 + 1, endLine: i * 10 + 5 })));
    for (const r of rooms) carveRoom(g, r);
    const triggers = rooms.map((_, i) => trigger({ startLine: i * 10 + 2 }));
    const result = placeSecretRooms(rooms, g, 60, triggers, mulberry32(2), true, []);
    expect(result.secretLoot.every((l) => l.kind !== "weapon")).toBe(true);
  });

  it("can roll a rockets loot kind when a rocket launcher is owned", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    // Force the final "choice" draw to pick the last candidate (index 2 of
    // [health, swap, rockets]) by scripting every draw to a high value —
    // shuffle's Fisher-Yates draws don't depend on absolute value ordering
    // in a way that breaks this, and the final Math.floor(rng()*len) pick
    // does land on the last index for any rng close to (but under) 1.
    const highRng = () => 0.999;
    const result = placeSecretRooms([room], g, 30, [trigger({ startLine: 5 })], highRng, true, []);
    expect(result.secretLoot).toHaveLength(1);
    expect(result.secretLoot[0].kind).toBe("rockets");
  });

  it("can roll a weapon loot kind (and picks from missingWeaponIndices) when some are missing", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    const highRng = () => 0.999;
    const result = placeSecretRooms([room], g, 30, [trigger({ startLine: 5 })], highRng, false, [7, 12]);
    expect(result.secretLoot).toHaveLength(1);
    expect(result.secretLoot[0].kind).toBe("weapon");
    expect([7, 12]).toContain(result.secretLoot[0].weaponIndex);
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(30);
      const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
      carveRoom(g, room);
      return placeSecretRooms([room], g, 30, [trigger({ startLine: 5 })], mulberry32(9), false, []);
    };
    expect(build()).toEqual(build());
  });

  it("skips a candidate side whose wall tile isn't actually solid rock (e.g. bordering another corridor)", () => {
    const g = grid(30);
    const room = makeRoom(10, 10, 5, 5, entity({ startLine: 1, endLine: 20 }));
    carveRoom(g, room);
    // Carve floor along the room's entire top edge exterior, so every "top"
    // candidate wall tile fails the grid[wall] === 1 check; only the other
    // 3 sides remain viable.
    for (let x = room.x - 1; x <= room.x + room.w; x++) g[room.y - 1][x] = 0;
    const result = placeSecretRooms([room], g, 30, [trigger({ startLine: 5 })], mulberry32(4), false, []);
    expect(result.secretLoot).toHaveLength(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { CodeEntity } from "../../parser/types";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type Enemy,
  type Room,
  type Tile,
} from "../types";
import { makeRoom } from "./geometry";
import { ACID_OVERFLOW_ENABLED, allocationDensity, isAllocationDense, planAcidOverflows } from "./acidOverflow";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 20, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function carve(g: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
  }
}

function enemyFor(room: Room): Enemy {
  return {
    x: room.center.x + 0.5,
    y: room.center.y + 0.5,
    hp: 50,
    maxHp: 50,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: room.x, y: room.y, w: room.w, h: room.h },
    aggroed: false,
    discovered: false,
    roamX: room.center.x + 0.5,
    roamY: room.center.y + 0.5,
    fireCooldown: 0,
    entity: room.entity,
    elite: false,
    edgeCase: false,
  };
}

/** A spawn room at index 0 plus one leaky function room with its own enemy. */
function leakySetup(overrides: Partial<CodeEntity> = {}) {
  const size = 32;
  const g = grid(size);
  const spawnRoom = makeRoom(2, 2, 4, 4, entity({ name: "spawn" }));
  const leaky = makeRoom(12, 12, 6, 6, entity({ name: "leaky", startLine: 10, endLine: 30, allocations: 6, ...overrides }));
  carve(g, spawnRoom);
  carve(g, leaky);
  return { g, rooms: [spawnRoom, leaky], leaky, enemies: [enemyFor(leaky)] };
}

describe("ACID_OVERFLOW_ENABLED", () => {
  it("is on by default", () => {
    expect(ACID_OVERFLOW_ENABLED).toBe(true);
  });
});

describe("allocationDensity", () => {
  it("is allocations per line of the entity's own span", () => {
    expect(allocationDensity(entity({ startLine: 1, endLine: 10, allocations: 5 }))).toBeCloseTo(0.5);
  });

  it("is 0 for an entity that allocates nothing", () => {
    expect(allocationDensity(entity({ startLine: 1, endLine: 10 }))).toBe(0);
  });

  it("treats a single-line entity as spanning one line, never zero", () => {
    expect(allocationDensity(entity({ startLine: 7, endLine: 7, allocations: 2 }))).toBe(2);
  });
});

describe("isAllocationDense", () => {
  it("accepts a function that allocates often across a real span", () => {
    expect(isAllocationDense(entity({ startLine: 1, endLine: 40, allocations: 6 }))).toBe(true);
  });

  it("rejects a short helper with one incidental allocation, however dense", () => {
    // Density alone would pass (1 alloc / 3 lines = 0.33), the absolute floor
    // is what stops it.
    expect(isAllocationDense(entity({ startLine: 1, endLine: 3, allocations: 1 }))).toBe(false);
  });

  it("rejects a huge module with a handful of allocations spread thin", () => {
    // Count alone would pass, the density gate is what stops it.
    expect(isAllocationDense(entity({ startLine: 1, endLine: 1000, allocations: 5 }))).toBe(false);
  });

  it("rejects an entity that allocates nothing at all", () => {
    expect(isAllocationDense(entity({ startLine: 1, endLine: 40 }))).toBe(false);
  });
});

describe("planAcidOverflows", () => {
  it("plans an overflow for an allocation-dense function's room", () => {
    const { g, rooms, enemies } = leakySetup();
    const plans = planAcidOverflows(rooms, g, enemies, new Set());
    expect(plans).toHaveLength(1);
    expect(plans[0].tiles.length).toBeGreaterThan(0);
    expect(plans[0].intervalSeconds).toBeGreaterThan(0);
  });

  it("points at the enemy spawned for that exact entity, by identity", () => {
    const { g, rooms, leaky, enemies } = leakySetup();
    // A same-named enemy for a *different* entity object must not be matched.
    const decoy = enemyFor(makeRoom(24, 24, 3, 3, entity({ name: "leaky", allocations: 6 })));
    const plans = planAcidOverflows(rooms, g, [decoy, ...enemies], new Set());
    expect(plans[0].enemyIndex).toBe(1);
    expect([decoy, ...enemies][plans[0].enemyIndex].entity).toBe(leaky.entity);
  });

  it("skips a leaky room whose function has no enemy — nothing would stop it", () => {
    const { g, rooms } = leakySetup();
    expect(planAcidOverflows(rooms, g, [], new Set())).toEqual([]);
  });

  it("never floods the spawn room", () => {
    const size = 32;
    const g = grid(size);
    const spawnRoom = makeRoom(12, 12, 6, 6, entity({ name: "spawn", startLine: 10, endLine: 30, allocations: 6 }));
    carve(g, spawnRoom);
    expect(planAcidOverflows([spawnRoom], g, [enemyFor(spawnRoom)], new Set())).toEqual([]);
  });

  it("ignores a class room even if its aggregated allocation count is high", () => {
    const { g, rooms, enemies } = leakySetup({ kind: "class" });
    expect(planAcidOverflows(rooms, g, enemies, new Set())).toEqual([]);
  });

  it("plans nothing for a function that doesn't allocate densely", () => {
    const { g, rooms, enemies } = leakySetup({ allocations: 1 });
    expect(planAcidOverflows(rooms, g, enemies, new Set())).toEqual([]);
  });

  it("caps at three overflow rooms per level", () => {
    const size = 64;
    const g = grid(size);
    const rooms: Room[] = [makeRoom(2, 2, 4, 4, entity({ name: "spawn" }))];
    carve(g, rooms[0]);
    for (let i = 0; i < 6; i++) {
      const room = makeRoom(10 + (i % 3) * 16, 10 + Math.floor(i / 3) * 20, 6, 6, entity({ name: `leaky${i}`, startLine: 10 + i * 40, endLine: 40 + i * 40, allocations: 8 }));
      carve(g, room);
      rooms.push(room);
    }
    const enemies = rooms.slice(1).map(enemyFor);
    expect(planAcidOverflows(rooms, g, enemies, new Set())).toHaveLength(3);
  });

  it("only ever lists plain-floor tiles — never a door, pad, spike, secret or existing acid", () => {
    const { g, rooms, leaky, enemies } = leakySetup();
    const claimed: Tile[] = [DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE, HAZARD_TILE];
    claimed.forEach((tile, i) => {
      g[leaky.y + 1][leaky.x + i] = tile;
    });
    const plans = planAcidOverflows(rooms, g, enemies, new Set());
    for (const tile of plans[0].tiles) expect(g[tile.y][tile.x]).toBe(0);
    expect(plans[0].tiles.length).toBe(leaky.w * leaky.h - claimed.length);
  });

  it("skips tiles reserved by systems that leave the grid as plain floor", () => {
    // Mines and keys both sit on tile 0, so the grid test alone can't see them.
    const { g, rooms, leaky, enemies } = leakySetup();
    const mineTile = { x: leaky.x + 2, y: leaky.y + 2 };
    const plans = planAcidOverflows(rooms, g, enemies, new Set([`${mineTile.x},${mineTile.y}`]));
    expect(plans[0].tiles).not.toContainEqual(mineTile);
  });

  it("orders tiles outward from the room centre, nearest first", () => {
    const { g, rooms, leaky, enemies } = leakySetup();
    const plans = planAcidOverflows(rooms, g, enemies, new Set());
    const cx = leaky.x + Math.floor(leaky.w / 2);
    const cy = leaky.y + Math.floor(leaky.h / 2);
    const distances = plans[0].tiles.map((t) => Math.abs(t.x - cx) + Math.abs(t.y - cy));
    // Non-decreasing: BFS from the centre can't reach a farther tile before a
    // nearer one.
    for (let i = 1; i < distances.length; i++) expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
  });

  it("stays inside the room's own rectangle", () => {
    const { g, rooms, leaky, enemies } = leakySetup();
    for (const tile of planAcidOverflows(rooms, g, enemies, new Set())[0].tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(leaky.x);
      expect(tile.x).toBeLessThan(leaky.x + leaky.w);
      expect(tile.y).toBeGreaterThanOrEqual(leaky.y);
      expect(tile.y).toBeLessThan(leaky.y + leaky.h);
    }
  });

  it("still plans a flood when the room's centre tile itself is blocked", () => {
    // A pillar on the centre must not cut the spread short — the walk orders
    // tiles by distance from the centre, it doesn't trace a flow through it.
    const { g, rooms, leaky, enemies } = leakySetup();
    g[leaky.y + Math.floor(leaky.h / 2)][leaky.x + Math.floor(leaky.w / 2)] = 1;
    const plans = planAcidOverflows(rooms, g, enemies, new Set());
    expect(plans[0].tiles.length).toBe(leaky.w * leaky.h - 1);
  });

  it("plans nothing for a room with no claimable floor at all", () => {
    const { g, rooms, leaky, enemies } = leakySetup();
    for (let y = leaky.y; y < leaky.y + leaky.h; y++) {
      for (let x = leaky.x; x < leaky.x + leaky.w; x++) g[y][x] = 1;
    }
    expect(planAcidOverflows(rooms, g, enemies, new Set())).toEqual([]);
  });

  it("floods a leakier function faster, floored so no room is unsurvivable", () => {
    const sparse = leakySetup({ startLine: 10, endLine: 60, allocations: 5 });
    const dense = leakySetup({ startLine: 10, endLine: 20, allocations: 40 });
    const sparseInterval = planAcidOverflows(sparse.rooms, sparse.g, sparse.enemies, new Set())[0].intervalSeconds;
    const denseInterval = planAcidOverflows(dense.rooms, dense.g, dense.enemies, new Set())[0].intervalSeconds;
    expect(denseInterval).toBeLessThan(sparseInterval);
    expect(denseInterval).toBeGreaterThanOrEqual(0.6);
    expect(sparseInterval).toBeLessThanOrEqual(2);
  });

  it("is deterministic and draws no randomness at all", () => {
    // The signature takes no rng on purpose — this is what lets the pass be
    // appended at the very end of `generate()` without shifting any earlier
    // draw. Running it twice on identical input must be byte-identical.
    const a = leakySetup();
    const b = leakySetup();
    expect(planAcidOverflows(a.rooms, a.g, a.enemies, new Set())).toEqual(
      planAcidOverflows(b.rooms, b.g, b.enemies, new Set()),
    );
  });

  it("writes nothing to the grid", () => {
    const { g, rooms, enemies } = leakySetup();
    const before = g.map((row) => [...row]);
    planAcidOverflows(rooms, g, enemies, new Set());
    expect(g).toEqual(before);
  });
});

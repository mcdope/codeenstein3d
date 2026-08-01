// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import { DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, SPIKE_TRAP_TILE, TELEPORTER_TILE, type Room, type Tile } from "../types";
import { makeRoom } from "./geometry";
import { placeVendorDepots, VENDOR_DEPOTS_ENABLED } from "./vendorDepots";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

/** All-solid grid; the spawn room below is the only carved space, so every
 * side of it is free rock — the best case for depot placement. */
function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function spawnRoom(): Room {
  return makeRoom(10, 10, 6, 6, entity());
}

function carve(g: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) g[y][x] = 0;
  }
}

/** Wraps an rng so a test can assert a code path drew nothing at all. */
function countingRng(seed: number): { rng: () => number; calls: () => number } {
  const inner = mulberry32(seed);
  let calls = 0;
  return {
    rng: () => {
      calls += 1;
      return inner();
    },
    calls: () => calls,
  };
}

describe("VENDOR_DEPOTS_ENABLED", () => {
  it("is on by default", () => {
    expect(VENDOR_DEPOTS_ENABLED).toBe(true);
  });
});

describe("placeVendorDepots", () => {
  it("carves one depot per four top-level imports", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { depots } = placeVendorDepots(room, g, 32, 8, mulberry32(1), true, true, true);
    expect(depots).toHaveLength(2);
  });

  it("caps at four depots however long the import block is", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { depots } = placeVendorDepots(room, g, 32, 400, mulberry32(2), true, true, true);
    expect(depots).toHaveLength(4);
  });

  it("places nothing — and draws no rng at all — below the import threshold", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { rng, calls } = countingRng(3);
    const result = placeVendorDepots(room, g, 32, 3, rng, true, true, true);
    expect(result).toEqual({ depots: [], pickups: [] });
    expect(calls()).toBe(0);
  });

  it("stocks each depot with at least one pickup", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { depots, pickups } = placeVendorDepots(room, g, 32, 16, mulberry32(4), true, true, true);
    expect(depots.length).toBeGreaterThan(0);
    expect(pickups.length).toBeGreaterThanOrEqual(depots.length);
    expect(pickups.every((p) => p.collected === false)).toBe(true);
    expect(pickups.every((p) => p.amount > 0)).toBe(true);
  });

  it("stocks a 2x2 depot twice and a 1x1 depot once", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { depots, pickups } = placeVendorDepots(room, g, 32, 400, mulberry32(5), true, true, true);
    const expected = depots.reduce((sum, d) => sum + (d.w >= 2 ? 2 : 1), 0);
    expect(pickups).toHaveLength(expected);
  });

  it("only stocks bullets when the player owns none of the other weapons", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { pickups } = placeVendorDepots(room, g, 32, 400, mulberry32(6), false, false, false);
    expect(pickups.length).toBeGreaterThan(0);
    expect(pickups.every((p) => p.kind === "bullets")).toBe(true);
  });

  it("can stock smg and gas once those weapons are owned", () => {
    const g = grid(48);
    const room = makeRoom(16, 16, 10, 10, entity());
    carve(g, room);
    // Sampled across seeds: the stock pick is uniform over the four available
    // kinds, so a single seed proves availability rather than distribution.
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const fresh = grid(48);
      carve(fresh, room);
      const { pickups } = placeVendorDepots(room, fresh, 48, 400, mulberry32(seed), true, true, true);
      for (const p of pickups) kinds.add(p.kind);
    }
    expect(kinds.has("smg")).toBe(true);
    expect(kinds.has("gas")).toBe(true);
  });

  it("carves the doorway open so every depot connects to the spawn room", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    const { depots } = placeVendorDepots(room, g, 32, 16, mulberry32(7), true, true, true);
    expect(depots.length).toBeGreaterThan(0);
    for (const depot of depots) {
      for (let y = depot.y; y < depot.y + depot.h; y++) {
        for (let x = depot.x; x < depot.x + depot.w; x++) expect(g[y][x]).toBe(0);
      }
    }
    // Flood fill from the spawn room's center must reach every depot tile.
    const seen = new Set<string>();
    const queue = [{ x: room.center.x, y: room.center.y }];
    while (queue.length > 0) {
      const p = queue.pop()!;
      const key = `${p.x},${p.y}`;
      if (seen.has(key) || g[p.y]?.[p.x] !== 0) continue;
      seen.add(key);
      queue.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
    }
    for (const depot of depots) expect(seen.has(`${depot.x},${depot.y}`)).toBe(true);
  });

  it("never overwrites a tile another system already claimed", () => {
    const g = grid(32);
    const room = spawnRoom();
    carve(g, room);
    // Ring the room with every claimed tile type. All of them fail the
    // "connecting tile is untouched rock" test, so nothing can be carved.
    const claimed: Tile[] = [DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE];
    let i = 0;
    for (let x = room.x - 1; x <= room.x + room.w; x++) {
      g[room.y - 1][x] = claimed[i++ % claimed.length];
      g[room.y + room.h][x] = claimed[i++ % claimed.length];
    }
    for (let y = room.y - 1; y <= room.y + room.h; y++) {
      g[y][room.x - 1] = claimed[i++ % claimed.length];
      g[y][room.x + room.w] = claimed[i++ % claimed.length];
    }
    const before = g.map((row) => [...row]);
    const { depots, pickups } = placeVendorDepots(room, g, 32, 400, mulberry32(8), true, true, true);
    expect(depots).toEqual([]);
    expect(pickups).toEqual([]);
    expect(g).toEqual(before);
  });

  it("returns empty instead of throwing when the map has no free rock at all", () => {
    const size = 12;
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 0 as Tile));
    const room = makeRoom(2, 2, 4, 4, entity());
    expect(() => placeVendorDepots(room, g, size, 400, mulberry32(9), true, true, true)).not.toThrow();
    expect(placeVendorDepots(room, g, size, 400, mulberry32(9), true, true, true)).toEqual({ depots: [], pickups: [] });
  });

  it("returns empty when the spawn room sits flush against the map border", () => {
    // Every candidate footprint would fall outside the 1-tile border margin.
    const size = 8;
    const g = grid(size);
    const room = makeRoom(1, 1, size - 2, size - 2, entity());
    carve(g, room);
    expect(placeVendorDepots(room, g, size, 400, mulberry32(10), true, true, true)).toEqual({ depots: [], pickups: [] });
  });

  it("is deterministic for the same rng seed", () => {
    const run = () => {
      const g = grid(32);
      const room = spawnRoom();
      carve(g, room);
      return placeVendorDepots(room, g, 32, 16, mulberry32(42), true, true, true);
    };
    expect(run()).toEqual(run());
  });

  it("produces different layouts for different seeds", () => {
    const run = (seed: number) => {
      const g = grid(32);
      const room = spawnRoom();
      carve(g, room);
      return placeVendorDepots(room, g, 32, 16, mulberry32(seed), true, true, true);
    };
    expect(run(1)).not.toEqual(run(999));
  });
});

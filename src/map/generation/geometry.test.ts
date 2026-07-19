// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Enemy, Room, Tile } from "../types";
import {
  carveRoom,
  centeredRoom,
  clearCriticalTiles,
  findPropSpot,
  makeRoom,
  roomDimensions,
  roomForLine,
  roomsOverlap,
} from "./geometry";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

describe("roomDimensions", () => {
  it("scales width with complexity and height with line span", () => {
    const small = roomDimensions(entity({ complexityScore: 1, startLine: 1, endLine: 1 }), 30);
    const bigger = roomDimensions(entity({ complexityScore: 10, startLine: 1, endLine: 20 }), 30);
    expect(bigger.w).toBeGreaterThan(small.w);
    expect(bigger.h).toBeGreaterThan(small.h);
  });

  it("grows with nesting depth", () => {
    const flat = roomDimensions(entity({ nestingDepth: 0 }), 30);
    const nested = roomDimensions(entity({ nestingDepth: 3 }), 30);
    expect(nested.w).toBeGreaterThan(flat.w);
    expect(nested.h).toBeGreaterThan(flat.h);
  });

  it("never goes below the 4-tile floor", () => {
    const dims = roomDimensions(entity({ complexityScore: 0, startLine: 1, endLine: 1, nestingDepth: 0 }), 30);
    expect(dims.w).toBeGreaterThanOrEqual(4);
    expect(dims.h).toBeGreaterThanOrEqual(4);
  });

  it("caps at size-2 (or 18, whichever is smaller)", () => {
    const dims = roomDimensions(entity({ complexityScore: 1000, nestingDepth: 50 }), 12);
    expect(dims.w).toBeLessThanOrEqual(10);
    expect(dims.h).toBeLessThanOrEqual(10);
  });

  it("caps at 18 even on a huge map", () => {
    const dims = roomDimensions(entity({ complexityScore: 1000, nestingDepth: 50 }), 200);
    expect(dims.w).toBeLessThanOrEqual(18);
    expect(dims.h).toBeLessThanOrEqual(18);
  });
});

describe("makeRoom", () => {
  it("computes a floor-divided center", () => {
    const room = makeRoom(2, 3, 5, 4, entity());
    expect(room.center).toEqual({ x: 4, y: 5 });
  });

  it("carries the entity through", () => {
    const e = entity({ name: "carried" });
    expect(makeRoom(0, 0, 4, 4, e).entity).toBe(e);
  });
});

describe("centeredRoom", () => {
  it("centers an 8x8 (or smaller) room on the map", () => {
    const room = centeredRoom(entity(), 30);
    expect(room.w).toBe(8);
    expect(room.h).toBe(8);
    expect(room.x).toBe(11);
    expect(room.y).toBe(11);
  });

  it("shrinks to fit a small map", () => {
    const room = centeredRoom(entity(), 6);
    expect(room.w).toBeLessThanOrEqual(4);
  });

  it("uses the given entity when provided", () => {
    const e = entity({ name: "real" });
    expect(centeredRoom(e, 30).entity).toBe(e);
  });

  it("falls back to a synthetic <entry> placeholder when no entity is given", () => {
    const room = centeredRoom(undefined, 30);
    expect(room.entity.name).toBe("<entry>");
    expect(room.entity.kind).toBe("class");
  });
});

describe("roomsOverlap", () => {
  it("detects a direct overlap", () => {
    expect(roomsOverlap({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 }, 0)).toBe(true);
  });

  it("returns false for rects that don't touch", () => {
    expect(roomsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 10, y: 10, w: 2, h: 2 }, 0)).toBe(false);
  });

  it("counts adjacency as overlap once margin is applied", () => {
    expect(roomsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }, 0)).toBe(false);
    expect(roomsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }, 1)).toBe(true);
  });
});

describe("carveRoom", () => {
  it("clears every tile within the room's footprint to floor", () => {
    const g = grid(10);
    const room: Room = makeRoom(2, 2, 3, 3, entity());
    carveRoom(g, room);
    for (let y = 2; y < 5; y++) {
      for (let x = 2; x < 5; x++) {
        expect(g[y][x]).toBe(0);
      }
    }
    expect(g[0][0]).toBe(1);
  });
});

describe("clearCriticalTiles", () => {
  it("clears spawn, exit, and every enemy tile", () => {
    const g = grid(10);
    const enemy = { x: 5.5, y: 6.5 } as Enemy;
    clearCriticalTiles(g, { x: 1, y: 1 }, { x: 8, y: 8 }, [enemy]);
    expect(g[1][1]).toBe(0);
    expect(g[8][8]).toBe(0);
    expect(g[6][5]).toBe(0);
  });

  it("clears every multiplayer spawn tile too", () => {
    const g = grid(10);
    const enemy = { x: 5.5, y: 6.5 } as Enemy;
    const multiplayerSpawns = [{ x: 2, y: 3 }, { x: 4, y: 7 }];
    clearCriticalTiles(g, { x: 1, y: 1 }, { x: 8, y: 8 }, [enemy], multiplayerSpawns);
    expect(g[1][1]).toBe(0);
    expect(g[8][8]).toBe(0);
    expect(g[6][5]).toBe(0);
    expect(g[3][2]).toBe(0);
    expect(g[7][4]).toBe(0);
  });

  it("omitted multiplayerSpawns behaves exactly like an empty array", () => {
    const withDefault = grid(10);
    const withEmpty = grid(10);
    const enemy = { x: 5.5, y: 6.5 } as Enemy;
    clearCriticalTiles(withDefault, { x: 1, y: 1 }, { x: 8, y: 8 }, [enemy]);
    clearCriticalTiles(withEmpty, { x: 1, y: 1 }, { x: 8, y: 8 }, [enemy], []);
    expect(withDefault).toEqual(withEmpty);
  });
});

describe("findPropSpot", () => {
  it("finds an open tile clear of the room center and avoid/placed lists", () => {
    const g = grid(10);
    const room = makeRoom(1, 1, 6, 6, entity());
    carveRoom(g, room);
    const spot = findPropSpot(room, g, [], [], mulberry32(1));
    expect(spot).not.toBeNull();
  });

  it("returns null when every candidate is on a wall", () => {
    const g = grid(10); // everything stays a wall (never carved)
    const room = makeRoom(1, 1, 6, 6, entity());
    const spot = findPropSpot(room, g, [], [], mulberry32(1));
    expect(spot).toBeNull();
  });

  it("rejects a candidate too close to the room's own center, then succeeds on retry", () => {
    const g = grid(10);
    const room = makeRoom(1, 1, 6, 6, entity()); // center = (4, 4)
    carveRoom(g, room);
    // First attempt's rng draws land exactly on the center (rejected by the
    // PROP_CLEARANCE-from-center check); second attempt's draws land clear.
    const sequence = [0.5, 0.5, 0, 0];
    let i = 0;
    const scriptedRng = () => sequence[i++ % sequence.length];
    const spot = findPropSpot(room, g, [], [], scriptedRng);
    expect(spot).toEqual({ x: 2, y: 2 });
  });

  it("rejects a candidate too close to an avoid point, then succeeds on retry", () => {
    const g = grid(12);
    const room = makeRoom(1, 1, 8, 8, entity()); // center = (5, 5)
    carveRoom(g, room);
    // First attempt lands on (2,2), right next to the avoid point (2.5,2.5);
    // second attempt lands on the far corner (7,7), clear of both center and
    // avoid.
    const sequence = [0, 0, 0.99, 0.99];
    let i = 0;
    const scriptedRng = () => sequence[i++ % sequence.length];
    const spot = findPropSpot(room, g, [{ x: 2.5, y: 2.5 }], [], scriptedRng);
    expect(spot).toEqual({ x: 7, y: 7 });
  });

  it("avoids points too close to already-placed props", () => {
    const g = grid(10);
    const room = makeRoom(1, 1, 6, 6, entity());
    carveRoom(g, room);
    const placed = [{ x: 3, y: 3 }];
    const spot = findPropSpot(room, g, [], placed, mulberry32(3));
    if (spot) {
      const dx = spot.x + 0.5 - (placed[0].x + 0.5);
      const dy = spot.y + 0.5 - (placed[0].y + 0.5);
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(1.8);
    }
  });
});

describe("roomForLine", () => {
  it("returns the room whose entity contains the line", () => {
    const room = makeRoom(0, 0, 4, 4, entity({ startLine: 5, endLine: 15 }));
    expect(roomForLine([room], 10)).toBe(room);
  });

  it("returns undefined when no room contains the line", () => {
    const room = makeRoom(0, 0, 4, 4, entity({ startLine: 5, endLine: 15 }));
    expect(roomForLine([room], 100)).toBeUndefined();
  });

  it("picks the most specific (smallest span) containing room, e.g. a method over its class", () => {
    const classRoom = makeRoom(0, 0, 4, 4, entity({ name: "C", kind: "class", startLine: 1, endLine: 100 }));
    const methodRoom = makeRoom(10, 10, 4, 4, entity({ name: "m", kind: "method", startLine: 40, endLine: 50 }));
    const found = roomForLine([classRoom, methodRoom], 45);
    expect(found).toBe(methodRoom);
  });

  it("returns undefined for an empty room list", () => {
    expect(roomForLine([], 5)).toBeUndefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import { DOOR_TILE, type Enemy, type Room, type Tile } from "../types";
import {
  carveRect,
  doorwayTiles,
  carveRoom,
  centeredRoom,
  clearCriticalTiles,
  connectorTiles,
  findPropSpot,
  sideCandidateFits,
  sideCandidates,
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

  it("keeps the already-found most-specific room when a later, less-specific room also contains the line", () => {
    const classRoom = makeRoom(0, 0, 4, 4, entity({ name: "C", kind: "class", startLine: 1, endLine: 100 }));
    const methodRoom = makeRoom(10, 10, 4, 4, entity({ name: "m", kind: "method", startLine: 40, endLine: 50 }));
    // Reverse order from the test above: the smaller-span room arrives first,
    // so picking it must survive a later, larger-span room still containing the line.
    const found = roomForLine([methodRoom, classRoom], 45);
    expect(found).toBe(methodRoom);
  });

  it("returns undefined for an empty room list", () => {
    expect(roomForLine([], 5)).toBeUndefined();
  });
});

describe("sideCandidates", () => {
  const anchor = { x: 10, y: 10, w: 4, h: 4 };

  it("offers one candidate per perimeter tile on each of the four sides", () => {
    const candidates = sideCandidates(anchor, 2, 2, 0);
    // 4 tiles along the top + 4 along the bottom + 4 left + 4 right.
    expect(candidates).toHaveLength(16);
    expect(new Set(candidates.map((c) => c.side))).toEqual(new Set(["top", "bottom", "left", "right"]));
  });

  it("puts the doorway on the anchor's own wall ring, never inside the room", () => {
    for (const c of sideCandidates(anchor, 2, 2, 0)) {
      const insideX = c.wall.x >= anchor.x && c.wall.x < anchor.x + anchor.w;
      const insideY = c.wall.y >= anchor.y && c.wall.y < anchor.y + anchor.h;
      expect(insideX && insideY).toBe(false);
    }
  });

  it("starts the footprint one tile past the doorway, never overlapping it", () => {
    for (const c of sideCandidates(anchor, 2, 2, 0)) {
      const overlapsDoor =
        c.wall.x >= c.x0 && c.wall.x <= c.x1 && c.wall.y >= c.y0 && c.wall.y <= c.y1;
      expect(overlapsDoor).toBe(false);
    }
  });

  it("pushes the footprint further out as offset grows", () => {
    const near = sideCandidates(anchor, 2, 2, 0).find((c) => c.side === "top")!;
    const far = sideCandidates(anchor, 2, 2, 3).find((c) => c.side === "top")!;
    expect(far.y1).toBe(near.y1 - 3);
  });

  it("sizes the footprint to the requested width and height on every side", () => {
    for (const c of sideCandidates(anchor, 3, 5, 1)) {
      expect(c.x1 - c.x0 + 1).toBe(3);
      expect(c.y1 - c.y0 + 1).toBe(5);
    }
  });
});

describe("sideCandidateFits", () => {
  const anchor = { x: 10, y: 10, w: 4, h: 4 };

  function rockGrid(size: number): Tile[][] {
    return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
  }

  it("accepts a candidate surrounded entirely by untouched rock", () => {
    const g = rockGrid(32);
    const c = sideCandidates(anchor, 2, 2, 0).find((x) => x.side === "top")!;
    expect(sideCandidateFits(c, g, 32)).toBe(true);
  });

  it("rejects a candidate whose doorway tile is already claimed", () => {
    const g = rockGrid(32);
    const c = sideCandidates(anchor, 2, 2, 0).find((x) => x.side === "top")!;
    g[c.wall.y][c.wall.x] = 0;
    expect(sideCandidateFits(c, g, 32)).toBe(false);
  });

  it("rejects a candidate whose footprint would leave the map border", () => {
    const g = rockGrid(32);
    const edgeAnchor = { x: 1, y: 1, w: 4, h: 4 };
    const c = sideCandidates(edgeAnchor, 3, 3, 0).find((x) => x.side === "top")!;
    expect(sideCandidateFits(c, g, 32)).toBe(false);
  });

  it("rejects a candidate whose one-tile margin touches something already carved", () => {
    const g = rockGrid(32);
    const c = sideCandidates(anchor, 2, 2, 0).find((x) => x.side === "top")!;
    // Just outside the footprint, inside the margin ring.
    g[c.y0 - 1][c.x0] = 0;
    expect(sideCandidateFits(c, g, 32)).toBe(false);
  });

  it("rejects a candidate whose connector would cut through carved space", () => {
    const g = rockGrid(32);
    const c = sideCandidates(anchor, 2, 2, 2).find((x) => x.side === "top")!;
    const corridor = connectorTiles(c, 2);
    g[corridor[2].y][corridor[2].x] = 0;
    expect(sideCandidateFits(c, g, 32, corridor)).toBe(false);
  });

  it("accepts a connector made entirely of untouched rock", () => {
    const g = rockGrid(32);
    const c = sideCandidates(anchor, 2, 2, 2).find((x) => x.side === "top")!;
    expect(sideCandidateFits(c, g, 32, connectorTiles(c, 2))).toBe(true);
  });
});

describe("connectorTiles", () => {
  const anchor = { x: 10, y: 10, w: 4, h: 4 };

  it("returns just the doorway tile at offset 0", () => {
    const c = sideCandidates(anchor, 2, 2, 0).find((x) => x.side === "top")!;
    expect(connectorTiles(c, 0)).toEqual([{ x: c.wall.x, y: c.wall.y }]);
  });

  it("steps outward one tile per offset, away from the anchor", () => {
    const c = sideCandidates(anchor, 2, 2, 3).find((x) => x.side === "left")!;
    expect(connectorTiles(c, 3)).toEqual([
      { x: c.wall.x, y: c.wall.y },
      { x: c.wall.x - 1, y: c.wall.y },
      { x: c.wall.x - 2, y: c.wall.y },
      { x: c.wall.x - 3, y: c.wall.y },
    ]);
  });
});

describe("carveRect", () => {
  it("carves inclusive bounds to floor and reports them as an x/y/w/h rect", () => {
    const g: Tile[][] = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 1 as Tile));
    const rect = carveRect(g, 2, 3, 4, 6);
    expect(rect).toEqual({ x: 2, y: 3, w: 3, h: 4 });
    for (let y = 3; y <= 6; y++) {
      for (let x = 2; x <= 4; x++) expect(g[y][x]).toBe(0);
    }
    expect(g[2][2]).toBe(1);
    expect(g[7][4]).toBe(1);
  });
});

describe("doorwayTiles", () => {
  function gridWith(doors: Array<[number, number]>, size = 10): Tile[][] {
    const g: Tile[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => 0 as Tile));
    for (const [x, y] of doors) g[y][x] = DOOR_TILE;
    return g;
  }

  it("returns the whole 4-connected run a door belongs to", () => {
    // The stage03 shape: a corridor flush along a room wall turns the entire
    // shared boundary into separate door tiles. It is one gate.
    const g = gridWith([[4, 3], [4, 4], [4, 5], [4, 6], [4, 7]]);
    const run = doorwayTiles(g, { x: 4, y: 5 });
    expect(run).toHaveLength(5);
    expect(new Set(run.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(["4,3", "4,4", "4,5", "4,6", "4,7"]),
    );
  });

  it("finds the same run from any tile in it", () => {
    const g = gridWith([[4, 3], [4, 4], [4, 5]]);
    const fromTop = doorwayTiles(g, { x: 4, y: 3 }).map((p) => `${p.x},${p.y}`).sort();
    const fromBottom = doorwayTiles(g, { x: 4, y: 5 }).map((p) => `${p.x},${p.y}`).sort();
    expect(fromTop).toEqual(fromBottom);
  });

  it("keeps two separate doorways separate", () => {
    // A gap of one floor tile means two distinct gates, and two keys.
    const g = gridWith([[4, 3], [4, 4], [4, 6], [4, 7]]);
    expect(doorwayTiles(g, { x: 4, y: 3 })).toHaveLength(2);
    expect(doorwayTiles(g, { x: 4, y: 6 })).toHaveLength(2);
  });

  it("returns a single tile for a lone door", () => {
    expect(doorwayTiles(gridWith([[4, 4]]), { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
  });

  it("returns nothing for a tile that isn't a door", () => {
    expect(doorwayTiles(gridWith([[4, 4]]), { x: 1, y: 1 })).toEqual([]);
  });

  it("returns nothing for an out-of-bounds start", () => {
    expect(doorwayTiles(gridWith([[4, 4]]), { x: -1, y: 99 })).toEqual([]);
  });

  it("doesn't connect diagonally — a diagonal pair is two doorways", () => {
    const g = gridWith([[4, 4], [5, 5]]);
    expect(doorwayTiles(g, { x: 4, y: 4 })).toHaveLength(1);
  });
});

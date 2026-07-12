// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../prng";
import type { CodeEntity } from "../../parser/types";
import type { Tile } from "../types";
import { carveRoom, makeRoom } from "./geometry";
import { MAZE_THRESHOLD } from "./labyrinth";
import { placeDecorations, placePillars } from "./props";

function entity(overrides: Partial<CodeEntity> = {}): CodeEntity {
  return { name: "f", kind: "function", startLine: 1, endLine: 5, complexityScore: 3, nestingDepth: 0, ...overrides };
}

function grid(size: number): Tile[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 1 as Tile));
}

function alwaysZero(): number {
  return 0;
}

describe("placePillars", () => {
  it("never places a pillar in the spawn room (index 0), even if it qualifies", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 8, 8, entity());
    carveRoom(g, spawnRoom);
    const before = g.map((row) => [...row]);
    placePillars([spawnRoom], g, [], alwaysZero);
    expect(g).toEqual(before);
  });

  it("places 1-3 pillars in a qualifying large open room", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(8, 1, 10, 10, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    placePillars([spawnRoom, room], g, [], mulberry32(1));
    let wallsInRoom = 0;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (g[y][x] === 1) wallsInRoom++;
      }
    }
    expect(wallsInRoom).toBeGreaterThan(0);
    expect(wallsInRoom).toBeLessThanOrEqual(3);
  });

  it("skips a global-variable (hazard) room even if it's large", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(8, 1, 10, 10, entity({ kind: "global" }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const before = g.map((row) => [...row]);
    placePillars([spawnRoom, room], g, [], mulberry32(1));
    expect(g).toEqual(before);
  });

  it("skips a labyrinth room (nestingDepth >= MAZE_THRESHOLD) even if it's large", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(8, 1, 10, 10, entity({ nestingDepth: MAZE_THRESHOLD }));
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const before = g.map((row) => [...row]);
    placePillars([spawnRoom, room], g, [], mulberry32(1));
    expect(g).toEqual(before);
  });

  it("skips a room smaller than LARGE_ROOM_MIN_DIM", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(8, 1, 5, 5, entity());
    carveRoom(g, spawnRoom);
    carveRoom(g, room);
    const before = g.map((row) => [...row]);
    placePillars([spawnRoom, room], g, [], mulberry32(1));
    expect(g).toEqual(before);
  });

  it("skips placing a pillar when findPropSpot can't find a spot", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 4, 4, entity());
    const room = makeRoom(8, 1, 10, 10, entity());
    carveRoom(g, spawnRoom);
    // room stays uncarved (all walls) -> findPropSpot always fails
    expect(() => placePillars([spawnRoom, room], g, [], mulberry32(1))).not.toThrow();
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const spawnRoom = makeRoom(1, 1, 4, 4, entity());
      const room = makeRoom(8, 1, 10, 10, entity());
      carveRoom(g, spawnRoom);
      carveRoom(g, room);
      placePillars([spawnRoom, room], g, [], mulberry32(11));
      return g;
    };
    expect(build()).toEqual(build());
  });
});

describe("placeDecorations", () => {
  it("includes the spawn room (unlike placePillars)", () => {
    const g = grid(20);
    const spawnRoom = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, spawnRoom);
    const decorations = placeDecorations([spawnRoom], g, [], mulberry32(1));
    expect(decorations.length).toBeGreaterThan(0);
  });

  it("returns 1-3 decorations per qualifying room, each a known kind", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity());
    carveRoom(g, room);
    const decorations = placeDecorations([room], g, [], mulberry32(1));
    expect(decorations.length).toBeGreaterThanOrEqual(1);
    expect(decorations.length).toBeLessThanOrEqual(3);
    for (const d of decorations) {
      expect(["rack", "plant", "desk", "block"]).toContain(d.kind);
    }
  });

  it("skips a room that doesn't qualify as large/open", () => {
    const g = grid(20);
    const small = makeRoom(1, 1, 5, 5, entity());
    carveRoom(g, small);
    expect(placeDecorations([small], g, [], mulberry32(1))).toEqual([]);
  });

  it("skips placing a decoration when findPropSpot can't find a spot", () => {
    const g = grid(20);
    const room = makeRoom(1, 1, 10, 10, entity()); // uncarved
    expect(() => placeDecorations([room], g, [], mulberry32(1))).not.toThrow();
  });

  it("is deterministic for the same rng seed", () => {
    const build = () => {
      const g = grid(20);
      const room = makeRoom(1, 1, 10, 10, entity());
      carveRoom(g, room);
      return placeDecorations([room], g, [], mulberry32(13));
    };
    expect(build()).toEqual(build());
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The predicates the engine and the playtest bot now share.
 *
 * The emphasis is on the two things this module exists to stop being possible:
 * the fast path and the declarative set silently disagreeing, and the bot's
 * sight rule silently becoming the engine's (or vice versa). Both were real —
 * the second one is the demo-campaign L6 wedge, eleven days and seven wrong
 * root causes.
 */
import { describe, expect, it } from "vitest";

import {
  SOLID_TILES,
  collidesWithWall,
  hasLineOfSight,
  isHazard,
  isHazardAt,
  isRouteBlocking,
  isRouteBlockingAt,
  isWall,
  isWallAt,
} from "./mapPredicates.ts";
import { BRANCH_DOOR_TILE, DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, SPIKE_TRAP_TILE } from "../map/types.ts";

/** Every tile value the map layer can emit, so a new one cannot slip past
 * these tests by simply not being enumerated here. */
const ALL_TILES = [0, 1, HAZARD_TILE, DOOR_TILE, 4, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE, BRANCH_DOOR_TILE];

/** A 5x5 grid whose single interior cell carries `tile`. */
function gridWith(tile: number) {
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0));
  grid[2][2] = tile;
  return { grid };
}

describe("SOLID_TILES agrees with isWall", () => {
  // `isWall` uses an explicit comparison chain and `SOLID_TILES` a Set,
  // deliberately: over 2.6M lookups the Set costs 3.0x the chain, and `isWall`
  // runs per enemy per AI tick and per sight sample. That split is only safe
  // while the two agree on every tile value there is — which is this test.
  it.each(ALL_TILES)("tile %i", (tile) => {
    expect(isWall(gridWith(tile), 2, 2)).toBe(SOLID_TILES.has(tile));
  });
});

describe("the three tile sets", () => {
  it("treats out of bounds as solid, but not as a hazard", () => {
    const map = gridWith(0);
    for (const [x, y] of [
      [-1, 2],
      [2, -1],
      [99, 2],
      [2, 99],
    ]) {
      expect(isWall(map, x, y)).toBe(true);
      expect(isRouteBlocking(map, x, y)).toBe(true);
      expect(isHazard(map, x, y)).toBe(false);
    }
  });

  it("lets a route plan through a door that a body and a bullet cannot cross", () => {
    // The single genuine divergence, and the one the L6 wedge came from
    // conflating. A route planner may walk up and open a door; nothing else may
    // pass it while it is shut.
    for (const door of [DOOR_TILE, BRANCH_DOOR_TILE]) {
      expect(isWall(gridWith(door), 2, 2)).toBe(true);
      expect(isRouteBlocking(gridWith(door), 2, 2)).toBe(false);
    }
  });

  it("blocks both on the tiles that are solid to everything", () => {
    for (const solid of [1, SECRET_WALL_TILE, LORE_TILE]) {
      expect(isWall(gridWith(solid), 2, 2)).toBe(true);
      expect(isRouteBlocking(gridWith(solid), 2, 2)).toBe(true);
    }
  });

  it("lets acid, floor, teleporters and spikes through both", () => {
    for (const open of [0, HAZARD_TILE, 4, SPIKE_TRAP_TILE]) {
      expect(isWall(gridWith(open), 2, 2)).toBe(false);
      expect(isRouteBlocking(gridWith(open), 2, 2)).toBe(false);
    }
  });
});

describe("the fractional-position wrappers", () => {
  // Only the bot calls these — it asks about the position a body is standing
  // at, where the engine asks about an integer cell. `scripts/**` is outside
  // the `src/` coverage denominator, so without this block they would be
  // uncovered lines in a file the ~99.9% gate applies to.
  it("floors to the containing cell", () => {
    const map = gridWith(1);
    // Anywhere inside cell (2,2) is the wall; anywhere inside (1,2) is not.
    for (const [x, y] of [
      [2.0, 2.0],
      [2.5, 2.5],
      [2.99, 2.01],
    ]) {
      expect(isWallAt(map, x, y)).toBe(true);
      expect(isRouteBlockingAt(map, x, y)).toBe(true);
    }
    expect(isWallAt(map, 1.5, 2.5)).toBe(false);
    expect(isRouteBlockingAt(map, 1.5, 2.5)).toBe(false);
  });

  it("carries each predicate's own out-of-bounds answer", () => {
    const map = gridWith(1);
    expect(isWallAt(map, -0.5, 2.5)).toBe(true);
    expect(isRouteBlockingAt(map, -0.5, 2.5)).toBe(true);
    expect(isHazardAt(map, -0.5, 2.5)).toBe(false);
  });

  it("finds acid at a fractional position", () => {
    const map = gridWith(HAZARD_TILE);
    expect(isHazardAt(map, 2.5, 2.5)).toBe(true);
    expect(isHazardAt(map, 1.5, 2.5)).toBe(false);
    // Acid is walkable, so it is neither kind of blocker.
    expect(isWallAt(map, 2.5, 2.5)).toBe(false);
    expect(isRouteBlockingAt(map, 2.5, 2.5)).toBe(false);
  });
});

describe("hasLineOfSight's sealedCorner flag", () => {
  /**
   * The L6 geometry, reduced. A ray at exactly 45 degrees crosses the point
   * where four tiles meet; the two tiles it passes *between* are solid, the two
   * it samples are not. Point sampling therefore reports a clear view through
   * a corner no bullet could cross.
   */
  function sealedCornerMap() {
    const grid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
    grid[3][2] = 1; // one flanking tile
    grid[2][3] = DOOR_TILE; // the other, closed — solid to a bullet
    return { grid };
  }

  it("sees through the sealed corner when the flag is off (the engine's aggro rule)", () => {
    expect(hasLineOfSight(sealedCornerMap(), 3.0, 3.0, 2.0, 2.0, false)).toBe(true);
  });

  it("blocks the sealed corner when the flag is on (the bot's can-I-shoot rule)", () => {
    expect(hasLineOfSight(sealedCornerMap(), 3.0, 3.0, 2.0, 2.0, true)).toBe(false);
  });

  it("defaults to off, so an unmarked caller keeps the engine's behaviour", () => {
    expect(hasLineOfSight(sealedCornerMap(), 3.0, 3.0, 2.0, 2.0)).toBe(true);
  });

  it("still lets a single-corner graze through even with the flag on", () => {
    // Blocking on *either* flanking tile was measured far too strict: it made a
    // blocker standing diagonally in a doorway unshootable and ran two CI jobs
    // into their timeouts. Only a corner sealed by *both* blocks.
    const grid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
    grid[3][2] = 1; // one solid, one open
    expect(hasLineOfSight({ grid }, 3.0, 3.0, 2.0, 2.0, true)).toBe(true);
  });

  it("agrees with the flag off and on when no diagonal corner is crossed", () => {
    const grid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
    grid[2][3] = 1;
    expect(hasLineOfSight({ grid }, 1.5, 2.5, 4.5, 2.5, false)).toBe(false);
    expect(hasLineOfSight({ grid }, 1.5, 2.5, 4.5, 2.5, true)).toBe(false);
    expect(hasLineOfSight({ grid }, 1.5, 4.5, 4.5, 4.5, false)).toBe(true);
    expect(hasLineOfSight({ grid }, 1.5, 4.5, 4.5, 4.5, true)).toBe(true);
  });
});

describe("collidesWithWall", () => {
  it("catches a wall the centre point misses", () => {
    const map = gridWith(1);
    // Centre sits in open floor at (1.9, 2.5); a 0.2-radius box still overlaps
    // the solid cell at x=2. A point test would say clear.
    expect(isWall(map, Math.floor(1.9), Math.floor(2.5))).toBe(false);
    expect(collidesWithWall(map, 1.9, 2.5, 0.2)).toBe(true);
  });

  it("is clear when the whole box is in open floor", () => {
    expect(collidesWithWall(gridWith(1), 1.5, 1.5, 0.2)).toBe(false);
  });
});

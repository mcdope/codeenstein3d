// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { Enemy } from "../map/types";
import { EnemySpatialGrid } from "./spatialGrid";

function enemy(x: number, y: number, alive = true): Enemy {
  return {
    x,
    y,
    hp: alive ? 10 : 0,
    maxHp: 10,
    alive,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 1, h: 1 },
    aggroed: false,
    discovered: false,
    roamX: x,
    roamY: y,
    fireCooldown: 0,
    entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
    elite: false,
    edgeCase: false,
  };
}

describe("EnemySpatialGrid", () => {
  it("returns no candidates before rebuild() has ever been called", () => {
    const grid = new EnemySpatialGrid();
    expect(grid.queryIndices(0, 0, 5)).toEqual([]);
  });

  it("excludes dead enemies from the buckets", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(1, 1, false)], 10);
    expect(grid.queryIndices(1, 1, 0.5)).toEqual([]);
  });

  it("buckets multiple living enemies sharing the same tile", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(1, 1), enemy(1, 1)], 10);
    expect(grid.queryIndices(1, 1, 0.4)).toEqual([0, 1]);
  });

  it("finds an enemy within the query circle's bounding box", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(5, 5)], 10);
    expect(grid.queryIndices(5, 5, 1)).toEqual([0]);
  });

  it("ignores tiles the query circle doesn't reach", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(5, 5)], 10);
    expect(grid.queryIndices(0, 0, 1)).toEqual([]);
  });

  it("returns bucketed indices sorted ascending regardless of scan order", () => {
    const grid = new EnemySpatialGrid();
    // index 0 is placed in the tile scanned FIRST (lower y), index... wait,
    // we want a higher array index bucketed into a tile visited before a
    // lower array index's tile, so the raw (unsorted) walk order and the
    // required ascending output order actually differ.
    const enemies = [enemy(5, 6), enemy(5, 5)]; // enemies[0] -> tile(5,6) (scanned 2nd row), enemies[1] -> tile(5,5) (scanned 1st row)
    grid.rebuild(enemies, 10);
    const result = grid.queryIndices(5, 5.5, 1);
    expect(result).toEqual([0, 1]); // ascending, even though tile(5,5) [index 1] is visited before tile(5,6) [index 0]
  });

  it("rebuild() clears any previous bucket state", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(1, 1)], 10);
    expect(grid.queryIndices(1, 1, 0.4)).toEqual([0]);
    grid.rebuild([enemy(9, 9)], 10);
    expect(grid.queryIndices(1, 1, 0.4)).toEqual([]);
    expect(grid.queryIndices(9, 9, 0.4)).toEqual([0]);
  });

  it("anyWithin() returns true when a bucketed living enemy satisfies the predicate", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(5, 5)], 10);
    expect(grid.anyWithin(5, 5, 1, () => true)).toBe(true);
  });

  it("anyWithin() returns false when no bucketed enemy satisfies the predicate", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(5, 5)], 10);
    expect(grid.anyWithin(5, 5, 1, () => false)).toBe(false);
  });

  it("anyWithin() returns false for an enemy that died after rebuild()", () => {
    const grid = new EnemySpatialGrid();
    const e = enemy(5, 5);
    grid.rebuild([e], 10);
    e.alive = false; // alive flags may change between rebuild and query, per the class docstring
    expect(grid.anyWithin(5, 5, 1, () => true)).toBe(false);
  });

  it("anyWithin() short-circuits on the first matching enemy without scanning the rest", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([enemy(5, 5), enemy(5, 5)], 10);
    let calls = 0;
    const found = grid.anyWithin(5, 5, 1, () => {
      calls++;
      return true;
    });
    expect(found).toBe(true);
    expect(calls).toBe(1);
  });

  it("skips tiles with no bucket at all", () => {
    const grid = new EnemySpatialGrid();
    grid.rebuild([], 10);
    expect(grid.anyWithin(5, 5, 3, () => true)).toBe(false);
  });
});

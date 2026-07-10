// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A tiny uniform spatial hash over living enemies, bucketed per map tile —
 * turns "which enemies are near this point" from a scan of every enemy on
 * the map into a lookup of the handful of tiles a query circle overlaps.
 *
 * Deliberately rebuilt from scratch on the (rare) frames that actually need
 * proximity queries — rockets in flight — rather than maintained
 * incrementally every frame: a rebuild is one cheap O(enemies) pass, and on
 * the vast majority of frames (no rockets) the grid costs nothing at all.
 *
 * Determinism contract: `queryIndices` returns enemy *array indices* in
 * ascending order, so a caller iterating them visits enemies in exactly the
 * order the old full-array scan did (restricted to the candidates) — the
 * order in which kills happen, and therefore the order seeded-rng loot rolls
 * are drawn, must never depend on bucket layout.
 */
import type { Enemy } from "../map/types";

export class EnemySpatialGrid {
  /** Tile key (`y * width + x`) → indices into the enemies array, in
   * insertion (= ascending) order. */
  private readonly buckets = new Map<number, number[]>();
  private enemies: readonly Enemy[] = [];
  private width = 0;

  /** Rebuild from scratch: bucket every living enemy's index by its tile.
   * Positions must not change between this call and the queries against it
   * (alive flags may — every query re-checks them). */
  rebuild(enemies: readonly Enemy[], width: number): void {
    this.buckets.clear();
    this.enemies = enemies;
    this.width = width;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      const key = Math.floor(e.y) * width + Math.floor(e.x);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  /** Every bucketed enemy index whose tile intersects the circle's bounding
   * box, ascending. A superset of the enemies actually within `r` — callers
   * apply their own exact distance/alive checks, same as the full scan did. */
  queryIndices(x: number, y: number, r: number): number[] {
    const result: number[] = [];
    this.forEachCandidate(x, y, r, (i) => {
      result.push(i);
      return false;
    });
    result.sort((a, b) => a - b);
    return result;
  }

  /** True if any bucketed living enemy within the circle's bounding box
   * satisfies `pred` — order-independent, so no sort is needed. */
  anyWithin(x: number, y: number, r: number, pred: (enemy: Enemy) => boolean): boolean {
    return this.forEachCandidate(x, y, r, (i) => {
      const e = this.enemies[i];
      return e.alive && pred(e);
    });
  }

  /** Walk every candidate index in the circle's AABB of tiles; stops (and
   * returns true) the first time `visit` returns true. */
  private forEachCandidate(x: number, y: number, r: number, visit: (index: number) => boolean): boolean {
    const cx0 = Math.floor(x - r);
    const cx1 = Math.floor(x + r);
    const cy0 = Math.floor(y - r);
    const cy1 = Math.floor(y + r);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.buckets.get(cy * this.width + cx);
        if (!bucket) continue;
        for (const i of bucket) {
          if (visit(i)) return true;
        }
      }
    }
    return false;
  }
}

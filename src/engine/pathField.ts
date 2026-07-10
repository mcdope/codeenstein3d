// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A single player-rooted BFS distance field shared by every chasing enemy.
 *
 * The chase AI used to flood-fill its own window per enemy per frame — with
 * a fresh `Map` and queue allocated each call, that was the engine's single
 * worst scaling cost on enemy-dense maps. The distances only depend on the
 * player's tile and the wall grid, so one full-map flood serves every enemy,
 * and it only needs recomputing when the player crosses a tile boundary or
 * the grid itself mutates (a door opens, a secret wall slides away — see
 * `RaycasterEngine`'s `gridVersion`). Flat typed-array storage, allocated
 * once per level: zero steady-state allocation.
 *
 * No `rng` is involved anywhere in this path — determinism is structural.
 */
import { isWall } from "./player";
import type { GameMap } from "../map/types";

export class PathField {
  /** BFS distance (tiles) from the player's tile, -1 = unreached. */
  private dist = new Int32Array(0);
  /** Reusable ring queue of cell ids for the flood fill. */
  private queue = new Int32Array(0);
  private width = 0;
  private height = 0;
  private lastPx = -1;
  private lastPy = -1;
  private lastVersion = -1;

  /**
   * Make the field current for the player standing on tile (`px`,`py`) and
   * the grid revision `gridVersion` — refloods only when either changed.
   */
  ensure(map: GameMap, px: number, py: number, gridVersion: number): void {
    const size = map.width * map.height;
    if (this.dist.length !== size) {
      this.dist = new Int32Array(size);
      this.queue = new Int32Array(size);
      this.width = map.width;
      this.height = map.height;
      this.lastPx = -1; // force the first flood
    }
    if (px === this.lastPx && py === this.lastPy && gridVersion === this.lastVersion) return;
    this.lastPx = px;
    this.lastPy = py;
    this.lastVersion = gridVersion;

    this.dist.fill(-1);
    // Player inside a solid tile (noClip) — leave the field empty; every
    // enemy then falls back to straight-line steering, same as the old
    // per-enemy search's player-tile-is-wall bailout.
    if (isWall(map, px, py)) return;

    const width = this.width;
    let head = 0;
    let tail = 0;
    const start = py * width + px;
    this.dist[start] = 0;
    this.queue[tail++] = start;
    while (head < tail) {
      const cur = this.queue[head++];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      const cd = this.dist[cur];
      // Same +x, -x, +y, -y neighbor order the per-enemy flood used —
      // `isWall` reports out-of-bounds as solid, so no bounds checks needed.
      if (!isWall(map, cx + 1, cy) && this.dist[cur + 1] === -1) {
        this.dist[cur + 1] = cd + 1;
        this.queue[tail++] = cur + 1;
      }
      if (!isWall(map, cx - 1, cy) && this.dist[cur - 1] === -1) {
        this.dist[cur - 1] = cd + 1;
        this.queue[tail++] = cur - 1;
      }
      if (!isWall(map, cx, cy + 1) && this.dist[cur + width] === -1) {
        this.dist[cur + width] = cd + 1;
        this.queue[tail++] = cur + width;
      }
      if (!isWall(map, cx, cy - 1) && this.dist[cur - width] === -1) {
        this.dist[cur - width] = cd + 1;
        this.queue[tail++] = cur - width;
      }
    }
  }

  /** BFS distance from the player's tile to (`x`,`y`); -1 when unreached or
   * out of bounds. */
  distAt(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return -1;
    return this.dist[y * this.width + x];
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Player / camera for the raycaster.
 *
 * Uses the classic "direction vector + camera plane" model (à la Lode's
 * raycasting tutorial): `dir` is the facing unit vector and `plane` is
 * perpendicular to it, its length setting the field of view. Positions are in
 * fractional tile units, so `posX = 4.5` means the middle of column 4.
 *
 * Movement resolves collisions per-axis against the tile grid using an AABB
 * (a square of half-width `radius`) so the player slides along walls instead
 * of sticking, and can never enter a solid cell.
 */
import { type GameMap, type Point } from "../map/types";
import { collidesWithWall } from "./mapPredicates.ts";

export interface PlayerConfig {
  /** Half-width of the player's collision box, in tiles. */
  radius: number;
}

const DEFAULT_CONFIG: PlayerConfig = { radius: 0.2 };

/** Vertical field of view factor; ~0.66 ≈ 66°, the Wolfenstein look. */
const FOV_PLANE = 0.66;

export class Player {
  posX: number;
  posY: number;
  dirX = 1;
  dirY = 0;
  planeX = 0;
  planeY = FOV_PLANE;
  /** IDCLIP cheat — bypasses wall collision entirely while true. Toggled at
   * runtime (see `RaycasterEngine.applyCheat`), not part of `PlayerConfig`
   * since it's a mid-run cheat state, not a construction-time setting. */
  noClip = false;

  private readonly config: PlayerConfig;

  /** `spawn` defaults to `map.spawn` — a multiplayer session overrides it per
   * player with one of `GameMap.multiplayerSpawns`'s spread-out points (see
   * `RaycasterEngine`'s own `localSpawn`/`addPlayer` spawn parameters),
   * single-player/replay never pass it and keep today's exact behavior. */
  constructor(map: GameMap, config: Partial<PlayerConfig> = {}, spawn: Point = map.spawn) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Spawn in the middle of the spawn tile.
    this.posX = spawn.x + 0.5;
    this.posY = spawn.y + 0.5;
  }

  /** Half-width of the collision box, in tiles. */
  get radius(): number {
    return this.config.radius;
  }

  /** Rotate facing and camera plane by `angle` radians (positive = right). */
  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dirX = this.dirX * cos - this.dirY * sin;
    this.dirY = this.dirX * sin + this.dirY * cos;
    this.dirX = dirX;
    const planeX = this.planeX * cos - this.planeY * sin;
    this.planeY = this.planeX * sin + this.planeY * cos;
    this.planeX = planeX;
  }

  /** Move `dist` tiles along the facing vector (negative = backward). */
  moveForward(dist: number, map: GameMap): void {
    this.move(this.dirX * dist, this.dirY * dist, map);
  }

  /**
   * Move `dist` tiles perpendicular to the facing vector, without turning
   * (negative = strafe left, positive = strafe right). The right vector is the
   * facing vector rotated +90°, matching `rotate`'s positive-angle convention.
   */
  strafe(dist: number, map: GameMap): void {
    const strafeX = -this.dirY;
    const strafeY = this.dirX;
    this.move(strafeX * dist, strafeY * dist, map);
  }

  /** Attempt a translation, resolving each axis independently for sliding. */
  private move(dx: number, dy: number, map: GameMap): void {
    const nextX = this.posX + dx;
    if (!this.collides(map, nextX, this.posY)) this.posX = nextX;

    const nextY = this.posY + dy;
    if (!this.collides(map, this.posX, nextY)) this.posY = nextY;
  }

  /** AABB-vs-grid test: does the box centered at (px,py) touch any wall cell? */
  private collides(map: GameMap, px: number, py: number): boolean {
    if (this.noClip) return false;
    return collidesWithWall(map, px, py, this.config.radius);
  }
}

// `isWall`, `isHazard` and `collidesWithWall` moved to `mapPredicates.ts` so
// the playtest bot can import the *same* predicate instead of re-typing it in
// plain JavaScript — see that module's header for why (the L6 wedge). They are
// re-exported here because every existing caller in `src/` reaches for them at
// this path, and the move is meant to change nothing but the definition site.
// Imported as well as re-exported, not merely re-exported: `export … from`
// creates no local binding, and `PlayerState#collides` below calls it.
export { isHazard, isWall } from "./mapPredicates.ts";
export { collidesWithWall };

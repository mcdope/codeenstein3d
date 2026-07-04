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
import { DOOR_TILE, HAZARD_TILE, type GameMap } from "../map/types";

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

  private readonly config: PlayerConfig;

  constructor(map: GameMap, config: Partial<PlayerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Spawn in the middle of the spawn tile.
    this.posX = map.spawn.x + 0.5;
    this.posY = map.spawn.y + 0.5;
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

  /** Attempt a translation, resolving each axis independently for sliding. */
  private move(dx: number, dy: number, map: GameMap): void {
    const nextX = this.posX + dx;
    if (!this.collides(map, nextX, this.posY)) this.posX = nextX;

    const nextY = this.posY + dy;
    if (!this.collides(map, this.posX, nextY)) this.posY = nextY;
  }

  /** AABB-vs-grid test: does the box centered at (px,py) touch any wall cell? */
  private collides(map: GameMap, px: number, py: number): boolean {
    const r = this.config.radius;
    const minX = Math.floor(px - r);
    const maxX = Math.floor(px + r);
    const minY = Math.floor(py - r);
    const maxY = Math.floor(py + r);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        if (isWall(map, cx, cy)) return true;
      }
    }
    return false;
  }
}

/** A cell is solid if it's out of bounds or a wall (1). */
export function isWall(map: GameMap, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true;
  const tile = map.grid[cy][cx];
  // Walls (1) and still-locked doors (3) are solid; acid (2) and floor (0) are not.
  return tile === 1 || tile === DOOR_TILE;
}

/** True if the cell is a hazard (acid) tile — walkable, but it drains health. */
export function isHazard(map: GameMap, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return false;
  return map.grid[cy][cx] === HAZARD_TILE;
}

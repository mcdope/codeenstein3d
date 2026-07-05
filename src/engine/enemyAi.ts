// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Enemy AI: the per-frame chase-and-melee behaviour that turns the otherwise
 * inert `Enemy` billboards into active threats.
 *
 * This lives in the engine layer rather than as a method on the `Enemy` data
 * (which is plain, serializable map-layer state) so the map never has to depend
 * on the player/camera. Each living enemy homes in on the player once inside
 * `AGGRO_RADIUS`, slides along walls using the exact AABB grid test the player
 * uses (`collidesWithWall`), and bites for `ATTACK_DAMAGE` on a fixed cooldown
 * once within `ATTACK_RADIUS` — so damage lands in discrete hits, not every
 * frame.
 */
import { collidesWithWall, isWall, type Player } from "./player";
import type { Enemy, GameMap } from "../map/types";

/** Distance (tiles) within which an enemy notices and chases the player. */
const AGGRO_RADIUS = 5;
/** Enemy movement speed in tiles per second (slower than the player's 3.2). */
const MOVEMENT_SPEED = 1.7;
/** Distance (tiles) at which an enemy stops chasing and melees instead. */
const ATTACK_RADIUS = 0.5;
/** Seconds between successive melee bites from a single enemy. */
const ATTACK_COOLDOWN = 0.8;
/** Stability (health) the player loses per melee bite. */
const ATTACK_DAMAGE = 10;
/** Half-width of an enemy's collision box, in tiles. */
const ENEMY_RADIUS = 0.3;

/**
 * Advance every living enemy by `dt` seconds and return the total stability
 * damage the player should take from melee bites this frame. Call once per
 * frame, before rendering.
 */
export function updateEnemies(
  enemies: Enemy[],
  player: Player,
  map: GameMap,
  dt: number,
): number {
  let damage = 0;
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    damage += updateEnemy(enemy, player, map, dt);
  }
  return damage;
}

/** Chase/attack a single enemy; returns the melee damage it deals this frame. */
function updateEnemy(enemy: Enemy, player: Player, map: GameMap, dt: number): number {
  // Cool down toward the next available bite, whatever the current range.
  if (enemy.attackCooldown > 0) {
    enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
  }

  const dx = player.posX - enemy.x;
  const dy = player.posY - enemy.y;
  const dist = Math.hypot(dx, dy);

  // In melee range: hold position and bite whenever the cooldown has elapsed.
  if (dist <= ATTACK_RADIUS) {
    if (enemy.attackCooldown === 0) {
      enemy.attackCooldown = ATTACK_COOLDOWN;
      return ATTACK_DAMAGE;
    }
    return 0;
  }

  // Otherwise home in on the player if within aggro range. Steer toward the
  // next cell of a wall-aware path (so the enemy rounds corners and walls) and
  // fall back to a straight line when no path is found within the window.
  if (dist < AGGRO_RADIUS && dist > 0) {
    const step = MOVEMENT_SPEED * dt;
    const waypoint = nextWaypoint(enemy, player, map);
    chaseToward(enemy, waypoint?.x ?? player.posX, waypoint?.y ?? player.posY, step, map);
  }
  return 0;
}

/** How far beyond the aggro radius the path search may look, in tiles. */
const PATH_MARGIN = 2;

/**
 * Next steering target for a chasing enemy: the center of the walkable cell
 * adjacent to the enemy that lies on the shortest path to the player.
 *
 * Computed with a breadth-first flood fill outward from the player's tile,
 * bounded to a window around the enemy so the cost stays tiny (enemies only
 * path when already within aggro range). Returns `null` when the player's tile
 * is unwalkable, out of the window, or unreachable — the caller then steers
 * straight at the player. This is what lets enemies round convex corners and
 * finite wall segments instead of hanging on them.
 */
function nextWaypoint(enemy: Enemy, player: Player, map: GameMap): { x: number; y: number } | null {
  const ex = Math.floor(enemy.x);
  const ey = Math.floor(enemy.y);
  const px = Math.floor(player.posX);
  const py = Math.floor(player.posY);
  if (ex === px && ey === py) return null; // same tile — just go straight in

  const reach = AGGRO_RADIUS + PATH_MARGIN;
  const minX = ex - reach;
  const maxX = ex + reach;
  const minY = ey - reach;
  const maxY = ey + reach;
  if (px < minX || px > maxX || py < minY || py > maxY) return null;
  if (isWall(map, px, py)) return null;

  const width = map.width;
  const cellId = (x: number, y: number): number => y * width + x;

  // BFS distances from the player's tile, restricted to the window.
  const distField = new Map<number, number>();
  const queue: number[] = [cellId(px, py)];
  distField.set(cellId(px, py), 0);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const cd = distField.get(cur)!;
    for (const [nx, ny] of neighbors4(cx, cy)) {
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (isWall(map, nx, ny)) continue;
      const id = cellId(nx, ny);
      if (distField.has(id)) continue;
      distField.set(id, cd + 1);
      queue.push(id);
    }
  }

  // Descend the distance field: pick the enemy's walkable neighbor closest to
  // the player. Requires a strict decrease so we always make progress inward.
  let best: { x: number; y: number } | null = null;
  let bestDist = distField.get(cellId(ex, ey)) ?? Infinity;
  for (const [nx, ny] of neighbors4(ex, ey)) {
    if (isWall(map, nx, ny)) continue;
    const d = distField.get(cellId(nx, ny));
    if (d === undefined || d >= bestDist) continue;
    bestDist = d;
    best = { x: nx + 0.5, y: ny + 0.5 };
  }
  return best;
}

/** The four orthogonal neighbors of a tile. */
function neighbors4(x: number, y: number): [number, number][] {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

/**
 * Candidate heading offsets (radians), tried in order: straight at the player
 * first, then progressively wider slides. The wider ones let a chasing enemy
 * wall-follow around a corner instead of walking into a wall face and hanging
 * (greedy steering has no tangential component to slide on when it points
 * straight at a wall).
 */
const STEER_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

/** A heading must actually advance the enemy this fraction of a step to count
 * as progress — filters out headings that merely graze a wall. */
const MIN_PROGRESS = 0.25;

/**
 * Step the enemy up to `step` tiles toward (tx,ty) while avoiding walls. Each
 * candidate heading is resolved with the same per-axis AABB slide the player
 * uses; among the headings that make real progress, the one ending closest to
 * the target wins. This rounds convex wall corners instead of hanging on them.
 */
function chaseToward(enemy: Enemy, tx: number, ty: number, step: number, map: GameMap): void {
  const desired = Math.atan2(ty - enemy.y, tx - enemy.x);
  let bestX = enemy.x;
  let bestY = enemy.y;
  let bestDist = Infinity;
  let moved = false;

  for (const offset of STEER_OFFSETS) {
    const angle = desired + offset;
    const { x, y } = slidePosition(enemy, Math.cos(angle) * step, Math.sin(angle) * step, map);
    if (Math.hypot(x - enemy.x, y - enemy.y) < step * MIN_PROGRESS) continue;
    const d = Math.hypot(tx - x, ty - y);
    if (d < bestDist) {
      bestDist = d;
      bestX = x;
      bestY = y;
      moved = true;
    }
  }

  if (moved) {
    enemy.x = bestX;
    enemy.y = bestY;
  }
}

/**
 * Per-axis AABB slide against the wall grid, returning the resulting position
 * without mutating the enemy (identical collision model to the player).
 */
function slidePosition(
  enemy: Enemy,
  dx: number,
  dy: number,
  map: GameMap,
): { x: number; y: number } {
  let { x, y } = enemy;
  const nextX = x + dx;
  if (!collidesWithWall(map, nextX, y, ENEMY_RADIUS)) x = nextX;
  const nextY = y + dy;
  if (!collidesWithWall(map, x, nextY, ENEMY_RADIUS)) y = nextY;
  return { x, y };
}

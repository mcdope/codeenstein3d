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
import { collidesWithWall, type Player } from "./player";
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

  // Otherwise home in on the player if within aggro range.
  if (dist < AGGRO_RADIUS && dist > 0) {
    const step = MOVEMENT_SPEED * dt;
    moveEnemy(enemy, (dx / dist) * step, (dy / dist) * step, map);
  }
  return 0;
}

/** Per-axis AABB slide against the wall grid (identical model to the player). */
function moveEnemy(enemy: Enemy, dx: number, dy: number, map: GameMap): void {
  const nextX = enemy.x + dx;
  if (!collidesWithWall(map, nextX, enemy.y, ENEMY_RADIUS)) enemy.x = nextX;
  const nextY = enemy.y + dy;
  if (!collidesWithWall(map, enemy.x, nextY, ENEMY_RADIUS)) enemy.y = nextY;
}

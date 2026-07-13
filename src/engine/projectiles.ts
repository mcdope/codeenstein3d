// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Enemy ranged attacks: small 2D "bolts" that travel in a straight line toward
 * where the player stood when fired. Each frame they advance along their
 * velocity; a bolt dies when it hits the player (dealing damage) or a wall.
 * Rendered as glowing billboards, occluded by the wall z-buffer like sprites.
 */
import { isWall, type Player } from "./player";
import { collectOrbBillboards, type BillboardJob } from "./sprites";
import type { GameMap } from "../map/types";

/** Bolt travel speed, in tiles per second (dodgeable, but faster than a chase). */
const PROJECTILE_SPEED = 5;
/** Stability the player loses when a bolt connects. */
const PROJECTILE_DAMAGE = 8;
/** Bolt collision half-size, in tiles. */
const PROJECTILE_RADIUS = 0.15;

/** One in-flight enemy bolt, in world (tile) space. */
export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
}

/** Spawn a bolt at (x,y) heading straight toward (tx,ty). `damageMultiplier`
 * scales the base damage (Elite enemies hit harder — see `enemyAi.ts`). */
export function spawnProjectile(
  list: Projectile[],
  x: number,
  y: number,
  tx: number,
  ty: number,
  damageMultiplier = 1,
): void {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy) || 1;
  list.push({
    x,
    y,
    vx: (dx / d) * PROJECTILE_SPEED,
    vy: (dy / d) * PROJECTILE_SPEED,
    damage: PROJECTILE_DAMAGE * damageMultiplier,
  });
}

/**
 * Advance every bolt by `dt`, removing any that struck the player (whose AABB
 * is a box of half-width `player.radius`) or hit a wall / left the map. Returns
 * the total stability damage the player should take this frame.
 */
export function updateProjectiles(
  list: Projectile[],
  player: Player,
  map: GameMap,
  dt: number,
  /** Balancing telemetry only — fired once per bolt that actually lands on
   * the player, for the enemy-accuracy metric (fired count comes from
   * `EnemyAiEvents.onRangedFire` instead, at spawn time). See `telemetry.ts`. */
  onHit?: () => void,
): number {
  let damage = 0;
  const reach = player.radius + PROJECTILE_RADIUS;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Player AABB hit takes precedence (you can get shot with your back to a wall).
    if (Math.abs(p.x - player.posX) < reach && Math.abs(p.y - player.posY) < reach) {
      damage += p.damage;
      onHit?.();
      list.splice(i, 1);
      continue;
    }
    // Wall (or out-of-bounds, which isWall reports as solid) destroys the bolt.
    if (isWall(map, Math.floor(p.x), Math.floor(p.y))) {
      list.splice(i, 1);
    }
  }
  return damage;
}

/** Collect bolts as small glowing magenta orb draw jobs at eye level,
 * wall-occluded. See `collectOrbBillboards` in `sprites.ts`. */
export function collectProjectileBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: Projectile[],
  zBuffer: Float64Array,
): BillboardJob[] {
  return collectOrbBillboards(ctx, player, list, zBuffer, {
    halo: "rgba(255,80,200,0.35)",
    core: "#ff3ea5",
    center: "#ffd0ec",
  });
}

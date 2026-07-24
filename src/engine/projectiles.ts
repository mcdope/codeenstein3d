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

/** Spawn a bolt at (x,y) heading toward (tx,ty), optionally rotated off dead-
 * center by a random angle up to `aimSpreadDeg` in either direction —
 * `DifficultyMultipliers.enemyAimSpreadDeg`'s actual effect (0 = perfectly
 * aimed, same as before that difficulty axis existed). `damageMultiplier`
 * scales the base damage (Elite enemies hit harder — see `enemyAi.ts`).
 * `rng` defaults to `Math.random` but `RaycasterEngine` always passes its own
 * seeded stream instead, same reason `enemyAi.ts`'s doc comment gives for
 * roam-target picking and fire-cooldown jitter — this changes enemy
 * behavior, which the replay system's determinism depends on. */
export function spawnProjectile(
  list: Projectile[],
  x: number,
  y: number,
  tx: number,
  ty: number,
  damageMultiplier = 1,
  aimSpreadDeg = 0,
  rng: () => number = Math.random,
): void {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy) || 1;
  let dirX = dx / d;
  let dirY = dy / d;
  if (aimSpreadDeg > 0) {
    const angle = (rng() * 2 - 1) * (aimSpreadDeg * (Math.PI / 180));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotX = dirX * cos - dirY * sin;
    const rotY = dirX * sin + dirY * cos;
    dirX = rotX;
    dirY = rotY;
  }
  list.push({
    x,
    y,
    vx: dirX * PROJECTILE_SPEED,
    vy: dirY * PROJECTILE_SPEED,
    damage: PROJECTILE_DAMAGE * damageMultiplier,
  });
}

/** A living player this bolt can strike, for `updateProjectiles`' per-player
 * attribution — the same `{id, player}` shape `enemyAi.ts`'s `EnemyTarget`
 * uses, so both modules share one calling convention. */
export interface ProjectileTarget {
  id: string;
  player: Player;
}

/**
 * Advance every bolt by `dt`, removing any that struck a living player (whose
 * AABB is a box of half-width `player.radius`) or hit a wall / left the map.
 * `targets` must already be in sorted-`id` order (the caller's contract, same
 * as `enemyAi.ts`'s `updateEnemies`) — a bolt tests every target in that
 * order and stops at the first hit, so two players standing close enough to
 * both be in reach resolve deterministically. Returns per-player damage
 * attribution for whoever a bolt actually landed on.
 */
export function updateProjectiles(
  list: Projectile[],
  targets: readonly ProjectileTarget[],
  map: GameMap,
  dt: number,
): Map<string, number> {
  const damage = new Map<string, number>();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Player AABB hit takes precedence (you can get shot with your back to a wall).
    let hit = false;
    for (const target of targets) {
      const reach = target.player.radius + PROJECTILE_RADIUS;
      if (Math.abs(p.x - target.player.posX) < reach && Math.abs(p.y - target.player.posY) < reach) {
        damage.set(target.id, (damage.get(target.id) ?? 0) + p.damage);
        list.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;
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

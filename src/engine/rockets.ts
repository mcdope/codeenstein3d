// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Player-fired rockets: a slow, visible projectile (unlike the instant
 * hitscan pellets every other weapon fires) that explodes on contact with a
 * wall or a living enemy, dealing distance-scaled splash damage to everything
 * in the blast radius — including the player, if they're standing close
 * enough. Mirrors the enemy bolt module (`projectiles.ts`) and the mine blast
 * falloff (`traps.ts`), but reports *where* it exploded rather than a single
 * damage total, since `RaycasterEngine` fans that out across every enemy and
 * the player rather than hitting just one target.
 */
import { isWall, type Player } from "./player";
import { collectOrbBillboards, type BillboardJob } from "./sprites";
import type { GameMap } from "../map/types";

/** Rocket travel speed, in tiles per second — much slower than a hitscan
 * pellet (instant) so it's a real, dodgeable projectile in flight. */
const ROCKET_SPEED = 18;
/** Radius (tiles) of a rocket's blast; damage falls off with distance inside
 * it, and is 0 entirely outside it. */
export const ROCKET_BLAST_RADIUS = 2.6;
/** Floor on the falloff curve so even an edge-of-blast hit stays meaningful. */
const ROCKET_DAMAGE_FALLOFF_FLOOR = 0.3;
/** How close a rocket has to get to a living enemy to detonate — bigger than
 * a precise hitbox check so a near-miss still reads as a hit. */
const ROCKET_ENEMY_TRIGGER_RADIUS = 0.4;

/** One in-flight rocket, in world (tile) space. */
export interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /**
   * Max (ground-zero) damage this rocket deals on detonation — baked in at
   * fire time from the weapon that fired it, not looked up again later, so
   * switching weapons mid-flight can't retroactively change it (matches
   * `Projectile.damage` in `projectiles.ts`).
   */
  damage: number;
  /** Which player fired this rocket — splash damages every enemy plus the
   * firer (the existing self-damage risk, a core Ghidra trade-off), but
   * never a teammate. Threaded through to `RocketExplosion` so the engine
   * can apply that exclusion at the damage-fan-out step. */
  firedBy: string;
}

/** Fire a rocket from (x,y) heading straight along (dirX,dirY) — the
 * player's current facing; this engine has no separate aim direction. */
export function spawnRocket(
  list: Rocket[],
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  damage: number,
  firedBy: string,
): void {
  list.push({
    x: x + dirX * 0.4,
    y: y + dirY * 0.4,
    vx: dirX * ROCKET_SPEED,
    vy: dirY * ROCKET_SPEED,
    damage,
    firedBy,
  });
}

/** Where and how hard a rocket detonated — the engine fans distance-scaled
 * damage out from this point across every enemy and the player. */
export interface RocketExplosion {
  x: number;
  y: number;
  damage: number;
  firedBy: string;
}

/**
 * Advance every in-flight rocket by `dt`, detonating (and removing) any that
 * hit a wall or come near a living enemy. Returns one explosion per rocket
 * that went off this frame; applying the actual AoE damage, VFX, and audio is
 * left to the caller (see `RaycasterEngine`), same division of labor as
 * `updateMines`/`detonateMine` in `traps.ts`.
 *
 * `nearLivingEnemy(x, y, radius)` answers whether any living enemy is within
 * `radius` of the point — the engine backs it with its spatial grid (see
 * `spatialGrid.ts`) instead of the full enemy-array scan this used to do per
 * rocket per frame.
 */
export function updateRockets(
  list: Rocket[],
  nearLivingEnemy: (x: number, y: number, radius: number) => boolean,
  map: GameMap,
  dt: number,
): RocketExplosion[] {
  const explosions: RocketExplosion[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    r.x += r.vx * dt;
    r.y += r.vy * dt;

    const hitEnemy = nearLivingEnemy(r.x, r.y, ROCKET_ENEMY_TRIGGER_RADIUS);
    const hitWall = isWall(map, Math.floor(r.x), Math.floor(r.y));
    if (hitEnemy || hitWall) {
      explosions.push({ x: r.x, y: r.y, damage: r.damage, firedBy: r.firedBy });
      list.splice(i, 1);
    }
  }
  return explosions;
}

/** Distance-scaled splash damage `explosion` deals at (`tx`,`ty`) — 0 outside
 * `ROCKET_BLAST_RADIUS` entirely, same falloff shape as a proximity mine. */
export function rocketDamageAt(explosion: RocketExplosion, tx: number, ty: number): number {
  const distance = Math.hypot(explosion.x - tx, explosion.y - ty);
  if (distance >= ROCKET_BLAST_RADIUS) return 0;
  const falloff = Math.max(ROCKET_DAMAGE_FALLOFF_FLOOR, 1 - distance / ROCKET_BLAST_RADIUS);
  return explosion.damage * falloff;
}

/** Collect in-flight rockets as small glowing orange billboard draw jobs,
 * wall-occluded like every other world sprite. See `collectOrbBillboards` in
 * `sprites.ts`. */
export function collectRocketBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: Rocket[],
  zBuffer: Float64Array,
): BillboardJob[] {
  return collectOrbBillboards(ctx, player, list, zBuffer, {
    halo: "rgba(255,140,40,0.35)",
    core: "#ff6a2a",
    center: "#ffd9a0",
  });
}

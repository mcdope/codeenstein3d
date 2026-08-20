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
import {
  ROCKET_BLAST_RADIUS,
  ROCKET_DAMAGE_FALLOFF_FLOOR,
  ROCKET_ENEMY_TRIGGER_RADIUS,
  ROCKET_SPEED,
} from "./combatConstants";

// Re-exported because `engine.ts` and the sprite layer already import it from
// here; the value itself now lives in `combatConstants.ts` so plain-Node
// consumers can read it without bundling the renderer.
export { ROCKET_BLAST_RADIUS };


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
  /**
   * Whether this detonation was triggered by a living enemy inside
   * `ROCKET_ENEMY_TRIGGER_RADIUS` rather than by a wall.
   *
   * Telemetry only — nothing in the simulation reads it, and the damage
   * fan-out is identical either way (`rocketDamageAt` works off distance from
   * the blast point, not off what stopped the rocket). It exists because the
   * distinction is otherwise unrecoverable after the fact, and it is exactly
   * the one the 2026-08-19 tunnelling analysis had to *simulate* to answer:
   * a rocket that sails past its target and detonates on the wall behind
   * still does splash damage, so "did it connect" cannot be inferred from the
   * damage it dealt.
   */
  hitEnemy: boolean;
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
/**
 * Furthest a rocket may travel between collision samples, in tiles.
 *
 * Half `ROCKET_ENEMY_TRIGGER_RADIUS`: a target directly on the flight line is
 * then never more than 0.1 tiles from the nearest sample, so nearly the whole
 * trigger radius stays usable for targets offset laterally. Independent of
 * `dt`, which is the point — the outcome must not depend on how finely the
 * frame clock happens to be chopped.
 */
const ROCKET_MAX_SUBSTEP_TILES = ROCKET_ENEMY_TRIGGER_RADIUS / 2;

export function updateRockets(
  list: Rocket[],
  nearLivingEnemy: (x: number, y: number, radius: number) => boolean,
  map: GameMap,
  dt: number,
): RocketExplosion[] {
  const explosions: RocketExplosion[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    // Sub-step, because collision here is a *point sample* at the end of the
    // move and a rocket is the fastest thing in the game.
    //
    // At `ROCKET_SPEED` 18 t/s a single 50ms step advances **0.90 tiles**,
    // while the window around an enemy is only `2 * ROCKET_ENEMY_TRIGGER_RADIUS`
    // = 0.80 wide — so a rocket could straddle a target completely and sail
    // past it. Measured before this fix: **11.1% of target positions along the
    // flight line were unhittable at 50ms**, exactly `(0.90 - 0.80) / 0.90`,
    // and every one of them was hit at 60Hz.
    //
    // That mattered beyond the odd missed shot because 50ms is not a rare
    // frame — it is `MAX_DT`, and the balancing harness pumps *exactly* one
    // 50ms frame per bot decision, so every balance number gathered before
    // this understated ghidra by roughly a ninth of its shots. See
    // `dtInvariance.test.ts`.
    //
    // A swept segment-to-point distance would be exact, but `nearLivingEnemy`
    // takes a point and a radius (it is backed by the spatial grid), so
    // sub-stepping keeps that contract. The step is half the trigger radius:
    // with samples 0.2 apart the worst-case gap to a target on the line is
    // 0.1, leaving essentially the whole radius usable laterally.
    const speed = Math.hypot(r.vx, r.vy);
    const subSteps = Math.max(1, Math.ceil((speed * dt) / ROCKET_MAX_SUBSTEP_TILES));
    const subDt = dt / subSteps;
    for (let s = 0; s < subSteps; s++) {
      r.x += r.vx * subDt;
      r.y += r.vy * subDt;

      const hitEnemy = nearLivingEnemy(r.x, r.y, ROCKET_ENEMY_TRIGGER_RADIUS);
      const hitWall = isWall(map, Math.floor(r.x), Math.floor(r.y));
      if (hitEnemy || hitWall) {
        explosions.push({ x: r.x, y: r.y, damage: r.damage, firedBy: r.firedBy, hitEnemy });
        list.splice(i, 1);
        break;
      }
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

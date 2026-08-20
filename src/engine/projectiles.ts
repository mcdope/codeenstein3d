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
import { ENEMY_WEAPONS, PROJECTILE_RADIUS, type EnemyArchetype, type EnemyWeapon } from "./combatConstants";


/** One in-flight enemy bolt, in world (tile) space. `targetId` locks the bolt
 * to whichever player it was fired at — see `updateProjectiles`' own doc
 * comment for why this matters (a bolt must never redirect onto a different
 * player just because it geometrically passes through them). */
export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  targetId: string;
  /**
   * Collision half-size, carried per bolt rather than read from a module
   * constant, because it is a per-archetype weapon field now
   * (`ENEMY_WEAPONS`). Optional, defaulting to the shared
   * `PROJECTILE_RADIUS`, so the many test literals that predate the weapon
   * table keep compiling and keep their old behaviour.
   */
  radius?: number;
  /**
   * Which archetype's weapon fired this — rendering only (it picks the
   * palette), never read by the simulation. Optional for the same reason as
   * `radius`; an absent one renders as `normal`.
   */
  archetype?: EnemyArchetype;
  /**
   * Index into the engine's `enemies` array of whoever fired this bolt, so a
   * landing hit can say which enemy dealt the damage. Purely for telemetry
   * attribution — nothing in the simulation reads it, so it changes no
   * behaviour and consumes no RNG.
   *
   * An index rather than a reference: that array is assigned once at engine
   * construction and never spliced, so indices are stable for a level's whole
   * lifetime, and it is the same `eid` the `hit`/`kill`/`damageDealt` events
   * already use — which lets the `levelStart` roster resolve it to an
   * archetype without this field having to carry one.
   *
   * Optional because tests construct `Projectile` literals directly.
   */
  srcEid?: number;
}

/** Spawn a bolt at (x,y) heading toward (tx,ty) — the position of the player
 * identified by `targetId` at the moment of firing — optionally rotated off
 * dead-center by a random angle up to `aimSpreadDeg` in either direction.
 *
 * `weapon` is the firing archetype's entry in `ENEMY_WEAPONS` and supplies
 * speed, damage, collision size and its own inherent scatter. It replaces the
 * old `damageMultiplier` parameter: the archetype ladder is baked into
 * `weapon.damage` now, so the only thing left to scale is `damageScale` —
 * multiplayer's player-count Elite scaling, which is Elite-only and cannot be
 * a property of the weapon because it depends on how many players are in the
 * game.
 *
 * `aimSpreadDeg` is the *difficulty's* `enemyAimSpreadDeg`; the weapon's own
 * `spreadDeg` is added to it here rather than by the caller, so no call site
 * can forget one half of the sum.
 *
 * `rng` defaults to `Math.random` but `RaycasterEngine` always passes its own
 * seeded stream instead, same reason `enemyAi.ts`'s doc comment gives for
 * roam-target picking and fire-cooldown jitter — this changes enemy
 * behavior, which the replay system's determinism depends on.
 *
 * **Note the RNG consumption is now weapon-dependent.** A draw happens only
 * when the total spread is above zero, so an Edge Case consumes one where it
 * previously consumed none on Hard (`enemyAimSpreadDeg` 0). That is a
 * deliberate, deterministic change — it shifts the seeded stream, which is
 * part of why this lands with a `defaultHighscore.ts` regeneration. */
export function spawnProjectile(
  list: Projectile[],
  x: number,
  y: number,
  tx: number,
  ty: number,
  targetId: string,
  weapon: EnemyWeapon = ENEMY_WEAPONS.normal,
  damageScale = 1,
  aimSpreadDeg = 0,
  rng: () => number = Math.random,
  /** See `Projectile.srcEid` — telemetry attribution only. Deliberately last,
   * *after* `rng`, so every existing positional call site keeps passing its
   * seeded stream in the same slot: this must not perturb RNG consumption. */
  srcEid?: number,
): void {
  const dx = tx - x;
  const dy = ty - y;
  const d = Math.hypot(dx, dy) || 1;
  let dirX = dx / d;
  let dirY = dy / d;
  const spreadDeg = aimSpreadDeg + weapon.spreadDeg;
  if (spreadDeg > 0) {
    const angle = (rng() * 2 - 1) * (spreadDeg * (Math.PI / 180));
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
    vx: dirX * weapon.speed,
    vy: dirY * weapon.speed,
    damage: weapon.damage * damageScale,
    targetId,
    radius: weapon.radius,
    archetype: weapon.archetype,
    srcEid,
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
 * Advance every bolt by `dt`, removing any that struck their locked target
 * (whose AABB is a box of half-width `player.radius`) or hit a wall / left
 * the map. A bolt can only ever hit the single player it was fired at
 * (`targetId`, set once at `spawnProjectile()` time) — never a different
 * player it happens to fly past. This matters specifically when the original
 * target dies mid-flight: without this lock, an in-flight bolt aimed at a
 * now-dead player would keep traveling its old straight line and could land
 * on a completely unrelated player who was never actually threatened by the
 * enemy that fired it. If the locked target isn't in `targets` anymore
 * (dead/disconnected), the bolt simply can't hit anyone this frame — it
 * keeps flying harmlessly until it hits a wall or leaves the map. Returns
 * per-player damage attribution for whoever a bolt actually landed on.
 */
export function updateProjectiles(
  list: Projectile[],
  targets: readonly ProjectileTarget[],
  map: GameMap,
  dt: number,
  /** Fired once per bolt that actually lands, carrying which enemy fired it
   * (`Projectile.srcEid`) and how much it dealt. A callback rather than a
   * richer return type so the summed `Map` every caller already destructures
   * keeps its shape — the same reason `EnemyAiEvents` exists next door. */
  onHit?: (srcEid: number | undefined, targetId: string, amount: number, x: number, y: number) => void,
): Map<string, number> {
  const damage = new Map<string, number>();
  const targetsById = new Map(targets.map((t) => [t.id, t]));
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Player AABB hit takes precedence (you can get shot with your back to a wall).
    const target = targetsById.get(p.targetId);
    if (target) {
      const reach = target.player.radius + (p.radius ?? PROJECTILE_RADIUS);
      if (Math.abs(p.x - target.player.posX) < reach && Math.abs(p.y - target.player.posY) < reach) {
        damage.set(target.id, (damage.get(target.id) ?? 0) + p.damage);
        // The bolt's position at impact — the status-bar face reads it to look
        // toward the hit. See `RaycasterEngine.noteHurtFrom`.
        onHit?.(p.srcEid, target.id, p.damage, p.x, p.y);
        list.splice(i, 1);
        continue;
      }
    }
    // Wall (or out-of-bounds, which isWall reports as solid) destroys the bolt.
    if (isWall(map, Math.floor(p.x), Math.floor(p.y))) {
      list.splice(i, 1);
    }
  }
  return damage;
}

/** Collect bolts as small glowing orb draw jobs at eye level, wall-occluded,
 * coloured by the archetype that fired them — magenta for a regular enemy,
 * hot orange for an Elite's heavy shell, pale cyan for an Edge Case's spray.
 * See `collectOrbBillboards` in `sprites.ts`.
 *
 * The palette is resolved per bolt rather than per call because one frame can
 * hold bolts from all three archetypes at once. Passing a resolver keeps that
 * allocation-free — grouping the list by archetype first would mean up to
 * three temporary arrays every frame, on the render path. */
export function collectProjectileBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: Projectile[],
  zBuffer: Float64Array,
): BillboardJob[] {
  return collectOrbBillboards(ctx, player, list, zBuffer, (p) => ENEMY_WEAPONS[p.archetype ?? "normal"].palette);
}

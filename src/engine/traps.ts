// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Runtime behavior for the two trap kinds `MapGenerator` scatters at corridor
 * choke points (see `placeTraps` in `map/mapGenerator.ts`). `SpikeTrap`/`Mine`
 * stay plain data on `GameMap`; this module reads/mutates them, following the
 * same split used for enemies (`enemyAi.ts`) and projectiles (`projectiles.ts`).
 */
import type { Mine, SpikeTrap } from "../map/types";
import type { Player } from "./player";

/** Stability drained per second while standing on an active spike tile. */
const SPIKE_DPS = 20;
/**
 * Tiles within which a mine becomes visible (sticky — once seen, stays seen).
 * Deliberately much larger than `MINE_FUSE_RADIUS` so spotting one and
 * actually being in danger from it are two different moments: playtest
 * feedback was that mines were visible too late to do anything about, so
 * "seen" now happens well before "dangerous".
 */
const MINE_SIGHT_RADIUS = 4.5;
/** Tiles within which a mine actually starts arming its fuse. */
const MINE_FUSE_RADIUS = 1.8;
/** Seconds the player must stay inside the fuse radius before it blows. */
const MINE_FUSE_SECONDS = 0.9;
/** Radius (tiles) of a mine's blast; damage falls off with distance inside it,
 * and is 0 entirely outside it — so shooting one from far enough away (see
 * `detonateMine`) is a genuinely safe way to clear it, not just a formality.
 * Exported so `RaycasterEngine` can size the same explosion VFX (ring +
 * spark particles) a rocket uses (see `rockets.ts`'s `ROCKET_BLAST_RADIUS`). */
export const MINE_BLAST_RADIUS = 2.4;
/** Damage dealt at ground zero; the falloff floor keeps even an edge-of-blast
 * hit meaningful rather than trailing off to nothing. */
const MINE_MAX_DAMAGE = 32;
const MINE_DAMAGE_FALLOFF_FLOOR = 0.35;

/** Whether `trap` is in its damaging half of the cycle at `levelTime` seconds. */
export function isSpikeActive(trap: SpikeTrap, levelTime: number): boolean {
  const t = (levelTime + trap.phase) % trap.period;
  return t >= trap.period / 2;
}

/**
 * "x,y" tile keys of every spike trap currently active, computed once per
 * frame — the floor-cast renderer looks tiles up in this set per-pixel rather
 * than recomputing each trap's phase for every pixel it touches.
 */
export function activeSpikeTileKeys(traps: readonly SpikeTrap[], levelTime: number): Set<string> {
  const keys = new Set<string>();
  for (const trap of traps) {
    if (isSpikeActive(trap, levelTime)) keys.add(`${trap.x},${trap.y}`);
  }
  return keys;
}

/** Stability loss (already dt-scaled) if the player is standing on a spike
 * tile currently in its active phase; 0 otherwise. */
export function spikeDamage(
  traps: readonly SpikeTrap[],
  player: Player,
  levelTime: number,
  dt: number,
): number {
  const cx = Math.floor(player.posX);
  const cy = Math.floor(player.posY);
  const trap = traps.find((t) => t.x === cx && t.y === cy);
  if (!trap || !isSpikeActive(trap, levelTime)) return 0;
  return SPIKE_DPS * dt;
}

/**
 * Detonate `mine` (marking it permanently dead) and return the distance-scaled
 * AoE damage this deals to `player` right now — 0 if they're outside the blast
 * radius entirely. Shared by the proximity fuse (`updateMines`) and gunfire
 * (a mine hit by a pellet — see `RaycasterEngine.fire()`): shooting one from
 * beyond its blast radius is a genuinely safe way to clear it, not just a
 * formality, since both paths use the same falloff.
 */
export function detonateMine(mine: Mine, player: Player): number {
  mine.alive = false;
  const distance = Math.hypot(mine.x - player.posX, mine.y - player.posY);
  if (distance >= MINE_BLAST_RADIUS) return 0;
  const falloff = Math.max(MINE_DAMAGE_FALLOFF_FLOOR, 1 - distance / MINE_BLAST_RADIUS);
  return MINE_MAX_DAMAGE * falloff;
}

/** Where and how hard a mine detonated on its own (proximity fuse), for the
 * caller to fan out matching VFX — mirrors `RocketExplosion` in `rockets.ts`. */
export interface MineDetonation {
  x: number;
  y: number;
  damage: number;
}

/**
 * Advance every live mine's state by `dt` seconds. A mine within
 * `MINE_SIGHT_RADIUS` becomes visible — sticky, so once spotted it stays on
 * the radar even if the player backs out that far again. Only within the much
 * tighter `MINE_FUSE_RADIUS` does its fuse actually start counting; stepping
 * back out of that resets the timer (the "immediately back away" grace). One
 * that reaches the fuse threshold detonates for distance-scaled AoE damage.
 * Returns one entry per mine that went off this frame (almost always 0 or 1,
 * but never assumed to be capped at that).
 */
export function updateMines(mines: Mine[], player: Player, dt: number): MineDetonation[] {
  const detonations: MineDetonation[] = [];
  for (const mine of mines) {
    if (!mine.alive) continue;
    const distance = Math.hypot(mine.x - player.posX, mine.y - player.posY);
    if (distance <= MINE_SIGHT_RADIUS) mine.visible = true;

    if (distance > MINE_FUSE_RADIUS) {
      mine.closeTimer = 0;
      continue;
    }
    mine.closeTimer += dt;
    if (mine.closeTimer < MINE_FUSE_SECONDS) continue;

    detonations.push({ x: mine.x, y: mine.y, damage: detonateMine(mine, player) });
  }
  return detonations;
}

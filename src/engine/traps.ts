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
const SPIKE_DPS = 34;
/** Tiles within which a mine notices the player and starts its fuse. */
const MINE_PROXIMITY_RADIUS = 1.6;
/** Seconds the player must stay inside the proximity radius before it blows. */
const MINE_FUSE_SECONDS = 0.6;
/** Radius (tiles) of a mine's blast; damage falls off with distance inside it. */
const MINE_BLAST_RADIUS = 2.2;
/** Damage dealt at ground zero; the falloff floor keeps even an edge-of-blast
 * hit meaningful rather than trailing off to nothing. */
const MINE_MAX_DAMAGE = 55;
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
 * Advance every live mine's proximity fuse by `dt` seconds. A mine within
 * `MINE_PROXIMITY_RADIUS` becomes visible and starts counting; stepping back
 * out resets its timer (the "immediately back away" grace). One that reaches
 * the fuse threshold detonates: it goes permanently dead and contributes
 * distance-scaled AoE damage to the returned total.
 */
export function updateMines(mines: Mine[], player: Player, dt: number): number {
  let damage = 0;
  for (const mine of mines) {
    if (!mine.alive) continue;
    const distance = Math.hypot(mine.x - player.posX, mine.y - player.posY);
    if (distance > MINE_PROXIMITY_RADIUS) {
      mine.closeTimer = 0;
      continue;
    }
    mine.visible = true;
    mine.closeTimer += dt;
    if (mine.closeTimer < MINE_FUSE_SECONDS) continue;

    mine.alive = false;
    const falloff = Math.max(MINE_DAMAGE_FALLOFF_FLOOR, 1 - distance / MINE_BLAST_RADIUS);
    damage += MINE_MAX_DAMAGE * falloff;
  }
  return damage;
}

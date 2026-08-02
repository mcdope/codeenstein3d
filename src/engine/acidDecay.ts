// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Runtime behavior for an Exception Handling Zone's `try` gauntlet: step in
 * the acid and that tile starts burning out, vanishing a couple of seconds
 * later. The toll is paid once — come back through with the `catch`/`finally`
 * loot and the floor you already crossed is inert.
 *
 * The gauntlet is deliberately unavoidable (see `placeExceptionZones`), which
 * is the whole point of a `try` block, but "unavoidable" was being charged
 * twice: the zone dead-ends, so the only way out is back the way you came,
 * through the identical acid, at full `HAZARD_DPS`. Decay keeps the entry cost
 * and drops the exit tax.
 *
 * ## Why this derives the grid instead of emitting a mutation
 *
 * `RaycasterEngine`'s `pendingGridDelta` is additive-only, and a door opening
 * or a secret wall flooding away pushes `{value: 0}` — so a decay mutation
 * would in fact satisfy that invariant, unlike Acid Overflow's `0 →
 * HAZARD_TILE` (see `acidOverflow.ts`). It still doesn't use it, for the other
 * half of that module's reasoning: a guest that mispredicts contact would
 * decay a tile the host hasn't, and an additive-only channel can never put it
 * back. Deriving the grid from `touchedAt` every tick retracts as readily as
 * it applies, and is safe for exactly the same reason Acid Overflow's is —
 * the tile set is fixed at generation time and provably disjoint from every
 * other tile-claiming system, since `placeExceptionZones` carves into
 * untouched rock.
 *
 * `gridVersion` is deliberately not bumped, also matching Acid Overflow: acid
 * is walkable either way (`isWall` excludes `HAZARD_TILE`), so nothing that
 * caches on walkability — the shared path field, the minimap's wall layer —
 * is stale because a tile stopped burning.
 */
import { HAZARD_TILE, type ExceptionZone, type Point, type Tile } from "../map/types";

/** Seconds between a player first touching a gauntlet tile and it burning
 * out. Long enough that crossing a five-tile shaft still costs real health at
 * `HAZARD_DPS`, short enough that the return trip is clean. */
export const ACID_DECAY_SECONDS = 2.5;

/** The only part of a `Player` this needs — its collision box. Structural for
 * the same reason `AcidOverflowActor` is: a plain literal should be enough to
 * call it from a test. */
export interface AcidDecayActor {
  posX: number;
  posY: number;
  radius: number;
}

/**
 * Per-level decay state: `levelTime` at which each gauntlet tile was first
 * touched, keyed `"x,y"`. Absent means untouched, and a tile is never keyed
 * twice — the first contact starts the clock and later ones don't restart it.
 */
export type AcidDecayState = Map<string, number>;

export function createAcidDecayState(): AcidDecayState {
  return new Map();
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Every tile that may decay: acid inside some zone's `try` gauntlet.
 *
 * Read from the grid rather than from a stored list so a tile another system
 * legitimately owns can never be claimed by mistake — `placeExceptionZones`
 * puts spikes *instead of* acid on some tiles of the same shaft ("a tile is
 * one hazard kind"), and only the ones that actually ended up `HAZARD_TILE`
 * are ours. Called once per level, not per tick.
 */
export function decayableTiles(zones: readonly ExceptionZone[], grid: readonly Tile[][]): Point[] {
  const tiles: Point[] = [];
  for (const zone of zones) {
    for (let y = zone.tryRect.y; y < zone.tryRect.y + zone.tryRect.h; y++) {
      for (let x = zone.tryRect.x; x < zone.tryRect.x + zone.tryRect.w; x++) {
        if (grid[y]?.[x] === HAZARD_TILE) tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

/** Whether `actor`'s collision box overlaps tile `(x, y)`. Box-vs-tile rather
 * than centre-in-tile: the acid should start burning the moment you're
 * standing in it, which is the same test `applyHazardDamage` effectively
 * makes by sampling the tile under the player. */
function touching(actor: AcidDecayActor, x: number, y: number): boolean {
  return (
    actor.posX + actor.radius > x &&
    actor.posX - actor.radius < x + 1 &&
    actor.posY + actor.radius > y &&
    actor.posY - actor.radius < y + 1
  );
}

/**
 * Start the clock on any gauntlet tile a living player is standing in, then
 * reconcile the grid against every clock — writing floor where the timer has
 * elapsed and acid back where it hasn't.
 *
 * Both directions matter. Writing acid back is what makes a mispredicting
 * guest self-correct once the host's `touchedAt` arrives, and it costs
 * nothing on the host, where the condition simply never holds.
 *
 * Returns the tiles that finished decaying on *this* call, for the caller to
 * cue a local effect from. Nothing about that return value is simulation
 * state — peers that cue differently stay in lockstep.
 */
export function updateAcidDecay(
  tiles: readonly Point[],
  state: AcidDecayState,
  actors: readonly AcidDecayActor[],
  grid: Tile[][],
  levelTime: number,
): Point[] {
  const burnedOut: Point[] = [];
  for (const tile of tiles) {
    const k = key(tile.x, tile.y);
    if (!state.has(k) && actors.some((a) => touching(a, tile.x, tile.y))) {
      state.set(k, levelTime);
    }

    const touchedAt = state.get(k);
    const gone = touchedAt !== undefined && levelTime - touchedAt >= ACID_DECAY_SECONDS;
    const current = grid[tile.y]?.[tile.x];
    if (gone && current === HAZARD_TILE) {
      grid[tile.y][tile.x] = 0;
      burnedOut.push(tile);
    } else if (!gone && current === 0) {
      // Retraction: a guest decayed this early and the host says otherwise.
      grid[tile.y][tile.x] = HAZARD_TILE;
    }
  }
  return burnedOut;
}

/**
 * How far through burning out a tile is, 0 (untouched) to 1 (gone) — for
 * rendering a tile that is visibly draining rather than blinking out. Returns
 * 0 for a tile that was never touched.
 */
export function acidDecayProgress(state: AcidDecayState, x: number, y: number, levelTime: number): number {
  const touchedAt = state.get(key(x, y));
  if (touchedAt === undefined) return 0;
  const t = (levelTime - touchedAt) / ACID_DECAY_SECONDS;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

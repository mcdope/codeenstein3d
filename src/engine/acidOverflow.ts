// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Runtime behavior for the "Acid Overflow" rooms `MapGenerator` plans for
 * allocation-dense functions (see `planAcidOverflows` in
 * `map/generation/acidOverflow.ts`). Walk into one and its floor starts
 * flooding, one tile at a time; kill the enemy representing the leaking
 * function and the flood freezes where it is.
 *
 * `AcidOverflow` stays plain data on `GameMap`; this module owns the per-level
 * runtime state and reconciles the grid against it — the same split
 * `enemyAi.ts` and `traps.ts` already use.
 *
 * ## Why this never touches `pendingGridDelta`
 *
 * `RaycasterEngine.applyGridReconciliation` carries a LOAD-BEARING INVARIANT:
 * every emitted `TileMutation.value` is `0`, which is exactly what makes
 * applying a snapshot's grid out of order safe, and therefore what lets the
 * guest apply grid corrections outside its exact-tick gate. An acid mutation
 * is `0 → HAZARD_TILE`, and `gridDelta` is additive-only, so routing acid
 * through it would both violate the invariant literally and leave a guest that
 * mis-predicted room entry with permanent phantom acid it could never retract.
 *
 * Instead the grid is *derived* from a tiny piece of per-overflow state, which
 * rides the reconciliation snapshot like `MineSnapshot` does — behind the
 * exact-tick gate, alongside the other PRNG-coupled state. `applied` is
 * deliberately not transmitted: it's a pure local derivation, re-reconciled on
 * the very next tick, **including retracting** tiles a guest speculatively
 * flooded. Retraction is only safe because the candidate tile list was
 * precomputed at generation time and is provably disjoint from every other
 * tile-claiming system.
 */
import { HAZARD_TILE, type AcidOverflow, type Enemy, type Point, type Tile } from "../map/types";

/** The only part of a `Player` this module needs — its collision box. Taken
 * structurally rather than as a full `Player` so the room-entry test stays
 * trivially callable with a plain literal, the same way `enemyAi.ts`'s helpers
 * keep their inputs as narrow as the work actually requires. */
export interface AcidOverflowActor {
  posX: number;
  posY: number;
  radius: number;
}

/** Per-overflow runtime state. One entry per `GameMap.acidOverflows` entry,
 * index-aligned. */
export interface AcidOverflowState {
  /** `levelTime` at which the first living player entered the room, or `null`
   * while nobody has. */
  startedAt: number | null;
  /** Tile count frozen in at the moment the assigned enemy died, or `null`
   * while it's still alive and the flood is still growing. */
  frozenTarget: number | null;
  /**
   * How many tiles this peer currently has written as acid. Purely local and
   * derived — never transmitted, and re-reconciled against `startedAt`/
   * `frozenTarget` every tick, in both directions.
   */
  applied: number;
}

export function createAcidOverflowStates(count: number): AcidOverflowState[] {
  return Array.from({ length: count }, () => ({ startedAt: null, frozenTarget: null, applied: 0 }));
}

/**
 * How many of `overflow.tiles` should be acid right now. Pure, and a function
 * of nothing but `levelTime` (bit-identical repeated addition on every peer),
 * the recorded `startedAt`, and the generation-time `intervalSeconds` — no
 * randomness, no per-peer recomputation.
 */
export function acidFillTarget(overflow: AcidOverflow, state: AcidOverflowState, levelTime: number): number {
  if (state.startedAt === null) return 0;
  const elapsed = levelTime - state.startedAt;
  return Math.min(overflow.tiles.length, Math.max(0, Math.floor(elapsed / overflow.intervalSeconds)));
}

/**
 * Advance every overflow one tick against the living players' positions, then
 * reconcile `grid` to the result — writing `HAZARD_TILE` forward, and plain
 * floor *back* for any tile past a lowered target.
 *
 * The room-entry test reuses `updateRoomDiscovery`'s exact AABB shape (the
 * player's collision box against the room rect), so "you're in the room"
 * means the same thing here as it does for discovering an enemy.
 */
export function updateAcidOverflows(
  overflows: readonly AcidOverflow[],
  states: AcidOverflowState[],
  enemies: readonly Enemy[],
  players: readonly AcidOverflowActor[],
  grid: Tile[][],
  levelTime: number,
): void {
  for (let i = 0; i < overflows.length; i++) {
    const overflow = overflows[i];
    const state = states[i];

    if (state.startedAt === null && players.some((p) => intersectsRoom(p, overflow))) {
      state.startedAt = levelTime;
    }

    // Polled rather than hooked into `damageEnemy`'s kill branch on purpose:
    // a guest's enemy can also die by being overwritten in
    // `applyReconciliationSnapshot`, which bypasses `damageEnemy` entirely —
    // a hook there would simply never fire for that peer and the flood would
    // grow forever on it.
    if (state.frozenTarget === null && enemies[overflow.enemyIndex]?.alive === false) {
      state.frozenTarget = acidFillTarget(overflow, state, levelTime);
    }

    const target = state.frozenTarget ?? acidFillTarget(overflow, state, levelTime);
    for (let t = state.applied; t < target; t++) {
      const tile = overflow.tiles[t];
      grid[tile.y][tile.x] = HAZARD_TILE;
    }
    for (let t = target; t < state.applied; t++) {
      const tile = overflow.tiles[t];
      grid[tile.y][tile.x] = 0;
    }
    state.applied = target;
  }
}

/**
 * Every tile currently flooded, for the corner minimap's hazard marker pass.
 * `GameMap.hazards` deliberately doesn't grow at runtime (it's painted
 * unconditionally, with no grid re-check, and would need to be retractable),
 * so this is computed per frame instead — the same shape as
 * `activeSpikeTileKeys`.
 */
export function acidTiles(
  overflows: readonly AcidOverflow[],
  states: readonly AcidOverflowState[],
): Point[] {
  const tiles: Point[] = [];
  for (let i = 0; i < overflows.length; i++) {
    tiles.push(...overflows[i].tiles.slice(0, states[i].applied));
  }
  return tiles;
}

/** The player's collision box against the room rect — `updateRoomDiscovery`'s
 * test, kept identical so "inside the room" means one thing engine-wide. */
function intersectsRoom(player: AcidOverflowActor, overflow: AcidOverflow): boolean {
  const r = player.radius;
  const { x, y, w, h } = overflow.room;
  return player.posX + r > x && player.posX - r < x + w && player.posY + r > y && player.posY - r < y + h;
}

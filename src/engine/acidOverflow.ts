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
import { HAZARD_TILE, type AcidOverflow, type Enemy, type Point, type Rect, type Tile } from "../map/types";

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
 *
 * Returns the indices of any overflows that started flooding on *this* tick,
 * for the caller to hang purely cosmetic feedback off (a sound, a toast — see
 * `RaycasterEngine.simulate`). Returned rather than fired from in here so this
 * module stays free of audio/HUD concerns, the same way `enemyAi.ts` reports
 * through `EnemyAiEvents` instead of playing its own sounds.
 */
export function updateAcidOverflows(
  overflows: readonly AcidOverflow[],
  states: AcidOverflowState[],
  enemies: readonly Enemy[],
  players: readonly AcidOverflowActor[],
  grid: Tile[][],
  levelTime: number,
): number[] {
  const startedNow: number[] = [];
  for (let i = 0; i < overflows.length; i++) {
    const overflow = overflows[i];
    const state = states[i];

    if (state.startedAt === null && players.some((p) => intersectsRoom(p, overflow))) {
      state.startedAt = levelTime;
      startedNow.push(i);
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
  return startedNow;
}

/** Shared empty result, so the overwhelmingly common cases — a level with no
 * overflow rooms at all, or none entered yet — cost no allocation per frame.
 * Same reasoning as `raycaster.ts`'s own `NO_READ_TERMINALS`. */
const NO_ACID_TILES: readonly Point[] = [];

/**
 * Every tile currently flooded, for the corner minimap's hazard marker pass.
 * `GameMap.hazards` deliberately doesn't grow at runtime (it's painted
 * unconditionally, with no grid re-check, and would need to be retractable),
 * so this is computed per frame instead — the same shape as
 * `activeSpikeTileKeys`.
 *
 * The returned points are the *same objects* held in `overflow.tiles`, not
 * copies: they're read-only tile coordinates that live for the whole level, so
 * copying them once per frame would be pure garbage for no safety gained.
 */
export function acidTiles(
  overflows: readonly AcidOverflow[],
  states: readonly AcidOverflowState[],
): readonly Point[] {
  let total = 0;
  for (let i = 0; i < overflows.length; i++) total += states[i].applied;
  if (total === 0) return NO_ACID_TILES;

  const tiles: Point[] = [];
  for (let i = 0; i < overflows.length; i++) {
    const planned = overflows[i].tiles;
    for (let t = 0; t < states[i].applied; t++) tiles.push(planned[t]);
  }
  return tiles;
}

/** The player's collision box against the room rect — `updateRoomDiscovery`'s
 * test, kept identical so "inside the room" means one thing engine-wide.
 *
 * Exported because a flood is started by *any* living player, but its cue is
 * only worth showing to one who can actually see it: in a coop session a
 * teammate walking into a room on the far side of the level shouldn't put a
 * warning on your screen. */
export function intersectsRoom(player: AcidOverflowActor, overflow: AcidOverflow): boolean {
  return intersectsRect(player, overflow.room);
}

/** The same test against a bare rect, optionally grown by `margin` tiles on
 * every side.
 *
 * Split out of `intersectsRoom` rather than copied so the engine keeps exactly
 * one definition of "the player is in this box" — the point of that function's
 * comment above. `margin` is what makes it usable for *proximity* as well as
 * containment: the key hint wants "walked past the doorway", which is the room
 * rect plus a tile or so of the corridor outside it, not the room itself. */
export function intersectsRect(player: AcidOverflowActor, rect: Rect, margin = 0): boolean {
  const r = player.radius + margin;
  const { x, y, w, h } = rect;
  return player.posX + r > x && player.posX - r < x + w && player.posY + r > y && player.posY - r < y + h;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Elite HP/damage scaling by player count (multiplayer step 9,
 * `doc/dev/multiplayer-game-state-spec.md` §4). Unlike `difficulty.ts`
 * (`src/`-root, since both the map and engine layers need it), this is
 * consumed entirely within the engine layer — `RaycasterEngine`'s
 * constructor applies the HP multiplier once, at construction, the same spot
 * difficulty's own HP rescale already runs; `enemyAi.ts`'s `damageMultiplier`
 * applies the damage multiplier per-hit, since a single frame's aggregate
 * damage can already mix Elite and non-Elite hits (unlike difficulty's own
 * damage multiplier, which is safe to apply to that aggregate post-hoc).
 * Edge Case enemies are deliberately untouched — this is Elite-only scaling.
 */

export interface EliteScalingMultipliers {
  /** Multiplies an Elite's `hp`/`maxHp` once, at engine construction —
   * stacks with (multiplies on top of) `ELITE_HP_MULTIPLIER`'s own base 4x,
   * which is already baked into `enemy.maxHp` at map-generation time. */
  hp: number;
  /** Multiplies an Elite's melee/ranged damage output, on top of
   * `ELITE_DAMAGE_MULTIPLIER`'s own base 2x. */
  damage: number;
}

/** How much extra HP/damage an Elite enemy gets per player beyond the
 * first — reasoned starting points ("each extra player adds half again the
 * HP a solo Elite would have, and a quarter more bite"), not validated ones;
 * see `doc/dev/balancing-telemetry.md` for the process that should tune
 * these once real multiplayer sessions can generate telemetry from, same as
 * every other balance constant in this codebase. */
const ELITE_HP_SCALE_PER_EXTRA_PLAYER = 0.5;
const ELITE_DAMAGE_SCALE_PER_EXTRA_PLAYER = 0.25;

/** `playerCount` <= 1 (single-player, or a not-yet-fully-joined multiplayer
 * session) returns the identity multiplier (1/1) — a formula, not a fixed
 * per-tier lookup table like `DIFFICULTY_MULTIPLIERS`, since player count is
 * an open-ended integer (the signaling server's own cap is 16 players, per
 * `multiplayer-server-spec.md`) rather than a fixed handful of named tiers. */
export function eliteScalingFor(playerCount: number): EliteScalingMultipliers {
  const extra = Math.max(0, playerCount - 1);
  return {
    hp: 1 + extra * ELITE_HP_SCALE_PER_EXTRA_PLAYER,
    damage: 1 + extra * ELITE_DAMAGE_SCALE_PER_EXTRA_PLAYER,
  };
}

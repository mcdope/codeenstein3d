// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loot drop resolution: what a defeated (non-elite) enemy leaves behind, and
 * how much of it. Kept separate from `RaycasterEngine` (which owns the actual
 * drop list, pickup radius, and application of the effect) the same way
 * `enemyAi.ts`/`projectiles.ts`/`traps.ts` split behavior from state.
 */
import type { DifficultyLevel } from "../difficulty";
import type { LootKind } from "../map/types";

/** Relative odds of each loot kind on a regular enemy kill. Rockets are the
 * scarcest/highest-value ammo type, so they're weighted well below bullets;
 * health and swap sit in between. */
const LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 50 },
  { kind: "rockets", weight: 10 },
  { kind: "health", weight: 20 },
  { kind: "swap", weight: 20 },
];

/** Normal difficulty only: a slightly higher ammo (bullets/rockets) share than
 * the base `LOOT_WEIGHTS`, trimmed from health/swap — Easy/Hard already have
 * their own scarcity curve via `DifficultyMultipliers.ammoDropRate` (the
 * *amount* per drop), so this only tweaks Normal's drop *kind* odds, per
 * playtest feedback that ammo ran too scarce there specifically. */
const NORMAL_LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 58 },
  { kind: "rockets", weight: 12 },
  { kind: "health", weight: 15 },
  { kind: "swap", weight: 15 },
];

/** On a bonus (restock-arena) level, kills lean harder toward the scarcer,
 * higher-value drops — it's meant to feel like a resupply stop. */
const BONUS_LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 30 },
  { kind: "rockets", weight: 25 },
  { kind: "health", weight: 25 },
  { kind: "swap", weight: 20 },
];

/** Roll a random loot kind for a regular (non-elite) enemy kill, weighted by
 * `LOOT_WEIGHTS` (`NORMAL_LOOT_WEIGHTS` on Normal difficulty specifically, or
 * `BONUS_LOOT_WEIGHTS` on a bonus level, which takes priority over both).
 * Elites use their own guaranteed-drop logic instead — see
 * `RaycasterEngine`'s `dropEliteLoot`.
 *
 * `rng` defaults to `Math.random` but `RaycasterEngine` always passes its own
 * seeded stream instead — a loot roll changes what ammo/health is available
 * for the rest of the run, so it has to go through the same deterministic
 * source as everything else the replay system depends on (see `src/prng.ts`'s
 * doc comment for the full seeded/cosmetic split).
 *
 * `hasRocketLauncher` gates the `"rockets"` entry out of the weight table
 * entirely (rather than re-rolling into it) — until the launcher is
 * unlocked, rocket ammo would just be dead loot cluttering the drop, so its
 * share is redistributed across the remaining kinds instead. */
export function rollLoot(
  bonusLevel = false,
  difficulty: DifficultyLevel = "normal",
  rng: () => number = Math.random,
  hasRocketLauncher = true,
): Exclude<LootKind, "weapon"> {
  const weights = bonusLevel
    ? BONUS_LOOT_WEIGHTS
    : difficulty === "normal"
      ? NORMAL_LOOT_WEIGHTS
      : LOOT_WEIGHTS;
  const usable = hasRocketLauncher ? weights : weights.filter((w) => w.kind !== "rockets");
  const total = usable.reduce((sum, w) => sum + w.weight, 0);
  let r = rng() * total;
  for (const w of usable) {
    if (r < w.weight) return w.kind;
    r -= w.weight;
  }
  return usable[0].kind;
}

/** Default pickup amounts, per loot kind (overridable per-drop for elite
 * kills — see `LootDrop.amount`). */
export const BULLETS_DROP_AMOUNT = 6;
export const ROCKETS_DROP_AMOUNT = 2;
export const HEALTH_DROP_AMOUNT = 20;
export const SWAP_DROP_AMOUNT = 15;
/** Elite kills guarantee a bigger heal than a regular enemy's health drop. */
export const ELITE_HEALTH_DROP_AMOUNT = 50;
/** Maximum swap the player can stockpile. */
export const MAX_SWAP = 100;

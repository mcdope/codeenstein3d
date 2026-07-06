// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loot drop resolution: what a defeated (non-elite) enemy leaves behind, and
 * how much of it. Kept separate from `RaycasterEngine` (which owns the actual
 * drop list, pickup radius, and application of the effect) the same way
 * `enemyAi.ts`/`projectiles.ts`/`traps.ts` split behavior from state.
 */
import type { LootKind } from "../map/types";

/** Relative odds of each loot kind on a regular enemy kill. Rockets are the
 * scarcest/highest-value ammo type, so they're weighted well below bullets;
 * health and armor sit in between. */
const LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 50 },
  { kind: "rockets", weight: 10 },
  { kind: "health", weight: 20 },
  { kind: "armor", weight: 20 },
];

/** On a bonus (restock-arena) level, kills lean harder toward the scarcer,
 * higher-value drops — it's meant to feel like a resupply stop. */
const BONUS_LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 30 },
  { kind: "rockets", weight: 25 },
  { kind: "health", weight: 25 },
  { kind: "armor", weight: 20 },
];

/** Roll a random loot kind for a regular (non-elite) enemy kill, weighted by
 * `LOOT_WEIGHTS` (or `BONUS_LOOT_WEIGHTS` on a bonus level). Elites use their
 * own guaranteed-drop logic instead — see `RaycasterEngine`'s `dropEliteLoot`. */
export function rollLoot(bonusLevel = false): Exclude<LootKind, "weapon"> {
  const weights = bonusLevel ? BONUS_LOOT_WEIGHTS : LOOT_WEIGHTS;
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  let r = Math.random() * total;
  for (const w of weights) {
    if (r < w.weight) return w.kind;
    r -= w.weight;
  }
  return weights[0].kind;
}

/** Default pickup amounts, per loot kind (overridable per-drop for elite
 * kills — see `LootDrop.amount`). */
export const BULLETS_DROP_AMOUNT = 6;
export const ROCKETS_DROP_AMOUNT = 2;
export const HEALTH_DROP_AMOUNT = 20;
export const ARMOR_DROP_AMOUNT = 15;
/** Elite kills guarantee a bigger heal than a regular enemy's health drop. */
export const ELITE_HEALTH_DROP_AMOUNT = 50;
/** Maximum armor the player can stockpile. */
export const MAX_ARMOR = 100;

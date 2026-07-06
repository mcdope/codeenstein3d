// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Difficulty setting — scales enemy HP, enemy-dealt damage, and ammo/loot
 * drop amounts. Lives at the `src/` root, not under `map/` or `engine/`,
 * since both layers need it and the map layer must never import the engine
 * layer (see [[codeenstein-project]]'s layering rule) — a small, dependency-
 * free shared module is the cleanest way for both to read the same table
 * without creating a cross-layer import. In practice only `engine.ts`
 * currently reads it (enemy HP is rescaled in-place on the map's `Enemy`
 * objects right after construction, rather than threading difficulty through
 * `MapGenerator.generate()`), but the module stays layer-neutral regardless.
 */

export type DifficultyLevel = "easy" | "normal" | "hard";

export interface DifficultyMultipliers {
  /** Multiplies every enemy's `hp`/`maxHp` once, at engine construction. */
  hp: number;
  /** Multiplies damage the player takes from enemies (melee bites, ranged
   * bolts). Does not affect trap/hazard/self-inflicted (rocket splash) damage
   * — those aren't "enemy dealt". */
  damage: number;
  /** Multiplies the amount granted per ammo/health/armor pickup, both the
   * map's static pickups and enemies' dynamic loot drops. */
  ammoDropRate: number;
}

/** Per the task spec: Easy/Hard = 0.7x/1.5x enemy HP. Damage mirrors the HP
 * curve (a tougher/softer world should also hit proportionally harder/softer);
 * ammoDropRate moves the opposite way — Easy is more forgiving on resources,
 * Hard is scarcer, compounding with the tougher enemies rather than
 * offsetting them. */
export const DIFFICULTY_MULTIPLIERS: Record<DifficultyLevel, DifficultyMultipliers> = {
  easy: { hp: 0.7, damage: 0.7, ammoDropRate: 1.3 },
  normal: { hp: 1, damage: 1, ammoDropRate: 1 },
  hard: { hp: 1.5, damage: 1.5, ammoDropRate: 0.7 },
};

export const DEFAULT_DIFFICULTY: DifficultyLevel = "normal";

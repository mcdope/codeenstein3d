// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Difficulty setting — scales enemy HP, enemy-dealt damage, and ammo/loot
 * drop amounts, and sets how many rollbacks a run gets. Lives at the `src/`
 * root, not under `map/` or `engine/`,
 * since both layers need it and the map layer must never import the engine
 * layer (see `doc/dev/architecture.md`'s layering rule) — a small, dependency-
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
  /** Multiplies the amount granted per ammo/health/swap pickup, both the
   * map's static pickups and enemies' dynamic loot drops. */
  ammoDropRate: number;
  /** Max random angle (degrees, either direction) an enemy's ranged bolt can
   * deviate from a dead-on shot at the player's current position — see
   * `spawnProjectile` in `rockets.ts`'s sibling `projectiles.ts`. 0 means a
   * perfectly aimed shot (still dodgeable, since bolts don't track/home).
   * Balance telemetry found enemy hit rate sat in a narrow 70-77% band
   * regardless of difficulty tier — every difficulty axis before this one
   * only made enemies *tougher* (hp/damage), never *smarter*; this is the
   * first one that actually changes how well they aim. */
  enemyAimSpreadDeg: number;
}

/** Per the task spec: Easy/Hard = 0.7x/1.5x enemy HP. Hard's damage still
 * mirrors its HP curve (a tougher world should also hit proportionally
 * harder). Easy's damage no longer mirrors its own HP curve the same way —
 * balance telemetry (a 450-run, 9-combo campaign) found Easy's original 0.7x
 * combined with a cautious, health-seeking playstyle to produce near-total
 * immunity for the whole campaign (100% survival to level 15 in one combo,
 * where the other two profiles were already down to single digits by then)
 * — real stakes even on Easy, for a player who plays it safe, needed the
 * damage floor raised independently of the HP floor. ammoDropRate moves the
 * opposite way from HP/damage — Easy is more forgiving on resources, Hard is
 * scarcer, compounding with the tougher enemies rather than offsetting them. */
export const DIFFICULTY_MULTIPLIERS: Record<DifficultyLevel, DifficultyMultipliers> = {
  easy: { hp: 0.7, damage: 0.85, ammoDropRate: 1.3, enemyAimSpreadDeg: 10 },
  normal: { hp: 1, damage: 1, ammoDropRate: 1, enemyAimSpreadDeg: 4 },
  hard: { hp: 1.5, damage: 1.5, ammoDropRate: 0.7, enemyAimSpreadDeg: 0 },
};

/**
 * How many rollbacks (arcade continues) a fresh single-player run starts with.
 * Spending one restarts the level you died on from the state you entered it
 * with, rather than ending the run — see `main.ts`'s `onGameOver`.
 *
 * **A separate table rather than a field on `DifficultyMultipliers`, and the
 * distinction is not cosmetic.** Every member of that interface is a
 * *multiplier applied to a simulation quantity*, consumed inside the engine's
 * own combat maths (`engine.ts` resolves the table once at construction and
 * multiplies hp/damage/loot/aim by it). A retry budget is not a multiplier, is
 * never read by the engine's simulation at all, and is consumed by the app
 * shell — folding it in would make `DIFFICULTY_MULTIPLIERS`' name a lie and
 * invite the next reader to treat it as another combat knob.
 *
 * The counts run the same direction as every other difficulty axis (Easy most
 * forgiving, Hard least), so they compound with the HP/damage/loot curve rather
 * than offsetting it — the same principle `DIFFICULTY_MULTIPLIERS`'
 * `ammoDropRate` follows.
 *
 * **Hard is deliberately zero**, which makes it the one tier where death is
 * still final and the Kernel Panic screen keeps its original single button.
 * That is a design statement rather than a spare slot: a difficulty whose
 * whole identity is a tighter margin should not also hand back the run. Two
 * consequences worth knowing before changing it — the rollback badge never
 * draws on Hard (it hides at 0), and `grantedRollbacks()` returning 0 is no
 * longer proof that the harness opt-out took effect, which is why
 * `getRollbackState` reports `disabled` separately for scripts to assert on.
 */
export const ROLLBACKS_BY_DIFFICULTY: Record<DifficultyLevel, number> = {
  easy: 2,
  normal: 1,
  hard: 0,
};

export const DEFAULT_DIFFICULTY: DifficultyLevel = "normal";

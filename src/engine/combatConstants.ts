// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Simulation scalars that decide how much damage flows in each direction —
 * player maximum health, enemy melee/ranged output, engagement ranges and
 * movement speeds, and the archetype multipliers layered over them.
 *
 * **Why they live here rather than beside the code that uses them.** Two
 * consumers need them and neither can reach the other's module. `enemyAi.ts`
 * and `projectiles.ts` own the behaviour, but both import `player.ts` and
 * `sprites.ts`, which drag the renderer in — so the offline balance solver
 * (`scripts/lib/levelSolver.mjs`, plain Node via esbuild) cannot bundle them
 * to read a damage number. `MAX_HEALTH` had the same problem one layer up: it
 * lived in `engine.ts`, which is the whole game.
 *
 * Copying the numbers into the solver was the alternative, and it is exactly
 * the failure `combatPolicy.mjs`'s `ROCKET_TRAVEL_SPEED` already demonstrated
 * — a mirrored constant that modelled the player's own rocket at the enemy
 * bolt's speed, wrong by 3.6x, with nothing in the build able to notice. This
 * module is dependency-free by construction so that no consumer ever has that
 * excuse: it imports nothing, and nothing here may ever import anything.
 *
 * The same property makes it the natural home for closing
 * `SIMULATION_BALANCE`'s documented gap — its comment in `engine.ts` names
 * `ELITE_DAMAGE_MULTIPLIER`, `EDGE_CASE_SPEED_MULTIPLIER`, `SPIKE_DPS`,
 * `MINE_DAMAGE_FALLOFF_FLOOR` and `PROJECTILE_SPEED` as uncovered, and says
 * covering them "means exporting each and extending this object". Two of those
 * five now live here. Folding them into the hash is deliberately *not* done
 * yet: it moves `balanceHash` and invalidates every shipped replay, so it
 * belongs after every other simulation change, followed by a single
 * `defaultHighscore.ts` regeneration. See `doc/dev/balancing-telemetry.md`.
 */

/** Starting / maximum System Stability (health), as a percentage. */
export const MAX_HEALTH = 100;

/** Distance (tiles) within which an enemy notices and chases the player. */
export const AGGRO_RADIUS = 7.5;
/** Enemy chase speed in tiles per second (slower than the player's 3.2). */
export const MOVEMENT_SPEED = 1.7;
/** Max distance (tiles) at which a chasing enemy will take a ranged shot. */
export const RANGED_RANGE = 8;
/** Min / max seconds between an enemy's ranged shots (randomized each time). */
export const FIRE_COOLDOWN_MIN = 1.2;
export const FIRE_COOLDOWN_MAX = 2.6;
/** Enemy roam (idle wander) speed — a relaxed stroll. */
export const ROAM_SPEED = 0.8;
/** Distance (tiles) from a roam target at which the enemy picks a new one. */
export const ROAM_ARRIVE = 0.25;
/** Distance (tiles) at which an enemy stops chasing and melees instead. */
export const ATTACK_RADIUS = 0.5;
/** Seconds between successive melee bites from a single enemy. */
export const ATTACK_COOLDOWN = 0.8;
/** Stability (health) the player loses per melee bite. */
export const ATTACK_DAMAGE = 10;
/** Half-width of an enemy's collision box, in tiles. */
export const ENEMY_RADIUS = 0.3;
/** Melee/ranged damage multiplier for an Elite (boss-tier) enemy — see
 * `Enemy.elite`. Its HP scaling already lives in `mapGenerator.ts`; this is
 * the "high damage" half of the spec. */
export const ELITE_DAMAGE_MULTIPLIER = 2;
/** Chase/roam speed multiplier for an Edge Case enemy — see `Enemy.edgeCase`.
 * "Very high movement speed": noticeably faster than the player can react to. */
export const EDGE_CASE_SPEED_MULTIPLIER = 2.2;
/** Melee/ranged damage multiplier for an Edge Case enemy — "low melee
 * damage": a nuisance, not a threat. */
export const EDGE_CASE_DAMAGE_MULTIPLIER = 0.4;
/** Average per-second chance an Edge Case enemy abandons its current roam
 * target early (before arriving) — the core of its erratic roaming. */
export const EDGE_CASE_RETARGET_RATE = 2.0;
/** Random heading wobble (radians) applied to an Edge Case enemy's roam step,
 * on top of its retargeting — reads as visibly twitchy/darting rather than a
 * smooth glide even between retargets. */
export const EDGE_CASE_ROAM_JITTER_RAD = 0.9;

/** Bolt travel speed, in tiles per second (dodgeable, but faster than a chase). */
export const PROJECTILE_SPEED = 5;
/** Stability the player loses when a bolt connects. */
export const PROJECTILE_DAMAGE = 8;
/** Bolt collision half-size, in tiles. */
export const PROJECTILE_RADIUS = 0.15;

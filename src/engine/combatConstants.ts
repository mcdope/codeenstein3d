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
 * The same property made it the natural home for closing
 * `SIMULATION_BALANCE`'s documented gap, and that gap is now **closed**: see
 * `COMBAT_BALANCE` at the bottom, which folds every scalar in this module into
 * the hash wholesale (`traps.ts` does the same with `TRAP_BALANCE`). The
 * comment in `engine.ts` used to name `ELITE_DAMAGE_MULTIPLIER`,
 * `EDGE_CASE_SPEED_MULTIPLIER`, `SPIKE_DPS`, `MINE_DAMAGE_FALLOFF_FLOOR` and
 * `PROJECTILE_SPEED` as uncovered and deferred the work to "if one of them is
 * ever tuned" — the per-archetype enemy weapon table tunes exactly those, so
 * that condition fired.
 *
 * It was deferred this long because folding them in moves `balanceHash` and
 * invalidates every shipped replay. That cost is real but it is paid **once**
 * for any number of simulation changes, so the sequencing is unchanged: batch
 * the balance work, close the hash last, regenerate `defaultHighscore.ts`
 * once, afterwards. See `doc/dev/balancing-telemetry.md`.
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

/**
 * Per-archetype enemy ranged weapons — the "enemies have no weapon concept"
 * gap, closed.
 *
 * Every enemy used to fire the identical bolt: one `spawnProjectile` call site
 * in `enemyAi.ts`, one speed, one damage, one cadence, with the archetype
 * showing up only as a scalar multiplier on the damage. So a swarm of Edge
 * Cases and an Elite were the same attack at different volumes.
 *
 * **Mean ranged DPS per archetype is deliberately unchanged, exactly.** Elite
 * doubles its damage and doubles its cooldown window; Edge Case halves both.
 * The arithmetic is exact rather than approximate — `enemyWeapons.test.ts`
 * asserts each archetype's `damage / meanCooldown` still equals the old
 * `PROJECTILE_DAMAGE * multiplier / 1.9` — so this change moves *texture*, not
 * expected damage taken. That matters because three prior A/Bs left total
 * damage taken invariant at 122/127/126 while redistributing it, and the
 * measured difficulty driver is exposure-time x enemy count. A table that also
 * quietly raised DPS would be unmeasurable against that history; one that
 * holds the mean fixed isolates what actually changed.
 *
 * What does change is the *shape* of the incoming damage, which is the point:
 *
 * - **normal** — unchanged in every field. The baseline the other two are
 *   defined against.
 * - **elite** — one heavy, slow, telegraphed shell. 32 damage a third of the
 *   player's health at once, but at 3.6 tiles/s it is the slowest bolt in the
 *   game and there is time to step out of it. Dodging an Elite becomes a real
 *   decision rather than an averaging exercise.
 * - **edgeCase** — a fast, weak, inaccurate spray. 1.6 a bolt at nearly twice
 *   the fire rate and 7 degrees of inherent scatter, so it chips rather than
 *   spikes and is hard to dodge deliberately. Matches what the archetype
 *   already is in melee ("a nuisance, not a threat").
 *
 * **`radius` is per-weapon but identical across all three, on purpose.** It
 * feeds the hit test (`updateProjectiles`), so varying it would change how
 * often a bolt connects and break the DPS invariant this table is built
 * around. It lives here so that varying it later is a one-line change with a
 * visible consequence, rather than a constant hidden in another module — but
 * the first version of this table deliberately does not spend that budget.
 *
 * `palette` is pure rendering and carries no simulation weight, which is why
 * it is the one field free to differ without any balance argument.
 */
export type EnemyArchetype = "normal" | "elite" | "edgeCase";

/** One archetype's ranged attack. `damage` is the final per-bolt figure,
 * archetype scaling already applied — it is *not* multiplied by
 * `ELITE_DAMAGE_MULTIPLIER`/`EDGE_CASE_DAMAGE_MULTIPLIER` again, which stay
 * the melee ladder. Multiplayer's player-count Elite scaling still applies on
 * top, Elite-only, per `multiplayer-game-state-spec.md` §4. */
export interface EnemyWeapon {
  /** Which archetype this is the weapon of. Redundant with the key it is
   * stored under, and deliberately so: a spawned bolt carries the archetype
   * for rendering, and reading it off the weapon means `spawnProjectile` needs
   * one argument rather than two. `enemyWeapons.test.ts` asserts every entry
   * agrees with its own key, so the redundancy cannot drift. */
  archetype: EnemyArchetype;
  /** Bolt travel speed, tiles per second. */
  speed: number;
  /** Stability the player loses when one bolt connects. */
  damage: number;
  /** Bolt collision half-size, in tiles — see the note above on why these are
   * currently equal. */
  radius: number;
  /** Min / max seconds between shots; the actual gap is drawn uniformly. */
  cooldownMin: number;
  cooldownMax: number;
  /** Inherent aim scatter in degrees, *added* to the difficulty's own
   * `enemyAimSpreadDeg` rather than replacing it. */
  spreadDeg: number;
  /** Billboard colours — rendering only. */
  palette: { halo: string; core: string; center: string };
}

export const ENEMY_WEAPONS: Readonly<Record<EnemyArchetype, EnemyWeapon>> = {
  normal: {
    archetype: "normal",
    speed: PROJECTILE_SPEED,
    damage: PROJECTILE_DAMAGE,
    radius: PROJECTILE_RADIUS,
    cooldownMin: FIRE_COOLDOWN_MIN,
    cooldownMax: FIRE_COOLDOWN_MAX,
    spreadDeg: 0,
    palette: { halo: "rgba(255,80,200,0.35)", core: "#ff3ea5", center: "#ffd0ec" },
  },
  elite: {
    archetype: "elite",
    // 2x damage, 2x cooldown window: 32 / 3.8 === 8 * 2 / 1.9.
    speed: 3.6,
    damage: PROJECTILE_DAMAGE * 2 * ELITE_DAMAGE_MULTIPLIER,
    radius: PROJECTILE_RADIUS,
    cooldownMin: FIRE_COOLDOWN_MIN * 2,
    cooldownMax: FIRE_COOLDOWN_MAX * 2,
    spreadDeg: 0,
    palette: { halo: "rgba(255,120,40,0.38)", core: "#ff7a28", center: "#ffe0b0" },
  },
  edgeCase: {
    archetype: "edgeCase",
    // 0.5x damage, 0.5x cooldown window: 1.6 / 0.95 === 8 * 0.4 / 1.9.
    speed: 7.5,
    damage: PROJECTILE_DAMAGE * 0.5 * EDGE_CASE_DAMAGE_MULTIPLIER,
    radius: PROJECTILE_RADIUS,
    cooldownMin: FIRE_COOLDOWN_MIN * 0.5,
    cooldownMax: FIRE_COOLDOWN_MAX * 0.5,
    spreadDeg: 7,
    palette: { halo: "rgba(120,255,230,0.32)", core: "#3ef0d0", center: "#d6fff8" },
  },
};

/** Rocket travel speed, in tiles per second — much slower than a hitscan
 * pellet (instant) so it's a real, dodgeable projectile in flight.
 *
 * Note this is the *player's* rocket (ghidra), four times faster than
 * `PROJECTILE_SPEED`, which is an enemy bolt. `combatPolicy.mjs` mirrored the
 * wrong one of those two for the bot's own self-splash avoidance and was out
 * by 3.6x as a result; `constantMirrors.test.mjs` now pins both. */
export const ROCKET_SPEED = 18;
/** Radius (tiles) of a rocket's blast; damage falls off with distance inside
 * it, and is 0 entirely outside it. */
export const ROCKET_BLAST_RADIUS = 2.6;
/** Floor on the falloff curve so even an edge-of-blast hit stays meaningful. */
export const ROCKET_DAMAGE_FALLOFF_FLOOR = 0.3;
/** How close a rocket has to get to a living enemy to detonate — bigger than
 * a precise hitbox check so a near-miss still reads as a hit. */
export const ROCKET_ENEMY_TRIGGER_RADIUS = 0.4;

/**
 * Every simulation scalar above, as one object, so `SIMULATION_BALANCE` can
 * fold the lot in wholesale instead of naming the two or three someone
 * happened to tune.
 *
 * **This is the same "hash the output, not a maintained list of inputs"
 * reasoning the enemy roster and the `WEAPONS` table already get** — see
 * `balanceHash.ts`. The difference is that a list of scalars *is* a
 * maintained list, so the property is enforced rather than assumed:
 * `simulationBalanceCoverage.test.ts` enumerates this module's exports and
 * fails if a value-carrying one is missing here — scalars and tables alike,
 * so `ENEMY_WEAPONS` could not be added without also being hashed. Add a constant above, forget this
 * object, and the test says so before the hash silently stops covering it.
 *
 * Ordering is irrelevant — `stableStringify` sorts keys, so a cosmetic
 * reshuffle here does not invalidate a single replay.
 */
export const COMBAT_BALANCE = {
  MAX_HEALTH,
  AGGRO_RADIUS,
  MOVEMENT_SPEED,
  RANGED_RANGE,
  FIRE_COOLDOWN_MIN,
  FIRE_COOLDOWN_MAX,
  ROAM_SPEED,
  ROAM_ARRIVE,
  ATTACK_RADIUS,
  ATTACK_COOLDOWN,
  ATTACK_DAMAGE,
  ENEMY_RADIUS,
  ELITE_DAMAGE_MULTIPLIER,
  EDGE_CASE_SPEED_MULTIPLIER,
  EDGE_CASE_DAMAGE_MULTIPLIER,
  EDGE_CASE_RETARGET_RATE,
  EDGE_CASE_ROAM_JITTER_RAD,
  PROJECTILE_SPEED,
  PROJECTILE_DAMAGE,
  PROJECTILE_RADIUS,
  ROCKET_SPEED,
  ROCKET_BLAST_RADIUS,
  ROCKET_DAMAGE_FALLOFF_FLOOR,
  ROCKET_ENEMY_TRIGGER_RADIUS,
  // Not a scalar, and that is the point — nesting it means the hash covers
  // every field of every archetype's weapon, including ones added later.
  ENEMY_WEAPONS,
} as const;

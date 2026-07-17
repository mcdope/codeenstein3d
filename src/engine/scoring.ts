// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-of-level scoring. Pure/deterministic, so it's cheap to recompute every
 * frame for a live HUD readout (see `RaycasterEngine.buildStats`) rather than
 * only once at the exit — the final `total` at the moment `onWin` fires is
 * simply whatever the running readout last showed.
 */
import type { Enemy } from "../map/types";

/** Flat points every kill is worth, before the complexity/elite scaling. */
const BASE_KILL_POINTS = 50;
/** Extra points per point of the killed entity's `complexityScore`. */
const COMPLEXITY_POINTS_PER_SCORE = 15;
/** Elite kills multiply the whole (base + complexity) subtotal. */
const ELITE_KILL_MULTIPLIER = 3;

/** Points awarded for defeating `enemy` — scaled by its entity's cyclomatic
 * complexity (a gnarlier function is a more valuable kill) and tripled for an
 * Elite. Called once per kill, at the moment it dies (see
 * `RaycasterEngine.damageEnemy`) — the running total lives on the engine, not
 * here, since a defeated enemy is no longer around to re-derive it from. */
export function killPoints(enemy: Enemy): number {
  const subtotal = BASE_KILL_POINTS + enemy.entity.complexityScore * COMPLEXITY_POINTS_PER_SCORE;
  return enemy.elite ? subtotal * ELITE_KILL_MULTIPLIER : subtotal;
}

/** Max points awarded for finishing at full health. */
const HEALTH_BONUS_MAX = 500;
/** Max points split four ways between remaining bullets/rockets/smg/gas ammo
 * (each contributes up to a quarter), relative to what the level started the
 * player out with. */
const AMMO_BONUS_MAX = 250;
/** Max points for finishing quickly. */
const SPEED_BONUS_MAX = 400;
/** Time (seconds) at/under which the speed bonus is maxed out; decays
 * linearly to 0 by twice this. */
const SPEED_TARGET_SEC = 90;
/** Max points for a near-optimal route from spawn to exit. */
const PATH_BONUS_MAX = 300;
/** Fraction of walkable tiles that must have been visited to count as a "100%
 * Clear" — not literally 1.0, since a couple of tiles can be geometrically
 * unreachable in some layouts (e.g. wedged behind a spawn-side wall corner). */
const MAP_COMPLETION_THRESHOLD = 0.95;
/** Flat bonus for reaching that threshold before/at the exit. */
const MAP_COMPLETION_BONUS = 750;
/** Flat points per unique lore terminal read this level. */
const LORE_BONUS_PER_TERMINAL = 100;
/** Flat points per unique secret room opened this level — double the lore
 * bonus, since finding one takes actively interacting with a specific
 * stretch of wall rather than just walking near a terminal. */
const SECRET_ROOM_BONUS_PER_ROOM = 200;
/** Flat points per "Multi Kill" (3 kills within `MULTI_KILL_WINDOW_SEC` of
 * each other — see `RaycasterEngine.damageEnemy`, which owns the rolling-
 * window detection and just reports how many times each tier fired). */
const MULTI_KILL_BONUS = 300;
/** Flat points per "Ultra Kill" (6 kills within `ULTRA_KILL_WINDOW_SEC`) —
 * bigger than a Multi Kill, matching the existing top-tier
 * `MAP_COMPLETION_BONUS` for a cohesive "big bonus" scale. */
const ULTRA_KILL_BONUS = 750;
/** Max points for weapon accuracy — same scale as `AMMO_BONUS_MAX`, the
 * other "how carefully did you play" bonus. */
const ACCURACY_BONUS_MAX = 250;

export interface ScoreInput {
  /** Sum of `killPoints()` for every enemy defeated so far. */
  killPoints: number;
  finalHealth: number;
  maxHealth: number;
  finalBullets: number;
  finalRockets: number;
  finalSmg: number;
  finalGas: number;
  /** Bullets/rockets/smg/gas ammo the level started the player out with — the
   * baseline remaining ammo is scored against (see `AMMO_BONUS_MAX`). */
  startingBullets: number;
  startingRockets: number;
  startingSmg: number;
  startingGas: number;
  /** Seconds elapsed so far this level. */
  levelTimeSec: number;
  /** Tiles of ground actually covered so far this level. */
  distanceTraveledTiles: number;
  /** BFS-shortest tile distance from spawn to exit — the "perfect" route. */
  shortestPathTiles: number;
  /** Unique walkable tiles visited so far, divided by the level's total
   * walkable tile count — see `MAP_COMPLETION_THRESHOLD`. */
  mapCompletionFrac: number;
  /** Count of unique lore terminals read so far this level. */
  uniqueLoreTerminalsRead: number;
  /** Count of unique secret rooms opened so far this level. */
  uniqueSecretRoomsOpened: number;
  /** Count of "Multi Kill" streaks triggered so far this level. */
  multiKillCount: number;
  /** Count of "Ultra Kill" streaks triggered so far this level. */
  ultraKillCount: number;
  /** Shots fired so far this level, summed across every weapon. */
  weaponShotsFired: number;
  /** Shots that landed so far this level, summed across every weapon. */
  weaponHits: number;
}

export interface ScoreBreakdown {
  killPoints: number;
  healthBonus: number;
  ammoBonus: number;
  speedBonus: number;
  pathBonus: number;
  mapCompletionBonus: number;
  loreBonus: number;
  secretRoomBonus: number;
  multikillBonus: number;
  accuracyBonus: number;
  /** Sum of every bonus, floored at 0. */
  total: number;
}

/** Score breakdown for the current run state — safe (and cheap) to call every
 * frame; see this module's doc comment for why it isn't win-only. */
export function computeScore(input: ScoreInput): ScoreBreakdown {
  const healthFrac = clamp01(input.finalHealth / input.maxHealth);
  const healthBonus = Math.round(healthFrac * HEALTH_BONUS_MAX);

  const bulletsFrac = input.startingBullets > 0 ? clamp01(input.finalBullets / input.startingBullets) : 0;
  const rocketsFrac = input.startingRockets > 0 ? clamp01(input.finalRockets / input.startingRockets) : 0;
  const smgFrac = input.startingSmg > 0 ? clamp01(input.finalSmg / input.startingSmg) : 0;
  const gasFrac = input.startingGas > 0 ? clamp01(input.finalGas / input.startingGas) : 0;
  const ammoBonus = Math.round(((bulletsFrac + rocketsFrac + smgFrac + gasFrac) / 4) * AMMO_BONUS_MAX);

  const speedFrac = clamp01(1 - Math.max(0, input.levelTimeSec - SPEED_TARGET_SEC) / SPEED_TARGET_SEC);
  const speedBonus = Math.round(speedFrac * SPEED_BONUS_MAX);

  // Ratio of the ideal route to what was actually walked — 1 for a perfect
  // line, shrinking the more the player wandered/backtracked. No distance
  // traveled yet (level just started) reads as a perfect ratio rather than a
  // division by zero.
  const pathRatio =
    input.distanceTraveledTiles > 0 ? input.shortestPathTiles / input.distanceTraveledTiles : 1;
  const pathBonus = Math.round(clamp01(pathRatio) * PATH_BONUS_MAX);

  const mapCompletionBonus =
    clamp01(input.mapCompletionFrac) > MAP_COMPLETION_THRESHOLD ? MAP_COMPLETION_BONUS : 0;
  const loreBonus = input.uniqueLoreTerminalsRead * LORE_BONUS_PER_TERMINAL;
  const secretRoomBonus = input.uniqueSecretRoomsOpened * SECRET_ROOM_BONUS_PER_ROOM;
  const multikillBonus = input.multiKillCount * MULTI_KILL_BONUS + input.ultraKillCount * ULTRA_KILL_BONUS;

  // No shots fired reads as 0% accuracy, not a division-by-zero/100% trap.
  const accuracyFrac = input.weaponShotsFired > 0 ? clamp01(input.weaponHits / input.weaponShotsFired) : 0;
  const accuracyBonus = Math.round(accuracyFrac * ACCURACY_BONUS_MAX);

  const total = Math.max(
    0,
    input.killPoints +
      healthBonus +
      ammoBonus +
      speedBonus +
      pathBonus +
      mapCompletionBonus +
      loreBonus +
      secretRoomBonus +
      multikillBonus +
      accuracyBonus,
  );

  return {
    killPoints: input.killPoints,
    healthBonus,
    ammoBonus,
    speedBonus,
    pathBonus,
    mapCompletionBonus,
    loreBonus,
    secretRoomBonus,
    multikillBonus,
    accuracyBonus,
    total,
  };
}

/** Identity value for `sumScoreBreakdowns` — a fresh run's "nothing banked
 * yet" baseline (see `EngineCarryover.priorScoreBreakdown`). */
export function zeroScoreBreakdown(): ScoreBreakdown {
  return {
    killPoints: 0,
    healthBonus: 0,
    ammoBonus: 0,
    speedBonus: 0,
    pathBonus: 0,
    mapCompletionBonus: 0,
    loreBonus: 0,
    secretRoomBonus: 0,
    multikillBonus: 0,
    accuracyBonus: 0,
    total: 0,
  };
}

/** Elementwise sum of every category, including `total` — used to accumulate
 * a run-wide breakdown across levels the same way `EngineStats.score` itself
 * already accumulates via `EngineCarryover.priorScore`. */
export function sumScoreBreakdowns(a: ScoreBreakdown, b: ScoreBreakdown): ScoreBreakdown {
  return {
    killPoints: a.killPoints + b.killPoints,
    healthBonus: a.healthBonus + b.healthBonus,
    ammoBonus: a.ammoBonus + b.ammoBonus,
    speedBonus: a.speedBonus + b.speedBonus,
    pathBonus: a.pathBonus + b.pathBonus,
    mapCompletionBonus: a.mapCompletionBonus + b.mapCompletionBonus,
    loreBonus: a.loreBonus + b.loreBonus,
    secretRoomBonus: a.secretRoomBonus + b.secretRoomBonus,
    multikillBonus: a.multikillBonus + b.multikillBonus,
    accuracyBonus: a.accuracyBonus + b.accuracyBonus,
    total: a.total + b.total,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

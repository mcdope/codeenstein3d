// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Curated player-facing slice of `telemetry.ts`'s `TelemetryState` — the
 * "how'd I do" numbers a real player would care about (kills, weapon
 * accuracy, damage taken by source, time survived, loot collected, closest
 * call), deliberately excluding the bot/balance-only fields (TTK windows,
 * forced-melee-kill count, mines triggered/disarmed, and similar QA/
 * verification-only counters) that `telemetry.ts` also tracks for
 * `scripts/run-balancing-telemetry.mjs`. Kept separate from `telemetry.ts`
 * itself (which stays a bot/balance-scoped module, see its own doc comment)
 * since this also depends on `scoring.ts`'s types for the run-accumulator
 * shape used by the level-end stats screen (see `RaycasterEngine.buildStats`
 * and `EngineStats.levelPlayerStats`/`runPlayerStats`).
 */
import type { DamageSource, TelemetryState } from "./telemetry";

/** Off by default — recording telemetry for this on every real playthrough
 * (not just `?testHooks=1` bot runs) measurably slowed gameplay down even
 * after gating the derived stats to only compute at level-end (see
 * `RaycasterEngine.buildStats`'s `atLevelEnd` gate); the per-event recording
 * calls themselves (`recordShot`/`recordDamage`/etc., ~20 call sites in
 * `engine.ts`) turned out to be the real remaining cost. Flip this on to
 * re-enable the level-end/run-end stats screen (`GameHud`'s Commit Summary/
 * Kernel Panic/Build Successful stats rows) for real play — same pattern as
 * `DECORATIONS_ENABLED` in `mapGenerator.ts`. `?testHooks=1` (the balancing
 * bot) is unaffected either way — it always gets telemetry. */
export const PLAYER_STATS_ENABLED = false;

export interface PlayerFacingStats {
  kills: number;
  /** Shots fired, summed across every weapon. */
  shotsFired: number;
  /** Shots that landed, summed across every weapon. */
  hits: number;
  /** Derived from `hits`/`shotsFired`; 0 when nothing was fired (never a
   * division-by-zero, never a false 100%). */
  weaponAccuracyPct: number;
  damageTakenBySource: Record<DamageSource, number>;
  timeSurvivedSec: number;
  /** Sum of `lootCollectedDynamic` + `lootCollectedStatic` across every
   * `LootKind`, this level (or the whole run, once merged). */
  lootCollectedTotal: number;
  /** Lowest health value observed — the "closest call" stat. Merges as a
   * min, not an average, across a run (see `mergePlayerFacingStats`). */
  minHealthReached: number;
  /** Which of the 6 damage sources landed the killing blow, if the level
   * ended in death. Level-scoped only — deliberately not accumulated across
   * a run by `mergePlayerFacingStats` (see its doc comment). */
  fatalDamageSource: DamageSource | null;
}

function sumLootRecord(record: Partial<Record<string, number>>): number {
  // `?? 0` is unreachable in practice — `telemetry.ts`'s `recordLootCollected`
  // only ever assigns a real number to a key, never `undefined` — but
  // `Partial<Record<...>>`'s type still allows it, and `Object.values` types
  // accordingly.
  /* v8 ignore next */
  return Object.values(record).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
}

function accuracyPct(hits: number, shotsFired: number): number {
  return shotsFired > 0 ? Math.round((hits / shotsFired) * 100) : 0;
}

/** Derives the curated slice from a single level's raw telemetry — pure, no
 * mutation. `getTelemetrySnapshot()` (the balancing bot's full-fidelity
 * hook) calls this internally for the fields the two share, then splices its
 * own bot-only extras on top. */
export function buildPlayerFacingStats(t: TelemetryState, levelTimeSec: number, kills: number): PlayerFacingStats {
  const shotsFired = Object.values(t.weaponTallies).reduce((sum, tally) => sum + tally.shotsFired, 0);
  const hits = Object.values(t.weaponTallies).reduce((sum, tally) => sum + tally.hits, 0);
  return {
    kills,
    shotsFired,
    hits,
    weaponAccuracyPct: accuracyPct(hits, shotsFired),
    damageTakenBySource: { ...t.damageBySource },
    timeSurvivedSec: levelTimeSec,
    lootCollectedTotal: sumLootRecord(t.lootCollectedDynamic) + sumLootRecord(t.lootCollectedStatic),
    minHealthReached: t.minHealthReached,
    fatalDamageSource: t.fatalDamageSource,
  };
}

/** Identity value for `mergePlayerFacingStats` — a fresh run's "nothing
 * banked yet" baseline (see `EngineCarryover.priorPlayerStats`). */
export function emptyPlayerFacingStats(): PlayerFacingStats {
  return {
    kills: 0,
    shotsFired: 0,
    hits: 0,
    weaponAccuracyPct: 0,
    damageTakenBySource: { enemyMelee: 0, enemyRanged: 0, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 },
    timeSurvivedSec: 0,
    lootCollectedTotal: 0,
    minHealthReached: Infinity,
    fatalDamageSource: null,
  };
}

/** Accumulates curated stats across levels the same way `EngineStats.score`
 * itself already accumulates via `EngineCarryover.priorScore` — sums for
 * counts/time, min-of-mins for the "closest call ever" reading, and a
 * *recomputed* (not averaged) accuracy so a low-shot level can't misweight
 * against a high-shot one. */
export function mergePlayerFacingStats(a: PlayerFacingStats, b: PlayerFacingStats): PlayerFacingStats {
  const shotsFired = a.shotsFired + b.shotsFired;
  const hits = a.hits + b.hits;
  return {
    kills: a.kills + b.kills,
    shotsFired,
    hits,
    weaponAccuracyPct: accuracyPct(hits, shotsFired),
    damageTakenBySource: {
      enemyMelee: a.damageTakenBySource.enemyMelee + b.damageTakenBySource.enemyMelee,
      enemyRanged: a.damageTakenBySource.enemyRanged + b.damageTakenBySource.enemyRanged,
      trapSpike: a.damageTakenBySource.trapSpike + b.damageTakenBySource.trapSpike,
      trapMine: a.damageTakenBySource.trapMine + b.damageTakenBySource.trapMine,
      hazard: a.damageTakenBySource.hazard + b.damageTakenBySource.hazard,
      selfRocket: a.damageTakenBySource.selfRocket + b.damageTakenBySource.selfRocket,
    },
    timeSurvivedSec: a.timeSurvivedSec + b.timeSurvivedSec,
    lootCollectedTotal: a.lootCollectedTotal + b.lootCollectedTotal,
    minHealthReached: Math.min(a.minHealthReached, b.minHealthReached),
    fatalDamageSource: b.fatalDamageSource,
  };
}

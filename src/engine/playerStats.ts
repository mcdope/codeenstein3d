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

/**
 * The level-end / run-end stats rows on the Commit Summary, Kernel Panic and
 * Build Successful overlays. **On since 2026-08-23.**
 *
 * It was born `false` on 2026-07-17 with the claim that recording telemetry on
 * every real playthrough "measurably slowed gameplay down", the ~20 per-event
 * `record*` sites being blamed as the remaining cost. **No numbers were ever
 * recorded for that claim** — not in the commit, not in `history.md`, not in
 * `perf-findings.json`. It has now been measured twice and is not reproducible
 * either time:
 *
 * - 2026-08-02 (`perf-review-2026-08-02.md` §7) — "not reproducible", but on a
 *   pre-P1 build already dropping ~29% of frames, which is the least sensitive
 *   baseline a small per-frame cost could be tested against.
 * - 2026-08-23, the remeasure `notes` asked for, on a build that actually holds
 *   the vsync edge (59.3-59.6 fps, ~1% dropped). Clock-equalized `c2-2bg` cell,
 *   4 runs per arm, headed: busy median **5.775ms off vs 5.800ms on, +0.025ms**,
 *   against a calibrated minimum detectable difference of **0.16ms**. Dropped
 *   frames went *down* (1.72% -> 1.57%); `longTasks` 0 in both arms.
 *
 * The level-end derivation below (`buildPlayerFacingStats` and friends, called
 * once from `engine.ts`'s `atLevelEnd` branch) was measured directly rather
 * than through a pacing cell, since it is one-shot and the engine has already
 * stopped by the time the overlay draws: **0.00027 ms per level transition**,
 * 0.0016% of one frame.
 *
 * Reproduce either with `npm run perf:bench -- --flag playerstats`.
 *
 * `?testHooks=1` (the balancing bot) is unaffected and always had telemetry —
 * see `telemetryEnabled` in `engine.ts`.
 */
export const PLAYER_STATS_ENABLED = true;

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
  /* v8 ignore next -- @preserve */
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

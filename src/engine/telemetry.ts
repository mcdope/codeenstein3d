// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Balancing telemetry: plain counters/records the engine accumulates only
 * when `?testHooks=1` is active (see `RaycasterEngine`'s constructor and
 * `__codeensteinTestHooks.getTelemetrySnapshot()`), read by
 * `scripts/run-balancing-telemetry.mjs`. Kept out of `engine.ts` as pure
 * types + increment helpers so the engine's own diff at each call site stays
 * a one-line `this.telemetry?.recordX(...)`. Nothing here touches RNG or
 * mutates simulation state — it only observes what already happened.
 */
import type { Enemy, LootKind } from "../map/types";

export type DamageSource = "enemyMelee" | "enemyRanged" | "trapSpike" | "trapMine" | "hazard" | "selfRocket";
export type HealSource = "pickupHealth" | "pickupSwap" | "lifesteal";
export type EnemyCategory = "normal" | "elite" | "edgeCase";

export interface WeaponTally {
  shotsFired: number;
  hits: number;
  kills: number;
}

/** One enemy's time-to-kill window: opened the moment it first aggroes
 * (proximity+LOS or damage-aggro — see `enemyAi.ts`/`RaycasterEngine.damageEnemy`),
 * closed at death. `deathAtLevelTime` stays `null` for an enemy still alive
 * when a snapshot is pulled (e.g. the level a run died on). */
export interface EnemyTtkRecord {
  category: EnemyCategory;
  aggroAtLevelTime: number;
  deathAtLevelTime: number | null;
}

export interface TelemetryState {
  ttkPending: EnemyTtkRecord[];
  ttkFinished: EnemyTtkRecord[];
  peakAggroedCount: number;
  combatTimeSec: number;
  enemyBoltsFired: number;
  enemyBoltsHit: number;
  enemyMeleeAttacks: number;
  minHealthReached: number;
  timeBelow25PctHealthSec: number;
  damageBySource: Record<DamageSource, number>;
  healingBySource: Record<HealSource, number>;
  /** Keyed by index into `WEAPONS`. */
  weaponTallies: Record<number, WeaponTally>;
  lootRolled: Partial<Record<LootKind, number>>;
  lootCollectedDynamic: Partial<Record<LootKind, number>>;
  lootCollectedStatic: Partial<Record<LootKind, number>>;
  timeAtZeroRangedAmmoSec: number;
  killsForcedByMelee: number;
  minesTriggered: number;
  minesDisarmed: number;
  /** Which of the 6 damage sources landed the killing blow, if the level
   * ended in death. `null` for a level the run didn't die on. */
  fatalDamageSource: DamageSource | null;
  /** How many regular (non-elite) kills rolled for ammo/swap loot at all —
   * denominator for `regularKillLootMisses`, letting balance telemetry
   * empirically confirm `REGULAR_KILL_NO_DROP_CHANCE`'s ~20% miss rate in
   * real play rather than trusting the constant alone. Elite kills always
   * drop (see `dropEliteLoot`) and health is its own always-on check (see
   * `RaycasterEngine`'s kill handler) — neither counts here. */
  regularKillLootRolls: number;
  /** Of `regularKillLootRolls`, how many rolled a miss (no ammo/swap drop —
   * may still have gotten health and/or the Toolchain miss-chance bonus). */
  regularKillLootMisses: number;
}

export function createTelemetryState(): TelemetryState {
  return {
    ttkPending: [],
    ttkFinished: [],
    peakAggroedCount: 0,
    combatTimeSec: 0,
    enemyBoltsFired: 0,
    enemyBoltsHit: 0,
    enemyMeleeAttacks: 0,
    minHealthReached: Infinity,
    timeBelow25PctHealthSec: 0,
    damageBySource: { enemyMelee: 0, enemyRanged: 0, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 },
    healingBySource: { pickupHealth: 0, pickupSwap: 0, lifesteal: 0 },
    weaponTallies: {},
    lootRolled: {},
    lootCollectedDynamic: {},
    lootCollectedStatic: {},
    timeAtZeroRangedAmmoSec: 0,
    killsForcedByMelee: 0,
    minesTriggered: 0,
    minesDisarmed: 0,
    fatalDamageSource: null,
    regularKillLootRolls: 0,
    regularKillLootMisses: 0,
  };
}

/** `elite` > `edgeCase` > `normal` — the same precedence used everywhere else
 * an enemy's tier is derived (see `Enemy.elite`/`Enemy.edgeCase`'s doc comments). */
export function enemyCategory(enemy: Pick<Enemy, "elite" | "edgeCase">): EnemyCategory {
  return enemy.elite ? "elite" : enemy.edgeCase ? "edgeCase" : "normal";
}

export function recordDamage(state: TelemetryState, source: DamageSource, amount: number): void {
  state.damageBySource[source] += amount;
}

export function recordFatalDamage(state: TelemetryState, source: DamageSource): void {
  state.fatalDamageSource = source;
}

export function recordHeal(state: TelemetryState, source: HealSource, amount: number): void {
  state.healingBySource[source] += amount;
}

function tallyFor(state: TelemetryState, weaponIndex: number): WeaponTally {
  return (state.weaponTallies[weaponIndex] ??= { shotsFired: 0, hits: 0, kills: 0 });
}

export function recordShot(state: TelemetryState, weaponIndex: number): void {
  tallyFor(state, weaponIndex).shotsFired += 1;
}

export function recordHit(state: TelemetryState, weaponIndex: number): void {
  tallyFor(state, weaponIndex).hits += 1;
}

export function recordKill(state: TelemetryState, weaponIndex: number): void {
  tallyFor(state, weaponIndex).kills += 1;
}

export function recordEnemyBoltFired(state: TelemetryState): void {
  state.enemyBoltsFired += 1;
}

export function recordEnemyBoltHit(state: TelemetryState): void {
  state.enemyBoltsHit += 1;
}

export function recordEnemyMeleeAttack(state: TelemetryState): void {
  state.enemyMeleeAttacks += 1;
}

export function recordMineTriggered(state: TelemetryState): void {
  state.minesTriggered += 1;
}

export function recordMineDisarmed(state: TelemetryState): void {
  state.minesDisarmed += 1;
}

export function recordKillForcedByMelee(state: TelemetryState): void {
  state.killsForcedByMelee += 1;
}

export function recordRegularKillLootRoll(state: TelemetryState, missed: boolean): void {
  state.regularKillLootRolls += 1;
  if (missed) state.regularKillLootMisses += 1;
}

export function recordLootRolled(state: TelemetryState, kind: LootKind, amount: number): void {
  state.lootRolled[kind] = (state.lootRolled[kind] ?? 0) + amount;
}

export function recordLootCollected(
  state: TelemetryState,
  origin: "dynamic" | "static",
  kind: LootKind,
  amount: number,
): void {
  const bucket = origin === "dynamic" ? state.lootCollectedDynamic : state.lootCollectedStatic;
  bucket[kind] = (bucket[kind] ?? 0) + amount;
}

/** Called once per frame; tracks the health/ammo-desperation time series. */
export function updatePerFrame(
  state: TelemetryState,
  dt: number,
  healthFraction: number,
  rangedAmmoTotal: number,
): void {
  if (healthFraction < 0.25) state.timeBelow25PctHealthSec += dt;
  if (rangedAmmoTotal <= 0) state.timeAtZeroRangedAmmoSec += dt;
}

export function updateMinHealth(state: TelemetryState, health: number): void {
  if (health < state.minHealthReached) state.minHealthReached = health;
}

/** Open a TTK window for an enemy the instant it aggroes (either trigger —
 * proximity+LOS or being shot). No-op if already open (aggro is sticky, but
 * both triggers can independently observe the same already-true transition
 * in the same frame). */
export function recordEnemyAggro(
  state: TelemetryState,
  index: WeakMap<Enemy, EnemyTtkRecord>,
  enemy: Enemy,
  levelTime: number,
): void {
  if (index.has(enemy)) return;
  const record: EnemyTtkRecord = { category: enemyCategory(enemy), aggroAtLevelTime: levelTime, deathAtLevelTime: null };
  index.set(enemy, record);
  state.ttkPending.push(record);
}

/** Close out an enemy's TTK window at death. No-op if it was never recorded
 * as aggroed (shouldn't happen — a killed enemy was always shot at least
 * once, which aggroes it — but defensive regardless). */
export function recordEnemyDeath(
  state: TelemetryState,
  index: WeakMap<Enemy, EnemyTtkRecord>,
  enemy: Enemy,
  levelTime: number,
): void {
  const record = index.get(enemy);
  if (!record) return;
  record.deathAtLevelTime = levelTime;
  const pendingAt = state.ttkPending.indexOf(record);
  if (pendingAt !== -1) state.ttkPending.splice(pendingAt, 1);
  state.ttkFinished.push(record);
}

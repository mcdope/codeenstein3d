// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { Enemy } from "../map/types";
import {
  createTelemetryState,
  enemyCategory,
  recordDamage,
  recordEnemyAggro,
  recordEnemyDeath,
  recordFatalDamage,
  recordHeal,
  recordHit,
  recordKill,
  recordKillForcedByMelee,
  recordLootCollected,
  recordLootRolled,
  recordMineDisarmed,
  recordMineTriggered,
  recordRegularKillLootRoll,
  recordShot,
  updateMinHealth,
  updatePerFrame,
} from "./telemetry";

function fakeEnemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 0,
    y: 0,
    hp: 10,
    maxHp: 10,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 1, h: 1 },
    aggroed: false,
    discovered: false,
    roamX: 0,
    roamY: 0,
    fireCooldown: 0,
    entity: { kind: "function", name: "f", complexityScore: 1 } as Enemy["entity"],
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

describe("createTelemetryState", () => {
  it("zero-initializes every counter and starts minHealthReached at Infinity", () => {
    const state = createTelemetryState();
    expect(state.peakAggroedCount).toBe(0);
    expect(state.minHealthReached).toBe(Infinity);
    expect(state.fatalDamageSource).toBeNull();
    expect(state.damageBySource).toEqual({ enemyMelee: 0, enemyRanged: 0, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 });
    expect(state.weaponTallies).toEqual({});
  });
});

describe("enemyCategory", () => {
  it("prioritizes elite over edgeCase", () => {
    expect(enemyCategory({ elite: true, edgeCase: true })).toBe("elite");
    expect(enemyCategory({ elite: false, edgeCase: true })).toBe("edgeCase");
    expect(enemyCategory({ elite: false, edgeCase: false })).toBe("normal");
  });
});

describe("recordDamage / recordFatalDamage", () => {
  it("accumulates per-source damage and records the fatal source once", () => {
    const state = createTelemetryState();
    recordDamage(state, "enemyMelee", 10);
    recordDamage(state, "enemyMelee", 5);
    recordDamage(state, "hazard", 3);
    expect(state.damageBySource.enemyMelee).toBe(15);
    expect(state.damageBySource.hazard).toBe(3);
    recordFatalDamage(state, "trapMine");
    expect(state.fatalDamageSource).toBe("trapMine");
  });
});

describe("recordHeal", () => {
  it("accumulates per-source healing", () => {
    const state = createTelemetryState();
    recordHeal(state, "lifesteal", 3);
    recordHeal(state, "lifesteal", 1);
    recordHeal(state, "pickupHealth", 20);
    expect(state.healingBySource).toEqual({ pickupHealth: 20, pickupSwap: 0, lifesteal: 4 });
  });
});

describe("weapon tallies", () => {
  it("tracks shots/hits/kills independently per weapon index", () => {
    const state = createTelemetryState();
    recordShot(state, 0);
    recordShot(state, 0);
    recordHit(state, 0);
    recordKill(state, 0);
    recordShot(state, 2);
    expect(state.weaponTallies[0]).toEqual({ shotsFired: 2, hits: 1, kills: 1 });
    expect(state.weaponTallies[2]).toEqual({ shotsFired: 1, hits: 0, kills: 0 });
    expect(state.weaponTallies[5]).toBeUndefined();
  });

  it("recordKillForcedByMelee increments an independent counter", () => {
    const state = createTelemetryState();
    recordKillForcedByMelee(state);
    recordKillForcedByMelee(state);
    expect(state.killsForcedByMelee).toBe(2);
  });
});

describe("mine counters", () => {
  it("triggered and disarmed are independent", () => {
    const state = createTelemetryState();
    recordMineTriggered(state);
    recordMineDisarmed(state);
    recordMineDisarmed(state);
    expect(state.minesTriggered).toBe(1);
    expect(state.minesDisarmed).toBe(2);
  });
});

describe("loot counters", () => {
  it("recordLootRolled sums per kind", () => {
    const state = createTelemetryState();
    recordLootRolled(state, "bullets", 1);
    recordLootRolled(state, "bullets", 1);
    recordLootRolled(state, "health", 50);
    expect(state.lootRolled).toEqual({ bullets: 2, health: 50 });
  });

  it("recordLootCollected keeps dynamic and static buckets separate", () => {
    const state = createTelemetryState();
    recordLootCollected(state, "dynamic", "bullets", 6);
    recordLootCollected(state, "static", "bullets", 11);
    recordLootCollected(state, "dynamic", "bullets", 6);
    expect(state.lootCollectedDynamic).toEqual({ bullets: 12 });
    expect(state.lootCollectedStatic).toEqual({ bullets: 11 });
  });

  it("recordRegularKillLootRoll counts total rolls and misses separately", () => {
    const state = createTelemetryState();
    recordRegularKillLootRoll(state, false);
    recordRegularKillLootRoll(state, true);
    recordRegularKillLootRoll(state, true);
    expect(state.regularKillLootRolls).toBe(3);
    expect(state.regularKillLootMisses).toBe(2);
  });
});

describe("per-frame trackers", () => {
  it("updateMinHealth only ever decreases", () => {
    const state = createTelemetryState();
    updateMinHealth(state, 80);
    updateMinHealth(state, 30);
    updateMinHealth(state, 50);
    expect(state.minHealthReached).toBe(30);
  });

  it("updatePerFrame accumulates time below 25% health and time at zero ranged ammo", () => {
    const state = createTelemetryState();
    updatePerFrame(state, 0.1, 0.5, 5); // healthy, has ammo
    updatePerFrame(state, 0.2, 0.1, 0); // low health, no ammo
    updatePerFrame(state, 0.3, 0.9, 3); // full health, has ammo
    expect(state.timeBelow25PctHealthSec).toBeCloseTo(0.2);
    expect(state.timeAtZeroRangedAmmoSec).toBeCloseTo(0.2);
  });
});

describe("TTK tracking", () => {
  it("opens a pending window on aggro and closes it (moving to ttkFinished) on death", () => {
    const state = createTelemetryState();
    const index = new WeakMap();
    const enemy = fakeEnemy({ elite: true });

    recordEnemyAggro(state, index, enemy, 1.5);
    expect(state.ttkPending).toHaveLength(1);
    expect(state.ttkPending[0]).toEqual({ category: "elite", aggroAtLevelTime: 1.5, deathAtLevelTime: null });
    expect(state.ttkFinished).toHaveLength(0);

    recordEnemyDeath(state, index, enemy, 4.25);
    expect(state.ttkPending).toHaveLength(0);
    expect(state.ttkFinished).toHaveLength(1);
    expect(state.ttkFinished[0]).toEqual({ category: "elite", aggroAtLevelTime: 1.5, deathAtLevelTime: 4.25 });
  });

  it("is idempotent — a second aggro call for the same enemy doesn't open a duplicate window", () => {
    const state = createTelemetryState();
    const index = new WeakMap();
    const enemy = fakeEnemy();

    recordEnemyAggro(state, index, enemy, 1);
    recordEnemyAggro(state, index, enemy, 2); // e.g. damage-aggro firing again after proximity-aggro already did
    expect(state.ttkPending).toHaveLength(1);
    expect(state.ttkPending[0].aggroAtLevelTime).toBe(1); // first one wins
  });

  it("recordEnemyDeath is a no-op for an enemy that was never recorded as aggroed", () => {
    const state = createTelemetryState();
    const index = new WeakMap();
    const enemy = fakeEnemy();

    recordEnemyDeath(state, index, enemy, 5);
    expect(state.ttkFinished).toHaveLength(0);
  });
});

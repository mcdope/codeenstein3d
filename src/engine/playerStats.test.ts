// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { createTelemetryState, type TelemetryState } from "./telemetry";
import { buildPlayerFacingStats, emptyPlayerFacingStats, mergePlayerFacingStats } from "./playerStats";

function telemetry(overrides: Partial<TelemetryState> = {}): TelemetryState {
  return { ...createTelemetryState(), ...overrides };
}

describe("buildPlayerFacingStats", () => {
  it("derives shotsFired/hits/accuracy from weaponTallies, summed across every weapon", () => {
    const t = telemetry({
      weaponTallies: {
        0: { shotsFired: 10, hits: 5, kills: 1 },
        1: { shotsFired: 10, hits: 5, kills: 0 },
      },
    });
    const stats = buildPlayerFacingStats(t, 42, 3);
    expect(stats.shotsFired).toBe(20);
    expect(stats.hits).toBe(10);
    expect(stats.weaponAccuracyPct).toBe(50);
  });

  it("reads 0% accuracy, not 100%, when nothing was fired", () => {
    const stats = buildPlayerFacingStats(telemetry(), 10, 0);
    expect(stats.shotsFired).toBe(0);
    expect(stats.weaponAccuracyPct).toBe(0);
  });

  it("sums lootCollectedDynamic and lootCollectedStatic into one total", () => {
    const t = telemetry({
      lootCollectedDynamic: { health: 2, bullets: 3 },
      lootCollectedStatic: { rockets: 1 },
    });
    expect(buildPlayerFacingStats(t, 0, 0).lootCollectedTotal).toBe(6);
  });

  it("passes through damageBySource, minHealthReached, fatalDamageSource, kills, and levelTimeSec", () => {
    const t = telemetry({
      damageBySource: { enemyMelee: 5, enemyRanged: 10, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 },
      minHealthReached: 12,
      fatalDamageSource: "enemyRanged",
    });
    const stats = buildPlayerFacingStats(t, 99, 7);
    expect(stats.damageTakenBySource).toEqual(t.damageBySource);
    expect(stats.minHealthReached).toBe(12);
    expect(stats.fatalDamageSource).toBe("enemyRanged");
    expect(stats.kills).toBe(7);
    expect(stats.timeSurvivedSec).toBe(99);
  });
});

describe("emptyPlayerFacingStats", () => {
  it("is the identity value for mergePlayerFacingStats", () => {
    const level = buildPlayerFacingStats(
      telemetry({ weaponTallies: { 0: { shotsFired: 4, hits: 2, kills: 1 } } }),
      30,
      2,
    );
    expect(mergePlayerFacingStats(emptyPlayerFacingStats(), level)).toEqual(level);
  });
});

describe("mergePlayerFacingStats", () => {
  it("sums kills, shots, hits, loot, and survival time", () => {
    const a = buildPlayerFacingStats(telemetry({ weaponTallies: { 0: { shotsFired: 10, hits: 5, kills: 1 } } }), 30, 2);
    const b = buildPlayerFacingStats(telemetry({ weaponTallies: { 0: { shotsFired: 10, hits: 5, kills: 1 } } }), 45, 3);
    const merged = mergePlayerFacingStats(a, b);
    expect(merged.kills).toBe(5);
    expect(merged.shotsFired).toBe(20);
    expect(merged.hits).toBe(10);
    expect(merged.timeSurvivedSec).toBe(75);
  });

  it("recomputes accuracy from merged raw counts, not by averaging per-level percentages", () => {
    // Level A: 10/10 shots hit (100%). Level B: 0/90 hit (0%). A naive
    // average of the two percentages would read 50% — the merge must
    // instead read ~11% (10 hits / 100 total shots), weighted by volume.
    const a = buildPlayerFacingStats(telemetry({ weaponTallies: { 0: { shotsFired: 10, hits: 10, kills: 0 } } }), 0, 0);
    const b = buildPlayerFacingStats(telemetry({ weaponTallies: { 0: { shotsFired: 90, hits: 0, kills: 0 } } }), 0, 0);
    expect(mergePlayerFacingStats(a, b).weaponAccuracyPct).toBe(10);
  });

  it("elementwise-sums damageTakenBySource", () => {
    const a = buildPlayerFacingStats(
      telemetry({ damageBySource: { enemyMelee: 5, enemyRanged: 0, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 } }),
      0,
      0,
    );
    const b = buildPlayerFacingStats(
      telemetry({ damageBySource: { enemyMelee: 2, enemyRanged: 3, trapSpike: 0, trapMine: 0, hazard: 0, selfRocket: 0 } }),
      0,
      0,
    );
    const merged = mergePlayerFacingStats(a, b);
    expect(merged.damageTakenBySource.enemyMelee).toBe(7);
    expect(merged.damageTakenBySource.enemyRanged).toBe(3);
  });

  it("takes the min, not the sum or average, of minHealthReached", () => {
    const a = buildPlayerFacingStats(telemetry({ minHealthReached: 40 }), 0, 0);
    const b = buildPlayerFacingStats(telemetry({ minHealthReached: 8 }), 0, 0);
    expect(mergePlayerFacingStats(a, b).minHealthReached).toBe(8);
    expect(mergePlayerFacingStats(b, a).minHealthReached).toBe(8);
  });

  it("keeps the second (later) level's fatalDamageSource, not merged", () => {
    const a = buildPlayerFacingStats(telemetry({ fatalDamageSource: null }), 0, 0);
    const b = buildPlayerFacingStats(telemetry({ fatalDamageSource: "trapMine" }), 0, 0);
    expect(mergePlayerFacingStats(a, b).fatalDamageSource).toBe("trapMine");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";

import {
  hitRateByDistance,
  levelPacing,
  lootEconomy,
  measuredSelfSustain,
  summarize,
  survivability,
  timeToKillByArchetype,
  weaponUsage,
} from "./eventMetrics.mjs";

describe("summarize", () => {
  it("returns null for an empty sample rather than zero", () => {
    // "No observations" and "observed zero" are different answers, and
    // conflating them is how a missing metric reads as a good one.
    expect(summarize([])).toBeNull();
  });

  it("reports mean, median, p90 and max", () => {
    expect(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ n: 10, mean: 5.5, p50: 6, p90: 10, max: 10 });
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    summarize(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("weaponUsage", () => {
  it("counts trigger-pulls and pellets separately, which the aggregate counters conflate", () => {
    // A 7-pellet pull landing 3 pellets: one pull, 7 fired, 3 hits. The old
    // hits/shotsFired ratio would read 300%.
    const usage = weaponUsage([
      { e: "shot", w: 1, pellets: 7 },
      { e: "hit", w: 1 },
      { e: "hit", w: 1 },
      { e: "hit", w: 1 },
    ]);
    expect(usage[0]).toMatchObject({ w: 1, pulls: 1, pelletsFired: 7, pelletHits: 3, pullsThatHit: 1 });
    expect(usage[0].pelletHitRate).toBeCloseTo(3 / 7, 10);
    expect(usage[0].triggerHitRate).toBe(1);
  });

  it("counts a pull that landed nothing against the trigger hit rate", () => {
    const usage = weaponUsage([
      { e: "shot", w: 0, pellets: 1 },
      { e: "hit", w: 0 },
      { e: "shot", w: 0, pellets: 1 },
    ]);
    expect(usage[0]).toMatchObject({ pulls: 2, pullsThatHit: 1 });
    expect(usage[0].triggerHitRate).toBe(0.5);
  });

  it("derives overkill from the pre-clamp negative HP", () => {
    const usage = weaponUsage([
      { e: "damageDealt", w: 0, amt: 22, hpBefore: 5, hpAfter: -17 },
      { e: "damageDealt", w: 0, amt: 22, hpBefore: 40, hpAfter: 18 },
    ]);
    // Only the killing blow overshot; the non-lethal hit contributes nothing.
    expect(usage[0].overkill).toMatchObject({ n: 1, mean: 17, max: 17 });
  });

  it("splits damage and kill share across weapons", () => {
    const usage = weaponUsage([
      { e: "damageDealt", w: 0, amt: 75, hpBefore: 100, hpAfter: 25 },
      { e: "damageDealt", w: 1, amt: 25, hpBefore: 25, hpAfter: 0 },
      { e: "kill", w: 1, arch: "normal" },
    ]);
    expect(usage.find((u) => u.w === 0).shareOfDamage).toBe(0.75);
    expect(usage.find((u) => u.w === 1).shareOfKills).toBe(1);
  });

  it("ignores damage with no weapon, so splash and traps do not skew weapon share", () => {
    const usage = weaponUsage([{ e: "damageDealt", w: null, amt: 50, hpBefore: 60, hpAfter: 10 }]);
    expect(usage).toEqual([]);
  });
});

describe("hitRateByDistance", () => {
  it("buckets a pull's pellets by the range it was taken at", () => {
    const rows = hitRateByDistance([
      { e: "shot", w: 1, pellets: 7, dist: 1 },
      { e: "hit", w: 1, dist: 1 },
      { e: "shot", w: 1, pellets: 7, dist: 5 },
      { e: "hit", w: 1, dist: 5 },
      { e: "hit", w: 1, dist: 5 },
    ]);
    expect(rows.find((r) => r.bucket === "0-2")).toMatchObject({ fired: 7, hits: 1 });
    expect(rows.find((r) => r.bucket === "4-7")).toMatchObject({ fired: 7, hits: 2 });
  });

  it("excludes a pull with no target rather than bucketing it as zero range", () => {
    expect(hitRateByDistance([{ e: "shot", w: 0, pellets: 1, dist: null }])).toEqual([]);
  });

  it("puts anything past the last boundary in the open-ended bucket", () => {
    const rows = hitRateByDistance([{ e: "shot", w: 0, pellets: 1, dist: 40 }]);
    expect(rows[0].bucket).toBe("10+");
  });
});

describe("lootEconomy", () => {
  const events = [
    { e: "lootDropped", kind: "bullets", amount: 4, fromArch: "edgeCase" },
    { e: "lootDropped", kind: "health", amount: 20, fromArch: "normal" },
    { e: "lootCollected", kind: "bullets", source: "drop", grantedHealth: 0, grantedSwap: 0 },
    { e: "lootCollected", kind: "health", source: "drop", grantedHealth: 0, grantedSwap: 0 },
    { e: "lootCollected", kind: "bullets", source: "preplaced", grantedHealth: 0, grantedSwap: 0 },
    { e: "levelEnd", prePlacedUncollected: [{ pid: 1 }, { pid: 2 }], enemiesAlive: [{ eid: 3 }] },
  ];

  it("splits collection by source, which is the whole point of the field", () => {
    const economy = lootEconomy(events);
    expect(economy.collected).toMatchObject({ preplaced: 1, drop: 2 });
    expect(economy.relianceRatio).toBeCloseTo(2 / 3, 10);
  });

  it("attributes spawned drops to the archetype that paid for them", () => {
    expect(lootEconomy(events).dropped.byArch).toEqual({ edgeCase: 1, normal: 1 });
  });

  it("counts the nominal-vs-actual budget gap from levelEnd", () => {
    const economy = lootEconomy(events);
    expect(economy.uncollectedPrePlaced).toBe(2);
    expect(economy.unrealisedDropsFromAlive).toBe(1);
  });

  it("flags a health pickup that granted nothing as pure overflow", () => {
    // Collected at full stability: the pickup was consumed and gave zero back.
    expect(lootEconomy(events).wastedHealthPickups).toEqual({ total: 1, granted0: 1 });
  });
});

describe("measuredSelfSustain", () => {
  const damagePerAmmo = { bullets: 22, rockets: 150, smg: 12, gas: 19.2 };

  it("values an archetype's drops against the HP it cost to kill", () => {
    const sustain = measuredSelfSustain(
      [
        { e: "kill", arch: "normal", maxHp: 100 },
        { e: "lootDropped", kind: "bullets", amount: 4, fromArch: "normal" },
      ],
      damagePerAmmo,
    );
    expect(sustain.normal).toMatchObject({ kills: 1, hpKilled: 100, dropDamage: 88 });
    expect(sustain.normal.ratio).toBeCloseTo(0.88, 10);
  });

  it("shows a cheap archetype out-sustaining an expensive one on identical drops", () => {
    // The Edge Case takes the same drop path with no special-casing, so an
    // identical drop against a tenth of the HP is a tenfold ratio.
    const sustain = measuredSelfSustain(
      [
        { e: "kill", arch: "normal", maxHp: 100 },
        { e: "lootDropped", kind: "bullets", amount: 4, fromArch: "normal" },
        { e: "kill", arch: "edgeCase", maxHp: 10 },
        { e: "lootDropped", kind: "bullets", amount: 4, fromArch: "edgeCase" },
      ],
      damagePerAmmo,
    );
    expect(sustain.edgeCase.ratio / sustain.normal.ratio).toBeCloseTo(10, 10);
  });

  it("counts health and swap as effective health, not as damage", () => {
    const sustain = measuredSelfSustain(
      [
        { e: "kill", arch: "normal", maxHp: 50 },
        { e: "lootDropped", kind: "health", amount: 20, fromArch: "normal" },
      ],
      damagePerAmmo,
    );
    expect(sustain.normal.dropDamage).toBe(0);
    expect(sustain.normal.dropHealth).toBe(20);
  });
});

describe("timeToKillByArchetype", () => {
  it("closes the window from the aggro time the kill carries", () => {
    const ttk = timeToKillByArchetype([
      { e: "kill", arch: "normal", t: 5, aggroAt: 2 },
      { e: "kill", arch: "normal", t: 10, aggroAt: 9 },
    ]);
    expect(ttk.normal).toMatchObject({ n: 2, mean: 2 });
  });

  it("excludes a kill with no recorded aggro rather than counting it as instant", () => {
    expect(timeToKillByArchetype([{ e: "kill", arch: "normal", t: 5, aggroAt: null }])).toEqual({});
  });
});

describe("survivability", () => {
  it("totals damage by source and counts deaths", () => {
    const result = survivability([
      { e: "damageTaken", src: "enemyRanged", amt: 8, healthAfter: 92 },
      { e: "damageTaken", src: "enemyRanged", amt: 8, healthAfter: 84 },
      { e: "damageTaken", src: "trapMine", amt: 30, healthAfter: 54 },
      { e: "playerDeath", src: "trapMine" },
    ]);
    expect(result.bySource).toEqual({ enemyRanged: 16, trapMine: 30 });
    expect(result.deaths).toBe(1);
  });
});

describe("levelPacing", () => {
  it("aggregates repeat visits to the same level across runs", () => {
    const levels = levelPacing([
      { e: "levelEnd", lvl: 1, t: 40, killCount: 5, outcome: "cleared" },
      { e: "levelEnd", lvl: 1, t: 60, killCount: 7, outcome: "died" },
      { e: "levelEnd", lvl: 2, t: 30, killCount: 3, outcome: "cleared" },
    ]);
    expect(levels[0]).toMatchObject({ lvl: 1, visits: 2, outcomes: { cleared: 1, died: 1 } });
    expect(levels[0].time.mean).toBe(50);
    expect(levels[1].lvl).toBe(2);
  });
});

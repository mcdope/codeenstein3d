// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";

import {
  damageTakenByAttacker,
  hitRateByDistance,
  killRateByHpBand,
  levelPacing,
  lootEconomy,
  measuredSelfSustain,
  summarize,
  survivability,
  timeToKillByArchetype,
  weaponChoiceByTarget,
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

  it("reports no hit rate for a splash weapon, rather than a structural zero", () => {
    // A rocket never emits `hit` -- it resolves as damageDealt from the blast --
    // so hits/pellets would read 0% however well it performed. That artifact was
    // reported as a measurement once. Damage and kills still count.
    const usage = weaponUsage([
      { e: "shot", w: 4, pellets: 1, splash: true },
      { e: "damageDealt", w: 4, amt: 150, hpBefore: 200, hpAfter: 50 },
      { e: "kill", w: 4, arch: "normal" },
    ]);
    expect(usage[0].pelletHitRate).toBeNull();
    expect(usage[0].triggerHitRate).toBeNull();
    expect(usage[0]).toMatchObject({ pulls: 1, damage: 150, kills: 1 });
  });

  it("still reports a hit rate for hitscan weapons", () => {
    const usage = weaponUsage([{ e: "shot", w: 1, pellets: 4 }, { e: "hit", w: 1 }]);
    expect(usage[0].pelletHitRate).toBe(0.25);
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

describe("damageTakenByAttacker", () => {
  it("splits an event's damage across its attackers in proportion to their pre-multiplier shares", () => {
    // `by[].amt` sums to 20 while `amt` is 30 — the difficulty multiplier lives
    // between them. Summing `by[].amt` directly would under-report by a third.
    const result = damageTakenByAttacker([
      { e: "damageTaken", lvl: 3, src: "enemyMelee", amt: 30, by: [{ eid: 1, arch: "elite", amt: 15 }, { eid: 2, arch: "normal", amt: 5 }] },
    ]);
    expect(result.byArch.elite.amt).toBeCloseTo(22.5);
    expect(result.byArch.normal.amt).toBeCloseTo(7.5);
    expect(result.totalAmt).toBe(30);
  });

  it("reports trap and hazard damage as unattributed rather than dropping it", () => {
    const result = damageTakenByAttacker([
      { e: "damageTaken", lvl: 1, src: "hazard", amt: 12, by: null },
      { e: "damageTaken", lvl: 1, src: "enemyRanged", amt: 8, by: [{ eid: 0, arch: "normal", amt: 8 }] },
    ]);
    expect(result.totalAmt).toBe(20);
    expect(result.attributedAmt).toBe(8);
    expect(result.unattributedAmt).toBe(12);
  });

  it("keys attackers by level so the same eid on two levels is two enemies", () => {
    const hit = (lvl, eid, amt) => ({ e: "damageTaken", lvl, src: "enemyMelee", amt, by: [{ eid, arch: "elite", amt }] });
    const result = damageTakenByAttacker([hit(8, 1, 100), hit(12, 1, 40)]);
    expect(result.topAttackers).toHaveLength(2);
    expect(result.topAttackers[0]).toMatchObject({ lvl: 8, eid: 1, amt: 100 });
  });

  it("surfaces a single enemy that is the whole level", () => {
    // The Stage C reading in one shape: one Elite at 93% of all damage taken.
    const elite = { e: "damageTaken", lvl: 12, src: "enemyMelee", amt: 93, by: [{ eid: 1, arch: "elite", amt: 93 }] };
    const chaff = { e: "damageTaken", lvl: 12, src: "enemyMelee", amt: 7, by: [{ eid: 2, arch: "edgeCase", amt: 7 }] };
    const result = damageTakenByAttacker([elite, chaff]);
    expect(result.topAttackers[0].share).toBeCloseTo(0.93);
  });

  it("splits evenly when the shares are all zero rather than dividing by zero", () => {
    const result = damageTakenByAttacker([
      { e: "damageTaken", lvl: 1, src: "enemyMelee", amt: 10, by: [{ eid: 0, arch: "normal", amt: 0 }, { eid: 1, arch: "normal", amt: 0 }] },
    ]);
    expect(result.byArch.normal.amt).toBeCloseTo(10);
    expect(result.topAttackers.map((a) => a.amt)).toEqual([5, 5]);
  });
});

describe("killRateByHpBand", () => {
  const spawn = (...hps) => ({ e: "levelStart", enemies: hps.map((maxHp, eid) => ({ eid, maxHp, arch: "normal" })) });
  const kill = (maxHp, extra = {}) => ({ e: "kill", maxHp, arch: "normal", t: 10, aggroAt: 7, lvl: 1, ...extra });

  it("counts the roster as the denominator, so zero kills of zero spawns is not a zero rate", () => {
    // A kill count of 0 is meaningless without knowing how many existed —
    // an empty band reports null, a populated one that never dies reports 0%.
    const { bands } = killRateByHpBand([spawn(100, 100), kill(100)]);
    const small = bands.find((b) => b.band === "<250");
    const huge = bands.find((b) => b.band === "5000+");
    expect(small).toMatchObject({ spawned: 2, killed: 1, rate: 0.5 });
    expect(huge).toMatchObject({ spawned: 0, killed: 0, rate: null });
  });

  it("separates an enemy that is fought and won from one that only ever spawns", () => {
    const { bands } = killRateByHpBand([spawn(200, 200, 3000), kill(200), kill(200)]);
    expect(bands.find((b) => b.band === "<250").rate).toBe(1);
    expect(bands.find((b) => b.band === "3000-4999")).toMatchObject({ spawned: 1, killed: 0, rate: 0 });
  });

  it("reports median TTK per band, so a band that is 'won' slowly is visible", () => {
    const { bands } = killRateByHpBand([spawn(2500), kill(2500, { t: 30, aggroAt: 6 })]);
    expect(bands.find((b) => b.band === "2000-2999").ttk.p50).toBe(24);
  });

  it("names the largest enemy ever killed, which is the ceiling the generator may not exceed", () => {
    const { maxHpKilled } = killRateByHpBand([spawn(100, 2200), kill(100), kill(2200, { arch: "elite", difficulty: "normal", lvl: 11 })]);
    expect(maxHpKilled).toMatchObject({ maxHp: 2200, arch: "elite", lvl: 11, difficulty: "normal" });
  });

  it("returns no ceiling at all when nothing was killed", () => {
    expect(killRateByHpBand([spawn(3000)]).maxHpKilled).toBeNull();
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

describe("weaponChoiceByTarget", () => {
  const shot = (w, targetArch, dist) => ({ e: "shot", w, targetArch, dist, pellets: 1 });

  it("splits weapon choice by the target's archetype and the range fired at", () => {
    const rows = weaponChoiceByTarget(
      [shot(3, "normal", 5), shot(3, "normal", 5), shot(4, "normal", 5), shot(3, "edgeCase", 1)],
      { 3: "gdb", 4: "ghidra" },
    );
    const far = rows.find((r) => r.arch === "normal" && r.bucket === "4-7");
    expect(far).toMatchObject({ total: 3, byWeapon: { gdb: 2, ghidra: 1 } });
    expect(rows.find((r) => r.arch === "edgeCase")).toMatchObject({ bucket: "0-2", total: 1 });
  });

  it("is the query two failed A/Bs needed: which weapon at rocket-legal range", () => {
    // If ghidra is absent from the >=4 tile rows against non-Edge-Case
    // targets, the blocker is weapon *selection*, not the safety gate.
    const rows = weaponChoiceByTarget([shot(3, "normal", 6), shot(3, "elite", 6)], { 3: "gdb" });
    expect(rows.every((r) => !("ghidra" in r.byWeapon))).toBe(true);
  });

  it("excludes shots with no crosshair target rather than bucketing them", () => {
    expect(weaponChoiceByTarget([shot(0, null, 5), shot(0, "normal", null)], {})).toEqual([]);
  });

  it("falls back to an index label for an unnamed weapon", () => {
    expect(weaponChoiceByTarget([shot(9, "normal", 5)], {})[0].byWeapon).toEqual({ "#9": 1 });
  });
});

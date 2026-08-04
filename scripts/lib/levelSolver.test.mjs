// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Unit tests for the offline balance solver.
 *
 * Every constant the solver reads is injected, so these run against small
 * fixture tables rather than the real `weapons.ts`/`loot.ts` — which is the
 * point: a test that fed in the real numbers would break on every deliberate
 * balance change and prove nothing about the arithmetic. The real modules are
 * exercised end-to-end by `npm run balancing:budget` instead.
 *
 * `scripts/**` is excluded from the `src/` coverage denominator but is still
 * executed by `vitest run`, so this does run in CI — same as
 * `abReport.test.mjs` and `combatPolicy.test.mjs`.
 */
import { describe, expect, it } from "vitest";

import {
  archetypeOf,
  carryForward,
  dropBudget,
  enemyBudget,
  expectedEliteDrop,
  expectedRegularDrop,
  guaranteedLoadout,
  hpOutliers,
  poolDamageValues,
  prePlacedBudget,
  scaleRosterForDifficulty,
  scaledAmount,
  selfSustainByArchetype,
  solveCampaign,
  solveLevel,
  timeToKill,
  weaponProfile,
  weaponProfiles,
} from "./levelSolver.mjs";

/** A miniature arsenal shaped like the real one: a cheap single-pellet
 * baseline, a multi-pellet weapon that is more ammo-efficient per round, a
 * projectile, and a free melee fallback. */
const WEAPONS = [
  { name: "pea shooter", pellets: 1, damagePerPellet: 10, ammoPerShot: 1, ammoType: "bullets", fireIntervalSec: 0.2 },
  { name: "scattergun", pellets: 5, damagePerPellet: 10, ammoPerShot: 2, ammoType: "bullets", fireIntervalSec: 1 },
  { name: "shiv", pellets: 1, damagePerPellet: 25, ammoPerShot: 0, meleeRange: 1.5 },
  { name: "boomstick", pellets: 1, damagePerPellet: 100, ammoPerShot: 1, ammoType: "rockets", fireIntervalSec: 2, isRocket: true },
];

const DIFFICULTY_MULTIPLIERS = {
  easy: { hp: 0.5, damage: 1, ammoDropRate: 2, enemyAimSpreadDeg: 10 },
  normal: { hp: 1, damage: 1, ammoDropRate: 1, enemyAimSpreadDeg: 4 },
  hard: { hp: 2, damage: 1, ammoDropRate: 0.5, enemyAimSpreadDeg: 0 },
};

const WEIGHTS = [
  { kind: "bullets", weight: 50 },
  { kind: "rockets", weight: 25 },
  { kind: "health", weight: 100 },
  { kind: "swap", weight: 25 },
];

const profiles = weaponProfiles(WEAPONS);

const constants = {
  profiles,
  DIFFICULTY_MULTIPLIERS,
  lootWeightsFor: () => WEIGHTS,
  REGULAR_KILL_NO_DROP_CHANCE: 0.2,
  GDB_WEAPON_INDEX: 99, // no smg weapon in this fixture arsenal
  GHIDRA_WEAPON_INDEX: 3,
  FRIDAY_HOTFIX_WEAPON_INDEX: 98,
  STARTING_WEAPONS: [0, 1, 2],
  FORCED_UNLOCK_LEVELS: [{ level: 4, weaponIndex: 3, name: "boomstick" }],
  startingAmmo: () => ({ bullets: 100, rockets: 0, smg: 0, gas: 0 }),
  dropAmounts: {
    bullets: 10,
    rockets: 2,
    smg: 10,
    gas: 10,
    health: 20,
    swap: 5,
    eliteHealth: 50,
    eliteBullets: 30,
    eliteSwap: 40,
  },
};

const enemy = (maxHp, extra = {}) => ({ maxHp, hp: maxHp, elite: false, edgeCase: false, entity: { name: "f", complexityScore: 3 }, ...extra });

describe("weaponProfile", () => {
  it("multiplies damage by pellet count for hitscan weapons", () => {
    expect(weaponProfile(WEAPONS[1], 1).damagePerTrigger).toBe(50);
  });

  it("does not multiply by pellets for a rocket, whose damagePerPellet is the whole blast", () => {
    expect(weaponProfile(WEAPONS[3], 3).damagePerTrigger).toBe(100);
  });

  it("reports damage per ammo unit, which can rank a weapon differently from dps", () => {
    const pea = weaponProfile(WEAPONS[0], 0);
    const scatter = weaponProfile(WEAPONS[1], 1);
    // The scattergun is worse dps (50/s vs 50/s here) but twice as efficient
    // per round -- exactly the shotgun-vs-pistol relationship the real table
    // has, and the reason damagePerAmmo is a separate metric.
    expect(scatter.damagePerAmmo).toBe(25);
    expect(pea.damagePerAmmo).toBe(10);
  });

  it("gives melee weapons infinite damage per ammo, since they drain no pool", () => {
    expect(weaponProfile(WEAPONS[2], 2).damagePerAmmo).toBe(Infinity);
    expect(weaponProfile(WEAPONS[2], 2).melee).toBe(true);
  });

  it("falls back to the engine's melee cooldown when fireIntervalSec is absent", () => {
    expect(weaponProfile(WEAPONS[2], 2).fireIntervalSec).toBe(0.15);
  });
});

describe("timeToKill", () => {
  it("counts the gaps between shots, not the shots -- a one-shot kill is instant", () => {
    const boom = weaponProfile(WEAPONS[3], 3);
    expect(timeToKill(boom, 100)).toEqual({ shots: 1, seconds: 0, ammo: 1 });
  });

  it("charges N-1 intervals for N shots", () => {
    const pea = weaponProfile(WEAPONS[0], 0);
    // 35 HP needs 4 shots of 10, so 3 gaps of 0.2s.
    expect(timeToKill(pea, 35)).toEqual({ shots: 4, seconds: expect.closeTo(0.6, 10), ammo: 4 });
  });

  it("charges no ammo for melee", () => {
    expect(timeToKill(weaponProfile(WEAPONS[2], 2), 100).ammo).toBe(0);
  });
});

describe("poolDamageValues", () => {
  it("takes the best owned weapon per pool", () => {
    expect(poolDamageValues(profiles, [0, 1, 2]).bullets).toBe(25);
  });

  it("ignores weapons the player does not own", () => {
    expect(poolDamageValues(profiles, [0, 2]).bullets).toBe(10);
  });

  it("values a pool with no owned weapon at zero, not undefined", () => {
    // Rockets on the floor before the launcher is unlocked really are worth
    // nothing right now -- rollLoot filters them out for the same reason.
    expect(poolDamageValues(profiles, [0, 1, 2]).rockets).toBe(0);
  });
});

describe("scaledAmount", () => {
  it("applies the difficulty rate", () => {
    expect(scaledAmount(20, 1.3)).toBe(26);
  });

  it("never rounds a drop down to nothing", () => {
    // The real ROCKETS_DROP_AMOUNT is 1, and Hard's 0.7x would floor it to 0
    // without this -- a real asymmetry the ratios would otherwise misstate.
    expect(scaledAmount(1, 0.7)).toBe(1);
  });
});

describe("expectedRegularDrop", () => {
  const base = { constants, ownedWeapons: [0, 1, 2, 3], bonusLevel: false, difficulty: "normal" };

  it("excludes health from the weighted roll and grants it separately", () => {
    // health carries half the fixture's total weight, but healthHandledSeparately
    // drops it from the roll entirely -- so the grant is the flat drop amount,
    // not a weighted share. Swap still rides the roll and still counts as
    // effective health, since it absorbs damage 1:1.
    const swapFromRoll = (25 / 100) * 5 * 0.8;
    expect(expectedRegularDrop(base).health).toBeCloseTo(20 + swapFromRoll, 10);
  });

  it("skips the guaranteed health grant at full health, mirroring the engine's branch", () => {
    // Only the swap share survives, and it is still gated behind the roll.
    expect(expectedRegularDrop({ ...base, playerAtFullHealth: true }).health).toBeCloseTo((25 / 100) * 5 * 0.8, 10);
  });

  it("redistributes an unowned pool's share rather than producing dead loot", () => {
    const withRockets = expectedRegularDrop(base);
    const withoutRockets = expectedRegularDrop({ ...base, ownedWeapons: [0, 1, 2] });
    // Without the launcher the rockets entry leaves the table, so bullets'
    // share rises -- the remaining damage must not simply drop by rockets'
    // old contribution.
    const bulletsOnlyShare = (50 / 75) * 10 * 25 * 0.8;
    expect(withoutRockets.damage).toBeCloseTo(bulletsOnlyShare, 6);
    expect(withRockets.damage).toBeGreaterThan(withoutRockets.damage);
  });

  it("scales expected damage by the roll's hit rate", () => {
    expect(expectedRegularDrop(base).rollHitRate).toBe(0.8);
  });
});

describe("expectedEliteDrop", () => {
  it("yields no ammo at all for a damaged player, because the guaranteed drop is health", () => {
    const drop = expectedEliteDrop({ constants, ownedWeapons: [0, 1, 2, 3], difficulty: "normal" });
    expect(drop.damage).toBe(0);
    expect(drop.health).toBe(50);
  });

  it("falls back to a 50/50 bullets-or-swap coin flip at full health", () => {
    const drop = expectedEliteDrop({ constants, ownedWeapons: [0, 1, 2, 3], difficulty: "normal", playerAtFullHealth: true });
    expect(drop.damage).toBe(0.5 * 30 * 25);
    expect(drop.health).toBe(0.5 * 40);
  });
});

describe("scaleRosterForDifficulty", () => {
  it("scales HP without mutating the map's own roster", () => {
    const roster = [enemy(100)];
    const scaled = scaleRosterForDifficulty(roster, "hard", DIFFICULTY_MULTIPLIERS);
    expect(scaled[0].maxHp).toBe(200);
    expect(roster[0].maxHp).toBe(100);
  });

  it("rounds, matching the engine's own Math.round", () => {
    expect(scaleRosterForDifficulty([enemy(101)], "easy", DIFFICULTY_MULTIPLIERS)[0].maxHp).toBe(51);
  });
});

describe("archetypeOf / enemyBudget", () => {
  it("ranks elite above edgeCase, matching telemetry.ts's precedence", () => {
    expect(archetypeOf(enemy(1, { elite: true, edgeCase: true }))).toBe("elite");
  });

  it("totals HP per archetype", () => {
    const budget = enemyBudget([enemy(100), enemy(50, { edgeCase: true }), enemy(900, { elite: true })]);
    expect(budget.totalHp).toBe(1050);
    expect(budget.byArchetype.elite).toEqual({ count: 1, hp: 900 });
    expect(budget.byArchetype.edgeCase).toEqual({ count: 1, hp: 50 });
  });

  it("reports enemy DPS as null rather than guessing, since enemyAi's constants are private", () => {
    expect(enemyBudget([enemy(10)]).totalDps).toBeNull();
  });
});

describe("prePlacedBudget", () => {
  it("values ammo through the best owned weapon and health at face value", () => {
    const budget = prePlacedBudget({
      ammoPickups: [
        { kind: "bullets", amount: 10 },
        { kind: "health", amount: 30 },
      ],
      constants,
      ownedWeapons: [0, 1, 2],
      difficulty: "normal",
    });
    expect(budget.damage).toBe(250);
    expect(budget.health).toBe(30);
  });

  it("counts weapon pickups without valuing them", () => {
    const budget = prePlacedBudget({
      ammoPickups: [{ kind: "weapon", amount: 0, weaponIndex: 3 }],
      constants,
      ownedWeapons: [0],
      difficulty: "normal",
    });
    expect(budget.weaponPickups).toBe(1);
    expect(budget.damage).toBe(0);
  });

  it("applies difficulty scaling to pre-placed amounts, not just to drops", () => {
    const hard = prePlacedBudget({
      ammoPickups: [{ kind: "bullets", amount: 10 }],
      constants,
      ownedWeapons: [0, 1, 2],
      difficulty: "hard",
    });
    expect(hard.byKind.bullets).toBe(5);
  });
});

describe("selfSustainByArchetype", () => {
  const roster = [enemy(100), enemy(10, { edgeCase: true }), enemy(2000, { elite: true })];
  const args = { roster, constants, ownedWeapons: [0, 1, 2, 3], bonusLevel: false, difficulty: "normal" };

  it("flags a cheap archetype that drops like an expensive one", () => {
    const sustain = selfSustainByArchetype(args);
    // The Edge Case takes the regular drop path with no special-casing, so a
    // 10 HP nuisance is valued identically to a 100 HP regular enemy -- the
    // ratio is 10x higher purely because it is cheaper to kill.
    expect(sustain.edgeCase.ratio).toBeCloseTo(sustain.normal.ratio * 10, 6);
    expect(sustain.edgeCase.ratio).toBeGreaterThan(1);
  });

  it("reports an elite as a pure ammo sink", () => {
    expect(selfSustainByArchetype(args).elite.ratio).toBe(0);
  });

  it("returns null for an absent archetype rather than a misleading zero", () => {
    expect(selfSustainByArchetype({ ...args, roster: [enemy(100)] }).elite).toBeNull();
  });
});

describe("hpOutliers", () => {
  it("flags an enemy that outlasts every round on the level", () => {
    const outliers = hpOutliers([enemy(5000, { elite: true }), enemy(100)], 3000);
    expect(outliers[0].unkillable).toBe(true);
    expect(outliers[0].shareOfObtainable).toBeCloseTo(5000 / 3000, 10);
    expect(outliers[1].unkillable).toBe(false);
  });

  it("sorts hardest first", () => {
    expect(hpOutliers([enemy(10), enemy(900), enemy(300)], 10000).map((o) => o.maxHp)).toEqual([900, 300, 10]);
  });
});

describe("guaranteedLoadout", () => {
  it("is the starting three before any forced unlock", () => {
    expect(guaranteedLoadout(1, constants)).toEqual([0, 1, 2]);
  });

  it("adds a forced unlock once its level is reached", () => {
    expect(guaranteedLoadout(4, constants)).toEqual([0, 1, 2, 3]);
  });

  it("never assumes a lucky drop -- only the guaranteed floor", () => {
    expect(guaranteedLoadout(3, constants)).not.toContain(3);
  });
});

describe("solveLevel", () => {
  const map = { enemies: [enemy(100), enemy(100)], ammoPickups: [{ kind: "bullets", amount: 10 }], bonusLevel: false };

  it("uses the starting-ammo formula only when nothing is carried in", () => {
    const first = solveLevel({ map, constants, difficulty: "normal", ownedWeapons: [0, 1, 2] });
    expect(first.carried.fromStartingFormula).toBe(true);
    const later = solveLevel({ map, constants, difficulty: "normal", ownedWeapons: [0, 1, 2], carriedAmmo: { bullets: 4, rockets: 0, smg: 0, gas: 0 } });
    expect(later.carried.fromStartingFormula).toBe(false);
    expect(later.carried.damage).toBe(100);
  });

  it("separates the ratio you can reach without farming from the one that counts drops", () => {
    const solved = solveLevel({ map, constants, difficulty: "normal", ownedWeapons: [0, 1, 2], carriedAmmo: { bullets: 0, rockets: 0, smg: 0, gas: 0 } });
    // 10 bullets on the floor at 25 damage each, against 200 HP.
    expect(solved.clearRatio.withoutFarming).toBeCloseTo(250 / 200, 10);
    expect(solved.clearRatio.combined).toBeGreaterThan(solved.clearRatio.withoutFarming);
  });

  it("gets harder on hard, from both HP and drop scaling at once", () => {
    const normal = solveLevel({ map, constants, difficulty: "normal", ownedWeapons: [0, 1, 2], carriedAmmo: { bullets: 10, rockets: 0, smg: 0, gas: 0 } });
    const hard = solveLevel({ map, constants, difficulty: "hard", ownedWeapons: [0, 1, 2], carriedAmmo: { bullets: 10, rockets: 0, smg: 0, gas: 0 } });
    expect(hard.clearRatio.combined).toBeLessThan(normal.clearRatio.combined);
  });

  it("only reports TTK for weapons the player owns", () => {
    const solved = solveLevel({ map, constants, difficulty: "normal", ownedWeapons: [0, 2] });
    expect(Object.keys(solved.ttk.normal.byWeapon)).toEqual(["0", "2"]);
  });
});

describe("carryForward / solveCampaign", () => {
  it("spends the most efficient pool first and never carries a negative", () => {
    const solved = solveLevel({
      map: { enemies: [enemy(1000)], ammoPickups: [], bonusLevel: false },
      constants,
      difficulty: "normal",
      ownedWeapons: [0, 1, 2],
      carriedAmmo: { bullets: 8, rockets: 0, smg: 0, gas: 0 },
    });
    // 8 bullets at 25 damage is 200 against 1000 HP -- the pool empties.
    expect(carryForward(solved, constants).bullets).toBe(0);
  });

  it("leaves the surplus when the level costs less than what was carried", () => {
    const solved = solveLevel({
      map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false },
      constants,
      difficulty: "normal",
      ownedWeapons: [0, 1, 2],
      carriedAmmo: { bullets: 10, rockets: 0, smg: 0, gas: 0 },
    });
    expect(carryForward(solved, constants).bullets).toBeCloseTo(8, 10);
  });

  it("carries ammo across a campaign instead of restarting each level", () => {
    const levels = [
      { filename: "a", map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false } },
      { filename: "b", map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false } },
    ];
    const results = solveCampaign({ levels, constants, difficulty: "normal" });
    expect(results[0].carried.fromStartingFormula).toBe(true);
    expect(results[1].carried.fromStartingFormula).toBe(false);
    // Level 1 spent 50 HP worth of the 100 starting bullets at 25/round.
    expect(results[1].carried.ammo.bullets).toBeCloseTo(98, 10);
  });

  it("unlocks a forced weapon partway through the campaign", () => {
    const levels = Array.from({ length: 4 }, (_, i) => ({
      filename: `l${i}`,
      map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false },
    }));
    const results = solveCampaign({ levels, constants, difficulty: "normal" });
    expect(results[0].ownedWeapons).not.toContain(3);
    expect(results[3].ownedWeapons).toContain(3);
  });
});

describe("dropBudget", () => {
  it("values the whole roster, elites on their own separate path", () => {
    const roster = [enemy(100), enemy(2000, { elite: true })];
    const budget = dropBudget({ roster, constants, ownedWeapons: [0, 1, 2, 3], bonusLevel: false, difficulty: "normal" });
    expect(budget.damage).toBe(budget.perRegularKill.damage);
    expect(budget.health).toBe(budget.perRegularKill.health + budget.perEliteKill.health);
  });
});

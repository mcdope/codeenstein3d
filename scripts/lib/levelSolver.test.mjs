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
  DEFAULT_KILL_RATE,
  carryForward,
  dropBudget,
  enemyBudget,
  expectedEliteDrop,
  expectedRegularDrop,
  guaranteedLoadout,
  hpOutliers,
  incomingDps,
  poolDamageValues,
  prePlacedBudget,
  scaleRosterForDifficulty,
  scaledAmount,
  selfSustainByArchetype,
  solveCampaign,
  solveLevel,
  survivalWindow,
  threatScore,
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

const COMBAT = {
  MAX_HEALTH: 100,
  ATTACK_DAMAGE: 10,
  ATTACK_COOLDOWN: 0.8,
  PROJECTILE_DAMAGE: 8,
  FIRE_COOLDOWN_MIN: 1,
  FIRE_COOLDOWN_MAX: 3,
  RANGED_RANGE: 8,
  ELITE_DAMAGE_MULTIPLIER: 2,
  EDGE_CASE_DAMAGE_MULTIPLIER: 0.4,
  EDGE_CASE_SPEED_MULTIPLIER: 2.2,
};

const constants = {
  profiles,
  COMBAT,
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

  it("reports enemy DPS as null when no combat constants were supplied", () => {
    expect(enemyBudget([enemy(10)]).totalDps).toBeNull();
  });
});

describe("incomingDps / survivalWindow / threatScore", () => {
  it("sums melee and ranged, since the two cooldowns are independent", () => {
    const dps = incomingDps("normal", constants, "normal");
    expect(dps.melee).toBeCloseTo(10 / 0.8, 10);
    expect(dps.ranged).toBeCloseTo(8 / 2, 10);
    expect(dps.sustained).toBeCloseTo(dps.melee + dps.ranged, 10);
  });

  it("applies the archetype multiplier to both attacks", () => {
    const normal = incomingDps("normal", constants, "normal").sustained;
    expect(incomingDps("elite", constants, "normal").sustained).toBeCloseTo(normal * 2, 10);
    expect(incomingDps("edgeCase", constants, "normal").sustained).toBeCloseTo(normal * 0.4, 10);
  });

  it("compounds the difficulty damage multiplier on top", () => {
    const scaled = { ...constants, DIFFICULTY_MULTIPLIERS: { ...DIFFICULTY_MULTIPLIERS, hard: { ...DIFFICULTY_MULTIPLIERS.hard, damage: 1.5 } } };
    expect(incomingDps("normal", scaled, "hard").sustained).toBeCloseTo(incomingDps("normal", scaled, "normal").sustained * 1.5, 10);
  });

  it("halves the survival window when the attacker count doubles", () => {
    const one = survivalWindow("normal", 1, constants, "normal");
    expect(survivalWindow("normal", 2, constants, "normal")).toBeCloseTo(one / 2, 10);
  });

  it("counts armour as effective health, since swap absorbs 1:1", () => {
    expect(survivalWindow("normal", 1, constants, "normal", 100)).toBeCloseTo(survivalWindow("normal", 1, constants, "normal") * 2, 10);
  });

  it("ranks a fast weak archetype against a slow strong one via speed and hp terms", () => {
    // The Edge Case deals 0.4x damage but moves 2.2x as fast, so at equal HP
    // it out-threatens a regular enemy -- which is the comparison a bare DPS
    // number cannot make.
    const edge = threatScore("edgeCase", 100, constants, "normal");
    const normal = threatScore("normal", 100, constants, "normal");
    expect(edge / normal).toBeCloseTo(0.4 * 2.2, 10);
  });

  it("grows with HP sublinearly, so a damage sponge cannot outrank a lethal enemy", () => {
    const small = threatScore("normal", 100, constants, "normal");
    const big = threatScore("normal", 400, constants, "normal");
    expect(big / small).toBeCloseTo(2, 10);
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
  const levelOf = (hp, ammo) =>
    solveLevel({
      map: { enemies: [enemy(hp)], ammoPickups: [], bonusLevel: false },
      constants,
      difficulty: "normal",
      ownedWeapons: [0, 1, 2],
      carriedAmmo: { bullets: ammo, rockets: 0, smg: 0, gas: 0 },
    });

  it("drains the pool on a level it cannot afford, then banks only what it earned", () => {
    // 8 bullets at 25 damage is 200 against 1000 HP, so the spend empties the
    // pool outright. What comes back is the dead enemy's own drop and nothing
    // else -- strictly less than was carried in, and never negative.
    const left = carryForward(levelOf(1000, 8), constants, 1).bullets;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(8);
  });

  it("leaves the surplus when the level costs less than what was carried", () => {
    // 50 HP costs 2 bullets of 10; the enemy's own drop is banked on top, so
    // the carry lands above the 8 the spend alone would leave.
    const left = carryForward(levelOf(50, 10), constants, 1).bullets;
    expect(left).toBeGreaterThan(8);
  });

  it("banks and charges on the same rate, which is the whole point", () => {
    // The bug this exists to fix: the old model charged for the whole roster
    // while banking none of its drops, which double-penalises every later
    // level and, on the real campaign, manufactured a collapse play does not
    // show. Fighting more must cost more *and* return more.
    const solved = levelOf(1000, 100);
    const none = carryForward(solved, constants, 0).bullets;
    const half = carryForward(solved, constants, 0.5).bullets;
    const all = carryForward(solved, constants, 1).bullets;
    expect(none).toBe(100); // fought nothing: spent nothing, banked nothing
    expect(half).toBeLessThan(none); // this roster is a net loss to fight
    expect(all).toBeLessThan(half);
    // and the drops really are in there -- the spend alone would leave less
    const spendOnly = 100 - (1000 * 0.5) / 25;
    expect(half).toBeGreaterThan(spendOnly);
  });

  it("carries ammo across a campaign instead of restarting each level", () => {
    const levels = [
      { filename: "a", map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false } },
      { filename: "b", map: { enemies: [enemy(50)], ammoPickups: [], bonusLevel: false } },
    ];
    const results = solveCampaign({ levels, constants, difficulty: "normal", killRate: 1 });
    expect(results[0].carried.fromStartingFormula).toBe(true);
    expect(results[1].carried.fromStartingFormula).toBe(false);
    // 100 starting bullets, 50 HP costs 2 at 25 damage, plus the banked drop.
    expect(results[1].carried.ammo.bullets).toBeGreaterThan(98);
  });

  it("defaults to the measured kill rate", () => {
    const levels = [{ filename: "a", map: { enemies: [enemy(500)], ammoPickups: [], bonusLevel: false } }];
    const dflt = solveCampaign({ levels, constants, difficulty: "normal" });
    const explicit = solveCampaign({ levels, constants, difficulty: "normal", killRate: DEFAULT_KILL_RATE });
    expect(dflt[0].carried.damage).toBe(explicit[0].carried.damage);
    expect(DEFAULT_KILL_RATE).toBeGreaterThan(0);
    expect(DEFAULT_KILL_RATE).toBeLessThan(1);
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

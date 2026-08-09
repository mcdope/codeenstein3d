// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Unit tests for `maybeDetourForLoot`, which had none.
 *
 * It had none, and it was the single largest defect the 2026-08-06 sweep found:
 * on serilog level 9 the bot spent **87% of 14,268 tiles walked** detouring for
 * loot against 12% on the route, and every one of that repository's 60 capture
 * runs wedged without a single death. Three causes compounded — the detour is
 * re-picked once per *waypoint*, kills keep creating fresh drops, and some
 * drops were geometrically uncollectable — so each fix is pinned here
 * separately.
 *
 * Driven through `botDrive.test.mjs`'s subclass idiom: replace only the methods
 * that touch a page, plus `readLootSources`, which exists as a seam for exactly
 * this (see its doc comment in `bot.mjs`). Everything under test — the
 * selection scan, the budget, the give-up counter — is the real implementation.
 */
import { describe, expect, it } from "vitest";
import { Bot } from "./bot.mjs";
import { PROFILES } from "./profiles.mjs";

const PLAYER = {
  x: 1.5,
  y: 1.5,
  dirX: 1,
  dirY: 0,
  health: 100,
  healthFraction: 1,
  state: "playing",
  ammo: { bullets: 50 },
  weaponIndex: 0,
  ownedWeapons: [0, 1],
  meleeWouldHit: false,
  wouldMineHit: false,
  levelTime: 0,
  distanceTraveled: 0,
  swap: 0,
};

function openMap(w = 12, h = 12) {
  const grid = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 0)),
  );
  return { grid, width: w, height: h, exit: { x: 6, y: 6 }, spawn: { x: 1, y: 1 }, enemies: [], ammoPickups: [], keys: [], mines: [], spikeTraps: [] };
}

/**
 * Records every waypoint driven and never actually moves the player, so a test
 * can assert *what the bot aimed at* without simulating collection. `drops` is
 * mutable so a test can model a pickup vanishing — or refusing to.
 */
class LootBot extends Bot {
  constructor({ drops = [], healthFraction = 1, tuning = {} } = {}) {
    super({ evaluate: async () => ({}) }, PROFILES.Casual, { realtime: false, tuning });
    this.player = { ...PLAYER, healthFraction };
    this.drops = drops;
    this.driven = [];
    this.startLevel(openMap());
  }
  async readState() {
    return this.player;
  }
  async readFull() {
    return { player: this.player, enemies: [], mines: [], projectiles: [] };
  }
  async readLootSources() {
    return { player: this.player, dynamicDrops: this.drops, dynamicKeys: [] };
  }
  async driveTowardWithReplan(wp) {
    this.driven.push(wp);
    return { state: "playing" };
  }
}

const drop = (x, y, kind = "bullets") => ({ x, y, kind });

describe("maybeDetourForLoot — reaching the drop", () => {
  it("drives to the drop's own coordinate, not its tile centre", async () => {
    // The bug this pins: the engine collects within AMMO_PICKUP_RADIUS (0.5) of
    // the drop, the bot arrives within ARRIVE_EPS (0.15) of its waypoint, and
    // centre-to-corner is 0.707. A drop at .05/.05 sits 0.636 from the centre —
    // out of reach — so aiming at the centre could never collect it, and
    // nothing marked it collected either, so it was re-picked forever.
    const bot = new LootBot({ drops: [drop(5.05, 5.05)] });
    await bot.maybeDetourForLoot(new Set());
    const last = bot.driven.at(-1);
    expect(last).toEqual({ x: 5.05, y: 5.05 });
    // and it is genuinely outside the old aim point's pickup radius
    expect(Math.hypot(5.05 - 5.5, 5.05 - 5.5)).toBeGreaterThan(0.5);
  });
});

describe("maybeDetourForLoot — giving up", () => {
  it("abandons a drop it keeps failing to collect, then stops offering it", async () => {
    const bot = new LootBot({ drops: [drop(5.5, 5.5)], tuning: { LOOT_TARGET_GIVEUP_ATTEMPTS: 2 } });
    await bot.maybeDetourForLoot(new Set()); // attempt 1
    await bot.maybeDetourForLoot(new Set()); // attempt 2
    const drivenBefore = bot.driven.length;
    await bot.maybeDetourForLoot(new Set()); // over budget -> abandoned
    await bot.maybeDetourForLoot(new Set()); // and stays abandoned
    expect(bot.lootAbandoned.has("5.5,5.5")).toBe(true);
    expect(bot.driven.length).toBe(drivenBefore);
  });

  it("still detours to a different drop after abandoning one", async () => {
    // Selection is by BFS path length, so the nearer drop is taken first and is
    // therefore the one that gets abandoned — the player starts at (1.5,1.5).
    // Giving up on one target must not give up on loot altogether.
    const bot = new LootBot({ drops: [drop(5.5, 5.5), drop(3.5, 1.5)], tuning: { LOOT_TARGET_GIVEUP_ATTEMPTS: 1 } });
    await bot.maybeDetourForLoot(new Set());
    expect(bot.lootTarget).toBe("3.5,1.5");
    await bot.maybeDetourForLoot(new Set()); // second approach abandons it
    expect(bot.lootAbandoned.has("3.5,1.5")).toBe(true);
    bot.driven.length = 0;
    await bot.maybeDetourForLoot(new Set());
    expect(bot.driven.at(-1)).toEqual({ x: 5.5, y: 5.5 });
  });
});

describe("maybeDetourForLoot — commitment", () => {
  it("keeps its target instead of re-deciding while it is still on offer", async () => {
    // A nearer drop appearing mid-approach used to win the next scan, which is
    // how the re-pick-per-waypoint loop turned into a treadmill.
    const bot = new LootBot({ drops: [drop(6.5, 6.5)] });
    await bot.maybeDetourForLoot(new Set());
    expect(bot.lootTarget).toBe("6.5,6.5");
    bot.drops.unshift(drop(2.5, 1.5)); // much nearer, appears later
    bot.driven.length = 0;
    await bot.maybeDetourForLoot(new Set());
    expect(bot.driven.at(-1)).toEqual({ x: 6.5, y: 6.5 });
  });

  it("releases the target once it is collected and picks the next", async () => {
    const bot = new LootBot({ drops: [drop(6.5, 6.5)] });
    await bot.maybeDetourForLoot(new Set());
    bot.drops = [drop(2.5, 1.5)]; // the first was collected and is gone
    bot.driven.length = 0;
    await bot.maybeDetourForLoot(new Set());
    expect(bot.driven.at(-1)).toEqual({ x: 2.5, y: 1.5 });
  });
});

describe("maybeDetourForLoot — the budget", () => {
  it("stops detouring once the level's budget is spent", async () => {
    const bot = new LootBot({ drops: [drop(6.5, 6.5)] });
    bot.lootBudgetTiles = 2; // less than the path costs
    await bot.maybeDetourForLoot(new Set());
    expect(bot.lootBudgetTiles).toBeLessThanOrEqual(0);
    bot.driven.length = 0;
    bot.drops = [drop(3.5, 1.5)];
    await bot.maybeDetourForLoot(new Set());
    expect(bot.driven).toEqual([]);
  });

  it("never budgets away an urgent health detour", async () => {
    // Casual's healthDetourThreshold is 0.75, so 0.2 is urgent. Survival is not
    // shopping: a starving bot must still be allowed to walk to a medkit.
    const bot = new LootBot({ drops: [drop(6.5, 6.5, "health")], healthFraction: 0.2 });
    bot.lootBudgetTiles = 0;
    await bot.maybeDetourForLoot(new Set());
    expect(bot.driven.at(-1)).toEqual({ x: 6.5, y: 6.5 });
    expect(bot.lootBudgetTiles).toBe(0); // urgent detours spend nothing
  });

  it("driveLegs sizes the budget from the planned route", async () => {
    const bot = new LootBot({ drops: [] });
    const legs = [{ kind: "walk", waypoints: [{ x: 2.5, y: 1.5 }, { x: 3.5, y: 1.5 }, { x: 4.5, y: 1.5 }] }];
    await bot.driveLegs(legs);
    expect(bot.lootBudgetTiles).toBe(3 * bot.tuning.LOOT_BUDGET_FRACTION);
  });

  it("startLevel resets every per-level loot counter", async () => {
    const bot = new LootBot({ drops: [drop(5.5, 5.5)], tuning: { LOOT_TARGET_GIVEUP_ATTEMPTS: 1 } });
    await bot.maybeDetourForLoot(new Set());
    await bot.maybeDetourForLoot(new Set());
    expect(bot.lootAbandoned.size).toBeGreaterThan(0);
    bot.startLevel(openMap());
    expect(bot.lootAbandoned.size).toBe(0);
    expect(bot.lootAttempts.size).toBe(0);
    expect(bot.lootTarget).toBeNull();
    expect(bot.lootBudgetTiles).toBe(Infinity);
  });
});

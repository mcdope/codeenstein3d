// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Unit tests for `Bot`'s drive loops — the layer between the pure decision
 * core (`combatPolicy.test.mjs`) and a real browser.
 *
 * These exist because the drive loops had no direct coverage at all, and the
 * three defects they assert were each found the expensive way, from a CI job
 * that had been failing on master for four consecutive runs:
 *
 *  - `driveLegs` dropped `reason` when reporting a stuck route, so a caller
 *    that checked the reason was told the route had succeeded;
 *  - `driveToward` had no idea whether it was making progress, so a wedged
 *    drive spent its entire budget proving it before anything re-planned;
 *  - `driveToExit`'s blocker hunt is dead code under `ignoreThreats`, because
 *    the kill it waits for comes from the very combat branches that option
 *    suppresses.
 *
 * The bail's two exclusions are the most important assertions here. Both
 * mirror an exemption the offline anomaly detectors already apply, and a
 * regression in either would make the bot give up on a spike trap it is
 * *supposed* to wait out, or on a firefight it is winning.
 *
 * `Bot` is driven through a subclass that replaces only the four methods that
 * touch a page. Everything under test — the loops, the budgets, the tuning
 * gates — is the real implementation.
 */
import { describe, expect, it } from "vitest";
import { Bot, SPIKE_TRAP_TILE } from "./bot.mjs";
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

/** An open room with a rock border, big enough for a real BFS path. */
function openMap(w = 10, h = 10) {
  const grid = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : 0)),
  );
  return {
    grid,
    width: w,
    height: h,
    exit: { x: 5, y: 5 },
    spawn: { x: 1, y: 1 },
    enemies: [],
    ammoPickups: [],
    keys: [],
    mines: [],
    spikeTraps: [],
  };
}

/**
 * `Bot` with only its page-touching methods replaced. `onTick` decides how the
 * world evolves per decision, which is what lets a test express "the player is
 * pinned against a wall" without needing a wall.
 */
class FakeBot extends Bot {
  constructor({ onTick, enemies = [], tuning = {}, ignoreThreats = false } = {}) {
    super({ evaluate: async () => ({}) }, PROFILES.Casual, { realtime: false, tuning, ignoreThreats });
    this.player = { ...PLAYER };
    this.enemies = enemies;
    this.onTick = onTick ?? ((p) => p);
    this.ticks = 0;
    this.ignoreThreatsSeen = [];
  }
  async readFull() {
    return { player: this.player, enemies: this.enemies, mines: [], projectiles: [] };
  }
  async readState() {
    return this.player;
  }
  async applyAction() {
    return {};
  }
  async tick(player) {
    this.ticks += 1;
    this.player = { ...this.onTick(this.player, this.ticks) };
    return { player: this.player, enemies: this.enemies, mines: [], projectiles: [] };
  }
}

describe("driveToward's no-progress bail", () => {
  const PINNED = { onTick: (p) => p }; // never moves

  it("is off by default, so a pinned drive still burns the whole budget", async () => {
    const bot = new FakeBot(PINNED);
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 30);
    expect(result).toEqual({ state: "playing", reason: "stuck" });
    expect(bot.ticks).toBe(30);
  });

  it("gives up after BOT_NAV_STALL_BAIL_TICKS instead, when enabled", async () => {
    const bot = new FakeBot({ ...PINNED, tuning: { BOT_NAV_STALL_BAIL_TICKS: 5 } });
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 600);
    expect(result).toEqual({ state: "playing", reason: "stuck" });
    // The point of the whole change: a wedge costs 5 decisions, not 600.
    expect(bot.ticks).toBeLessThanOrEqual(6);
  });

  it("does not fire while the bot is actually moving", async () => {
    const bot = new FakeBot({
      onTick: (p) => ({ ...p, x: p.x + 0.3 }),
      tuning: { BOT_NAV_STALL_BAIL_TICKS: 5 },
    });
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 600);
    expect(result.reason).toBe("arrived");
  });

  it("does not fire on crawling progress that still leaves the stall radius", async () => {
    // 0.2/decision is well under a normal step but clears the 0.5 radius every
    // three decisions — real progress, just slow. Anchoring on a radius rather
    // than exact equality is what makes this distinguishable from a wedge.
    const bot = new FakeBot({
      onTick: (p) => ({ ...p, x: p.x + 0.2 }),
      tuning: { BOT_NAV_STALL_BAIL_TICKS: 5 },
    });
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 600);
    expect(result.reason).toBe("arrived");
  });

  it("does not fire while waiting out an active spike trap", async () => {
    // `detectAnomalies` refuses to call a spike wait a stall for the same
    // reason: standing still there is the correct move, for up to ~55
    // decisions. Bailing would send the bot re-planning around a trap that was
    // about to retract.
    const map = openMap();
    // Directly ahead of the player at (1.5,1.5) facing +x, and phased so it is
    // in the damaging half of its cycle at levelTime 0.
    map.grid[1][2] = SPIKE_TRAP_TILE;
    map.spikeTraps = [{ x: 2, y: 1, phase: 1, period: 2 }];
    const bot = new FakeBot({ ...PINNED, tuning: { BOT_NAV_STALL_BAIL_TICKS: 5 } });
    bot.startLevel(map);
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 20);
    expect(result).toEqual({ state: "playing", reason: "stuck" });
    expect(bot.ticks).toBe(20); // budget exhausted, not bailed
  });

  it("does not fire while engaged with a threat", async () => {
    // Mirrors `detectAnomalies`' `mostlyFiring` exemption and `driveToward`'s
    // own combat-tick relaxation: standing still to shoot is not a wedge.
    const enemies = [{ alive: true, aggroed: true, x: 2.0, y: 1.5, health: 50, elite: false, edgeCase: false }];
    const bot = new FakeBot({ ...PINNED, enemies, tuning: { BOT_NAV_STALL_BAIL_TICKS: 5 } });
    bot.startLevel(openMap());
    const result = await bot.driveToward({ x: 8.5, y: 1.5 }, 0.15, 20);
    expect(result.reason).toBe("stuck");
    expect(bot.ticks).toBeGreaterThan(5);
  });
});

describe("driveLegs", () => {
  it("reports a stuck route with both state and reason", async () => {
    // The transition script branched on `reason` and every other caller on
    // `state`. Dropping either silently tells one of them the opposite of what
    // happened.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.driveTowardWithReplan = async () => ({ state: "playing", reason: "stuck" });
    bot.maybeDetourForLoot = async () => ({ state: "playing" });
    const outcome = await bot.driveLegs([{ kind: "walk", waypoints: [{ x: 2.5, y: 1.5 }] }]);
    expect(outcome).toEqual({ state: "stuck", reason: "stuck" });
  });
});

describe("driveToExit", () => {
  it("treats an accepted exit as arrival even while the player stays 'playing'", async () => {
    // Multiplayer starts a countdown rather than ending the level, so the
    // single-player `state !== "playing"` signal never fires and a successful
    // run used to report itself stuck.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.driveToward = async () => ({ state: "playing", reason: "arrived" });
    bot.exitAccepted = async () => true;
    expect(await bot.driveToExit({ x: 5.5, y: 5.5 }, 80)).toEqual({ state: "playing", reason: "arrived" });
  });

  it("defaults exitAccepted to false, leaving single-player behaviour unchanged", async () => {
    expect(await new FakeBot().exitAccepted()).toBe(false);
  });

  it("hunts the exit-room blocker with combat on, and restores ignoreThreats after", async () => {
    // The hunt kills nothing without this: it walks at the blocker and waits
    // for the ordinary combat branches, which `ignoreThreats` suppresses.
    const map = openMap();
    map.enemies = [{ home: { x: 0, y: 0, w: 10, h: 10 } }];
    const bot = new FakeBot({ ignoreThreats: true, enemies: [{ alive: true, x: 6.5, y: 5.5, aggroed: false }] });
    bot.startLevel(map);
    bot.exitAccepted = async () => false;
    bot.driveToward = async () => {
      bot.ignoreThreatsSeen.push({ activity: bot.activity, ignoreThreats: bot.ignoreThreats });
      return { state: "playing", reason: "arrived" };
    };

    await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);

    const byActivity = (name) => bot.ignoreThreatsSeen.filter((s) => s.activity === name);
    expect(byActivity("exitHunt").length).toBeGreaterThan(0);
    expect(byActivity("exitHunt").every((s) => s.ignoreThreats === false)).toBe(true);
    // Scoped to the hunt alone — the caller's own setting is what everything
    // else runs under, which is what keeps the route threat-free.
    expect(byActivity("exit").every((s) => s.ignoreThreats === true)).toBe(true);
    expect(bot.ignoreThreats).toBe(true);
  });
});

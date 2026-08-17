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

describe("startLevel", () => {
  it("does not write the engine's live grid back into the caller's plan", async () => {
    // `levelPlans[i].map` is built once and reused for every attempt, and
    // `#refreshGridIfChanged` assigns into `this.map.grid` as doors open. When
    // those were the same object, attempt 1 rewrote the plan and attempt 2
    // routed against attempt 1's end-of-level grid. Found on a two-attempt
    // serilog run: attempt 1 clean, attempt 2 mismatching on five levels.
    const plan = openMap();
    const before = plan.grid.map((row) => [...row]);
    const bot = new FakeBot({});
    bot.startLevel(plan);
    // Simulate the live-grid refresh opening a door.
    bot.map.grid[1][1] = 3;
    expect(plan.grid).toEqual(before);
    expect(bot.map.grid[1][1]).toBe(3);
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

  it("defaults levelAdvancedUnderUs to false, leaving single-player behaviour unchanged", async () => {
    expect(await new FakeBot().levelAdvancedUnderUs()).toBe(false);
  });

  it("stops immediately when the level advanced under a bot that is stuck, not moving", async () => {
    // The `verify (multiplayer-transition)` failure of 2026-08-17 (CI run
    // 32044599072). Every other `exitAccepted()` check fires only after a
    // drive reports `teleported` — a jump no legal step explains. A bot that
    // is *stuck* never produces one, so nothing asked whether the level had
    // already moved on, and the loop drove at a dead exit until a 9-minute
    // wall-clock deadline killed a run that had in fact already won.
    //
    // Note what makes this test the one that would have caught it: the drive
    // never returns `teleported`. Every pre-existing test in this block hands
    // the loop a teleport or an arrival, which is exactly the path that
    // already worked.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    let drives = 0;
    bot.driveToward = async () => {
      drives += 1;
      return { state: "playing", reason: "stuck" };
    };
    bot.levelAdvancedUnderUs = async () => true;
    const result = await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(result).toEqual({ state: "playing", reason: "teleported" });
    // Round 0 bails before driving at all — the whole point is that no budget
    // is spent on a level that no longer exists.
    expect(drives).toBe(0);
  });

  it("keeps driving to a real arrival when a countdown is running but the level has NOT advanced", async () => {
    // The distinction `levelAdvancedUnderUs` exists to draw, and the reason it
    // is not just `exitAccepted()`. A running countdown makes `exitAccepted()`
    // true while this level is still the live one — the bot can and should go
    // on to reach the exit and report `arrived`. Bailing here would report a
    // legitimate arrival as a teleport, and downstream
    // (`run-balancing-telemetry-multiplayer.mjs`) that is the difference
    // between `reachedExit` and `levelAdvanced`.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.driveToward = async () => ({ state: "playing", reason: "arrived" });
    bot.exitAccepted = async () => true;
    bot.levelAdvancedUnderUs = async () => false;
    expect(await bot.driveToExit({ x: 5.5, y: 5.5 }, 80)).toEqual({ state: "playing", reason: "arrived" });
  });

  it("does not backtrack on round 0 by default, however far away it is", async () => {
    // Single-player's caller always ends its legs on the exit, so round 0 has
    // nothing to path around and this must stay exactly as it was.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.player = { ...bot.player, x: 1.5, y: 1.5 }; // nowhere near the exit
    const seen = [];
    bot.driveToward = async () => {
      seen.push(bot.activity);
      return { state: "playing", reason: "arrived" };
    };
    bot.exitAccepted = async () => true;
    await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(seen).not.toContain("exitBacktrack");
  });

  it("backtracks on round 0 when far from the exit and BOT_EXIT_BACKTRACK_TILES is set", async () => {
    // The multiplayer case: a wedged route hands off from 22 tiles out, and
    // straight-lining from there is a whole budget spent walking into a wall.
    const bot = new FakeBot({ tuning: { BOT_EXIT_BACKTRACK_TILES: 1.5 } });
    bot.startLevel(openMap());
    bot.player = { ...bot.player, x: 1.5, y: 1.5 };
    const seen = [];
    bot.driveToward = async () => {
      seen.push(bot.activity);
      return { state: "playing", reason: "arrived" };
    };
    bot.exitAccepted = async () => true;
    await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(seen).toContain("exitBacktrack");
  });

  it("does not claim arrival from an accepted exit this bot did not stand on", async () => {
    // `exitAccepted()` reports that the exit was *taken*, not who took it. In
    // a session where every player is bot-driven, a teammate's exit touch
    // satisfies it too. Reporting that as this bot's own arrival would fold
    // `run-balancing-telemetry-multiplayer.mjs`'s `levelAdvanced` outcome into
    // `reachedExit` and inflate the qualifying count that balancing decisions
    // are made from — a corrupted metric, not just a wrong test result.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.driveToward = async () => ({ state: "playing", reason: "teleported" });
    bot.exitAccepted = async () => true;
    const result = await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(result.reason).toBe("teleported");
  });

  it("still fails when a teleport keeps happening and the exit is never accepted", async () => {
    // Unchanged intent, sharper assertion: a pad the bot cannot get past must
    // terminate rather than loop, and must not be mistaken for arrival.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    bot.driveToward = async () => ({ state: "playing", reason: "teleported" });
    bot.exitAccepted = async () => false;
    const result = await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(result.reason).not.toBe("arrived");
    expect(result.reason).toBe("stuck");
  });

  it("re-plans past a teleporter pad instead of abandoning the exit", async () => {
    // The regression this exists for. A pad on the route to the exit warped
    // the host mid-drive; `driveToExit` reported `teleported` and stopped, so
    // the exit was never touched and the countdown never started —
    // `verify (multiplayer-transition)` failed 2 of 2 CI runs that way.
    //
    // A pad is distinguishable from a real transition, which is the whole
    // point: `exitAccepted()` is false for a pad (no countdown, exit tile
    // unchanged) and true for a transition. False means walk back and carry
    // on, which is what a player would do.
    const bot = new FakeBot();
    bot.startLevel(openMap());
    let drives = 0;
    bot.driveToward = async () => {
      drives += 1;
      return drives === 1 ? { state: "playing", reason: "teleported" } : { state: "playing", reason: "arrived" };
    };
    // False while the pad warp is being classified, true once the bot has
    // actually reached and taken the exit.
    bot.exitAccepted = async () => drives > 1;
    const result = await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(result.reason).toBe("arrived");
    expect(drives).toBeGreaterThan(1);
  });

  it("fights a blocker that is already adjacent, where there is no path to walk", async () => {
    // The failure this exists for: the host standing dead centre on the exit
    // with the blocker aggroed on the same tile at full health. `#walkPathTo`
    // had a zero-length path and returned instantly, so all six rounds passed
    // without executing a single decision and nothing ever shot.
    const map = openMap();
    map.enemies = [{ home: { x: 0, y: 0, w: 10, h: 10 } }];
    const bot = new FakeBot({ ignoreThreats: true, enemies: [{ alive: true, x: 5.5, y: 5.5, aggroed: true }] });
    bot.startLevel(map);
    bot.exitAccepted = async () => false;
    // Standing on the exit already, and the blocker is on that same tile.
    bot.player = { ...bot.player, x: 5.5, y: 5.5 };

    let decisionsUnderCombat = 0;
    bot.driveToward = async (point, eps, maxTicks) => {
      if (bot.activity === "exitHunt" && !bot.ignoreThreats) decisionsUnderCombat += maxTicks;
      return { state: "playing", reason: "stuck" };
    };

    await bot.driveToExit({ x: 5.5, y: 5.5 }, 80);
    expect(decisionsUnderCombat).toBeGreaterThan(0);
  });

  it("stops fighting the moment the blocker dies", async () => {
    const map = openMap();
    map.enemies = [{ home: { x: 0, y: 0, w: 10, h: 10 } }];
    const bot = new FakeBot({ ignoreThreats: true, enemies: [{ alive: true, x: 5.5, y: 5.5, aggroed: true }] });
    bot.startLevel(map);
    bot.player = { ...bot.player, x: 5.5, y: 5.5 };
    let accepted = false;
    bot.exitAccepted = async () => accepted;
    let chunks = 0;
    bot.driveToward = async () => {
      if (bot.activity === "exitHunt") {
        chunks += 1;
        // The kill lands on the first chunk; the gate opens with it.
        bot.enemies = [{ alive: false, x: 5.5, y: 5.5, aggroed: true }];
        accepted = true;
        return { state: "playing", reason: "stuck" };
      }
      // The exit push itself always lands — the bot is standing on the tile.
      return { state: "playing", reason: "arrived" };
    };
    expect(await bot.driveToExit({ x: 5.5, y: 5.5 }, 80)).toEqual({ state: "playing", reason: "arrived" });
    expect(chunks).toBe(1);
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

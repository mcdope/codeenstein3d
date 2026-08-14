// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Unit tests for the bot's decision core.
 *
 * These are the first direct assertions on this behaviour that have ever
 * existed: before the extraction, the only net under ~1400 lines of movement
 * and combat logic was `npm run balancing:scan`, which is headless-only, not
 * CI-wired, and can only observe the bot's decisions through a whole
 * playthrough. `scripts/**` is excluded from the `src/` coverage denominator but
 * is still executed by `vitest run`, so these do run in CI.
 *
 * The emphasis is deliberately on the four structural problems the wider bot
 * rework is about — standing still while shooting, never sprinting, conceding
 * the first shot, and not dodging — so that each becomes a regression test the
 * moment it is fixed, rather than something only a full campaign would reveal.
 */
import { describe, expect, it, vi } from "vitest";
import { PROFILES } from "./profiles.mjs";
import {
  activeSpikeAt,
  angleDelta,
  decide,
  DEFAULT_TUNING,
  findDangerousMine,
  forwardScanTiles,
  boltThreat,
  combatStrafeKey,
  dodgeStrafeKey,
  hasLineOfSight,
  isHazardAt,
  moveBurstMs,
  pickRangedWeapon,
  pickThreat,
  segmentBlocked,
  pickIncomingBolt,
  segmentsFor,
  turnSplitIntent,
  strafeIsSafe,
  turnBurstMs,
  uniformIntent,
  scoreRangedWeapon,
  expectedDamagePerShot,
  shouldCloseToMelee,
  hasAnyRangedAmmo,
  meleeDamage,
  WEAPON_STATS,
  SHOTGUN_WEAPON_INDEX,
  PISTOL_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  rocketDetonationDistanceAfterClosing,
  rocketAimUnsafe,
  numberKeyCodeFor,
  NUMBER_KEY_WEAPONS,
  KNIFE_WEAPON_INDEX,
  TOOLCHAIN_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  visibleMineNear,
  movementKeysFor,
  movementVectorFor,
  angularHalfWidth,
  pelletHitFraction,
  trackEnemyMotion,
  leadTarget,
  walkDistances,
} from "./combatPolicy.mjs";

const SIZE = 20;

/** An all-floor room with a solid border, plus whatever tiles the caller pokes in. */
function makeMap({ tiles = [], spikeTraps = [] } = {}) {
  const grid = Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1 ? 1 : 0)),
  );
  for (const [x, y, v] of tiles) grid[y][x] = v;
  return { grid, spikeTraps, mines: [], ammoPickups: [] };
}

function makePlayer(over = {}) {
  return {
    x: 10.5,
    y: 10.5,
    dirX: 1,
    dirY: 0,
    health: 100,
    healthFraction: 1,
    swap: 0,
    state: "playing",
    ammo: { bullets: 50, smg: 50, rockets: 5, gas: 50 },
    weaponIndex: 0,
    meleeWouldHit: false,
    wouldMineHit: false,
    ownedWeapons: [0, 1, 2],
    levelTime: 0,
    distanceTraveled: 0,
    ...over,
  };
}

function makeEnemy(over = {}) {
  return { x: 14.5, y: 10.5, alive: true, aggroed: true, elite: false, edgeCase: false, hp: 30, maxHp: 30, ...over };
}

// The real shipped Gamer profile, not a copy of it. The previous local
// clone silently drifted out of sync with `PROFILES` — nothing imported
// the real values, so no test could ever fail on a mismatch.
const PROFILE = PROFILES.Gamer;

function freshMemory() {
  return { retreatKey: null, retreatTicks: 0, shootKey: null, shootTicks: 0, abandoned: new Set(), trace: undefined };
}

function makeConfig(over = {}) {
  return {
    profile: PROFILE,
    tuning: DEFAULT_TUNING,
    stepMs: 50,
    ignoreThreats: false,
    simTimeMs: 100000,
    lastFireSimTimeMs: -Infinity,
    minDecisionMs: 0,
    logger: undefined,
    ...over,
  };
}

/** Convenience: the key set an intent would dispatch. */
const keysOf = (intent) => [...intent.holds.keys()].sort();

describe("geometry", () => {
  it("angleDelta wraps to the shortest signed turn", () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    // 350° -> 10° is a +20° turn, not -340°.
    expect(angleDelta((350 * Math.PI) / 180, (10 * Math.PI) / 180)).toBeCloseTo((20 * Math.PI) / 180);
  });

  it("isHazardAt reads the tile the point falls in, not the nearest corner", () => {
    const map = makeMap({ tiles: [[5, 5, 2]] });
    expect(isHazardAt(map, 5.9, 5.9)).toBe(true);
    expect(isHazardAt(map, 6.0, 5.5)).toBe(false);
  });

  it("activeSpikeAt is true only in the damaging half of the cycle", () => {
    const map = makeMap({ tiles: [[5, 5, 5]], spikeTraps: [{ x: 5, y: 5, period: 4, phase: 0 }] });
    expect(activeSpikeAt(map, 5.5, 5.5, 0)).toBe(false);
    expect(activeSpikeAt(map, 5.5, 5.5, 1.9)).toBe(false);
    expect(activeSpikeAt(map, 5.5, 5.5, 2.1)).toBe(true);
    expect(activeSpikeAt(map, 5.5, 5.5, 3.9)).toBe(true);
  });

  it("hasLineOfSight is blocked by walls but not by acid", () => {
    expect(hasLineOfSight(makeMap({ tiles: [[12, 10, 1]] }), 10.5, 10.5, 15.5, 10.5)).toBe(false);
    expect(hasLineOfSight(makeMap({ tiles: [[12, 10, 2]] }), 10.5, 10.5, 15.5, 10.5)).toBe(true);
  });
});

describe("burst timing", () => {
  const ctx = { tuning: DEFAULT_TUNING, stepMs: 50 };

  it("moveBurstMs caps the hold at the time the move actually needs", () => {
    // 0.1 tiles at 3.2 tiles/sec = 31.25ms, under the 50ms step.
    expect(moveBurstMs(0.1, false, ctx)).toBeCloseTo(31.25);
    // Sprinting halves it — which is exactly why a speed change is also a
    // timing change, the thing `minDecisionMs` exists to guard.
    expect(moveBurstMs(0.1, true, ctx)).toBeCloseTo(15.625);
    // Long moves clamp to the step.
    expect(moveBurstMs(99, false, ctx)).toBe(50);
    // Never zero, or the decision would dispatch nothing at all.
    expect(moveBurstMs(0, false, ctx)).toBe(1);
  });

  it("turnBurstMs records the rotation-anomaly handoff on memory", () => {
    // The side effect has to survive the move out of the Bot class — without
    // it `#checkRotationAnomaly` silently never fires again.
    const memory = freshMemory();
    turnBurstMs(0.5, 2, 1.23, { tuning: DEFAULT_TUNING, stepMs: 50, memory });
    expect(memory.pendingTurnCheck).toMatchObject({ beforeDir: 1.23, rotSpeedMultiplier: 2 });
  });

  it("turnBurstMs tolerates a missing memory", () => {
    expect(() => turnBurstMs(0.5, 2, 0, { tuning: DEFAULT_TUNING, stepMs: 50, memory: null })).not.toThrow();
  });

  it("forwardScanTiles floors at the historical fixed probe but scales past it", () => {
    expect(forwardScanTiles(true, { tuning: DEFAULT_TUNING, stepMs: 50 })).toBeCloseTo(0.6);
    expect(forwardScanTiles(true, { tuning: DEFAULT_TUNING, stepMs: 130 })).toBeCloseTo(0.832);
    // MultiplayerBot's window — where a fixed 0.6 probe would clear a spike
    // the bot then sprints straight onto in the same decision.
    expect(forwardScanTiles(true, { tuning: DEFAULT_TUNING, stepMs: 400 })).toBeCloseTo(2.56);
  });
});

describe("segmentBlocked", () => {
  const ctx = { tuning: DEFAULT_TUNING };

  it("catches a hazard strip the segment passes through, not just its endpoint", () => {
    // Acid at x=12 only; the segment starts at 10.5 and ends at 13.5, so an
    // endpoint-only check would walk straight through it.
    const map = makeMap({ tiles: [[12, 10, 2]] });
    expect(segmentBlocked(map, { x: 10.5, y: 10.5 }, { x: 1, y: 0 }, 3, 0, ctx)).toBe(true);
  });

  it("ignores hazards when the caller is on a committed route", () => {
    const map = makeMap({ tiles: [[12, 10, 2]] });
    expect(segmentBlocked(map, { x: 10.5, y: 10.5 }, { x: 1, y: 0 }, 3, 0, { ...ctx, hazard: false })).toBe(false);
  });

  it("blocks a spike that will be up by the time the bot arrives", () => {
    const map = makeMap({ tiles: [[12, 10, 5]], spikeTraps: [{ x: 12, y: 10, period: 4, phase: 0 }] });
    // Down right now...
    expect(activeSpikeAt(map, 12.5, 10.5, 0)).toBe(false);
    // ...and still blocked, because the arrival-time sample sees it up.
    expect(segmentBlocked(map, { x: 10.5, y: 10.5 }, { x: 1, y: 0 }, 3, 1.9, { ...ctx, hazard: false })).toBe(true);
  });

  it("is false with no map or a zero-length segment", () => {
    expect(segmentBlocked(null, { x: 0, y: 0 }, { x: 1, y: 0 }, 3, 0, ctx)).toBe(false);
    expect(segmentBlocked(makeMap(), { x: 1, y: 1 }, { x: 1, y: 0 }, 0, 0, ctx)).toBe(false);
  });
});

describe("pickThreat", () => {
  it("prefers a quick kill over a merely nearer enemy", () => {
    const player = makePlayer();
    const enemies = [makeEnemy({ x: 12.5, hp: 200 }), makeEnemy({ x: 16.5, edgeCase: true })];
    expect(pickThreat(enemies, player, PROFILE, undefined).i).toBe(1);
  });

  it("ignores enemies that are dead, un-aggroed, or out of engage radius", () => {
    const player = makePlayer();
    expect(pickThreat([makeEnemy({ alive: false })], player, PROFILE, undefined)).toBeUndefined();
    // The bot conceding the first shot: an enemy in plain view but not yet
    // aggroed is not a candidate at all. Stage 6 changes this; until then
    // this test pins the current behaviour so the change is visible.
    expect(pickThreat([makeEnemy({ aggroed: false })], player, PROFILE, undefined)).toBeUndefined();
    // 7,7 away is ~9.9 tiles, just outside the 9.5 engage radius.
    expect(pickThreat([makeEnemy({ x: 17.5, y: 17.5 })], player, PROFILE, undefined)).toBeUndefined();
  });

  it("breaks exact ties by enemy index, so ordering never depends on sort stability", () => {
    const player = makePlayer();
    const enemies = [makeEnemy({ x: 14.5, y: 10.5 }), makeEnemy({ x: 6.5, y: 10.5 })];
    // Both are exactly 4 tiles away and equally (non-)quick.
    expect(pickThreat(enemies, player, PROFILE, undefined).i).toBe(0);
  });

  it("takes MELEE_RANGE from injected tuning rather than the module default", () => {
    // The latent bug the extraction fixes: these helpers used to read
    // DEFAULT_TUNING directly, so a Bot's own `opts.tuning` never reached them.
    const player = makePlayer();
    const enemies = [makeEnemy({ x: 14.5, hp: 200 }), makeEnemy({ x: 12.5, hp: 200 })];
    // With a huge MELEE_RANGE both count as "quick", so it falls through to
    // nearest-first and picks the closer one.
    expect(pickThreat(enemies, player, PROFILE, undefined, { ...DEFAULT_TUNING, MELEE_RANGE: 99 }).i).toBe(1);
  });
});

describe("walkDistances", () => {
  it("measures 4-directional steps, not straight lines", () => {
    const d = walkDistances(makeMap(), { x: 10.5, y: 10.5 }, 20);
    expect(d.get("10,10")).toBe(0);
    expect(d.get("14,10")).toBe(4);
    // The diagonal is 4.24 tiles apart but 6 steps — the overestimate
    // WALK_DISTANCE_GATE_SLACK exists to absorb.
    expect(d.get("13,13")).toBe(6);
  });

  it("walks around walls rather than through them", () => {
    // A stub wall at x=13, y=8..12; (14,10) is 4 tiles away but 10 steps.
    const map = makeMap({ tiles: Array.from({ length: 5 }, (_, k) => [13, k + 8, 1]) });
    expect(walkDistances(map, { x: 10.5, y: 10.5 }, 20).get("14,10")).toBe(10);
  });

  it("omits tiles past maxSteps entirely, so a caller cannot read a truncated distance as a real one", () => {
    const d = walkDistances(makeMap(), { x: 10.5, y: 10.5 }, 3);
    expect(d.get("13,10")).toBe(3);
    expect(d.has("14,10")).toBe(false);
  });

  it("omits sealed-off tiles", () => {
    // Box (14,10) in on all four sides.
    const map = makeMap({
      tiles: [
        [13, 10, 1],
        [15, 10, 1],
        [14, 9, 1],
        [14, 11, 1],
      ],
    });
    expect(walkDistances(map, { x: 10.5, y: 10.5 }, 40).has("14,10")).toBe(false);
  });
});

describe("pickThreat walking distance", () => {
  // A full-height wall at x=13 whose only gap is at y=1. An enemy just past it
  // is 4 tiles away in a straight line and 22 by the only corridor there is.
  const walledOff = () => makeMap({ tiles: Array.from({ length: 17 }, (_, k) => [13, k + 2, 1]) });
  const farByCorridor = () => makeEnemy({ x: 14.5, y: 10.5 });
  const offTuning = { ...DEFAULT_TUNING, BOT_WALKING_DISTANCE_THREATS: false };

  it("drops an occluded enemy that is only near in a straight line", () => {
    expect(pickThreat([farByCorridor()], makePlayer(), PROFILE, walledOff())).toBeUndefined();
  });

  it("keeps that enemy with the flag off, so the arm is a real A/B arm", () => {
    expect(pickThreat([farByCorridor()], makePlayer(), PROFILE, walledOff(), offTuning).i).toBe(0);
  });

  it("keeps that enemy when no map is supplied, since there is nothing to measure against", () => {
    expect(pickThreat([farByCorridor()], makePlayer(), PROFILE, undefined).i).toBe(0);
  });

  it("never re-measures a visible enemy — a shot does not have to walk", () => {
    // Same wall, but the enemy is on the player's own side of it. Its walking
    // distance is irrelevant and it stays the pick.
    const near = makeEnemy({ x: 6.5, y: 10.5 });
    expect(pickThreat([near], makePlayer(), PROFILE, walledOff()).i).toBe(0);
  });

  it("orders two occluded enemies by corridor distance, reversing the straight-line answer", () => {
    // P: 4 tiles away, 10 steps around a wall stub. Q: 6 away, 8 steps around
    // a single pillar. Straight-line ranks P first; walking ranks Q first.
    const map = makeMap({ tiles: [...Array.from({ length: 5 }, (_, k) => [13, k + 8, 1]), [10, 7, 1]] });
    const enemies = [makeEnemy({ x: 14.5, y: 10.5 }), makeEnemy({ x: 10.5, y: 4.5 })];
    expect(pickThreat(enemies, makePlayer(), PROFILE, map, offTuning).i).toBe(0);
    expect(pickThreat(enemies, makePlayer(), PROFILE, map).i).toBe(1);
  });

  it("keeps an occluded enemy on a clear diagonal, which is what the sqrt(2) slack is for", () => {
    // 8.49 tiles away (inside engageRadius) but 12 steps — over engageRadius
    // as a raw step count, and kept only because the budget allows for the
    // 4-directional overestimate. One pillar on the sightline occludes it
    // without lengthening any of the routes around it.
    const map = makeMap({ tiles: [[13, 13, 1]] });
    expect(pickThreat([makeEnemy({ x: 16.5, y: 16.5 })], makePlayer(), PROFILE, map).i).toBe(0);
  });

  it("breaks equal corridor distances by index, so the ordering stays total", () => {
    // Two pillars, mirrored: both enemies are 6 tiles out and 8 steps around.
    const map = makeMap({
      tiles: [
        [10, 7, 1],
        [10, 13, 1],
      ],
    });
    const enemies = [makeEnemy({ x: 10.5, y: 4.5 }), makeEnemy({ x: 10.5, y: 16.5 })];
    expect(pickThreat(enemies, makePlayer(), PROFILE, map).i).toBe(0);
    expect(pickThreat([enemies[1], enemies[0]], makePlayer(), PROFILE, map).i).toBe(0);
  });
});

describe("pickRangedWeapon", () => {
  it("respects injected tuning for the cluster radius", () => {
    const player = makePlayer({ ownedWeapons: [0, 1, 2, 5], ammo: { bullets: 10, smg: 0, rockets: 0, gas: 10 } });
    const threat = { ...makeEnemy({ x: 12.5 }), dist: 2 };
    const enemies = [makeEnemy({ x: 12.5 }), makeEnemy({ x: 12.9 })];
    // A priority order that would *not* reach Friday Hotfix on its own, so the
    // only way to select it is via the cluster rule.
    const shotgunFirst = { ...PROFILE, weaponPriority: [1, 0] };
    // Clustered and close -> Friday Hotfix.
    expect(pickRangedWeapon(player, shotgunFirst, enemies, threat, null, DEFAULT_TUNING)).toBe(5);
    // Same geometry, but a cluster radius too small to group them: the cluster
    // rule doesn't fire, so Friday Hotfix is no longer selected.
    //
    // Deliberately asserts "not the cluster weapon" rather than a specific
    // fallthrough pick: since `pickRangedWeapon` scores on economics rather
    // than walking the priority list, the fallthrough here is the *pistol*
    // (2 bullets and 0.32s to kill a 30 HP threat, against the shotgun's 4
    // bullets and one 0.85s pump cycle — score 1.28 vs 2.77) — and it
    // returns null because the pistol is already equipped.
    const noCluster = pickRangedWeapon(player, shotgunFirst, enemies, threat, null, { ...DEFAULT_TUNING, CLUSTER_RADIUS: 0.01 });
    expect(noCluster).not.toBe(FRIDAY_HOTFIX_WEAPON_INDEX);
  });

  it("never selects a rocket at a mine target", () => {
    const player = makePlayer({ ownedWeapons: [0, 1, 2, 4], weaponIndex: 0 });
    expect(pickRangedWeapon(player, PROFILE, [], null, { dist: 9 }, DEFAULT_TUNING)).not.toBe(4);
  });

  it("returns null when the best choice is already equipped", () => {
    // The fixture must equip whatever the *scorer* actually prefers here, or
    // this silently stops testing the early return and just asserts "nothing
    // to switch to". It equipped the shotgun until the 0.85s pump cap landed;
    // against a no-threat ASSUMED_TARGET_HP of 60 the pistol now wins (0.768
    // vs 1.234), so the fixture follows the scorer.
    const player = makePlayer({ ownedWeapons: [0, 1, 2], weaponIndex: 0 });
    expect(pickRangedWeapon(player, PROFILE, [], null, null, DEFAULT_TUNING)).toBeNull();
  });
});

describe("findDangerousMine", () => {
  it("widens with the caller's reaction buffer", () => {
    const player = makePlayer();
    const mines = [{ x: 13.5, y: 10.5, alive: true, visible: true }]; // 3 tiles away
    expect(findDangerousMine(mines, player, new Set(), 0, DEFAULT_TUNING)).toBeUndefined();
    expect(findDangerousMine(mines, player, new Set(), 1, DEFAULT_TUNING)).toBeDefined();
  });

  it("skips mines the bot has given up on", () => {
    const player = makePlayer();
    const mines = [{ x: 11.5, y: 10.5, alive: true, visible: true }];
    expect(findDangerousMine(mines, player, new Set(["11.5,10.5"]), 0, DEFAULT_TUNING)).toBeUndefined();
  });
});

describe("segmentsFor", () => {
  it("yields exactly one phase when every key shares a duration", () => {
    // The identity property the extraction depends on: today's uniform intents
    // must dispatch exactly as the single pre-refactor call did.
    const holds = new Map([
      ["KeyW", 50],
      ["KeyE", 50],
    ]);
    expect(segmentsFor(holds, 50)).toEqual([{ keys: ["KeyW", "KeyE"], ms: 50 }]);
  });

  it("splits at each distinct hold, dropping keys whose hold has elapsed", () => {
    // What makes "turn briefly, keep walking" expressible at all.
    const holds = new Map([
      ["KeyE", 20],
      ["KeyW", 50],
    ]);
    expect(segmentsFor(holds, 50)).toEqual([
      { keys: ["KeyE", "KeyW"], ms: 20 },
      { keys: ["KeyW"], ms: 30 },
    ]);
  });

  it("returns a single empty phase for an empty holds map", () => {
    expect(segmentsFor(new Map(), 50)).toEqual([{ keys: [], ms: 50 }]);
    expect(segmentsFor(undefined, 50)).toEqual([{ keys: [], ms: 50 }]);
  });

  it("collapses to one phase when any phase would fall under the floor", () => {
    // Multiplayer's guard: a phase shorter than the lockstep input delay never
    // lands, so the decision reverts to the single-phase behaviour that has
    // always worked there rather than risking the spin-in-place failure.
    const holds = new Map([
      ["KeyE", 20],
      ["KeyW", 400],
    ]);
    expect(segmentsFor(holds, 400, 300)).toEqual([{ keys: ["KeyE", "KeyW"], ms: 20 }]);
  });

  it("still splits under a floor when every phase clears it", () => {
    const holds = new Map([
      ["KeyE", 350],
      ["KeyW", 700],
    ]);
    expect(segmentsFor(holds, 700, 300)).toEqual([
      { keys: ["KeyE", "KeyW"], ms: 350 },
      { keys: ["KeyW"], ms: 350 },
    ]);
  });

  it("ignores holds at or beyond the decision duration as cut points", () => {
    const holds = new Map([
      ["KeyW", 50],
      ["KeyA", 80],
    ]);
    expect(segmentsFor(holds, 50)).toEqual([{ keys: ["KeyW", "KeyA"], ms: 50 }]);
  });
});

describe("uniformIntent", () => {
  it("gives every key the resolved duration, and undefined means the whole step", () => {
    const i = uniformIntent(["KeyW", "KeyE"], undefined, 50, {});
    expect(i.durationMs).toBeUndefined();
    expect([...i.holds.values()]).toEqual([50, 50]);
  });

  it("defaults the action fields so a caller can't accidentally fire", () => {
    const i = uniformIntent([], 10, 50, {});
    expect(i).toMatchObject({ fire: false, useMelee: false, weaponSwitchIndex: null, firedSemiAuto: false });
  });
});

describe("decide — branch selection", () => {
  it("keeps marching and sprints when standing in acid, without stopping to fight", () => {
    const map = makeMap({ tiles: [[10, 10, 2]] });
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: { x: 15.5, y: 10.5 }, map },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("hazard");
    expect(keysOf(intent)).toContain("ShiftLeft");
    expect(intent.fire).toBe(false);
  });

  it("pivots in place when the target is inside its own turn radius", () => {
    // A forward-moving body cannot approach anything nearer than its turn
    // radius — the bearing changes at least as fast as it can rotate — so it
    // orbits. Measured on a wolf3d death with the sprint already off: radius
    // 0.62 tiles, target at 0.42, and the distance GROWING to 0.78 as the bot
    // spiralled outward. Inside that circle it must rotate, not drive.
    const map = makeMap({ tiles: [[10, 10, 2]] });
    const intent = decide(
      { player: makePlayer({ dirX: 1, dirY: 0 }), enemies: [], mines: [], navTarget: { x: 10.5, y: 10.9 }, map },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("hazard");
    expect(keysOf(intent)).not.toContain("KeyW");
    expect(keysOf(intent)).not.toContain("ShiftLeft");
    expect(keysOf(intent)).toContain("KeyE");
  });

  it("does not sprint while turning, so the turn radius stays inside the target", () => {
    // Measured on a wolf3d level-2 death trace: dir advanced 0.26 rad per 50ms
    // decision (w = 5.2 rad/s) while sprinting at 6.4 tiles/s, giving a turn
    // radius of 1.23 tiles against a nav target 0.87-1.4 tiles away. A target
    // inside the turn circle is geometrically unreachable, so the bot orbited
    // it at full health until the acid killed it. Walking halves the radius.
    const map = makeMap({ tiles: [[10, 10, 2]] });
    const turning = decide(
      { player: makePlayer({ dirX: 1, dirY: 0 }), enemies: [], mines: [], navTarget: { x: 10.5, y: 12.5 }, map },
      freshMemory(),
      makeConfig(),
    );
    expect(turning.branch).toBe("hazard");
    expect(keysOf(turning)).toContain("KeyW");
    expect(keysOf(turning)).not.toContain("ShiftLeft");
  });

  it("never adds a strafe key in the hazard branch", () => {
    // The 72%-regression rule: a lateral key next to KeyW costs 29% of the
    // forward component (engine.ts's diagonalScale), and here forward *is* the
    // survival axis.
    const map = makeMap({ tiles: [[10, 10, 2]] });
    const intent = decide(
      { player: makePlayer({ dirX: 0, dirY: 1 }), enemies: [], mines: [], navTarget: { x: 15.5, y: 10.5 }, map },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent)).not.toContain("KeyA");
    expect(keysOf(intent)).not.toContain("KeyD");
  });

  it("breaks contact at critical health instead of trading hits", () => {
    const intent = decide(
      { player: makePlayer({ healthFraction: 0.1 }), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("criticalHealth");
    expect(keysOf(intent)).toContain("ShiftLeft");
    expect(intent.fire).toBe(false);
  });

  // `STANDOFF_MIN_TARGET_HP` shares the critical-health branch body, so these
  // cover the gate rather than the movement — the movement is already asserted
  // by the critical-health test above.
  const standoffOn = { ...DEFAULT_TUNING, STANDOFF_MIN_TARGET_HP: 500 };

  it("holds range from a target too big to burst down", () => {
    const intent = decide(
      // 3,000 HP at 1.5 tiles: the wolf3d level-8 Elite, at the distance the
      // bot actually fought it (measured median 0.54t, 82% inside 2t).
      { player: makePlayer(), enemies: [makeEnemy({ hp: 3000, maxHp: 3000, elite: true, x: 12.0 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig({ tuning: standoffOn }),
    );
    expect(intent.branch).toBe("standoff");
    expect(keysOf(intent)).toContain("ShiftLeft");
  });

  it("stops holding range once the target is beyond STANDOFF_DISTANCE", () => {
    // Self-limiting is the whole design: past 5 tiles the gate releases and
    // normal ranged selection resumes, which is what makes ghidra legal again.
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy({ hp: 3000, maxHp: 3000, elite: true, x: 16.5 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig({ tuning: standoffOn }),
    );
    expect(intent.branch).not.toBe("standoff");
  });

  it("does not hold range from something it can actually kill", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy({ hp: 30, x: 12.0 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig({ tuning: standoffOn }),
    );
    expect(intent.branch).not.toBe("standoff");
  });

  it("does not back away from a big target it has no ammo to shoot", () => {
    // Same last-resort carve-out `shouldCloseToMelee` makes: dry is still dry,
    // and retreating from something you cannot shoot just loses the level
    // slowly instead of quickly.
    const intent = decide(
      {
        player: makePlayer({ ammo: { bullets: 0, smg: 0, rockets: 0, gas: 0 } }),
        enemies: [makeEnemy({ hp: 3000, maxHp: 3000, elite: true, x: 12.0 })],
        mines: [], navTarget: null, map: makeMap(),
      },
      freshMemory(),
      makeConfig({ tuning: standoffOn }),
    );
    expect(intent.branch).not.toBe("standoff");
  });

  it("critical health still wins over standoff, and still reports its own branch", () => {
    // Both gates are satisfied here. The label matters: `criticalHealth` and
    // `standoff` are separate rows in every anomaly and engaged-tile readout,
    // and conflating them would silently re-attribute existing measurements.
    const intent = decide(
      { player: makePlayer({ healthFraction: 0.1 }), enemies: [makeEnemy({ hp: 3000, maxHp: 3000, elite: true, x: 12.0 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig({ tuning: standoffOn }),
    );
    expect(intent.branch).toBe("criticalHealth");
  });

  it("REGRESSION GUARD: the standoff is enabled by default", () => {
    // Inverted on 2026-08-06 when the knob was turned on. It shipped inert
    // while it was a diagnostic; the arm-2 A/B measured what it does (see its
    // comment in DEFAULT_TUNING) and it is now the shipped behaviour. If this
    // ever flips back, every telemetry baseline recorded after that date stops
    // being comparable to anything recorded before it.
    expect(DEFAULT_TUNING.STANDOFF_MIN_TARGET_HP).toBe(500);
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy({ hp: 3000, maxHp: 3000, elite: true, x: 12.0 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("standoff");
  });

  it("retreats from a mine it is standing too close to", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [{ x: 11.5, y: 10.5, alive: true, visible: true }], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("mineRetreat");
    // Walks away rather than sprinting — unchanged, and pinned here because
    // it is one of the branches the diagonal-strafe regression came from.
    expect(keysOf(intent)).not.toContain("ShiftLeft");
  });

  it("backs straight away from a mine ahead instead of turning around", () => {
    // The captured stage03 wedge: the retreat used to spin 180 degrees while
    // holding `KeyW`, so it advanced *on* the mine for five decisions (0.45
    // tiles closer) and ran out its give-up budget before ever clearing the
    // blast radius. Reversing is the same speed as advancing (`forwardSign`
    // is signed, engine.ts), so the turn bought nothing.
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [{ x: 11.5, y: 10.5, alive: true, visible: true }], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("mineRetreat");
    expect(keysOf(intent)).toContain("KeyS");
    expect(keysOf(intent)).not.toContain("KeyW");
    // No turn at all — staying aimed is the point, so the disarm shot is
    // available the moment it clears the blast radius.
    expect(keysOf(intent).some((k) => k === "KeyE" || k === "KeyQ")).toBe(false);
  });

  it("walks forward when the mine is already behind it", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [{ x: 8.5, y: 10.5, alive: true, visible: true }], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("mineRetreat");
    expect(keysOf(intent)).toContain("KeyW");
    expect(keysOf(intent)).not.toContain("KeyS");
  });

  it("falls back to turning when the mine is nearly abeam", () => {
    // Straight back-up recovers |cos| of each step, which is ~0 at 90 degrees,
    // so there the bot does have to turn — and must not walk while doing it.
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [{ x: 10.5, y: 12.4, alive: true, visible: true }], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.branch).toBe("mineRetreat");
    expect(keysOf(intent).some((k) => k === "KeyE" || k === "KeyQ")).toBe(true);
    expect(keysOf(intent)).not.toContain("KeyW");
  });

  it("still never strafes while retreating from a mine", () => {
    // `diagonalScale` (1/sqrt(2)) would cut the escape axis by 29% — this is
    // the branch the 72% level-2 death regression came from, so the retreat
    // stays strictly turn-then-run in both the turning and running cases.
    for (const mine of [{ x: 11.5, y: 10.5 }, { x: 8.5, y: 10.5 }]) {
      const intent = decide(
        { player: makePlayer(), enemies: [], mines: [{ ...mine, alive: true, visible: true }], navTarget: null, map: makeMap() },
        freshMemory(),
        makeConfig(),
      );
      expect(keysOf(intent)).not.toContain("KeyA");
      expect(keysOf(intent)).not.toContain("KeyD");
      expect(keysOf(intent)).not.toContain("ShiftLeft");
    }
  });

  it("gives up on a mine after enough consecutive retreat ticks", () => {
    const memory = freshMemory();
    const world = { player: makePlayer(), enemies: [], mines: [{ x: 11.5, y: 10.5, alive: true, visible: true }], navTarget: null, map: makeMap() };
    let intent;
    for (let i = 0; i <= DEFAULT_TUNING.MINE_TARGET_GIVEUP_TICKS + 1; i++) intent = decide(world, memory, makeConfig());
    expect(memory.abandoned.has("11.5,10.5")).toBe(true);
    expect(intent.branch).not.toBe("mineRetreat");
  });

  it("ignoreThreats suppresses combat entirely", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: { x: 15.5, y: 10.5 }, map: makeMap() },
      freshMemory(),
      makeConfig({ ignoreThreats: true }),
    );
    expect(intent.branch).toBe("main");
    expect(intent.fire).toBe(false);
    expect(keysOf(intent)).toContain("KeyW");
  });
});

describe("decide — navigation", () => {
  it("sprints a clear straight leg", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent)).toEqual(["KeyW", "ShiftLeft"]);
  });

  it("walks instead of sprinting when a spike lies within sprint reach", () => {
    const map = makeMap({ tiles: [[12, 10, 5]], spikeTraps: [{ x: 12, y: 10, period: 4, phase: 2 }] });
    const intent = decide({ player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map }, freshMemory(), makeConfig({ stepMs: 400 }));
    expect(keysOf(intent)).toEqual(["KeyW"]);
  });

  it("still sprints across acid the route already committed to", () => {
    // planRoute prices hazard at 25x a floor tile, so a route that crosses it
    // crossed it deliberately — and crossing faster spends less time in it.
    const map = makeMap({ tiles: [[12, 10, 2]] });
    const intent = decide({ player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map }, freshMemory(), makeConfig({ stepMs: 400 }));
    expect(keysOf(intent)).toContain("ShiftLeft");
  });

  it("refuses to sprint when the resulting window would fall under the floor", () => {
    // Multiplayer: sprinting a short leg shrinks the decision below the
    // lockstep input delay. Walking gives twice the window for the same leg.
    const world = { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 11.5, y: 10.5 }, map: makeMap() };
    expect(keysOf(decide(world, freshMemory(), makeConfig({ stepMs: 400, minDecisionMs: 0 })))).toContain("ShiftLeft");
    expect(keysOf(decide(world, freshMemory(), makeConfig({ stepMs: 400, minDecisionMs: 300 })))).not.toContain("ShiftLeft");
  });

  it("waits rather than stepping onto an active spike directly ahead", () => {
    const map = makeMap({ tiles: [[11, 10, 5]], spikeTraps: [{ x: 11, y: 10, period: 4, phase: 2 }] });
    const intent = decide({ player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map }, freshMemory(), makeConfig());
    expect(keysOf(intent)).toEqual([]);
    expect(intent.trace.waitingOnSpike).toBe(true);
  });

  it("walks diagonally while correcting a small heading error", () => {
    // Heading error must land between TURN_MOVE_EPS (0.2) and
    // MAX_WALK_WHILE_TURNING_RAD (0.35): atan2(2, 6) ≈ 0.32 rad.
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 12.5 }, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent)).toContain("KeyW");
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
  });

  it("turns without walking when the heading error is large", () => {
    const intent = decide(
      { player: makePlayer({ dirX: -1, dirY: 0 }), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent)).not.toContain("KeyW");
    expect(keysOf(intent).some((k) => k === "KeyQ" || k === "KeyE")).toBe(true);
  });
});

describe("decide — combat", () => {
  it("swings at a threat already in melee reach rather than shooting into it", () => {
    // Load-bearing: firing at contact range can detonate a nearby mine onto
    // the bot (`destroyMine` in engine.ts). Measured at 3 level-1 deaths per
    // 60 attempts when this was removed.
    const intent = decide(
      { player: makePlayer({ meleeWouldHit: true }), enemies: [makeEnemy({ x: 11.4 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.fire).toBe(true);
    expect(intent.useMelee).toBe(true);
  });

  it("swings only once every ranged weapon is dry", () => {
    const dry = makePlayer({ meleeWouldHit: true, ammo: { bullets: 0, smg: 0, rockets: 0, gas: 0 } });
    const intent = decide(
      { player: dry, enemies: [makeEnemy({ x: 11.4 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.fire).toBe(true);
    expect(intent.useMelee).toBe(true);
  });

  it("keeps moving while firing a ranged shot", () => {
    // This assertion used to be `toEqual([])` — the bot stood perfectly still
    // to shoot, which is why `enemyAccuracy` (nominally "are enemies too
    // dangerous") really measured how easy a stationary target is to hit.
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.fire).toBe(true);
    expect(intent.useMelee).toBe(false);
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
  });

  it("strafes laterally only — never forward, never sprinting", () => {
    // Adding KeyW would engage engine.ts's diagonalScale and cut the forward
    // component 29%, the mechanism behind the recorded 0%->72% regression.
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent)).not.toContain("KeyW");
    expect(keysOf(intent)).not.toContain("ShiftLeft");
  });

  it("does not lengthen the decision — only changes which keys are held", () => {
    // The property that makes this safe where per-key durations were not:
    // the fire branch already ran a full-length step holding nothing.
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.durationMs).toBeUndefined();
  });

  it("holds still inside melee range rather than circling the target", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [makeEnemy({ x: 11.6 })], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(false);
  });

  it("reverses direction on a fixed period, which is what bounds the excursion", () => {
    const world = { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() };
    const at = (ticks) => {
      const m = freshMemory();
      m.combatStrafeTicks = ticks;
      return keysOf(decide(world, m, makeConfig())).find((k) => k === "KeyA" || k === "KeyD");
    };
    expect(at(0)).toBe("KeyD");
    expect(at(DEFAULT_TUNING.COMBAT_STRAFE_FLIP_TICKS - 1)).toBe("KeyD");
    expect(at(DEFAULT_TUNING.COMBAT_STRAFE_FLIP_TICKS)).toBe("KeyA");
    expect(at(DEFAULT_TUNING.COMBAT_STRAFE_FLIP_TICKS * 2)).toBe("KeyD");
  });

  it("advances the strafe counter while engaged and clears it when not", () => {
    const memory = freshMemory();
    const engaged = { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() };
    decide(engaged, memory, makeConfig());
    decide(engaged, memory, makeConfig());
    expect(memory.combatStrafeTicks).toBe(2);
    decide({ ...engaged, enemies: [] }, memory, makeConfig());
    expect(memory.combatStrafeTicks).toBe(0);
  });

  it("takes the other side when the preferred one is blocked", () => {
    // Wall immediately to the player's right (facing +x, so right is +y).
    const map = makeMap({ tiles: [[10, 11, 1]] });
    const intent = decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map }, freshMemory(), makeConfig());
    expect(keysOf(intent)).toContain("KeyA");
    expect(keysOf(intent)).not.toContain("KeyD");
  });

  it("stands still when both sides are blocked, and still shoots", () => {
    const map = makeMap({ tiles: [[10, 11, 1], [10, 9, 1]] });
    const intent = decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map }, freshMemory(), makeConfig());
    expect(keysOf(intent)).toEqual([]);
    expect(intent.fire).toBe(true);
  });

  it("refuses to strafe into acid — an optional move is never worth damage", () => {
    const map = makeMap({ tiles: [[10, 11, 2], [10, 9, 2]] });
    const intent = decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map }, freshMemory(), makeConfig());
    expect(keysOf(intent)).toEqual([]);
  });

  it("holds fire at an occluded threat even when perfectly aligned", () => {
    const map = makeMap({ tiles: [[12, 10, 1]] });
    const intent = decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map }, freshMemory(), makeConfig());
    expect(intent.fire).toBe(false);
  });

  it("respects the semi-auto fire cooldown and reports the pull to the caller", () => {
    const world = { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() };
    const ready = decide(world, freshMemory(), makeConfig({ simTimeMs: 10000, lastFireSimTimeMs: 0 }));
    expect(ready.fire).toBe(true);
    expect(ready.firedSemiAuto).toBe(true);
    const tooSoon = decide(world, freshMemory(), makeConfig({ simTimeMs: 10000, lastFireSimTimeMs: 9950 }));
    expect(tooSoon.fire).toBe(false);
    expect(tooSoon.trace.fireOnCooldown).toBe(true);
  });

  it("waits out the weapon's own engine interval when it outlasts the profile cooldown", () => {
    // The gate is `max(fireCooldownMs, fireIntervalSec)`, not either alone.
    // 500ms clears Gamer's 160ms trigger but is well inside the shotgun's
    // 850ms pump — dispatching Backquote here would queue a `fireQueued`
    // replay frame that the engine discards, ~5 of every 6 shotgun decisions.
    // `weaponPriority: [1]` keeps the scorer on the equipped shotgun so the
    // effective weapon is unambiguous.
    const world = { player: makePlayer({ weaponIndex: 1 }), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() };
    const config = { profile: { ...PROFILE, weaponPriority: [SHOTGUN_WEAPON_INDEX] }, simTimeMs: 10000 };
    const midPump = decide(world, freshMemory(), makeConfig({ ...config, lastFireSimTimeMs: 9500 }));
    expect(midPump.fire).toBe(false);
    // Still "aimed and willing, held back only by cadence" — `detectAnomalies`
    // needs that distinction to not report a pumping bot as stuck.
    expect(midPump.trace.fireOnCooldown).toBe(true);
    // Past the pump, the same fixture fires.
    const pumped = decide(world, freshMemory(), makeConfig({ ...config, lastFireSimTimeMs: 9100 }));
    expect(pumped.fire).toBe(true);
    expect(pumped.trace.fireOnCooldown).toBe(false);
  });

  it("does not report a semi-auto pull for an auto weapon", () => {
    // gdb/Friday Hotfix are engine-rate-limited while held, so the userland
    // cooldown must not apply — otherwise they get starved of frames.
    const player = makePlayer({ ownedWeapons: [0, 1, 2, 3], weaponIndex: 3 });
    const intent = decide(
      { player, enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      freshMemory(),
      makeConfig({ profile: { ...PROFILE, weaponPriority: [3] }, simTimeMs: 0, lastFireSimTimeMs: 0 }),
    );
    expect(intent.fire).toBe(true);
    expect(intent.firedSemiAuto).toBe(false);
  });

  it("freezes aim at the last seen position while a threat is occluded", () => {
    const memory = freshMemory();
    // One wall at x=15: the enemy is visible in front of it, occluded behind.
    const map = makeMap({ tiles: [[15, 10, 1]] });
    decide({ player: makePlayer(), enemies: [makeEnemy({ x: 14.5 })], mines: [], navTarget: null, map }, memory, makeConfig());
    expect(memory.lastVisibleThreat).toMatchObject({ i: 0, x: 14.5, y: 10.5 });
    // Same enemy walks past the wall — aggro is sticky, so it stays the
    // threat, but the aim must stay where it was last actually seen.
    decide({ player: makePlayer(), enemies: [makeEnemy({ x: 16.5 })], mines: [], navTarget: null, map }, memory, makeConfig());
    expect(memory.lastVisibleThreat).toMatchObject({ x: 14.5, y: 10.5 });
  });

  it("nudges sideways once a combat engagement has stalled long enough", () => {
    const memory = freshMemory();
    memory.combatStallTicks = DEFAULT_TUNING.COMBAT_STALL_TICKS_THRESHOLD;
    memory.combatStallPos = "x";
    const intent = decide(
      // Misaligned so it takes the re-aim path, where the stall strafe applies.
      { player: makePlayer({ dirX: 0, dirY: 1 }), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() },
      memory,
      makeConfig(),
    );
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
  });

  it("counts a frozen, non-firing engagement toward the stall counter", () => {
    const memory = freshMemory();
    const map = makeMap({ tiles: [[12, 10, 1]] }); // occluded -> never fires
    const world = { player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map };
    decide(world, memory, makeConfig());
    const first = memory.combatStallTicks;
    decide(world, memory, makeConfig());
    expect(memory.combatStallTicks).toBe(first + 1);
  });

  it("resets the stall counter when there is no threat", () => {
    const memory = freshMemory();
    memory.combatStallTicks = 12;
    memory.combatStallPos = "x";
    decide({ player: makePlayer(), enemies: [], mines: [], navTarget: null, map: makeMap() }, memory, makeConfig());
    expect(memory.combatStallTicks).toBe(0);
    expect(memory.combatStallPos).toBeNull();
  });
});

describe("decide — diagnostics", () => {
  it("emits a trace whose shape the anomaly detectors depend on", () => {
    const intent = decide(
      { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map: makeMap() },
      freshMemory(),
      makeConfig(),
    );
    expect(intent.trace).toMatchObject({ branch: "main", x: 10.5, y: 10.5, hpFrac: 1, waitingOnSpike: false });
    expect(Array.isArray(intent.trace.moveKeys)).toBe(true);
  });

  it("calls the nav logger when one is supplied, and tolerates none", () => {
    const debugNav = vi.fn();
    const world = { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 16.5, y: 10.5 }, map: makeMap() };
    decide(world, freshMemory(), makeConfig({ logger: { debugNav } }));
    expect(debugNav).toHaveBeenCalled();
    expect(() => decide(world, freshMemory(), makeConfig({ logger: undefined }))).not.toThrow();
  });

  it("works with no memory at all", () => {
    // `faceAngle` decides before `startLevel` has necessarily run.
    expect(() =>
      decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: makeMap() }, null, makeConfig()),
    ).not.toThrow();
  });

  it("works with no map, the shape faceAngle uses", () => {
    const intent = decide({ player: makePlayer(), enemies: [makeEnemy()], mines: [], navTarget: null, map: undefined }, freshMemory(), makeConfig());
    expect(intent.branch).toBe("main");
  });
});

/** A bolt heading in +x at PROJECTILE_SPEED, `perp` tiles off the player's line. */
function boltAt(x, y, vx = 5, vy = 0, over = {}) {
  return { x, y, vx, vy, damage: 8, targetId: "local", ...over };
}

const LOOKAHEAD = Math.max(DEFAULT_TUNING.DODGE_MIN_LOOKAHEAD_SEC, DEFAULT_TUNING.DODGE_LOOKAHEAD_DECISIONS * 0.05);

describe("boltThreat", () => {
  const player = makePlayer(); // (10.5, 10.5) facing +x

  it("sees a bolt closing head-on and reports time to impact", () => {
    // 2 tiles away at 5 tiles/sec.
    const t = boltThreat(boltAt(8.5, 10.5), player, LOOKAHEAD, DEFAULT_TUNING);
    expect(t).not.toBeNull();
    expect(t.tti).toBeCloseTo(0.4);
    expect(Math.abs(t.perp)).toBeLessThan(1e-9);
  });

  it("ignores a bolt already past the player", () => {
    // Same heading, but now beyond the player — receding.
    expect(boltThreat(boltAt(12.5, 10.5), player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
  });

  it("ignores a bolt that is already going to miss", () => {
    // Offset well beyond DODGE_MISS_MARGIN from the flight line.
    expect(boltThreat(boltAt(8.5, 13.5), player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
  });

  it("ignores a bolt still further out than the lookahead", () => {
    // 20 tiles at 5 t/s is 4s, far past the ~0.35s window.
    expect(boltThreat(boltAt(-9.5, 10.5), player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
  });

  it("reports which side a near-miss passes on", () => {
    const above = boltThreat(boltAt(8.5, 10.2), player, LOOKAHEAD, DEFAULT_TUNING);
    const below = boltThreat(boltAt(8.5, 10.8), player, LOOKAHEAD, DEFAULT_TUNING);
    expect(Math.sign(above.perp)).toBe(-Math.sign(below.perp));
  });

  it("ignores a zero-velocity bolt rather than dividing by zero", () => {
    expect(boltThreat(boltAt(8.5, 10.5, 0, 0), player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
  });
});

describe("pickIncomingBolt", () => {
  const player = makePlayer();

  it("picks the most urgent of several inbound bolts", () => {
    const bolts = [boltAt(9.0, 10.5), boltAt(9.8, 10.5)];
    expect(pickIncomingBolt(bolts, player, LOOKAHEAD, DEFAULT_TUNING).i).toBe(1);
  });

  it("ignores bolts aimed at somebody else", () => {
    // A bolt locked to a team-mate can never hit this player, so dodging it
    // would be pure cost.
    const bolts = [boltAt(9.0, 10.5, 5, 0, { targetId: "guest" })];
    expect(pickIncomingBolt(bolts, player, LOOKAHEAD, DEFAULT_TUNING, "local")).toBeNull();
    expect(pickIncomingBolt(bolts, player, LOOKAHEAD, DEFAULT_TUNING, "guest")).not.toBeNull();
  });

  it("returns null for an empty or missing list", () => {
    expect(pickIncomingBolt([], player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
    expect(pickIncomingBolt(undefined, player, LOOKAHEAD, DEFAULT_TUNING)).toBeNull();
  });
});

describe("dodgeStrafeKey", () => {
  const player = makePlayer(); // facing +x, so right is +y

  it("steps toward the side the bolt is already passing", () => {
    // Bolt passes slightly on the +y side; widening that gap means moving +y,
    // which is KeyD for a player facing +x.
    const bolt = boltAt(8.5, 10.8);
    const t = boltThreat(bolt, player, LOOKAHEAD, DEFAULT_TUNING);
    const key = dodgeStrafeKey(bolt, t, player);
    const otherBolt = boltAt(8.5, 10.2);
    const otherT = boltThreat(otherBolt, player, LOOKAHEAD, DEFAULT_TUNING);
    expect(dodgeStrafeKey(otherBolt, otherT, player)).not.toBe(key);
  });

  it("breaks toward KeyD for a dead-on bolt", () => {
    // Every bolt on Hard is dead-on: enemyAimSpreadDeg is 0 there, so this is
    // the common case, not an edge case.
    const bolt = boltAt(8.5, 10.5);
    const t = boltThreat(bolt, player, LOOKAHEAD, DEFAULT_TUNING);
    expect(dodgeStrafeKey(bolt, t, player)).toBe("KeyD");
  });
});

describe("decide — bolt dodging", () => {
  const engaged = (over = {}) => ({
    player: makePlayer(),
    enemies: [makeEnemy()],
    mines: [],
    navTarget: null,
    map: makeMap(),
    ...over,
  });

  it("steps off the flight line of an inbound bolt", () => {
    // The bolt flies along y=10.2 and the player sits at y=10.5, i.e. already
    // clear on the +y side — so widening the gap means continuing +y, which is
    // KeyD for a player facing +x. A bolt on the other side must pick KeyA.
    const above = decide(engaged({ projectiles: [boltAt(8.5, 10.2)] }), freshMemory(), makeConfig());
    expect(above.trace.dodgedBolt).toBe(true);
    expect(keysOf(above)).toContain("KeyD");

    const below = decide(engaged({ projectiles: [boltAt(8.5, 10.8)] }), freshMemory(), makeConfig());
    expect(below.trace.dodgedBolt).toBe(true);
    expect(keysOf(below)).toContain("KeyA");
  });

  it("dodges while still re-aiming, not only once it has a firing solution", () => {
    // The gap this closes: dodging used to live only in the fire branch, so a
    // bolt was evadable only when the bot was already aimed — the other ~57%
    // of combat decisions had no evasion at all. An enemy far off the bot's
    // heading puts it in the re-aim branch; a bolt inbound at the same moment
    // must still produce a dodge.
    const offAxis = makeEnemy({ x: 10.5, y: 6.5 }); // ~90 degrees off a +x facing
    const intent = decide(
      engaged({ enemies: [offAxis], projectiles: [boltAt(8.5, 10.2)] }),
      freshMemory(),
      makeConfig(),
    );
    expect(intent.trace.dodgedBolt).toBe(true);
    // Forward must be released: KeyW plus a lateral key engages the engine's
    // diagonalScale and cuts the forward axis 29% — the 0%->72% mechanism.
    expect(keysOf(intent)).not.toContain("KeyW");
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
  });

  it("leaves re-aiming alone when nothing is actually inbound", () => {
    // The distinction from the reverted "strafe while re-aiming" experiment:
    // that added blind oscillation on every decision and fought aim
    // convergence. With no bolt in flight this branch must not strafe at all.
    const offAxis = makeEnemy({ x: 10.5, y: 6.5 });
    const intent = decide(engaged({ enemies: [offAxis], projectiles: [] }), freshMemory(), makeConfig());
    expect(intent.trace.dodgedBolt).toBe(false);
  });

  it("can be switched off as one constant for an A/B", () => {
    const offAxis = makeEnemy({ x: 10.5, y: 6.5 });
    const world = engaged({ enemies: [offAxis], projectiles: [boltAt(8.5, 10.2)] });
    const off = decide(world, freshMemory(), makeConfig({ tuning: { ...DEFAULT_TUNING, DODGE_WHILE_REAIMING: false } }));
    expect(off.trace.dodgedBolt).toBe(false);
  });

  it("sprints the dodge, but never the blind oscillation", () => {
    // The one moment the bot knows it is about to be hit is worth spending
    // sprint on; a standing dance is not, or it would drift.
    const dodging = decide(engaged({ projectiles: [boltAt(8.5, 10.5)] }), freshMemory(), makeConfig());
    expect(dodging.trace.dodgedBolt).toBe(true);
    expect(keysOf(dodging)).toContain("ShiftLeft");

    const idle = decide(engaged({ projectiles: [] }), freshMemory(), makeConfig());
    expect(keysOf(idle)).not.toContain("ShiftLeft");
  });

  it("never holds forward alongside the dodge, so diagonalScale never applies", () => {
    const intent = decide(engaged({ projectiles: [boltAt(8.5, 10.5)] }), freshMemory(), makeConfig());
    expect(keysOf(intent)).not.toContain("KeyW");
  });

  it("falls back to the blind oscillation when nothing is inbound", () => {
    const intent = decide(engaged({ projectiles: [] }), freshMemory(), makeConfig());
    expect(intent.trace.dodgedBolt).toBe(false);
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
  });

  it("does not react to a bolt that will already miss", () => {
    const intent = decide(engaged({ projectiles: [boltAt(8.5, 13.5)] }), freshMemory(), makeConfig());
    expect(intent.trace.dodgedBolt).toBe(false);
  });

  it("takes the other side when the dodge direction is blocked", () => {
    // Dead-on bolt wants KeyD (+y); wall at +y forces KeyA.
    const map = makeMap({ tiles: [[10, 11, 1]] });
    const intent = decide(engaged({ map, projectiles: [boltAt(8.5, 10.5)] }), freshMemory(), makeConfig());
    expect(intent.trace.dodgedBolt).toBe(true);
    expect(keysOf(intent)).toContain("KeyA");
  });

  it("reports no dodge when both sides are blocked, and still fires", () => {
    const map = makeMap({ tiles: [[10, 11, 1], [10, 9, 1]] });
    const intent = decide(engaged({ map, projectiles: [boltAt(8.5, 10.5)] }), freshMemory(), makeConfig());
    expect(intent.trace.dodgedBolt).toBe(false);
    expect(keysOf(intent)).toEqual([]);
    expect(intent.fire).toBe(true);
  });

  it("works when the engine predates the projectile hook", () => {
    // `readFull` defaults to [] against an older build, so the bot degrades to
    // blind strafing rather than throwing.
    const w = engaged();
    delete w.projectiles;
    expect(() => decide(w, freshMemory(), makeConfig())).not.toThrow();
  });
});


describe("ranged weapon economics", () => {
  const owner = (over = {}) => makePlayer({ ownedWeapons: [0, 1, 2, 3, 4, 5, 6], ammo: { bullets: 200, smg: 700, rockets: 19, gas: 600 }, ...over });
  const target = (over = {}) => ({ ...makeEnemy(), dist: 5, i: 0, ...over });

  it("prefers the fastest reachable killer against a damage sponge, not the priority list's first entry", () => {
    // Casual's weaponPriority starts with the pistol, which needs ~44s on
    // 4400 HP. Inside Friday Hotfix's 3.5-tile reach that is the right answer;
    // the point is simply that it is not the pistol.
    const close = pickRangedWeapon(owner(), PROFILE, [], target({ dist: 2.5, hp: 4400, maxHp: 4400, elite: true }), null);
    // Asserted as "beats the head of the priority list", not as one specific
    // index. Which weapon wins here depends on the profile's `ammoThrift`, and
    // this test previously pinned Friday Hotfix only because its local fixture
    // omitted that field and silently scored against the default of 1. Under
    // the real Gamer profile (0.4) Friday Hotfix wins outright, 11.04s against
    // the shotgun's 24.60s — not a tiebreak. (The shotgun used to take this at
    // 8.96s. Its 18 -> 25 damage bump cut the blasts needed from 35 to 26, but
    // the 0.85s pump cap turned 35 x 0.16s = 5.6s of shooting into 26 x 0.85s
    // = 22.1s, so the cadence more than undoes the damage on a sponge this
    // big.) The invariant worth testing is the mechanism, not the winner.
    expect(close).not.toBe(PROFILE.weaponPriority[0]);
    expect(close).not.toBe(PISTOL_WEAPON_INDEX);
    // Beyond that reach the flamethrower is not a candidate at all, so the
    // answer becomes the best weapon that actually arrives — still not the
    // pistol. `weaponIndex: 3` deliberately equips something that cannot be
    // the answer here (gdb needs 367 smg bursts on 4400 HP), so a returned
    // `null` would mean "nothing was picked" rather than the early
    // already-equipped return — and the two `not.toBe`s would pass vacuously
    // against it. The `not.toBeNull` pins that down.
    //
    // Equipping the *pistol* here, not ghidra as this used to. Ghidra is index
    // 3, so the old fixture equipped the very weapon that wins this scenario
    // once the shotgun stops being over-valued — `pickRangedWeapon` then
    // correctly returns null ("keep what you have") and the assertion below
    // read that as a failure. Under the corrected pellet model the shotgun is
    // worth 43.4 at 7 tiles rather than 88.1, and ghidra wins outright.
    const far = pickRangedWeapon(owner({ weaponIndex: PISTOL_WEAPON_INDEX }), PROFILE, [], target({ dist: 7, hp: 4400, maxHp: 4400, elite: true }), null);
    expect(far).not.toBeNull();
    expect(far).not.toBe(FRIDAY_HOTFIX_WEAPON_INDEX);
    expect(far).not.toBe(PISTOL_WEAPON_INDEX);
  });

  it("scores a scarce reserve as more expensive than a plentiful one", () => {
    const opts = { targetHp: 600, dist: 5, profile: PROFILE, tuning: DEFAULT_TUNING };
    const scarce = scoreRangedWeapon(GHIDRA_WEAPON_INDEX, { ...opts, player: owner({ ammo: { bullets: 200, smg: 700, rockets: 2, gas: 600 } }) });
    const plentiful = scoreRangedWeapon(GHIDRA_WEAPON_INDEX, { ...opts, player: owner({ ammo: { bullets: 200, smg: 700, rockets: 400, gas: 600 } }) });
    expect(scarce).toBeGreaterThan(plentiful);
  });

  it("a thriftier profile pays more for the same burn", () => {
    // Inside Friday Hotfix's reach, so the score is finite and comparable.
    const opts = { targetHp: 4400, dist: 2.5, player: owner(), tuning: DEFAULT_TUNING };
    const thrifty = scoreRangedWeapon(FRIDAY_HOTFIX_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, ammoThrift: 2 } });
    const spender = scoreRangedWeapon(FRIDAY_HOTFIX_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, ammoThrift: 0 } });
    expect(thrifty).toBeGreaterThan(spender);
  });

  it("paces a semi-auto by whichever of the engine interval and the trigger is slower", () => {
    // Both limits are real and independent: `fireIntervalSec` is the gun,
    // `fireCooldownMs` is the hand. One 22 HP kill, so the score is exactly
    // one shot's cadence plus a fixed 0.024s of ammo burn.
    const opts = { targetHp: 22, dist: 1, player: owner(), tuning: DEFAULT_TUNING };
    const at = (fireCooldownMs) => scoreRangedWeapon(PISTOL_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, fireCooldownMs } });
    // The pistol's engine interval is 0.15s. Casual's 220ms and Gamer's 160ms
    // trigger are slower, so they bind and still separate the tiers.
    expect(at(220)).toBeCloseTo(0.244, 6);
    expect(at(160)).toBeCloseTo(0.184, 6);
    // Pro's 120ms is now the looser of the two, so the engine binds — and an
    // absurdly fast trigger buys nothing beyond that floor.
    expect(at(120)).toBeCloseTo(0.174, 6);
    expect(at(10)).toBeCloseTo(at(120), 6);
    // The shotgun's 0.85s pump dwarfs every profile's trigger, so no tier
    // out-shoots another with it at all.
    const pump = (fireCooldownMs) => scoreRangedWeapon(SHOTGUN_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, fireCooldownMs } });
    expect(pump(220)).toBeCloseTo(pump(10), 6);
  });

  it("ignores the dispatch cooldown entirely for a held auto weapon", () => {
    // gdb is fired by holding the key, so there is no per-shot dispatch for
    // `fireCooldownMs` to throttle — only the engine's 0.09s interval counts.
    const opts = { targetHp: 22, dist: 1, player: owner(), tuning: DEFAULT_TUNING };
    const at = (fireCooldownMs) => scoreRangedWeapon(GDB_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, fireCooldownMs } });
    expect(at(500)).toBeCloseTo(at(10), 6);
    // 2 bursts at 0.09s, plus 2 of 700 smg burned at Gamer's 0.4 thrift.
    expect(at(500)).toBeCloseTo(0.18 + 0.4 * (2 / 700) * DEFAULT_TUNING.AMMO_BURN_PENALTY_SEC, 6);
  });

  it("multi-pellet damage falls off far sooner than single-pellet", () => {
    // The engine's Cone of Fire applies to every ranged weapon, so nothing is
    // truly flat — but it is cubic in range, so a single-pellet weapon holds
    // full damage through medium range while a wide spread does not.
    const shotNear = expectedDamagePerShot(SHOTGUN_WEAPON_INDEX, 0.5);
    const shotMid = expectedDamagePerShot(SHOTGUN_WEAPON_INDEX, 8);
    expect(shotNear).toBeGreaterThan(shotMid);
    // Pistol: unchanged at medium range, degraded only near the fog line.
    expect(expectedDamagePerShot(PISTOL_WEAPON_INDEX, 8)).toBe(expectedDamagePerShot(PISTOL_WEAPON_INDEX, 0.5));
    expect(expectedDamagePerShot(PISTOL_WEAPON_INDEX, 13)).toBeLessThan(expectedDamagePerShot(PISTOL_WEAPON_INDEX, 8));
  });

  it("gdb keeps its accuracy at range where the pistol loses it", () => {
    // gdb overrides maxConeDeviationPx (20 vs the shared 38) precisely so it
    // stays usable far out despite low per-shot damage.
    const gdbRetention = expectedDamagePerShot(GDB_WEAPON_INDEX, 13) / expectedDamagePerShot(GDB_WEAPON_INDEX, 2);
    const pistolRetention = expectedDamagePerShot(PISTOL_WEAPON_INDEX, 13) / expectedDamagePerShot(PISTOL_WEAPON_INDEX, 2);
    expect(gdbRetention).toBeGreaterThan(pistolRetention);
  });

  it("never returns a weapon the player doesn't own or has no ammo for", () => {
    const dry = owner({ ownedWeapons: [0, 2], ammo: { bullets: 0, smg: 700, rockets: 19, gas: 600 } });
    expect(pickRangedWeapon(dry, PROFILE, [], target(), null)).toBeNull();
  });
});

describe("melee as last resort / for trivial targets", () => {
  const owner = (over = {}) => makePlayer({ ownedWeapons: [0, 1, 2, 3, 4, 5, 6], ammo: { bullets: 200, smg: 700, rockets: 19, gas: 600 }, ...over });
  const at = (dist, over = {}) => ({ ...makeEnemy(), dist, i: 0, ...over });

  it("swings at what is already in reach, but never walks to set one up", () => {
    // In-reach melee is load-bearing: firing at contact range detonates mines
    // onto the bot (`destroyMine`), measured as 3 level-1 deaths per 60 with
    // the knife never drawn. Approaching is worse again — see
    // `shouldCloseToMelee`'s note.
    expect(shouldCloseToMelee(at(1.2, { hp: 12, edgeCase: true }), owner(), PROFILE, DEFAULT_TUNING)).toBe(true);
    for (const d of [1.8, 2.5, 3, 6]) {
      expect(shouldCloseToMelee(at(d, { hp: 12, edgeCase: true }), owner(), PROFILE, DEFAULT_TUNING)).toBe(false);
    }
  });

  it("closes on anything once every ranged weapon is dry", () => {
    const dry = owner({ ammo: { bullets: 0, smg: 0, rockets: 0, gas: 0 } });
    expect(hasAnyRangedAmmo(dry)).toBe(false);
    expect(shouldCloseToMelee(at(6, { hp: 900 }), dry, PROFILE, DEFAULT_TUNING)).toBe(true);
  });

  it("keeps its distance from a sponge it cannot one-shot while it still has ammo", () => {
    expect(shouldCloseToMelee(at(3, { hp: 4400, elite: true }), owner(), PROFILE, DEFAULT_TUNING)).toBe(false);
  });

  it("swings harder once the Toolchain replaces the knife", () => {
    expect(meleeDamage(makePlayer({ ownedWeapons: [0, 1, 2] }))).toBe(40);
    expect(meleeDamage(makePlayer({ ownedWeapons: [0, 1, 2, 6] }))).toBe(80);
  });
});

describe("rocket discipline", () => {
  const owner = (over = {}) => makePlayer({ ownedWeapons: [0, 1, 2, 3, 4, 5, 6], ammo: { bullets: 200, smg: 700, rockets: 19, gas: 600 }, ...over });
  const at = (dist, over = {}) => ({ ...makeEnemy(), dist, i: 0, ...over });

  it("never rockets an Edge Case, however far away", () => {
    const pick = pickRangedWeapon(owner(), PROFILE, [], at(9, { hp: 12, maxHp: 15, edgeCase: true }), null);
    expect(pick).not.toBe(GHIDRA_WEAPON_INDEX);
  });

  it("accounts for how far a chaser closes during the rocket's flight", () => {
    // 5 tiles looks safe against ROCKET_SAFE_DISTANCE=4, but an Edge Case at
    // 3.74 t/s covers most of it while the rocket is in the air.
    const closed = rocketDetonationDistanceAfterClosing(5, { edgeCase: true, aggroed: true }, DEFAULT_TUNING);
    expect(closed).toBeLessThan(DEFAULT_TUNING.ROCKET_SAFE_DISTANCE);
    expect(rocketAimUnsafe(makePlayer(), [], 5, false, DEFAULT_TUNING, { edgeCase: true, aggroed: true })).toBe(true);
  });

  it("charges self-harm risk to the score, and a wary profile more so", () => {
    const opts = { targetHp: 600, dist: 4.5, player: owner(), threat: { edgeCase: false, aggroed: true }, tuning: DEFAULT_TUNING };
    const wary = scoreRangedWeapon(GHIDRA_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, selfHarmAversion: 3 } });
    const bold = scoreRangedWeapon(GHIDRA_WEAPON_INDEX, { ...opts, profile: { ...PROFILE, selfHarmAversion: 0 } });
    expect(wary).toBeGreaterThan(bold);
  });
});

describe("number-key weapon mapping", () => {
  it("maps each ranged weapon to the slot the engine actually reads", () => {
    // The engine treats a digit as an index into NUMBER_KEY_WEAPONS (melee
    // excluded), not into WEAPONS. `Digit${index + 1}` was wrong for
    // everything past the knife.
    expect(numberKeyCodeFor(PISTOL_WEAPON_INDEX)).toBe("Digit1");
    expect(numberKeyCodeFor(SHOTGUN_WEAPON_INDEX)).toBe("Digit2");
    expect(numberKeyCodeFor(GDB_WEAPON_INDEX)).toBe("Digit3");
    expect(numberKeyCodeFor(GHIDRA_WEAPON_INDEX)).toBe("Digit4");
    expect(numberKeyCodeFor(FRIDAY_HOTFIX_WEAPON_INDEX)).toBe("Digit5");
  });

  it("has no slot for a melee weapon", () => {
    expect(numberKeyCodeFor(KNIFE_WEAPON_INDEX)).toBeNull();
    expect(numberKeyCodeFor(TOOLCHAIN_WEAPON_INDEX)).toBeNull();
  });

  it("regression: asking for gdb must not equip the rocket launcher", () => {
    // The old `Digit${index+1}` gave Digit4, which is ghidra — the bot fired
    // rockets at point-blank range and took up to 99 self-damage.
    expect(numberKeyCodeFor(GDB_WEAPON_INDEX)).not.toBe(numberKeyCodeFor(GHIDRA_WEAPON_INDEX));
    expect(NUMBER_KEY_WEAPONS.indexOf(GDB_WEAPON_INDEX) + 1).not.toBe(GDB_WEAPON_INDEX + 1);
  });
});

describe("hard weapon range limits", () => {
  const owner = () => makePlayer({ ownedWeapons: [0, 1, 2, 3, 4, 5, 6], ammo: { bullets: 200, smg: 700, rockets: 19, gas: 600 } });
  it("never picks Friday Hotfix beyond its maxRange, however good its DPS looks", () => {
    const far = { ...makeEnemy(), dist: 7, hp: 4400, maxHp: 4400, i: 0 };
    expect(pickRangedWeapon(owner(), PROFILE, [], far, null)).not.toBe(FRIDAY_HOTFIX_WEAPON_INDEX);
    expect(scoreRangedWeapon(FRIDAY_HOTFIX_WEAPON_INDEX, { targetHp: 4400, dist: 7, player: owner(), profile: PROFILE, tuning: DEFAULT_TUNING })).toBe(Infinity);
  });
  it("models the range falloff, so it is not scored at full strength across its whole reach", () => {
    // The mirrored half of `rangeDamageScale`. Leaving it out would be worse
    // than the hard cutoff it replaced: the cutoff at least scored zero where
    // the weapon could not reach, whereas an unmirrored curve scores a full 48
    // a pull at 6 tiles where the engine really lands about 12.
    const at = (dist) => expectedDamagePerShot(FRIDAY_HOTFIX_WEAPON_INDEX, dist, DEFAULT_TUNING, makeEnemy());
    // No plateau any more, and its absence is the fix rather than a
    // regression: the old flat stretch was `hitFraction` clamping at 1 while
    // the engine was already dropping pellets. Measured on the shotgun, the
    // engine delivers 7 of 7 pellets at 1 tile and 5.63 at 2 — it decays
    // continuously from about 1.5 tiles out, so the model must too.
    expect(at(2.0)).toBeGreaterThan(at(2.5));
    expect(at(4.5)).toBeLessThan(at(2.5));           // then decay, monotonically
    expect(at(6.0)).toBeLessThan(at(4.5));
    expect(at(6.5)).toBe(0);                         // nothing at the far end
    // 0.5 would be the *pure* `rangeDamageScale` ramp — which is what this
    // used to measure, because the cone term was clamped at 1 across the whole
    // stretch and contributed nothing. The cone now decays as well, so the two
    // compound and the drop is steeper. Pinned as the property rather than the
    // new constant: the combined falloff must beat range falloff alone.
    expect(at(4.5) / at(2.5)).toBeLessThan(0.5);
  });

  it("is a candidate again inside that range, rather than scoring Infinity", () => {
    // The pair with the test above: out of reach it is not a candidate at all
    // (Infinity), inside reach it is scored on its merits. Whether it then
    // *wins* depends on the profile's ammo economics — see the note in
    // "prefers the fastest reachable killer" above — so this asserts
    // candidacy, which is what `maxRange` actually governs.
    const score = scoreRangedWeapon(FRIDAY_HOTFIX_WEAPON_INDEX, { targetHp: 4400, dist: 2.5, player: owner(), profile: PROFILE, tuning: DEFAULT_TUNING });
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe("melee approach is mine-aware", () => {
  it("treats a spotted mine ahead like a hazard tile", () => {
    const mines = [{ x: 11.1, y: 10.5, alive: true, visible: true }];
    expect(visibleMineNear(mines, 11.1, 10.5, DEFAULT_TUNING)).toBe(true);
    expect(visibleMineNear(mines, 20, 20, DEFAULT_TUNING)).toBe(false);
  });
  it("ignores an unspotted or dead mine — the player cannot see those either", () => {
    expect(visibleMineNear([{ x: 11, y: 10.5, alive: true, visible: false }], 11, 10.5, DEFAULT_TUNING)).toBe(false);
    expect(visibleMineNear([{ x: 11, y: 10.5, alive: false, visible: true }], 11, 10.5, DEFAULT_TUNING)).toBe(false);
  });
  it("guards the final closing step inside MELEE_RANGE", () => {
    // The bot still edges the last ~1.1 tiles onto a threat already in reach;
    // that step is what the mine check protects.
    expect(DEFAULT_TUNING.MELEE_RANGE).toBeGreaterThan(DEFAULT_TUNING.MELEE_CLOSE_MIN_DISTANCE);
  });
});

describe("critical-health retreat backpedals instead of turning (Stage 7)", () => {
  const fleeing = (threatAt) => ({
    player: makePlayer({ healthFraction: 0.1 }),
    enemies: [makeEnemy(threatAt)],
    mines: [],
    navTarget: null,
    map: makeMap(),
  });

  it("backs away from a threat dead ahead without turning at all", () => {
    // Facing +x with the threat at +x: the escape vector is a full 180
    // degrees away, which is exactly where the old code spun — running
    // *toward* the threat while it did, since KeyW was held throughout.
    const intent = decide(fleeing({ x: 13, y: 10 }), freshMemory(), makeConfig());
    expect(intent.branch).toBe("criticalHealth");
    expect(keysOf(intent)).toContain("KeyS");
    expect(keysOf(intent)).toContain("ShiftLeft");
    // No turn: staying aimed at what you are escaping is half the point.
    expect(keysOf(intent).some((k) => k === "KeyE" || k === "KeyQ")).toBe(false);
  });

  it("still sprints, whichever way the escape runs", () => {
    for (const at of [{ x: 13, y: 10 }, { x: 7, y: 10 }, { x: 10, y: 13 }]) {
      expect(keysOf(decide(fleeing(at), freshMemory(), makeConfig()))).toContain("ShiftLeft");
    }
  });

  it("strafes directly away from a threat abeam rather than reversing", () => {
    // Threat off to one side: pure lateral is the escape line here, and pure
    // lateral has no `diagonalScale` penalty at all.
    const intent = decide(fleeing({ x: 10, y: 13 }), freshMemory(), makeConfig());
    expect(keysOf(intent).some((k) => k === "KeyA" || k === "KeyD")).toBe(true);
    expect(keysOf(intent).some((k) => k === "KeyE" || k === "KeyQ")).toBe(false);
  });

  it("restores the old turn-then-run behaviour when the switch is off", () => {
    const intent = decide(
      fleeing({ x: 13, y: 10 }),
      freshMemory(),
      makeConfig({ tuning: { ...DEFAULT_TUNING, NAV_BACKPEDAL_RETREAT: false } }),
    );
    expect(keysOf(intent)).toContain("KeyW");
    expect(keysOf(intent).some((k) => k === "KeyE" || k === "KeyQ")).toBe(true);
  });

  it("does not start shooting while retreating — that is a separate change", () => {
    expect(decide(fleeing({ x: 13, y: 10 }), freshMemory(), makeConfig()).fire).toBe(false);
  });
});

describe("NAV_FULL_WASD switch", () => {
  it("stands still to turn when disabled, and keeps moving when enabled", () => {
    // Player faces +x with the target behind-left, so |delta| is well past
    // MAX_WALK_WHILE_TURNING_RAD and the old code froze here.
    const world = { player: makePlayer(), enemies: [], mines: [], navTarget: { x: 8, y: 6 }, map: makeMap() };
    const frozen = decide(world, freshMemory(), makeConfig({ tuning: { ...DEFAULT_TUNING, NAV_FULL_WASD: false } }));
    expect(keysOf(frozen).every((k) => k === "KeyQ" || k === "KeyE")).toBe(true);

    const moving = decide(world, freshMemory(), makeConfig());
    expect(keysOf(moving).some((k) => ["KeyW", "KeyA", "KeyS", "KeyD"].includes(k))).toBe(true);
  });
});

describe("movementKeysFor — full WASD instead of stopping to turn", () => {
  const P = Math.PI;

  it("maps each octant to the keys that point there", () => {
    expect(movementKeysFor(0)).toEqual(["KeyW"]);
    expect(movementKeysFor(P / 4)).toEqual(["KeyW", "KeyD"]);
    expect(movementKeysFor(P / 2)).toEqual(["KeyD"]);
    expect(movementKeysFor((3 * P) / 4)).toEqual(["KeyS", "KeyD"]);
    expect(movementKeysFor(P)).toEqual(["KeyS"]);
    expect(movementKeysFor(-P / 2)).toEqual(["KeyA"]);
    expect(movementKeysFor(-P / 4)).toEqual(["KeyW", "KeyA"]);
    expect(movementKeysFor((-3 * P) / 4)).toEqual(["KeyS", "KeyA"]);
  });

  it("wraps at ±π rather than falling off the end", () => {
    expect(movementKeysFor(-P)).toEqual(["KeyS"]);
    expect(movementKeysFor(2 * P)).toEqual(["KeyW"]);
  });

  it("never errs by more than half an octant", () => {
    // The guarantee that makes this worth doing: at worst 22.5 degrees off,
    // so cos(22.5) = 92% of the step still lands on the wanted direction —
    // versus 0% while standing still to turn.
    const dirOf = { KeyW: 0, KeyD: P / 2, KeyS: P, KeyA: -P / 2 };
    for (let d = -P; d <= P; d += 0.05) {
      const keys = movementKeysFor(d);
      // Reconstruct the octant's own angle from its keys.
      let x = 0;
      let y = 0;
      for (const k of keys) {
        x += Math.cos(dirOf[k]);
        y += Math.sin(dirOf[k]);
      }
      const got = Math.atan2(y, x);
      let err = Math.abs(angleDelta(got, d));
      expect(err).toBeLessThanOrEqual(P / 8 + 1e-9);
    }
  });
});

describe("movementVectorFor", () => {
  const facingEast = { dirX: 1, dirY: 0 };

  it("returns the world direction each key set actually moves", () => {
    // `toBeCloseTo` rather than `toEqual`: these are computed, so a component
    // can legitimately come out as -0, which deep equality distinguishes.
    const expectVec = (keys, x, y) => {
      const v = movementVectorFor(keys, facingEast);
      expect(v.x).toBeCloseTo(x);
      expect(v.y).toBeCloseTo(y);
    };
    expectVec(["KeyW"], 1, 0);
    expectVec(["KeyS"], -1, 0);
    // strafe right is the facing vector rotated +90 degrees (player.ts)
    expectVec(["KeyD"], 0, 1);
    expectVec(["KeyA"], 0, -1);
  });

  it("normalizes a diagonal", () => {
    const v = movementVectorFor(["KeyW", "KeyD"], facingEast);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(Math.SQRT1_2);
    expect(v.y).toBeCloseTo(Math.SQRT1_2);
  });

  it("returns null when the keys cancel out or there are none", () => {
    expect(movementVectorFor([], facingEast)).toBeNull();
    expect(movementVectorFor(["KeyW", "KeyS"], facingEast)).toBeNull();
  });

  it("rotates with the player's facing", () => {
    const facingNorth = { dirX: 0, dirY: 1 };
    const v = movementVectorFor(["KeyD"], facingNorth);
    expect(v.x).toBeCloseTo(-1);
    expect(v.y).toBeCloseTo(0);
  });
});

describe("turnSplitIntent", () => {
  const TURN = "KeyE";

  it("gives the turn key its own short hold while movement runs the whole decision", () => {
    // The decoupling itself. A widened decision (the stall-strafe needs 50ms
    // of displacement) must not hold the turn key for 50ms too.
    const intent = turnSplitIntent(new Set([TURN, "KeyA", "ShiftLeft"]), 50, 3, 50, {});
    expect(intent.holds.get(TURN)).toBe(3);
    expect(intent.holds.get("KeyA")).toBe(50);
    expect(intent.holds.get("ShiftLeft")).toBe(50);
    expect(intent.durationMs).toBe(50);
  });

  it("dispatches as two phases: turn+move, then move alone", () => {
    // `segmentsFor` is what realises it, and it has only ever seen one phase.
    const intent = turnSplitIntent(new Set([TURN, "KeyA"]), 50, 3, 50, {});
    const phases = segmentsFor(intent.holds, intent.durationMs, 0);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toEqual({ keys: [TURN, "KeyA"], ms: 3 });
    expect(phases[1]).toEqual({ keys: ["KeyA"], ms: 47 });
    expect(phases.reduce((sum, p) => sum + p.ms, 0)).toBe(50);
  });

  it("is identical to uniformIntent when the turn wants the whole decision", () => {
    // The common case must not change: an unwidened decision is one phase, so
    // this cannot alter behaviour where there was nothing to decouple.
    const intent = turnSplitIntent(new Set([TURN, "KeyW"]), 12, 12, 50, {});
    expect(segmentsFor(intent.holds, intent.durationMs, 0)).toEqual([{ keys: [TURN, "KeyW"], ms: 12 }]);
  });

  it("never extends a turn past the decision, nor shortens movement below it", () => {
    // `Math.min` guards the widened case; a turn hold longer than the decision
    // would otherwise produce a phase with negative remainder.
    const intent = turnSplitIntent(new Set([TURN, "KeyW"]), 20, 999, 50, {});
    expect(intent.holds.get(TURN)).toBe(20);
    expect(intent.holds.get("KeyW")).toBe(20);
  });

  it("falls back to a uniform hold when no separate turn hold was recorded", () => {
    const intent = turnSplitIntent(new Set([TURN, "KeyW"]), 50, null, 50, {});
    expect(intent.holds.get(TURN)).toBe(50);
    expect(intent.holds.get("KeyW")).toBe(50);
  });

  it("reproduces the old one-scalar behaviour when the switch is off", () => {
    // The A/B arm. Without this the change could only be compared against a
    // different commit, which would confound it with everything else that
    // landed since.
    const off = { ...DEFAULT_TUNING, TURN_SPLIT_PHASES: false };
    const intent = turnSplitIntent(new Set(["KeyE", "KeyA"]), 50, 3, 50, {}, off);
    expect(intent.holds.get("KeyE")).toBe(50);
    expect(segmentsFor(intent.holds, intent.durationMs, 0)).toHaveLength(1);
  });

  it("keeps the overshoot inside fireAngleEps for every profile", () => {
    // The property the whole change exists for, stated in the units that
    // matter. Before: a widened decision turned ENGINE_ROT_SPEED * rotMult *
    // 50ms regardless of how small the correction was.
    const ROT = DEFAULT_TUNING.ENGINE_ROT_SPEED;
    for (const [name, rotMult, eps] of [["Casual", 2.0, 0.08], ["Gamer", 3.5, 0.05], ["Pro", 5.0, 0.03]]) {
      const wantedRad = eps / 2; // a correction finer than the fire tolerance
      const burst = turnBurstMs(wantedRad, rotMult, 0, { tuning: DEFAULT_TUNING, stepMs: 50, memory: null });
      const intent = turnSplitIntent(new Set(["KeyE", "KeyA"]), 50, burst, 50, {});
      const heldMs = intent.holds.get("KeyE");
      const actualRad = ROT * rotMult * (heldMs / 1000);
      expect(actualRad, `${name} overshoots its own fireAngleEps`).toBeLessThanOrEqual(eps);
      // And the strafe still gets the full decision — the half the 2026-07-29
      // A/B lost when it removed the widening instead.
      expect(intent.holds.get("KeyA")).toBe(50);
    }
  });
});

// `BOT_AIM_LEAD` ships **off** — the 2026-08-11 A/B measured it as a regression
// (see its doc comment in `combatPolicy.mjs`). The machinery is kept for a
// future attempt against the engine's real velocity rather than a differenced
// estimate, so these pin what it does when switched on.
const LEAD_ON = { ...DEFAULT_TUNING, BOT_AIM_LEAD: true };
/** The lead is ON by default since 2026-08-14, so the *off* arm now has to say
 * so explicitly. These tests contrast the two arms, and a contrast that leans
 * on whichever way the default happens to point silently stops contrasting
 * anything the moment it flips — which is exactly what happened here. */
const LEAD_OFF = { ...DEFAULT_TUNING, BOT_AIM_LEAD: false };

describe("aim geometry", () => {
  it("angularHalfWidth falls off as 1/dist and crosses fireAngleEps where the report says it does", () => {
    // The crossing is the whole reason the fixed gate is wrong: inside it the
    // profile constant binds, outside it the geometry does. `report-aim-error`
    // put Gamer's crossing against a normal enemy at ~5.8 tiles.
    const eps = PROFILES.Gamer.fireAngleEps;
    expect(angularHalfWidth(5.7, makeEnemy())).toBeGreaterThan(eps);
    expect(angularHalfWidth(5.9, makeEnemy())).toBeLessThan(eps);
    // 1/dist, so doubling the range halves the angle (to within atan's own
    // curvature, which is negligible at these magnitudes).
    expect(angularHalfWidth(8, makeEnemy())).toBeCloseTo(angularHalfWidth(4, makeEnemy()) / 2, 3);
  });

  it("angularHalfWidth scales with the archetype's sprite", () => {
    const at = (over) => angularHalfWidth(6, makeEnemy(over));
    expect(at({ elite: true })).toBeGreaterThan(at({}));
    expect(at({ edgeCase: true })).toBeLessThan(at({}));
    // The Edge Case is the narrowest thing the bot shoots at, and even at the
    // edge of `engageRadius` it stays clear of the gate's own floor — the
    // reason `MIN_FIRE_ANGLE_EPS` is insurance rather than a live term.
    expect(angularHalfWidth(PROFILES.Gamer.engageRadius, makeEnemy({ edgeCase: true }))).toBeGreaterThan(DEFAULT_TUNING.MIN_FIRE_ANGLE_EPS);
  });

  it("trackEnemyMotion needs two samples before it reports a velocity", () => {
    const memory = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10 })], memory, 0);
    expect(memory.enemyMotion.vel[0]).toBeNull();
    trackEnemyMotion([makeEnemy({ x: 10.05 })], memory, 50);
    // 0.05 tiles in 50ms = 1 tile/sec.
    expect(memory.enemyMotion.vel[0].vx).toBeCloseTo(1, 6);
    expect(memory.enemyMotion.vel[0].vy).toBeCloseTo(0, 6);
  });

  it("trackEnemyMotion refuses a velocity it cannot vouch for", () => {
    // A teleport, a slot reused by a respawn, or simply a long gap between
    // decisions would each otherwise yield a huge bogus velocity — and an aim
    // thrown metres off the target is strictly worse than no lead at all.
    const teleported = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10 })], teleported, 0);
    trackEnemyMotion([makeEnemy({ x: 18 })], teleported, 50);
    expect(teleported.enemyMotion.vel[0]).toBeNull();

    const stale = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10 })], stale, 0);
    trackEnemyMotion([makeEnemy({ x: 10.05 })], stale, DEFAULT_TUNING.AIM_TRACK_MAX_GAP_MS + 50);
    expect(stale.enemyMotion.vel[0]).toBeNull();

    const dead = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10 })], dead, 0);
    trackEnemyMotion([makeEnemy({ x: 10.05, alive: false })], dead, 50);
    expect(dead.enemyMotion.vel[0]).toBeNull();
  });

  it("trackEnemyMotion allows an Edge Case its own higher top speed", () => {
    // 3.74 tiles/sec against a normal's 1.7 — a displacement that is honest
    // for one archetype and impossible for the other.
    const perWindow = (DEFAULT_TUNING.EDGE_CASE_CHASE_SPEED * 50) / 1000;
    const fast = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10, edgeCase: true })], fast, 0);
    trackEnemyMotion([makeEnemy({ x: 10 + perWindow, edgeCase: true })], fast, 50);
    expect(fast.enemyMotion.vel[0].vx).toBeCloseTo(DEFAULT_TUNING.EDGE_CASE_CHASE_SPEED, 6);

    const slow = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10 })], slow, 0);
    trackEnemyMotion([makeEnemy({ x: 10 + perWindow })], slow, 50);
    expect(slow.enemyMotion.vel[0]).toBeNull();
  });

  it("leadTarget extrapolates by exactly one frame, and returns the target untouched without one", () => {
    const memory = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10, y: 10 })], memory, 0);
    trackEnemyMotion([makeEnemy({ x: 10, y: 10.1 })], memory, 50); // 2 tiles/sec on +y
    const target = { i: 0, x: 10, y: 10.1 };
    expect(leadTarget(target, memory, 50, LEAD_ON).y).toBeCloseTo(10.2, 6);
    // Half the frame, half the lead — the arithmetic is linear in `leadMs`,
    // which is what lets `Bot#aimLeadMs` describe two very different harnesses.
    expect(leadTarget(target, memory, 25, LEAD_ON).y).toBeCloseTo(10.15, 6);
    // No index (a mine), no memory, and the shipped default all pass the
    // target through untouched.
    expect(leadTarget({ x: 3, y: 4 }, memory, 50, LEAD_ON)).toEqual({ x: 3, y: 4 });
    expect(leadTarget(target, null, 50, LEAD_ON)).toBe(target);
    // Explicitly the off arm: the shipped default now leads (2026-08-14), so
    // omitting tuning here would assert the opposite of what it reads as.
    expect(leadTarget(target, memory, 50, LEAD_OFF)).toBe(target);
  });

  it("leadTarget refuses to lead a close target, and MIN_DIST 0 reproduces the original arm", () => {
    // The 2026-08-11 arm lost because leading demands 4.6x more re-aim than
    // accuracy inside 2 tiles (see `leadTarget`). The gate is the fix, so pin
    // both sides of the cliff and the escape hatch that restores the old
    // behaviour for a single-variable comparison.
    const memory = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10, y: 10 })], memory, 0);
    trackEnemyMotion([makeEnemy({ x: 10, y: 10.1 })], memory, 50);

    const near = { i: 0, x: 10, y: 10.1, dist: 1.5 };
    const far = { i: 0, x: 10, y: 10.1, dist: 5 };
    expect(leadTarget(near, memory, 50, LEAD_ON), "inside 2 tiles the target passes through untouched").toBe(near);
    expect(leadTarget(far, memory, 50, LEAD_ON).y, "beyond the gate it still leads by a full frame").toBeCloseTo(10.2, 6);
    expect(
      leadTarget(near, memory, 50, { ...LEAD_ON, BOT_AIM_LEAD_MIN_DIST: 0 }).y,
      "MIN_DIST 0 must reproduce the un-gated 2026-08-11 arm exactly",
    ).toBeCloseTo(10.2, 6);

    // A target with no `dist` falls through and is led — deliberate, because
    // the only real caller (`pickThreat`'s threat) always carries one, and
    // failing closed here would silently disable the lead everywhere if that
    // ever changed. Pinned so the fall-through is a decision, not a surprise.
    expect(leadTarget({ i: 0, x: 10, y: 10.1 }, memory, 50, LEAD_ON).y).toBeCloseTo(10.2, 6);
  });

  it("leadTarget does not mutate the target it leads", () => {
    // `decide` hands the result straight into the aim math while `threat` stays
    // live for distance and weapon choice — a shared object here would move the
    // target under everything else that reads it.
    const memory = freshMemory();
    trackEnemyMotion([makeEnemy({ x: 10, y: 10 })], memory, 0);
    trackEnemyMotion([makeEnemy({ x: 10.1, y: 10 })], memory, 50);
    const target = { i: 0, x: 10.1, y: 10 };
    const led = leadTarget(target, memory, 50, LEAD_ON);
    expect(target.x).toBe(10.1);
    expect(led).not.toBe(target);
  });
});

describe("the fire gate", () => {
  /** Drive two decisions so the motion tracker has the pair it needs, and
   * return the second one's intent. */
  function decideTwice({ enemy, player = makePlayer(), tuning = DEFAULT_TUNING, config = {} }) {
    const memory = freshMemory();
    const world = (e) => ({ player, enemies: [e], mines: [], navTarget: null, map: makeMap(), projectiles: [] });
    decide(world(enemy.at(0)), memory, makeConfig({ tuning, simTimeMs: 0, ...config }));
    return decide(world(enemy.at(1)), memory, makeConfig({ tuning, simTimeMs: 50, ...config }));
  }
  /** An enemy standing still at `dist` tiles, `offsetRad` off the player's heading. */
  const still = (dist, offsetRad = 0, over = {}) => {
    const e = makeEnemy({ x: 10.5 + dist * Math.cos(offsetRad), y: 10.5 + dist * Math.sin(offsetRad), ...over });
    return { at: () => e };
  };

  it("refuses a shot the geometry cannot land, and keeps turning until it can", () => {
    // 0.045rad off at 8 tiles: inside Gamer's 0.05 constant, outside the
    // 0.036rad the target actually subtends there.
    const far = decideTwice({ enemy: still(8, 0.045) });
    expect(far.fire).toBe(false);
    // Still correcting — the gate and the realign threshold have to move
    // together, or the bot settles into an angle it will never fire from.
    expect([...far.holds.keys()]).toContain("KeyE");
  });

  it("fires at the same heading error up close, where the profile constant is the binding term", () => {
    // Same 0.045rad, 2 tiles out: the target subtends 0.14rad, so
    // `fireAngleEps` is what binds and the skill ladder is untouched.
    expect(decideTwice({ enemy: still(2, 0.045) }).fire).toBe(true);
  });

  it("reproduces the old fixed-tolerance behaviour when the switch is off", () => {
    // The A/B arm. Without it this change could only be compared against a
    // different commit, which would confound it with the aim lead landing
    // alongside it.
    const off = { ...DEFAULT_TUNING, BOT_ANGULAR_FIRE_GATE: false };
    expect(decideTwice({ enemy: still(8, 0.045), tuning: off }).fire).toBe(true);
  });

  it("aims at where a crossing target will be, not where it is", () => {
    // An Edge Case crossing at its own chase speed 4 tiles out, with the bot
    // already pointed at the position one frame ahead of it. That heading is
    // 0.047rad off the target's *current* bearing, wider than the 0.040rad it
    // subtends — so the two arms disagree about the same world: leading, the
    // bot is on target and shoots; not leading, it reads itself as misaligned
    // and turns back onto a position the shot will no longer find.
    const step = (DEFAULT_TUNING.EDGE_CASE_CHASE_SPEED * 50) / 1000;
    const crossing = { at: (n) => makeEnemy({ x: 14.5, y: 10.5 + n * step, edgeCase: true, hp: 15, maxHp: 15 }) };
    // The second decision sees the enemy one step along, so the position it
    // will occupy when that decision's shot resolves is two steps out.
    const ahead = Math.atan2(2 * step, 4);
    const aimedAhead = { dirX: Math.cos(ahead), dirY: Math.sin(ahead) };

    const led = decideTwice({ enemy: crossing, player: makePlayer(aimedAhead), tuning: LEAD_ON });
    expect(led.fire).toBe(true);

    const stale = decideTwice({ enemy: crossing, player: makePlayer(aimedAhead), tuning: LEAD_OFF });
    expect(stale.fire).toBe(false);
    expect([...stale.holds.keys()]).toContain("KeyQ");
  });
});

describe("pelletHitFraction — the multi-pellet cone", () => {
  const shotgun = WEAPON_STATS[SHOTGUN_WEAPON_INDEX];
  /** The engine's own projected half-width: `size = SCENE_HEIGHT * ENEMY_SIZE / depth`. */
  const halfWidthAt = (d) => (DEFAULT_TUNING.SCENE_HEIGHT_PX * DEFAULT_TUNING.ENEMY_SPRITE_SIZE) / (2 * d);

  it("reproduces the engine's measured pellet counts across the range", () => {
    // Measured 2026-08-12 by firing the real shotgun at a centred enemy in an
    // open room and counting pellets from damage dealt (60-200 shots per
    // distance). These are the numbers the model exists to predict; the old
    // one claimed a flat 7 out to 4 tiles.
    const measured = { 1: 7.0, 1.5: 6.63, 2: 5.63, 3: 3.92, 4: 2.96, 5: 2.38, 6: 2.04, 8: 1.59 };
    for (const [dist, pellets] of Object.entries(measured)) {
      const got = pelletHitFraction(halfWidthAt(Number(dist)), shotgun) * shotgun.pellets;
      expect(Math.abs(got - pellets), `${dist}t: modelled ${got.toFixed(2)} vs measured ${pellets}`).toBeLessThan(0.15);
    }
  });

  it("is 1 for a single-pellet weapon at every range", () => {
    // Not a special case bolted on: this answers "given the shot connected, how
    // much of its damage lands", and one pellet lands all of it. The measured
    // data agrees — pistol and gdb sit at exactly 1.00 damage-per-hit against
    // prediction at every range, so this path must not move.
    for (const d of [1, 4, 8, 12]) {
      expect(pelletHitFraction(halfWidthAt(d), WEAPON_STATS[PISTOL_WEAPON_INDEX])).toBe(1);
      expect(pelletHitFraction(halfWidthAt(d), WEAPON_STATS[GDB_WEAPON_INDEX])).toBe(1);
    }
  });

  it("falls off with distance and never leaves [0, 1]", () => {
    const at = (d) => pelletHitFraction(halfWidthAt(d), shotgun);
    expect(at(1)).toBe(1);
    for (const d of [1, 2, 3, 4, 6, 8, 12, 20]) {
      expect(at(d)).toBeGreaterThanOrEqual(0);
      expect(at(d)).toBeLessThanOrEqual(1);
    }
    expect(at(2)).toBeGreaterThan(at(4));
    expect(at(4)).toBeGreaterThan(at(8));
  });

  it("degenerates to a plain offset count when the cone deviation is zero", () => {
    // The near-wall case the probe also measured: with no deviation a pellet
    // hits exactly when its own offset is inside the target.
    const noDev = { ...shotgun, maxConeDeviationPx: 0 };
    expect(pelletHitFraction(halfWidthAt(2), noDev)).toBe(1); // all 7 offsets within +/-70px
    expect(pelletHitFraction(halfWidthAt(8), noDev) * 7).toBe(1); // only the centre pellet
  });

  it("the shipped model values the shotgun below the old one at every range past point blank", () => {
    // The consequence that matters: the shotgun was over-valued against
    // pistol/gdb everywhere in `pickRangedWeapon`, not just the cluster branch.
    const off = { ...DEFAULT_TUNING, BOT_PELLET_CONE_MODEL: false };
    for (const d of [2, 3, 4, 6, 8]) {
      const now = expectedDamagePerShot(SHOTGUN_WEAPON_INDEX, d, DEFAULT_TUNING);
      const before = expectedDamagePerShot(SHOTGUN_WEAPON_INDEX, d, off);
      expect(now, `${d}t`).toBeLessThan(before);
    }
    // ...and leaves the single-pellet weapons exactly where they were.
    for (const d of [2, 4, 8]) {
      expect(expectedDamagePerShot(PISTOL_WEAPON_INDEX, d, DEFAULT_TUNING)).toBe(expectedDamagePerShot(PISTOL_WEAPON_INDEX, d, off));
    }
  });
});

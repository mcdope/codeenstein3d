// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the trace-scanning anomaly detectors in `bot.mjs`.
 *
 * These exist because the detectors are the only automated check on bot
 * *behaviour* — `balancing:scan` is built on them — and until now nothing
 * verified that they fire when they should, or stay quiet when they shouldn't.
 * A detector that silently stops firing is worse than no detector, because the
 * scan keeps reporting clean.
 *
 * `detectOscillation` in particular was written against a real, reproducible
 * failure the other two miss entirely: a demo-campaign level that wedges most
 * full-campaign attempts while producing zero findings, because the bot paces
 * instead of freezing.
 */
import { describe, expect, it } from "vitest";
import { detectAnomalies, detectHeldKeyNoMovement, detectOscillation, pathAvoidingHazardsIfPossible, rankExitBlockers, summarizeActivityDistance } from "./bot.mjs";

/** One trace record, with the fields the detectors actually read. */
function rec(over = {}) {
  return {
    branch: "main",
    x: 0,
    y: 0,
    hpFrac: 1,
    threatDist: null,
    mineDist: null,
    waitingOnSpike: false,
    moveKeys: [],
    turnBurst: 50,
    fire: false,
    fireOnCooldown: false,
    ...over,
  };
}

/** `n` records ping-ponging along x between `a` and `b`. */
function pingPong(n, a = 10, b = 11, over = {}) {
  return Array.from({ length: n }, (_, i) => rec({ x: i % 2 === 0 ? a : b, y: 10, moveKeys: ["KeyW"], ...over }));
}

/** `n` records walking steadily in +x. */
function traverse(n, step = 0.3) {
  return Array.from({ length: n }, (_, i) => rec({ x: 10 + i * step, y: 10, moveKeys: ["KeyW"] }));
}

describe("detectOscillation", () => {
  it("flags a bot ping-ponging between two waypoints", () => {
    // The real failure shape: real ground covered, no net progress, sustained.
    const found = detectOscillation(pingPong(60));
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("oscillation");
    expect(found[0].ticks).toBeGreaterThanOrEqual(30);
  });

  it("stays quiet on a bot actually going somewhere", () => {
    expect(detectOscillation(traverse(200))).toEqual([]);
  });

  it("stays quiet on a bot standing still", () => {
    // That is `stall`'s job — reporting it here too would just double the noise
    // on every finding.
    expect(detectOscillation(Array.from({ length: 60 }, () => rec({ x: 10, y: 10 })))).toEqual([]);
  });

  it("does not flag circling while engaged with a threat", () => {
    // Sidestepping and dodging in a firefight is deliberate behaviour, not a
    // wedge — counting it would bury the real findings.
    expect(detectOscillation(pingPong(60, 10, 11, { threatDist: 4 }))).toEqual([]);
  });

  it("does flag pacing that is only briefly in combat", () => {
    const trace = pingPong(60);
    for (let i = 0; i < 10; i++) trace[i].threatDist = 4; // a minority
    expect(detectOscillation(trace)).toHaveLength(1);
  });

  it("does not flag waiting out a spike trap", () => {
    expect(detectOscillation(pingPong(60, 10, 11, { waitingOnSpike: true }))).toEqual([]);
  });

  it("needs a sustained run, not a brief wobble", () => {
    expect(detectOscillation(pingPong(20))).toEqual([]);
  });

  it("reports travelled distance, net displacement and their ratio", () => {
    const [f] = detectOscillation(pingPong(60));
    expect(f.detail).toMatch(/travelled=[\d.]+t/);
    expect(f.detail).toMatch(/net=[\d.]+t/);
    expect(f.detail).toMatch(/ratio=/);
  });

  it("treats zero net displacement as maximally oscillatory rather than dividing by zero", () => {
    const [f] = detectOscillation(pingPong(61)); // odd count ends where it began
    expect(f.detail).toContain("ratio=inf");
  });

  it("closes the run once the bot genuinely leaves the area", () => {
    // Pace, then walk away: the pacing is still reported, and the departure is
    // what ends it rather than being folded into one giant finding.
    const found = detectOscillation([...pingPong(40), ...traverse(60)]);
    expect(found).toHaveLength(1);
    expect(found[0].endTick).toBeLessThan(60);
  });

  it("tolerates an absent or too-short trace", () => {
    expect(detectOscillation(undefined)).toEqual([]);
    expect(detectOscillation([])).toEqual([]);
    expect(detectOscillation(pingPong(5))).toEqual([]);
  });
});

describe("detectOscillation — route progress vs thrashing", () => {
  /** A run of `n` records ping-ponging in place, with a `navDist` series. */
  const withNavDist = (dists) =>
    dists.map((navDist, i) => rec({ x: i % 2 === 0 ? 10 : 11, y: 10, moveKeys: ["KeyW"], navDist, delta: 0.1 }));

  it("exempts a run where the bot reached several nav targets", () => {
    // The bot's ordinary gait: approach a waypoint, arrive, get the next one
    // a tile away, turn, approach, arrive. Spatially confined and high
    // path/net ratio, so every other test here fires — but it is exactly what
    // the bot is supposed to do, and it was drowning the real findings.
    const sawtooth = [];
    for (let cycle = 0; cycle < 10; cycle++) sawtooth.push(1.0, 0.7, 0.4, 0.2, 1.05, 0.8);
    expect(detectOscillation(withNavDist(sawtooth))).toEqual([]);
  });

  it("still flags a bot circling a target it never reaches", () => {
    // navDist hovers around a tile out and never closes — the wedge this
    // detector exists for.
    const hovering = Array.from({ length: 60 }, (_, i) => 0.9 + (i % 2) * 0.15);
    expect(detectOscillation(withNavDist(hovering)).length).toBeGreaterThan(0);
  });

  it("counts arrivals as falling edges, so hovering at one target can't exempt a run", () => {
    // Sitting just inside the arrival radius for many ticks is one arrival,
    // not many — otherwise a bot stuck *on* its target would exempt itself.
    const parked = Array.from({ length: 60 }, () => 0.2);
    expect(detectOscillation(withNavDist(parked)).length).toBeGreaterThan(0);
  });

  it("needs more than a single arrival to count as progress", () => {
    const oneArrival = [...Array.from({ length: 30 }, () => 0.9), ...Array.from({ length: 30 }, () => 0.2)];
    expect(detectOscillation(withNavDist(oneArrival)).length).toBeGreaterThan(0);
  });

  it("is unchanged for traces recorded before navDist existed", () => {
    // Older traces have no navDist at all; they must behave exactly as before
    // rather than silently becoming exempt.
    expect(detectOscillation(pingPong(60)).length).toBeGreaterThan(0);
  });
});

describe("the three detectors cover distinct failures", () => {
  const paced = pingPong(60);
  const frozen = Array.from({ length: 60 }, () => rec({ x: 10, y: 10, moveKeys: ["KeyW"] }));

  it("a paced wedge is caught only by detectOscillation", () => {
    // This is exactly why it was written: the existing passes report nothing.
    expect(detectOscillation(paced).length).toBeGreaterThan(0);
    expect(detectAnomalies(paced).filter((f) => f.type === "stall")).toEqual([]);
    expect(detectHeldKeyNoMovement(paced)).toEqual([]);
  });

  it("a frozen wedge is caught by the older passes, not by oscillation", () => {
    expect(detectAnomalies(frozen).some((f) => f.type === "stall")).toBe(true);
    expect(detectHeldKeyNoMovement(frozen).length).toBeGreaterThan(0);
    expect(detectOscillation(frozen)).toEqual([]);
  });
});

describe("detectAnomalies", () => {
  it("flags a frozen position as a stall", () => {
    const found = detectAnomalies(Array.from({ length: 40 }, () => rec({ x: 5, y: 5 })));
    expect(found.some((f) => f.type === "stall")).toBe(true);
  });

  it("does not call a firefight a stall", () => {
    const trace = Array.from({ length: 40 }, () => rec({ x: 5, y: 5, fire: true, threatDist: 3 }));
    expect(detectAnomalies(trace).some((f) => f.type === "stall")).toBe(false);
  });

  it("flags health draining while frozen, even briefly", () => {
    const trace = [rec({ x: 5, y: 5, hpFrac: 1 }), rec({ x: 5, y: 5, hpFrac: 0.9 }), rec({ x: 5, y: 5, hpFrac: 0.8 })];
    expect(detectAnomalies(trace).some((f) => f.type === "healthDrainFrozen")).toBe(true);
  });

  it("does not call waiting out a spike a stall", () => {
    const trace = Array.from({ length: 40 }, () => rec({ x: 5, y: 5, waitingOnSpike: true }));
    expect(detectAnomalies(trace).some((f) => f.type === "stall")).toBe(false);
  });
});

describe("detectHeldKeyNoMovement", () => {
  it("flags a translating key held with no displacement", () => {
    const trace = Array.from({ length: 20 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW"] }));
    expect(detectHeldKeyNoMovement(trace).length).toBeGreaterThan(0);
  });

  it("ignores a turn key, which is not supposed to translate", () => {
    const trace = Array.from({ length: 20 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyE"] }));
    expect(detectHeldKeyNoMovement(trace)).toEqual([]);
  });

  it("reports the union of keys held across the run, not one tick's", () => {
    // Worth pinning: this reads as "these keys were held simultaneously" and is
    // not — it misled a reading of a real trace once.
    const trace = [
      ...Array.from({ length: 8 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW", "KeyE"] })),
      ...Array.from({ length: 8 }, () => rec({ x: 5, y: 5, moveKeys: ["KeyW", "KeyQ"] })),
    ];
    const [f] = detectHeldKeyNoMovement(trace);
    expect(f.detail).toContain("keysDuringRun=");
    expect(f.detail).toContain("KeyE");
    expect(f.detail).toContain("KeyQ");
  });
});

describe("summarizeActivityDistance", () => {
  /** `n` records at 1-tile spacing in +x under one activity label. */
  const leg = (n, activity, over = {}) =>
    Array.from({ length: n }, (_, i) => rec({ x: i, y: 0, activity, moveKeys: ["KeyW"], ...over }));

  it("returns nothing for an empty or missing trace", () => {
    expect(summarizeActivityDistance([])).toEqual({ rows: [], total: 0 });
    expect(summarizeActivityDistance(undefined)).toEqual({ rows: [], total: 0 });
  });

  it("charges each gap to the earlier record's activity", () => {
    // Positions 0,1,2 under "route" then 3,4 under "loot": the 2->3 gap is the
    // last "route" record's motion, so route gets 3 tiles and loot gets 1.
    const trace = [
      rec({ x: 0, activity: "route" }),
      rec({ x: 1, activity: "route" }),
      rec({ x: 2, activity: "route" }),
      rec({ x: 3, activity: "loot" }),
      rec({ x: 4, activity: "loot" }),
    ];
    const { rows, total } = summarizeActivityDistance(trace);
    expect(total).toBeCloseTo(4);
    expect(rows.map((r) => [r.activity, r.tiles])).toEqual([
      ["route", 3],
      ["loot", 1],
    ]);
  });

  it("counts the final record's ticks but not its unobservable motion", () => {
    const [row] = summarizeActivityDistance(leg(4, "route")).rows;
    expect(row.ticks).toBe(4);
    expect(row.tiles).toBeCloseTo(3);
  });

  it("computes each activity's share of the total", () => {
    const trace = [...leg(4, "route"), ...leg(2, "exit").map((r) => ({ ...r, x: r.x + 100 }))];
    const { rows } = summarizeActivityDistance(trace);
    expect(rows.find((r) => r.activity === "route").share).toBeCloseTo(0.75);
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
  });

  it("drops a teleport jump instead of charging it to an activity", () => {
    // A cross-map hop must not swamp every real figure — see the constant's
    // own comment for why the bar sits above the widest legitimate step.
    const trace = [rec({ x: 0, activity: "route" }), rec({ x: 60, activity: "route" }), rec({ x: 61, activity: "route" })];
    const { total, rows } = summarizeActivityDistance(trace);
    expect(total).toBeCloseTo(1);
    expect(rows[0].tiles).toBeCloseTo(1);
  });

  it("labels records with no activity rather than dropping them", () => {
    const { rows, total } = summarizeActivityDistance([rec({ x: 0 }), rec({ x: 1 })]);
    expect(rows.map((r) => r.activity)).toEqual(["unlabelled"]);
    expect(total).toBeCloseTo(1);
  });

  it("splits out distance covered while a threat was present", () => {
    const trace = [
      rec({ x: 0, activity: "route" }),
      rec({ x: 1, activity: "route", threatDist: 5 }),
      rec({ x: 2, activity: "route", threatDist: 4 }),
      rec({ x: 3, activity: "route" }),
    ];
    const [row] = summarizeActivityDistance(trace).rows;
    expect(row.tiles).toBeCloseTo(3);
    // Records 1 and 2 each cover one tile with a threat up; record 0 does not.
    expect(row.engagedTiles).toBeCloseTo(2);
  });

  it("treats the threat-driven escape branches as engaged without a threatDist", () => {
    // `mineRetreat` reports `threatDist: null` (its danger is a mine), so
    // keying only off `threatDist` would mis-file it as free navigation.
    const trace = [
      rec({ x: 0, activity: "route", branch: "mineRetreat", mineDist: 2 }),
      rec({ x: 1, activity: "route", branch: "criticalHealth" }),
      rec({ x: 2, activity: "route" }),
    ];
    const [row] = summarizeActivityDistance(trace).rows;
    expect(row.engagedTiles).toBeCloseTo(2);
  });

  it("keeps hazard and plain navigation out of the engaged split", () => {
    // Acid is terrain, not a threat — counting it as combat would inflate
    // exactly the number this breakdown exists to attribute.
    const trace = [rec({ x: 0, activity: "route", branch: "hazard" }), rec({ x: 1, activity: "route" })];
    expect(summarizeActivityDistance(trace).rows[0].engagedTiles).toBe(0);
  });
});

describe("rankExitBlockers", () => {
  /** A map with a wall down the middle: (5,y) is solid for y=0..8, so the two
   * halves only connect around the bottom. */
  const splitMap = () => {
    const grid = Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0));
    for (let x = 0; x < 12; x++) {
      grid[0][x] = 1;
      grid[11][x] = 1;
    }
    for (let y = 0; y < 12; y++) {
      grid[y][0] = 1;
      grid[y][11] = 1;
    }
    for (let y = 1; y <= 8; y++) grid[y][5] = 1;
    return { width: 12, height: 12, grid };
  };

  it("prefers the enemy that is genuinely nearer to walk to, not the nearer-looking one", () => {
    // Player at (3,2), west of the wall. `far` is on the same side and a short
    // walk; `nearLooking` is just across the wall — closer as the crow flies,
    // but reachable only by going all the way around the bottom.
    const map = splitMap();
    const player = { x: 3.5, y: 2.5 };
    const nearLooking = { i: 0, x: 6.5, y: 2.5 };
    const far = { i: 1, x: 3.5, y: 6.5 };
    expect(Math.hypot(nearLooking.x - player.x, nearLooking.y - player.y)).toBeLessThan(
      Math.hypot(far.x - player.x, far.y - player.y),
    );
    const ranked = rankExitBlockers([nearLooking, far], player, map, new Set());
    expect(ranked[0].i).toBe(1);
    expect(ranked[0].walkTiles).toBeLessThan(ranked[1].walkTiles);
  });

  it("sorts an unreachable blocker last rather than dropping it", () => {
    // The exit stays inert while any homed enemy lives, so discarding one
    // would turn a hunt into a silent "stuck".
    const map = splitMap();
    map.grid[5][3] = 1;
    const sealed = { i: 0, x: 10.5, y: 10.5 };
    const reachable = { i: 1, x: 3.5, y: 3.5 };
    const ranked = rankExitBlockers([sealed, reachable], { x: 3.5, y: 2.5 }, map, new Set());
    expect(ranked).toHaveLength(2);
    expect(ranked[0].i).toBe(1);
  });

  it("breaks ties by index, so the order is total", () => {
    const map = splitMap();
    const a = { i: 7, x: 3.5, y: 3.5 };
    const b = { i: 2, x: 3.5, y: 3.5 };
    expect(rankExitBlockers([a, b], { x: 3.5, y: 2.5 }, map, new Set()).map((e) => e.i)).toEqual([2, 7]);
  });

  it("keeps every candidate's own fields intact", () => {
    const map = splitMap();
    const ranked = rankExitBlockers([{ i: 0, x: 3.5, y: 3.5, alive: true, elite: true }], { x: 3.5, y: 2.5 }, map, new Set());
    expect(ranked[0]).toMatchObject({ i: 0, alive: true, elite: true });
  });
});

describe("pathAvoidingHazardsIfPossible", () => {
  const SPIKE = 5;
  /** Corridor from (1,1) to (5,1); the only way through is a spike at (3,1). */
  const gauntlet = () => {
    const grid = Array.from({ length: 5 }, () => Array.from({ length: 7 }, () => 1));
    for (let x = 1; x <= 5; x++) grid[1][x] = 0;
    grid[1][3] = SPIKE;
    return { width: 7, height: 5, grid };
  };
  const AVOID = new Set([SPIKE]);
  const A = { x: 1, y: 1 }, B = { x: 5, y: 1 };

  it("prefers the hazard-free route when one exists", () => {
    const map = gauntlet();
    map.grid[2][3] = 0; // a clean detour around the spike
    map.grid[2][2] = 0;
    map.grid[2][4] = 0;
    const r = pathAvoidingHazardsIfPossible(map, A, B, AVOID, new Set());
    expect(r.path).not.toBeNull();
    expect(r.viaHazard).toBe(false);
  });

  it("routes through the hazard rather than declaring the target unreachable", () => {
    // The captured main.c case: the exit is reachable, but every route to it
    // crosses a spike. Refusing to plan left driveToExit straight-lining into
    // a wall for ~22 seconds.
    const r = pathAvoidingHazardsIfPossible(gauntlet(), A, B, AVOID, new Set());
    expect(r.path).not.toBeNull();
    expect(r.viaHazard).toBe(true);
  });

  it("still reports genuinely unreachable targets as unreachable", () => {
    const map = gauntlet();
    map.grid[1][3] = 1; // solid wall, not a spike — no route at all
    const r = pathAvoidingHazardsIfPossible(map, A, B, AVOID, new Set());
    expect(r.path).toBeNull();
    expect(r.viaHazard).toBe(false);
  });

  it("keeps the old strict behaviour when the fallback is switched off", () => {
    const r = pathAvoidingHazardsIfPossible(gauntlet(), A, B, AVOID, new Set(), false);
    expect(r.path).toBeNull();
    expect(r.viaHazard).toBe(false);
  });
});

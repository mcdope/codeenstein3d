// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tests for the skill-ladder grader.
 *
 * The grader's whole job is to fail when the tiers stop being ordered, so the
 * cases that matter most here are the failing ones — an inverted axis that
 * still reports "pass" would be worse than having no grader, because it would
 * license per-tier conclusions that aren't supported.
 */
import { describe, expect, it } from "vitest";
import { FLAT_TARGETS, gradeAxis, gradeSeparation, LADDER, scalar, SEPARATION_TARGETS } from "./profileSeparation.mjs";

/** Minimal combo shaped like `json.profiles[name][difficulty]`. */
function combo({ enemyAccuracy, rangedPerSec, ttk, levelTime, distance = 300, overhead = 1.9 }) {
  return {
    campaignAggregate: {
      aiEffectivenessDanger: { enemyAccuracy: { mean: enemyAccuracy, samples: [enemyAccuracy] } },
      combatPacing: {
        levelTimeSec: { mean: levelTime, samples: [levelTime] },
        avgTtkByCategory: { normal: { mean: ttk, samples: [ttk] } },
        combatVsExplorationRatio: { mean: 0.1, samples: [0.1] },
        peakSimultaneousAggroed: { mean: 3, samples: [3] },
      },
      navigationMapFlow: {
        distanceTraveled: { mean: distance, samples: [distance] },
        routeFollowingOverhead: { mean: overhead, samples: [overhead] },
        routeEfficiencyScore: { mean: 0.34, samples: [0.34] },
      },
      damageHealingBreakdown: { damageBySource: { enemyRanged: rangedPerSec * levelTime } },
    },
  };
}

/** A ladder that passes every target, as the baseline for one-axis breakage. */
const GOOD = {
  Casual: combo({ enemyAccuracy: 0.60, rangedPerSec: 0.50, ttk: 1.20, levelTime: 78 }),
  Gamer: combo({ enemyAccuracy: 0.52, rangedPerSec: 0.42, ttk: 0.90, levelTime: 68 }),
  Pro: combo({ enemyAccuracy: 0.45, rangedPerSec: 0.34, ttk: 0.75, levelTime: 62 }),
};

describe("gradeAxis", () => {
  it("accepts a strictly decreasing ladder when lower is better", () => {
    expect(gradeAxis([3, 2, 1], "down")).toMatchObject({ monotonic: true, spread: 3, measuredStep: 1.5 });
  });

  it("rejects a tie — two tiers sharing a value is a tier that isn't one", () => {
    expect(gradeAxis([2, 2, 1], "down").monotonic).toBe(false);
  });

  it("rejects the real inversion this was built for", () => {
    // The measured baseline: Casual hit least, Gamer most. A skill ladder
    // where the *worst* player takes the least damage is not a skill ladder.
    expect(gradeAxis([0.499, 0.556, 0.531], "down").monotonic).toBe(false);
  });

  it("reports missing data rather than guessing", () => {
    expect(gradeAxis([1, null, 3], "down")).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("gradeSeparation", () => {
  it("passes a cleanly ordered ladder", () => {
    const r = gradeSeparation(GOOD);
    expect(r.pass).toBe(true);
    expect(r.axes.every((a) => a.pass)).toBe(true);
  });

  it("fails when one axis inverts, and names it", () => {
    const bad = { ...GOOD, Gamer: combo({ enemyAccuracy: 0.70, rangedPerSec: 0.42, ttk: 0.90, levelTime: 68 }) };
    const r = gradeSeparation(bad);
    expect(r.pass).toBe(false);
    expect(r.axes.find((a) => a.key === "enemyAccuracy")).toMatchObject({ monotonic: false, pass: false });
  });

  it("fails an axis whose MIDDLE step is unreadable, even though the ladder ends far apart", () => {
    // The exact failure mode: Casual is cleanly separated from both, so a
    // whole-ladder max/min ratio looks healthy (0.60/0.515 = 1.17x), while
    // Gamer->Pro is 1.01x — the step that flipped run-to-run across four n=5
    // scans. Grading the ends instead of the steps cannot catch this.
    const close = { ...GOOD, Pro: combo({ enemyAccuracy: 0.515, rangedPerSec: 0.34, ttk: 0.75, levelTime: 62 }) };
    const r = gradeSeparation(close);
    const axis = r.axes.find((a) => a.key === "enemyAccuracy");
    expect(axis.monotonic).toBe(true);
    expect(axis.meetsStep).toBe(false);
    expect(axis.spread).toBeGreaterThan(1.15); // the ends look fine; the middle does not
    expect(r.pass).toBe(false);
  });

  it("fails when a tier quietly becomes a different navigation policy", () => {
    // Walking 40% further is not "more casual", it is the mistake the old
    // `coverageMode` flag made.
    const wander = { ...GOOD, Casual: combo({ enemyAccuracy: 0.60, rangedPerSec: 0.50, ttk: 1.20, levelTime: 78, distance: 430 }) };
    const r = gradeSeparation(wander);
    expect(r.flatAxes.find((a) => a.key === "distanceTraveled").pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("reports missing profiles instead of grading a partial ladder", () => {
    const r = gradeSeparation({ Casual: GOOD.Casual, Pro: GOOD.Pro });
    expect(r.missing).toEqual(["Gamer"]);
    expect(r.pass).toBe(false);
  });
});

describe("pre-registered targets", () => {
  it("covers both inverted axes and both working ones", () => {
    expect(SEPARATION_TARGETS.map((t) => t.key)).toEqual(["enemyAccuracy", "dmg.enemyRangedPerSec", "ttkNormal", "levelTimeSec"]);
    expect(FLAT_TARGETS.map((t) => t.key)).toEqual(["distanceTraveled", "routeFollowOverhead"]);
    expect(LADDER).toEqual(["Casual", "Gamer", "Pro"]);
  });

  it("does not let the already-working axes regress below their measured baseline", () => {
    // ttk measured 1.476x and levelTime 1.221x before any of this work; the
    // targets exist so a later change cannot quietly trade them away.
    expect(SEPARATION_TARGETS.find((t) => t.key === "ttkNormal").minStep).toBeLessThanOrEqual(1.162);
    expect(SEPARATION_TARGETS.find((t) => t.key === "levelTimeSec").minStep).toBeLessThanOrEqual(1.081);
  });

  it("unwraps both metric shapes collectMetrics can return", () => {
    expect(scalar({ a: { mean: 5 } }, "a")).toBe(5);
    expect(scalar({ a: 7 }, "a")).toBe(7);
    expect(scalar({ a: null }, "a")).toBe(null);
  });
});

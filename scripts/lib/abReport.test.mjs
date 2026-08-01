// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Unit tests for the balancing A/B comparison helpers.
 *
 * `scripts/lib/` has historically had no automated tests at all — the only net
 * for ~1300 lines of bot decision logic was `npm run balancing:scan`, which is
 * headless-only and not CI-wired. These are the first, and they exist as much
 * to establish the wiring as to test this module: `scripts/**` is excluded from
 * the `src/` coverage *denominator* but is still executed by `vitest run`, so a
 * test placed here does run in CI, exactly like
 * `scripts/multiplayer-server.test.mjs`.
 */
import { describe, expect, it } from "vitest";
import { checkRollback, compareRunFlags, collectMetrics, computeSurvivalCurve, diffCombo, diffTelemetry, diffAnomalies, formatComboDiff, relChangeIsMeaningful, spreadValue } from "./abReport.mjs";

/** Minimal `spread()`-shaped object — `{ [kind]: value, samples }`. */
const sp = (kind, value) => ({ [kind]: value, samples: [value] });

/**
 * A combo output with just the fields these helpers read. Deliberately not a
 * full fixture: a fixture large enough to be realistic would hide which field
 * each assertion actually depends on.
 */
function combo({ attemptsUsed = 10, trueQualifyingCount = 5, failureReasons = [], levelSampleCounts = [5, 5, 3], aggregate = {} } = {}) {
  return {
    attemptsUsed,
    qualifyingRunCount: Math.min(trueQualifyingCount, 3),
    trueQualifyingCount,
    failureReasons,
    levels: levelSampleCounts.map((sampleCount, levelIndex) => ({ levelIndex, runtime: { sampleCount } })),
    campaignAggregate: aggregate,
  };
}

describe("spreadValue", () => {
  it("reads whichever of mean/max/min the spread carries", () => {
    expect(spreadValue(sp("mean", 1.5))).toBe(1.5);
    expect(spreadValue(sp("max", 9))).toBe(9);
    expect(spreadValue(sp("min", -2))).toBe(-2);
  });

  it("returns null for a missing or non-spread value rather than throwing", () => {
    expect(spreadValue(undefined)).toBeNull();
    expect(spreadValue(null)).toBeNull();
    expect(spreadValue(42)).toBeNull();
    expect(spreadValue({ samples: [] })).toBeNull();
  });

  it("reads a zero value rather than falling through to the next kind", () => {
    // A truthiness check here would skip `mean: 0` and report null, which for
    // `enemyAccuracy` is the difference between "perfect dodging" and "no data".
    expect(spreadValue({ mean: 0, samples: [] })).toBe(0);
  });
});

describe("computeSurvivalCurve", () => {
  it("counts a failure as having reached every level up to the one it failed on", () => {
    const c = computeSurvivalCurve(
      combo({
        levelSampleCounts: [0, 0, 0],
        failureReasons: [{ attempt: 1, reason: "died", diedAtLevelIndex: 2 }],
      }),
    );
    expect(c.levels.map((l) => l.reached)).toEqual([1, 1, 1]);
    expect(c.levels.map((l) => l.died)).toEqual([0, 0, 1]);
  });

  it("adds qualifying runs' per-level sample counts into reached", () => {
    const c = computeSurvivalCurve(
      combo({
        levelSampleCounts: [4, 4, 2],
        failureReasons: [{ attempt: 1, reason: "died", diedAtLevelIndex: 0 }],
      }),
    );
    expect(c.levels.map((l) => l.reached)).toEqual([5, 4, 2]);
  });

  it("separates died, stuck and crashed", () => {
    const c = computeSurvivalCurve(
      combo({
        levelSampleCounts: [0, 0],
        failureReasons: [
          { attempt: 1, reason: "died", diedAtLevelIndex: 1 },
          { attempt: 2, reason: "stuck", diedAtLevelIndex: 1 },
          { attempt: 3, reason: "attemptCrashed: boom", diedAtLevelIndex: 1 },
        ],
      }),
    );
    expect(c.levels[1]).toMatchObject({ reached: 3, died: 1, stuck: 1, crashed: 1 });
  });

  it("reports a conditional death rate, not a raw count", () => {
    const c = computeSurvivalCurve(
      combo({
        levelSampleCounts: [8, 0],
        failureReasons: [
          { attempt: 1, reason: "died", diedAtLevelIndex: 0 },
          { attempt: 2, reason: "died", diedAtLevelIndex: 0 },
        ],
      }),
    );
    expect(c.levels[0].reached).toBe(10);
    expect(c.levels[0].conditionalDeathRate).toBeCloseTo(0.2);
  });

  it("leaves the death rate null for a level nothing reached", () => {
    // Not 0 — "no deaths out of no attempts" would flatter a candidate that
    // stopped getting this far at all.
    const c = computeSurvivalCurve(combo({ levelSampleCounts: [0, 0], failureReasons: [] }));
    expect(c.levels[0].conditionalDeathRate).toBeNull();
    expect(c.levels[0].conditionalStuckRate).toBeNull();
  });

  it("uses trueQualifyingCount for the qualify rate, not the floored count", () => {
    const c = computeSurvivalCurve(combo({ attemptsUsed: 12, trueQualifyingCount: 7 }));
    expect(c.trueQualifyingCount).toBe(7);
    expect(c.qualifyRate).toBeCloseTo(7 / 12);
  });

  it("surfaces failures with no level attribution instead of dropping them", () => {
    const c = computeSurvivalCurve(
      combo({
        failureReasons: [
          { attempt: 1, reason: "attemptCrashed: browser died", diedAtLevelIndex: null },
          { attempt: 2, reason: "stuck", diedAtLevelIndex: null },
        ],
      }),
    );
    expect(c.unattributedFailures).toBe(2);
  });

  it("derives attrition from the reach curve, covering deaths failureReasons can't see", () => {
    // The blind spot this exists for: `isQualifying` is
    // `reachedExitForLevel[3]`, so a run that clears level 4 and then dies on
    // level 6 is a *qualifying* run — it never enters `failureReasons` and
    // contributes zero to `died`. Only the reach curve drops.
    const c = computeSurvivalCurve(combo({ levelSampleCounts: [20, 20, 20, 20, 20, 10], failureReasons: [] }));
    expect(c.levels.map((l) => l.died)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(c.levels[4].attritionRate).toBeCloseTo(0.5);
    expect(c.levels[4].conditionalDeathRate).toBe(0);
  });

  it("leaves attrition null on the last level, where clearing it isn't attrition", () => {
    const c = computeSurvivalCurve(combo({ levelSampleCounts: [10, 8] }));
    expect(c.levels[0].attritionRate).toBeCloseTo(0.2);
    expect(c.levels[1].attritionRate).toBeNull();
  });

  it("leaves attrition null for a level nothing reached", () => {
    const c = computeSurvivalCurve(combo({ levelSampleCounts: [0, 0, 0] }));
    expect(c.levels.map((l) => l.attritionRate)).toEqual([null, null, null]);
  });

  it("degrades to an empty curve on a malformed combo rather than throwing", () => {
    expect(computeSurvivalCurve(undefined)).toMatchObject({ attemptsUsed: 0, qualifyRate: null, levels: [] });
    expect(computeSurvivalCurve({}).levels).toEqual([]);
  });
});

describe("collectMetrics", () => {
  const aggregate = {
    combatPacing: { levelTimeSec: sp("mean", 120), avgTtkByCategory: { normal: sp("mean", 4) }, combatVsExplorationRatio: sp("mean", 0.3), peakSimultaneousAggroed: sp("max", 5) },
    aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0.587), minHealthReached: sp("min", 12), timeBelow25PctHealthSec: sp("mean", 3) },
    navigationMapFlow: { routeEfficiencyScore: sp("mean", 0.4), distanceTraveled: sp("mean", 900) },
    damageHealingBreakdown: { damageBySource: { enemyRanged: 497, enemyMelee: 13, hazard: 40, trapSpike: 5 } },
  };

  it("pulls every win and damage metric off the campaign aggregate", () => {
    const m = collectMetrics(combo({ aggregate }));
    expect(m.enemyAccuracy).toBeCloseTo(0.587);
    expect(m.levelTimeSec).toBe(120);
    expect(m.distanceTraveled).toBe(900);
    expect(m.minHealthReached).toBe(12);
    expect(m.peakAggroed).toBe(5);
    expect(m["dmg.enemyRanged"]).toBe(497);
    expect(m["dmg.trapSpike"]).toBe(5);
  });

  it("nulls out metrics an older telemetry file doesn't carry", () => {
    // levelTimeSec/distanceTraveled were only added alongside this module, so
    // a baseline captured before them must degrade to "not comparable" rather
    // than crash the whole report.
    const m = collectMetrics(combo({ aggregate: { aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0.5) } } }));
    expect(m.enemyAccuracy).toBe(0.5);
    expect(m.levelTimeSec).toBeNull();
    expect(m["dmg.enemyRanged"]).toBeNull();
  });
});

describe("diffCombo", () => {
  it("reports relative deltas for metrics present on both sides", () => {
    const base = combo({ aggregate: { aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0.6) } } });
    const cand = combo({ aggregate: { aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0.3) } } });
    const acc = diffCombo(base, cand).metrics.find((m) => m.key === "enemyAccuracy");
    expect(acc.relDelta).toBeCloseTo(-0.5);
    expect(acc.better).toBe("down");
  });

  it("leaves relDelta null when a baseline of zero can't produce a ratio", () => {
    const base = combo({ aggregate: { aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0) } } });
    const cand = combo({ aggregate: { aiEffectivenessDanger: { enemyAccuracy: sp("mean", 0.4) } } });
    expect(diffCombo(base, cand).metrics.find((m) => m.key === "enemyAccuracy").relDelta).toBeNull();
  });

  it("treats zero-to-zero as no change rather than as unknown", () => {
    const zero = combo({ aggregate: { damageHealingBreakdown: { damageBySource: { hazard: 0 } } } });
    expect(diffCombo(zero, zero).metrics.find((m) => m.key === "dmg.hazard").relDelta).toBe(0);
  });

  it("expresses death-rate movement in percentage points, not percent", () => {
    const base = combo({ levelSampleCounts: [9], failureReasons: [{ attempt: 1, reason: "died", diedAtLevelIndex: 0 }] });
    const cand = combo({ levelSampleCounts: [7], failureReasons: [{ attempt: 1, reason: "died", diedAtLevelIndex: 0 }, { attempt: 2, reason: "died", diedAtLevelIndex: 0 }, { attempt: 3, reason: "died", diedAtLevelIndex: 0 }] });
    const l0 = diffCombo(base, cand).levels[0];
    expect(l0.baseDeathRate).toBeCloseTo(0.1);
    expect(l0.candDeathRate).toBeCloseTo(0.3);
    expect(l0.deathRateDeltaPp).toBeCloseTo(20);
  });

  it("spans the longer side when the two runs saw different level counts", () => {
    const base = combo({ levelSampleCounts: [3, 3] });
    const cand = combo({ levelSampleCounts: [3, 3, 3, 3] });
    expect(diffCombo(base, cand).levels).toHaveLength(4);
  });
});

describe("relChangeIsMeaningful", () => {
  it("marks a big percentage on a near-zero base as unreadable", () => {
    // The real Stage 1 case: trapSpike 0.363 -> 0.605 rendered as "+66.3%",
    // which is half a percent of a 100 HP bar and reversed to -2.7% at a
    // larger sample.
    expect(relChangeIsMeaningful("dmg.trapSpike", 0.363, 0.605)).toBe(false);
  });

  it("reads a change once either side clears the floor", () => {
    expect(relChangeIsMeaningful("dmg.trapSpike", 4, 12)).toBe(true);
    expect(relChangeIsMeaningful("dmg.trapSpike", 12, 4)).toBe(true);
  });

  it("imposes no floor on metrics whose magnitudes are inherently large", () => {
    expect(relChangeIsMeaningful("enemyAccuracy", 0.001, 0.002)).toBe(true);
    expect(relChangeIsMeaningful("levelTimeSec", 0.1, 0.2)).toBe(true);
  });

  it("treats a missing value as readable, leaving the null relDelta to speak", () => {
    expect(relChangeIsMeaningful("dmg.trapSpike", null, 0.5)).toBe(true);
  });
});

describe("checkRollback", () => {
  const flat = () => combo({ attemptsUsed: 20, trueQualifyingCount: 10, levelSampleCounts: [10, 10] });

  it("passes when nothing moved", () => {
    expect(checkRollback(diffCombo(flat(), flat()))).toEqual([]);
  });

  it("trips on a qualify-rate collapse", () => {
    const cand = combo({ attemptsUsed: 20, trueQualifyingCount: 2, levelSampleCounts: [10, 10] });
    const breaches = checkRollback(diffCombo(flat(), cand));
    expect(breaches.some((b) => b.includes("qualifyRate fell"))).toBe(true);
  });

  it("trips on the historical 0% -> 72% level-2 death regression", () => {
    // The concrete regression this whole protocol exists to catch: adding
    // `diagonalStrafeKey` to every turn-and-move branch took Casual/normal's
    // level-2 death rate from 0% to 72%.
    const base = combo({ attemptsUsed: 20, trueQualifyingCount: 20, levelSampleCounts: [20, 20], failureReasons: [] });
    const cand = combo({
      attemptsUsed: 20,
      trueQualifyingCount: 6,
      levelSampleCounts: [20, 6],
      failureReasons: Array.from({ length: 14 }, (_, i) => ({ attempt: i + 1, reason: "died", diedAtLevelIndex: 1 })),
    });
    const breaches = checkRollback(diffCombo(base, cand));
    expect(breaches.some((b) => b.includes("L2 conditional death rate rose"))).toBe(true);
  });

  it("trips on an attrition rise even when failureReasons shows no deaths at all", () => {
    // Above the qualify bar, `died` stays 0 for both sides — attrition is the
    // only guard that can see this regression.
    const base = combo({ attemptsUsed: 20, trueQualifyingCount: 20, levelSampleCounts: [20, 20, 20, 20, 20, 20], failureReasons: [] });
    const cand = combo({ attemptsUsed: 20, trueQualifyingCount: 20, levelSampleCounts: [20, 20, 20, 20, 20, 4], failureReasons: [] });
    const diff = diffCombo(base, cand);
    expect(diff.levels[4].baseDeathRate).toBe(0);
    expect(diff.levels[4].candDeathRate).toBe(0);
    const breaches = checkRollback(diff);
    expect(breaches.some((b) => b.includes("L5 attrition rose"))).toBe(true);
  });

  it("does not trip attrition when the guard is not configured", () => {
    const base = combo({ levelSampleCounts: [20, 20] });
    const cand = combo({ levelSampleCounts: [20, 2] });
    expect(checkRollback(diffCombo(base, cand), { qualifyRateDropPp: 15, deathRateRisePp: 20, stuckIncreaseTrips: false })).toEqual([]);
  });

  it("trips on any increase in stuck count at all, with no tolerance", () => {
    const base = combo({ levelSampleCounts: [5], failureReasons: [] });
    const cand = combo({ levelSampleCounts: [5], failureReasons: [{ attempt: 1, reason: "stuck", diedAtLevelIndex: 0 }] });
    const breaches = checkRollback(diffCombo(base, cand));
    expect(breaches.some((b) => b.includes("stuck count rose 0 -> 1"))).toBe(true);
  });

  it("honours overridden thresholds, for the tightened late-stage gates", () => {
    const base = combo({ attemptsUsed: 20, trueQualifyingCount: 20, levelSampleCounts: [20] });
    const cand = combo({ attemptsUsed: 20, trueQualifyingCount: 18, levelSampleCounts: [18] });
    const diff = diffCombo(base, cand);
    expect(checkRollback(diff)).toEqual([]);
    const strict = checkRollback(diff, { qualifyRateDropPp: 8, deathRateRisePp: 10, stuckIncreaseTrips: true });
    expect(strict.some((b) => b.includes("qualifyRate fell"))).toBe(true);
  });
});

describe("diffTelemetry", () => {
  const side = (profiles) => ({ meta: {}, profiles });

  it("diffs every combo present in both sides", () => {
    const base = side({ Casual: { normal: combo(), hard: combo(), crossDifficultyFlags: ["x"] } });
    const cand = side({ Casual: { normal: combo(), hard: combo(), crossDifficultyFlags: [] } });
    const { combos, missing } = diffTelemetry(base, cand);
    expect(combos.map((c) => c.label)).toEqual(["Casual/normal", "Casual/hard"]);
    expect(missing).toEqual([]);
  });

  it("never treats crossDifficultyFlags as a difficulty", () => {
    const one = side({ Pro: { hard: combo(), crossDifficultyFlags: ["normal_ttk_high"] } });
    expect(diffTelemetry(one, one).combos.map((c) => c.label)).toEqual(["Pro/hard"]);
  });

  it("names combos missing from the candidate instead of silently comparing fewer", () => {
    const base = side({ Gamer: { normal: combo(), hard: combo() } });
    const cand = side({ Gamer: { normal: combo() } });
    const { combos, missing } = diffTelemetry(base, cand);
    expect(combos).toHaveLength(1);
    expect(missing).toEqual(["Gamer/hard"]);
  });

  it("handles a candidate missing the profile entirely", () => {
    const { combos, missing } = diffTelemetry(side({ Pro: { hard: combo() } }), side({}));
    expect(combos).toEqual([]);
    expect(missing).toEqual(["Pro/hard"]);
  });
});

describe("formatComboDiff", () => {
  it("renders guards, levels and metrics, and says guards pass", () => {
    const c = combo({ attemptsUsed: 20, trueQualifyingCount: 10, levelSampleCounts: [10, 10] });
    const out = formatComboDiff("Casual/normal", diffCombo(c, c));
    expect(out).toContain("=== Casual/normal ===");
    expect(out).toContain("qualifyRate");
    expect(out).toContain("enemyAccuracy");
    expect(out).toContain("GUARDS: pass");
  });

  it("spells out every breach and tells the reader to revert rather than tune", () => {
    const base = combo({ attemptsUsed: 20, trueQualifyingCount: 20, levelSampleCounts: [20] });
    const cand = combo({ attemptsUsed: 20, trueQualifyingCount: 1, levelSampleCounts: [1], failureReasons: [{ attempt: 1, reason: "stuck", diedAtLevelIndex: 0 }] });
    const out = formatComboDiff("Pro/hard", diffCombo(base, cand));
    expect(out).toContain("GUARDS: BREACHED");
    expect(out).toContain("do not tune it forward");
    expect(out).toContain("stuck count rose");
  });

  it("renders unattributed failures only when there are any", () => {
    const clean = combo();
    expect(formatComboDiff("x", diffCombo(clean, clean))).not.toContain("unattributed");
    const dirty = combo({ failureReasons: [{ attempt: 1, reason: "stuck", diedAtLevelIndex: null }] });
    expect(formatComboDiff("x", diffCombo(clean, dirty))).toContain("unattributed failures  0 -> 1");
  });

  it("flags a percentage on a near-zero base as too small to read", () => {
    const dmg = (trapSpike) => combo({ aggregate: { damageHealingBreakdown: { damageBySource: { trapSpike } } } });
    const out = formatComboDiff("x", diffCombo(dmg(0.363), dmg(0.605)));
    expect(out).toContain("too small to read");
    const big = formatComboDiff("x", diffCombo(dmg(20), dmg(33)));
    expect(big).not.toContain("too small to read");
  });

  it("renders em-dashes for metrics that aren't comparable instead of NaN", () => {
    const bare = combo({ aggregate: {} });
    const out = formatComboDiff("x", diffCombo(bare, bare));
    expect(out).not.toContain("NaN");
    expect(out).toContain("—");
  });
});

describe("compareRunFlags", () => {
  const withFlags = (flags) => ({ meta: { flags }, profiles: {} });

  it("passes when both sides were scoped identically", () => {
    const f = { levelLimit: 8, navDiag: true, anomalyScan: true };
    expect(compareRunFlags(withFlags(f), withFlags({ ...f }))).toEqual({ comparable: true, mismatches: [] });
  });

  it("catches the navDiag asymmetry that made a detector look newly-introduced", () => {
    // The real incident: the candidate ran with navDiag on and the baseline
    // without, so an entire detector class appeared to be a new regression when
    // it had simply never been enabled before.
    const r = compareRunFlags(withFlags({ navDiag: false }), withFlags({ navDiag: true }));
    expect(r.comparable).toBe(true);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toContain("navDiag");
  });

  it("catches a differing sample size", () => {
    expect(compareRunFlags(withFlags({ attemptCap: 20 }), withFlags({ attemptCap: 60 })).mismatches).toHaveLength(1);
  });

  it("reports not-comparable rather than mismatched when a side predates flag recording", () => {
    expect(compareRunFlags({ meta: {} }, withFlags({ navDiag: true }))).toEqual({ comparable: false, mismatches: [] });
  });
});

describe("diffAnomalies", () => {
  const combo = (summary) => ({ anomalySummary: summary, failureReasons: [], levels: [] });

  it("compares the decision-normalized figure, not ticks per run", () => {
    // Same ticks/run on both sides, but the candidate spent far fewer
    // decisions getting there — that is a real improvement and must show.
    const base = combo({ oscillation: { ticksPerRun: 500, ticksPerKiloDecision: 100, findingsPerRun: 10 } });
    const cand = combo({ oscillation: { ticksPerRun: 500, ticksPerKiloDecision: 50, findingsPerRun: 10 } });
    const [row] = diffAnomalies(base, cand);
    expect(row.type).toBe("oscillation");
    expect(row.relDelta).toBeCloseTo(-0.5);
  });

  it("keeps findings/run alongside so a divergence from ticks stays visible", () => {
    // The exact trap from the reverted first attempt: fewer ticks but more
    // findings. Reporting only one of the two hides it.
    const base = combo({ oscillation: { ticksPerKiloDecision: 100, findingsPerRun: 8 } });
    const cand = combo({ oscillation: { ticksPerKiloDecision: 80, findingsPerRun: 12 } });
    const [row] = diffAnomalies(base, cand);
    expect(row.relDelta).toBeCloseTo(-0.2);
    expect(row.baseFindingsPerRun).toBe(8);
    expect(row.candFindingsPerRun).toBe(12);
  });

  it("covers a type present on only one side", () => {
    const rows = diffAnomalies(combo({ stall: { ticksPerKiloDecision: 10 } }), combo({ oscillation: { ticksPerKiloDecision: 5 } }));
    expect(rows.map((r) => r.type)).toEqual(["oscillation", "stall"]);
    expect(rows.find((r) => r.type === "stall").candTicksPerRun).toBe(0);
  });

  it("returns nothing when neither side ran the anomaly scan", () => {
    expect(diffAnomalies({}, {})).toEqual([]);
    expect(diffAnomalies(undefined, undefined)).toEqual([]);
  });
});

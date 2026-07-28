// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Baseline-vs-candidate comparison for `run-balancing-telemetry.mjs` output.
 *
 * Every runtime number in `balancing_telemetry.json` is measured *through* the
 * playtest bot, so any change to how the bot moves or fights moves all of them.
 * That makes "did this bot change help?" a question nobody could answer by
 * reading one telemetry file — you need two, and you need to know which
 * differences are the intended win and which are collateral damage.
 *
 * This module splits those into two kinds of metric, because they need
 * different amounts of evidence:
 *
 * - **Guard metrics** — `qualifyRate` and the per-level survival curve. These
 *   answer "did the bot get worse at staying alive". They are attempt-level, so
 *   a 20-attempt run gives n=20 and only detects large swings. That is enough:
 *   the regression this exists to catch (`bot.mjs`'s `diagonalStrafeKey` A/B,
 *   which took Casual/normal's level-2 death rate from 0% to 72%) is enormous.
 *   Small guard movements are *not* readable at this sample size and must not
 *   be reported as if they were.
 * - **Win metrics** — `enemyAccuracy`, `levelTimeSec` and friends. These are
 *   per-level-visit aggregates over hundreds of samples per run and do have
 *   real resolution.
 *
 * The other thing this module exists to make routine: the survival curve is
 * *conditional*. Raw death counts per level are misleading because a level
 * nobody reaches has no deaths. `died[i] / reached[i]` is the number that
 * actually compares across two runs with different reach.
 *
 * Pure functions only — no fs, no process, no network. The CLI wrapper is
 * `scripts/report-balancing-ab.mjs`; the tests are `abReport.test.mjs`.
 */

/**
 * Read the single value out of a `spread(nums, kind)` object.
 *
 * `spread` emits `{ [kind]: value, samples }` with exactly one of
 * `mean`/`max`/`min` present, so a reader that doesn't already know the kind
 * has to probe. Returns `null` for anything that isn't a spread object, which
 * is how a metric missing from an older telemetry file degrades to "not
 * comparable" instead of throwing mid-report.
 */
export function spreadValue(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const kind of ["mean", "max", "min"]) {
    if (typeof obj[kind] === "number") return obj[kind];
  }
  return null;
}

/** Follow a dotted path, returning `undefined` rather than throwing on a gap. */
function at(obj, path) {
  return path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/**
 * Per-level reach/death/stuck counts for one profile×difficulty combo.
 *
 * `reached[i]` combines both populations, which is the only way to get it:
 * failing attempts are enumerated in `failureReasons` with the level index they
 * died on (so a failure at level `j` reached every level up to `j`), while
 * qualifying runs are not listed there at all and have to be counted from the
 * per-level `runtime.sampleCount` they contributed a snapshot to.
 *
 * A failure with a null `diedAtLevelIndex` (a campaign-level stall, or an
 * `attemptCrashed` before any level resolved) can't be attributed to a level
 * and is surfaced separately as `unattributedFailures` rather than silently
 * dropped — a rising count there is its own signal.
 *
 * **`died`/`stuck` are only complete below the qualify bar.** `isQualifying` is
 * `reachedExitForLevel[QUALIFY_LEVEL_INDEX]` (level index 3), so a run that
 * clears level 4 and *then* dies on level 6 is a qualifying run: it never
 * enters `failureReasons`, and its death is invisible here. `reached` has no
 * such gap — it is built from both populations — which is why
 * `attritionRate` (the fraction of runs that got to a level and no further)
 * exists alongside `conditionalDeathRate` and is the guard that actually
 * covers the whole campaign. Read `conditionalDeathRate` for the died-vs-stuck
 * split it uniquely gives, but never as a complete death rate above level 4.
 */
export function computeSurvivalCurve(combo) {
  const failures = Array.isArray(combo?.failureReasons) ? combo.failureReasons : [];
  const levelCount = Array.isArray(combo?.levels) ? combo.levels.length : 0;

  const levels = [];
  for (let i = 0; i < levelCount; i++) {
    const qualifyingReached = combo.levels[i]?.runtime?.sampleCount ?? 0;
    let reached = qualifyingReached;
    let died = 0;
    let stuck = 0;
    let crashed = 0;
    for (const f of failures) {
      if (typeof f.diedAtLevelIndex !== "number") continue;
      if (f.diedAtLevelIndex >= i) reached += 1;
      if (f.diedAtLevelIndex !== i) continue;
      if (typeof f.reason === "string" && f.reason.startsWith("attemptCrashed")) crashed += 1;
      else if (f.reason === "stuck") stuck += 1;
      else died += 1;
    }
    levels.push({
      levelIndex: i,
      reached,
      died,
      stuck,
      crashed,
      // Null, not 0, when nothing reached the level: "no deaths out of no
      // attempts" is not a 0% death rate, and averaging it in as one would
      // quietly flatter a candidate that stopped getting this far at all.
      conditionalDeathRate: reached > 0 ? died / reached : null,
      conditionalStuckRate: reached > 0 ? stuck / reached : null,
      // Filled in below — it needs the next level's `reached`.
      attritionRate: null,
    });
  }

  // Fraction of runs that reached a level and got no further, from the reach
  // curve alone. Unlike `conditionalDeathRate` this counts qualifying runs'
  // deaths too, so it is the one survival signal that stays honest above the
  // qualify bar. Null on the last level: reaching the final level and clearing
  // it is not attrition, and there is no `reached[i + 1]` to compare against.
  for (let i = 0; i < levels.length - 1; i++) {
    const here = levels[i].reached;
    if (here > 0) levels[i].attritionRate = (here - levels[i + 1].reached) / here;
  }

  const attemptsUsed = combo?.attemptsUsed ?? 0;
  return {
    attemptsUsed,
    // `trueQualifyingCount`, never `qualifyingRunCount` — the latter is floored
    // at the sample-size trim and would report a hard ceiling as a plateau.
    trueQualifyingCount: combo?.trueQualifyingCount ?? 0,
    qualifyRate: attemptsUsed > 0 ? (combo?.trueQualifyingCount ?? 0) / attemptsUsed : null,
    unattributedFailures: failures.filter((f) => typeof f.diedAtLevelIndex !== "number").length,
    levels,
  };
}

/**
 * The campaign-wide numbers worth putting side by side, and which direction
 * counts as an improvement.
 *
 * `better` is not decoration — it is what stops a reader from congratulating
 * themselves on a metric that moved the wrong way. `"flat"` marks metrics with
 * no good direction, where any large move is worth explaining either way.
 */
export const WIN_METRICS = [
  { key: "enemyAccuracy", path: "aiEffectivenessDanger.enemyAccuracy", better: "down" },
  { key: "levelTimeSec", path: "combatPacing.levelTimeSec", better: "down" },
  { key: "distanceTraveled", path: "navigationMapFlow.distanceTraveled", better: "flat" },
  { key: "routeEfficiency", path: "navigationMapFlow.routeEfficiencyScore", better: "up" },
  { key: "ttkNormal", path: "combatPacing.avgTtkByCategory.normal", better: "down" },
  { key: "minHealthReached", path: "aiEffectivenessDanger.minHealthReached", better: "up" },
  { key: "timeBelow25PctHp", path: "aiEffectivenessDanger.timeBelow25PctHealthSec", better: "down" },
  { key: "combatVsExploration", path: "combatPacing.combatVsExplorationRatio", better: "flat" },
  { key: "peakAggroed", path: "combatPacing.peakSimultaneousAggroed", better: "flat" },
];

/**
 * Damage sources read straight off `damageBySource` (plain numbers, not
 * spreads). `hazard`/`trapSpike` are guard-shaped rather than win-shaped: a
 * combat change that moves them at all means a dodge or strafe is walking the
 * bot into terrain, which is the failure mode the safety gates exist to stop.
 */
export const DAMAGE_METRICS = [
  { key: "dmg.enemyRanged", source: "enemyRanged", better: "down" },
  // Derived in `collectMetrics`, not read from `damageBySource` — listed here
  // so it appears in the report and diff alongside the raw figure.
  { key: "dmg.enemyRangedPerSec", source: null, better: "down" },
  { key: "dmg.enemyMelee", source: "enemyMelee", better: "down" },
  { key: "dmg.hazard", source: "hazard", better: "down" },
  { key: "dmg.trapSpike", source: "trapSpike", better: "down" },
];

/** Pull every comparable scalar out of one combo's `campaignAggregate`. */
export function collectMetrics(combo) {
  const agg = combo?.campaignAggregate;
  const out = {};
  for (const m of WIN_METRICS) out[m.key] = spreadValue(at(agg, m.path));
  const dmg = at(agg, "damageHealingBreakdown.damageBySource");
  for (const m of DAMAGE_METRICS) {
    if (m.source === null) continue; // derived below
    const v = dmg?.[m.source];
    out[m.key] = typeof v === "number" ? v : null;
  }
  // Ranged damage per second of level time.
  //
  // Raw `dmg.enemyRanged` is the most reliably-moving stat for a change that
  // makes the bot a harder target — but it also falls simply because a faster
  // bot spends less time being shot at, which is a different achievement.
  // Dividing by level time separates "harder to hit" from "exposed for less
  // time"; only the first is evidence that an evasion change worked.
  //
  // It is also the better instrument than `enemyAccuracy` for this, because
  // accuracy's denominator (bolts *fired*) shifts with exposure too, so both
  // its numerator and denominator move together and it under-reports.
  const lt = out.levelTimeSec;
  out["dmg.enemyRangedPerSec"] = lt && out["dmg.enemyRanged"] !== null ? out["dmg.enemyRanged"] / lt : null;
  return out;
}

/** Relative change, guarding the divide-by-zero and missing-metric cases. */
function relDelta(base, cand) {
  if (base === null || cand === null || base === undefined || cand === undefined) return null;
  if (base === 0) return cand === 0 ? 0 : null;
  return (cand - base) / Math.abs(base);
}

/**
 * Absolute floors below which a *relative* change on a metric is meaningless.
 *
 * Learned the hard way on Stage 1: `dmg.trapSpike` read "+66.3%" and looked
 * like a real regression, but the underlying move was 0.363 -> 0.605 damage
 * per level visit on a 100 HP bar — about half a percent of one health bar,
 * and it reversed to -2.7% at a larger sample. A percentage on a near-zero
 * base is pure noise amplification, and a threshold expressed only in percent
 * will fire on it forever.
 *
 * Keyed by metric; anything absent has no floor (its magnitudes are large
 * enough that the ratio means something on its own).
 */
export const RELATIVE_CHANGE_FLOORS = {
  "dmg.trapSpike": 5,
  "dmg.hazard": 5,
  "dmg.enemyMelee": 5,
  timeBelow25PctHp: 1,
};

/**
 * Whether a metric's relative change is large enough in *absolute* terms to be
 * worth reading at all. Returns false when both sides sit under the floor —
 * the ratio is then reported but explicitly marked as noise rather than
 * silently presented next to metrics that do carry signal.
 */
export function relChangeIsMeaningful(key, base, cand) {
  const floor = RELATIVE_CHANGE_FLOORS[key];
  if (floor === undefined) return true;
  if (base === null || cand === null || base === undefined || cand === undefined) return true;
  return Math.max(Math.abs(base), Math.abs(cand)) >= floor;
}

/**
 * Compare one combo across two telemetry files.
 *
 * Returns guards and metrics separately because they carry different weight:
 * a guard breach means revert the change, a metric move means the change did or
 * didn't do its job. Never collapse the two into one score.
 */
export function diffCombo(baseCombo, candCombo) {
  const baseCurve = computeSurvivalCurve(baseCombo);
  const candCurve = computeSurvivalCurve(candCombo);
  const baseMetrics = collectMetrics(baseCombo);
  const candMetrics = collectMetrics(candCombo);

  const metrics = [...WIN_METRICS, ...DAMAGE_METRICS].map((m) => ({
    key: m.key,
    better: m.better,
    base: baseMetrics[m.key],
    cand: candMetrics[m.key],
    relDelta: relDelta(baseMetrics[m.key], candMetrics[m.key]),
    meaningful: relChangeIsMeaningful(m.key, baseMetrics[m.key], candMetrics[m.key]),
  }));

  const levelCount = Math.max(baseCurve.levels.length, candCurve.levels.length);
  const levels = [];
  for (let i = 0; i < levelCount; i++) {
    const b = baseCurve.levels[i];
    const c = candCurve.levels[i];
    levels.push({
      levelIndex: i,
      baseReached: b?.reached ?? 0,
      candReached: c?.reached ?? 0,
      baseDeathRate: b?.conditionalDeathRate ?? null,
      candDeathRate: c?.conditionalDeathRate ?? null,
      // Percentage *points*, not percent — a death rate going 0.10 -> 0.30 is
      // +20pp, and calling that "+200%" is how a 20pp threshold gets misread.
      deathRateDeltaPp:
        b?.conditionalDeathRate === null || b?.conditionalDeathRate === undefined || c?.conditionalDeathRate === null || c?.conditionalDeathRate === undefined
          ? null
          : (c.conditionalDeathRate - b.conditionalDeathRate) * 100,
      baseAttrition: b?.attritionRate ?? null,
      candAttrition: c?.attritionRate ?? null,
      attritionDeltaPp:
        b?.attritionRate === null || b?.attritionRate === undefined || c?.attritionRate === null || c?.attritionRate === undefined
          ? null
          : (c.attritionRate - b.attritionRate) * 100,
      baseStuck: b?.stuck ?? 0,
      candStuck: c?.stuck ?? 0,
    });
  }

  return {
    guards: {
      baseQualifyRate: baseCurve.qualifyRate,
      candQualifyRate: candCurve.qualifyRate,
      qualifyRateDeltaPp:
        baseCurve.qualifyRate === null || candCurve.qualifyRate === null ? null : (candCurve.qualifyRate - baseCurve.qualifyRate) * 100,
      baseAttempts: baseCurve.attemptsUsed,
      candAttempts: candCurve.attemptsUsed,
      baseUnattributed: baseCurve.unattributedFailures,
      candUnattributed: candCurve.unattributedFailures,
    },
    levels,
    metrics,
  };
}

/**
 * Pre-registered rollback thresholds, from the plan's shared A/B protocol.
 *
 * Deliberately coarse and deliberately fixed in code rather than chosen after
 * seeing the numbers — a threshold picked once the result is known is not a
 * threshold. `stuckIncreaseTrips` has no tolerance at all because a stuck bot
 * is a navigation bug, not a balance outcome, and one is already too many.
 */
export const ROLLBACK_THRESHOLDS = {
  qualifyRateDropPp: 15,
  deathRateRisePp: 20,
  // Same tolerance as the death rate, on the metric that doesn't go blind
  // above the qualify bar. Both are checked: the death rate is the sharper
  // signal where it applies, attrition is the one that applies everywhere.
  attritionRisePp: 20,
  stuckIncreaseTrips: true,
};

/**
 * Evaluate one combo's diff against the thresholds. Returns the list of
 * breaches — empty means the stage passed its guards. Says nothing about
 * whether the stage achieved its *win*; that is the caller's judgement against
 * the stage's own stated metric.
 */
export function checkRollback(diff, thresholds = ROLLBACK_THRESHOLDS) {
  const breaches = [];
  const q = diff.guards.qualifyRateDeltaPp;
  if (q !== null && q < -thresholds.qualifyRateDropPp) {
    breaches.push(`qualifyRate fell ${(-q).toFixed(1)}pp (limit ${thresholds.qualifyRateDropPp}pp)`);
  }
  for (const l of diff.levels) {
    if (l.deathRateDeltaPp !== null && l.deathRateDeltaPp > thresholds.deathRateRisePp) {
      breaches.push(`L${l.levelIndex + 1} conditional death rate rose ${l.deathRateDeltaPp.toFixed(1)}pp (limit ${thresholds.deathRateRisePp}pp)`);
    }
    if (thresholds.attritionRisePp !== undefined && l.attritionDeltaPp !== null && l.attritionDeltaPp > thresholds.attritionRisePp) {
      breaches.push(`L${l.levelIndex + 1} attrition rose ${l.attritionDeltaPp.toFixed(1)}pp (limit ${thresholds.attritionRisePp}pp)`);
    }
    if (thresholds.stuckIncreaseTrips && l.candStuck > l.baseStuck) {
      breaches.push(`L${l.levelIndex + 1} stuck count rose ${l.baseStuck} -> ${l.candStuck}`);
    }
  }
  return breaches;
}

function fmt(n, digits = 3) {
  return n === null || n === undefined ? "  —" : n.toFixed(digits);
}

function pct(n) {
  return n === null || n === undefined ? "     —" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}

/** Percentage *points*, already scaled by the caller. Kept distinct from
 * `pct` because conflating the two is exactly how a "+20pp" threshold gets
 * misread as "+20%". */
function pp(n) {
  return n === null || n === undefined ? "(—)" : `(${n >= 0 ? "+" : ""}${n.toFixed(1)}pp)`;
}

/** Render one combo's diff as a plain-text block for terminal output. */
export function formatComboDiff(label, diff, thresholds = ROLLBACK_THRESHOLDS) {
  const lines = [];
  lines.push(`=== ${label} ===`);
  const g = diff.guards;
  lines.push(
    `  qualifyRate  ${fmt(g.baseQualifyRate)} -> ${fmt(g.candQualifyRate)}  ` +
      `(${g.qualifyRateDeltaPp === null ? "—" : `${g.qualifyRateDeltaPp >= 0 ? "+" : ""}${g.qualifyRateDeltaPp.toFixed(1)}pp`})  ` +
      `attempts ${g.baseAttempts} -> ${g.candAttempts}`,
  );
  if (g.baseUnattributed || g.candUnattributed) {
    lines.push(`  unattributed failures  ${g.baseUnattributed} -> ${g.candUnattributed}`);
  }
  lines.push("  level    reached          deathRate                attrition             stuck");
  for (const l of diff.levels) {
    lines.push(
      `  L${String(l.levelIndex + 1).padEnd(4)} ${String(l.baseReached).padStart(4)} -> ${String(l.candReached).padStart(4)}   ` +
        `${fmt(l.baseDeathRate)} -> ${fmt(l.candDeathRate)} ${pp(l.deathRateDeltaPp).padEnd(10)}` +
        `${fmt(l.baseAttrition)} -> ${fmt(l.candAttrition)} ${pp(l.attritionDeltaPp).padEnd(10)}` +
        `  ${l.baseStuck} -> ${l.candStuck}`,
    );
  }
  lines.push("  metric                  base       cand     change   want");
  for (const m of diff.metrics) {
    // A relative change on a metric whose absolute magnitude is tiny is noise
    // amplification, not signal — say so inline rather than letting it sit
    // unqualified next to changes that mean something.
    const note = m.meaningful ? m.better : `${m.better} (too small to read)`;
    lines.push(`  ${m.key.padEnd(22)} ${fmt(m.base, 3).padStart(8)} ${fmt(m.cand, 3).padStart(10)} ${pct(m.relDelta).padStart(9)}   ${note}`);
  }
  const breaches = checkRollback(diff, thresholds);
  if (breaches.length === 0) {
    lines.push("  GUARDS: pass");
  } else {
    lines.push("  GUARDS: BREACHED — revert this stage, do not tune it forward");
    for (const b of breaches) lines.push(`    - ${b}`);
  }
  return lines.join("\n");
}

/**
 * Walk both telemetry files' `profiles[name][difficulty]` trees and diff every
 * combo present in both. Combos present in only one side are reported by name
 * rather than skipped silently — an A/B that quietly compared four combos when
 * the operator thought it compared six is worse than one that errors.
 */
export function diffTelemetry(baseJson, candJson) {
  const combos = [];
  const missing = [];
  const profileNames = Object.keys(baseJson?.profiles ?? {});
  for (const profileName of profileNames) {
    const baseProfile = baseJson.profiles[profileName];
    const candProfile = candJson?.profiles?.[profileName];
    for (const difficulty of Object.keys(baseProfile)) {
      // `crossDifficultyFlags` sits alongside the difficulty keys in the same
      // object — it is an array of flag strings, not a combo.
      if (difficulty === "crossDifficultyFlags") continue;
      const label = `${profileName}/${difficulty}`;
      if (!candProfile?.[difficulty]) {
        missing.push(label);
        continue;
      }
      combos.push({ label, diff: diffCombo(baseProfile[difficulty], candProfile[difficulty]) });
    }
  }
  return { combos, missing };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Grades the skill ladder: are Casual/Gamer/Pro actually distinguishable?
 *
 * `abReport.mjs` compares two *sides* of one change. This compares the three
 * *profiles* within one capture, which is a different question and the one
 * that decides whether per-tier balance conclusions mean anything at all.
 *
 * Reuses `collectMetrics` and `spreadValue` from `abReport.mjs` unchanged, so
 * a metric only has to be defined once and both reports see the same numbers.
 *
 * ## Why the targets look the way they do
 *
 * Measured at n=40/profile on 2026-08-01 (difficulty=normal), before any of
 * this work:
 *
 *   enemyAccuracy          0.499 / 0.556 / 0.531   NOT monotonic
 *   dmg.enemyRangedPerSec  0.354 / 0.430 / 0.439   NOT monotonic — Pro is the
 *                                                  *most* hittable per second
 *   ttkNormal              1.114 / 0.877 / 0.755   monotonic, 1.476x
 *   levelTimeSec           75.9  / 67.2  / 62.1    monotonic, 1.221x
 *   distanceTraveled       305.8 / 310.8 / 307.3   flat, 1.016x
 *   routeFollowOverhead    1.908 / 1.939 / 1.918   flat, 1.016x
 *
 * i.e. both *pace* axes were fine and both *damage-avoidance* axes were
 * inverted — the tiers differed in how fast they played, not in how well.
 * The targets below are set against those measurements rather than picked:
 * the two inverted axes have to become monotonic at all, and the two working
 * ones must not regress below what they already achieved.
 *
 * The flat axes are held flat deliberately. Navigation is shortest-route-to-
 * exit for every tier by design, so a profile that starts walking noticeably
 * further is not "more casual", it is a different navigation policy — the
 * mistake the old `coverageMode` flag made.
 */
import { collectMetrics } from "./abReport.mjs";

/** Weakest → strongest. `curateMixedProfiles` depends on this order too. */
export const LADDER = ["Casual", "Gamer", "Pro"];

/**
 * `minStep` bounds the *smallest adjacent pair*, not the whole ladder.
 *
 * That distinction is the whole point. A whole-ladder max/min ratio can look
 * healthy while the middle step is unreadable — and the middle step is
 * exactly what fails today: Gamer↔Pro on `ttkNormal` flipped run-to-run
 * across four n=5 scans while Casual stayed cleanly separated from both. A
 * bar that cannot fail on that is measuring the wrong thing.
 *
 * Baselines (n=40) for the two axes that already work, as the smallest
 * adjacent ratio: `ttkNormal` 1.162 (1.270 then 1.162), `levelTimeSec` 1.081
 * (1.129 then 1.081). Their bars sit just under those so the axes cannot
 * regress, without demanding an improvement this stage isn't trying to make.
 */
export const SEPARATION_TARGETS = [
  { key: "enemyAccuracy", better: "down", minStep: 1.05, note: "inverted at baseline — the headline fix" },
  { key: "dmg.enemyRangedPerSec", better: "down", minStep: 1.05, note: "inverted at baseline" },
  { key: "ttkNormal", better: "down", minStep: 1.15, note: "baseline smallest step 1.162 — must not regress" },
  { key: "levelTimeSec", better: "down", minStep: 1.07, note: "baseline smallest step 1.081 — must not regress" },
];

/** Axes a skill tier must NOT move: profiles are not navigation policies. */
export const FLAT_TARGETS = [
  { key: "distanceTraveled", maxSpread: 1.05 },
  { key: "routeFollowOverhead", maxSpread: 1.05 },
];

/** Pull one scalar out of `collectMetrics`' output, which mixes plain numbers
 * and `{mean, samples}` spreads depending on the metric. */
export function scalar(metrics, key) {
  const v = metrics?.[key];
  const n = typeof v === "object" && v !== null ? v.mean : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * `values` are ladder-ordered. "down" means a more skilled tier has a smaller
 * number, so the sequence must be strictly decreasing.
 */
export function gradeAxis(values, better) {
  if (values.some((v) => v === null)) return { ok: false, reason: "missing", monotonic: false, spread: null, measuredStep: null };
  const strictlyDown = values.every((v, i) => i === 0 || v < values[i - 1]);
  const strictlyUp = values.every((v, i) => i === 0 || v > values[i - 1]);
  const monotonic = better === "down" ? strictlyDown : strictlyUp;
  const spread = Math.max(...values) / Math.min(...values);
  // Every adjacent step, as a ratio >= 1 whichever way the axis runs.
  const steps = values.slice(1).map((v, i) => (better === "down" ? values[i] / v : v / values[i]));
  return { monotonic, spread, measuredStep: Math.min(...steps), ok: monotonic };
}

/**
 * Grade a whole capture. `byProfile` maps profile name → the combo object
 * (`json.profiles[name][difficulty]`), which is what `collectMetrics` takes.
 */
export function gradeSeparation(byProfile, { targets = SEPARATION_TARGETS, flat = FLAT_TARGETS } = {}) {
  const metrics = Object.fromEntries(LADDER.map((name) => [name, byProfile[name] ? collectMetrics(byProfile[name]) : null]));
  const missing = LADDER.filter((name) => !metrics[name]);

  const axes = targets.map((t) => {
    const values = LADDER.map((name) => (metrics[name] ? scalar(metrics[name], t.key) : null));
    const graded = gradeAxis(values, t.better);
    const meetsStep = graded.measuredStep !== null && graded.measuredStep >= t.minStep;
    return { ...t, values, ...graded, meetsStep, pass: graded.monotonic && meetsStep };
  });

  const flatAxes = flat.map((t) => {
    const values = LADDER.map((name) => (metrics[name] ? scalar(metrics[name], t.key) : null));
    const spread = values.some((v) => v === null) ? null : Math.max(...values) / Math.min(...values);
    return { ...t, values, spread, pass: spread !== null && spread <= t.maxSpread };
  });

  return { missing, axes, flatAxes, pass: missing.length === 0 && axes.every((a) => a.pass) && flatAxes.every((a) => a.pass) };
}

const fmt = (v) => (v === null ? "     —" : Math.abs(v) >= 100 ? v.toFixed(1).padStart(6) : v.toFixed(3).padStart(6));

/** Human-readable report. Returns lines; the CLI decides how to print them. */
export function formatSeparation(result) {
  const out = [];
  if (result.missing.length > 0) out.push(`MISSING PROFILES: ${result.missing.join(", ")} — cannot grade the ladder`);
  out.push(`axis                     ${LADDER.map((n) => n.padStart(7)).join("")}  smallest step   want     verdict`);
  for (const a of result.axes) {
    out.push(
      `${a.key.padEnd(24)} ${a.values.map(fmt).join(" ")}      ` +
        `${(a.measuredStep ?? 0).toFixed(3)}x  >=${a.minStep}x  ` +
        `${a.pass ? "pass" : a.monotonic ? "TOO CLOSE" : "NOT MONOTONIC"}`,
    );
  }
  out.push("");
  out.push("must stay flat (profiles are skill tiers, not navigation policies):");
  for (const a of result.flatAxes) {
    out.push(`${a.key.padEnd(24)} ${a.values.map(fmt).join(" ")}   ${(a.spread ?? 0).toFixed(3)}x  <=${a.maxSpread}x  ${a.pass ? "pass" : "MOVED"}`);
  }
  out.push("");
  out.push(result.pass ? "LADDER: pass" : "LADDER: FAIL — the tiers are not cleanly ordered");
  return out;
}

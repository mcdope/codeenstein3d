// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Perf-audit report generator (`npm run perf:report`).
 *
 * Reads one or more `perf_runs/<timestamp>/` directories produced by
 * `scripts/run-perf-benchmark.mjs` and renders a single self-contained
 * `perf-report.html` at the repo root: frame-interval distributions,
 * busy-time spread, phase breakdowns, A/B comparisons, heap growth, and
 * (optionally) a ranked static-audit findings list.
 *
 * Zero runtime dependencies (Node 18 built-ins only) and zero external
 * requests in the output — every chart is hand-rolled inline SVG, every
 * style is inlined, and the page needs no JS to render (a couple of
 * native SVG <title> tooltips are the only interactivity).
 *
 * Design notes (see the `dataviz` skill this was built against):
 *  - Color is assigned by JOB, never eyeballed: cell identity and phase
 *    identity each get the documented 8-hue categorical order (never
 *    cycled); busy/impact severity uses the fixed status palette.
 *  - Charts over tables per project convention, but every chart still
 *    ships a same-page <details> table twin for the WCAG-clean read.
 *  - Runs that lack a field the newer schema added (busyPerFrame,
 *    rawBusyMs, phaseTotals — all absent in the very first calibration
 *    captures) fall back to the sparser `perfLog` console-scrape numbers
 *    instead of crashing; see `pickBusy()`/`pickPhaseMeans()`.
 *
 * Usage:
 *   node scripts/build-perf-report.mjs perf_runs/<dir> [more dirs...] [--findings path.json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "perf-report.html");

// ---------------------------------------------------------------------------
// Palette (dataviz skill reference instance — categorical order is the
// CVD-safety mechanism, never re-ordered per chart).
// ---------------------------------------------------------------------------

const CATEGORICAL = [
  { light: "#2a78d6", dark: "#3987e5" }, // 1 blue
  { light: "#008300", dark: "#008300" }, // 2 green
  { light: "#e87ba4", dark: "#d55181" }, // 3 magenta
  { light: "#eda100", dark: "#c98500" }, // 4 yellow
  { light: "#1baf7a", dark: "#199e70" }, // 5 aqua
  { light: "#eb6834", dark: "#d95926" }, // 6 orange
  { light: "#4a3aa7", dark: "#9085e9" }, // 7 violet
  { light: "#e34948", dark: "#e66767" }, // 8 red
];
const MUTED_OTHER = { light: "#898781", dark: "#898781" };

const STATUS = {
  good: { light: "#0ca30c", dark: "#0ca30c" },
  warning: { light: "#fab219", dark: "#fab219" },
  serious: { light: "#ec835a", dark: "#ec835a" },
  critical: { light: "#d03b3b", dark: "#d03b3b" },
};

/** Canonical scenario order (matches SCENARIOS registration order in
 * run-perf-benchmark.mjs) — fixes cell→color assignment so the same
 * scenario always wears the same hue across every chart on the page,
 * regardless of which run directories were passed or in what order. */
const SCENARIO_ORDER = [
  "s1-idle",
  "s2-replay",
  "s3-stress",
  "s4-magento",
  "s4-magento-fire",
  "s4-magento-dryfire",
  "s4-magento-mouseflood",
  "s5-bot-demo",
];

/** Fixed phase order = same order the palette was validated against
 * (adjacent-pairlist, all 8 slots, worst ΔE 9.1 light / 8.4 dark). The two
 * near-always-zero input phases are merged into one "input" bucket to fit
 * the 9 raw phases into the 8-slot categorical ceiling instead of cycling
 * a 9th hue (see dataviz anti-patterns: never generate a 9th hue). */
const PHASE_BUCKETS = [
  { key: "input", label: "input", raw: ["input-poll", "input-actions"] },
  { key: "sim", label: "sim", raw: ["sim"] },
  { key: "viewmodel", label: "viewmodel", raw: ["viewmodel"] },
  { key: "raycast-walls", label: "raycast-walls", raw: ["raycast-walls"] },
  { key: "billboards+targeting", label: "billboards+targeting", raw: ["billboards+targeting"] },
  { key: "firing", label: "firing", raw: ["firing"] },
  { key: "particle-effects", label: "particle-effects", raw: ["particle-effects"] },
  { key: "hud", label: "hud", raw: ["hud"] },
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const fmt = (n, opts = {}) => (Number.isFinite(n) ? n.toLocaleString("en-US", opts) : "n/a");
const fmtMs = (n) => (Number.isFinite(n) ? `${fmt(n, { maximumFractionDigits: 2 })}ms` : "n/a");
const fmtPct = (n) => (Number.isFinite(n) ? `${fmt(n, { maximumFractionDigits: 1 })}%` : "n/a");

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Nearest-rank percentile over an already-sorted ascending array — same
 * semantics as scripts/lib/perfConsoleParse.mjs's percentileSorted, kept
 * as an independent copy so this report has zero coupling to bench-harness
 * internals and never breaks if that file's shape changes. */
function percentile(sorted, pct) {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function quantiles(values) {
  if (!values || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Round a value up to a "nice" axis maximum (1/2/5 × 10^k). */
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

function colorFor(index) {
  return index >= 0 && index < CATEGORICAL.length ? CATEGORICAL[index] : MUTED_OTHER;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const dirs = [];
  let findingsPath = null;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--findings") findingsPath = argv[(i += 1)];
    else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else dirs.push(arg);
  }
  if (!dirs.length) throw new Error("usage: node scripts/build-perf-report.mjs <perf_runs/DIR> [more dirs...] [--findings path.json]");
  return { dirs, findingsPath };
}

/** Loads every `*.run<N>.json` in a directory (skips manifest.json /
 * calibration.json) plus calibration.json if present. Never throws on a
 * malformed individual run file — it's logged and skipped so one bad
 * capture doesn't sink the whole report. */
function loadRunDir(dir) {
  const abs = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(abs)) throw new Error(`run directory not found: ${abs}`);
  const files = fs.readdirSync(abs).filter((f) => /\.run\d+\.json$/.test(f));
  const runs = [];
  for (const f of files) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(abs, f), "utf8")));
    } catch (err) {
      console.error(`[perf:report] skipping unreadable run file ${path.join(dir, f)}: ${err.message}`);
    }
  }
  let calibration = null;
  const calPath = path.join(abs, "calibration.json");
  if (fs.existsSync(calPath)) {
    try {
      calibration = JSON.parse(fs.readFileSync(calPath, "utf8"));
    } catch (err) {
      console.error(`[perf:report] skipping unreadable calibration.json in ${dir}: ${err.message}`);
    }
  }
  return { runs, calibration };
}

function loadFindings(findingsPath) {
  if (!findingsPath) return null;
  const abs = path.resolve(process.cwd(), findingsPath);
  if (!fs.existsSync(abs)) {
    console.error(`[perf:report] --findings ${findingsPath} not found — rendering findings-pending placeholder`);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(abs, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error(`[perf:report] --findings ${findingsPath} is not valid JSON (${err.message}) — rendering placeholder`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grouping & per-cell aggregation
// ---------------------------------------------------------------------------

/** Per-run busy-time source, newest-schema first: the per-frame accumulator
 * (`busyPerFrame`/`rawBusyMs`, hundreds of samples) if present, else the
 * sparse `?perfDebug=1` console-scrape (`perfLog.busyMs`, only a couple of
 * samples per run — the very first calibration captures predate the
 * accumulator entirely). Returns {stats, raw, sparse} where `sparse` flags
 * the fallback so charts can caption it. */
function pickBusy(run) {
  if (run.busyPerFrame) return { stats: run.busyPerFrame, raw: run.rawBusyMs ?? null, sparse: false };
  if (run.perfLog?.busyMs) return { stats: run.perfLog.busyMs, raw: null, sparse: true };
  return { stats: null, raw: null, sparse: false };
}

/** Per-run mean phase costs merged into the 8-slot PHASE_BUCKETS, newest
 * schema (`phaseTotals.sum/count`) preferred over the sparse
 * `perfLog.phaseStats.mean` fallback. Returns {means: Map<key, ms>, n}. */
function pickPhaseMeans(run) {
  if (run.phaseTotals) {
    const means = new Map();
    let n = 0;
    for (const bucket of PHASE_BUCKETS) {
      let sum = 0;
      let count = 0;
      for (const raw of bucket.raw) {
        const t = run.phaseTotals[raw];
        if (t) {
          sum += t.sum;
          count += t.count;
        }
      }
      means.set(bucket.key, count ? sum / count : 0);
      n = Math.max(n, count);
    }
    return { means, n };
  }
  if (run.perfLog?.phaseStats) {
    const means = new Map();
    let n = 0;
    for (const bucket of PHASE_BUCKETS) {
      let weightedSum = 0;
      let weight = 0;
      for (const raw of bucket.raw) {
        const s = run.perfLog.phaseStats[raw];
        if (s) {
          weightedSum += s.mean * s.n;
          weight += s.n;
        }
      }
      means.set(bucket.key, weight ? weightedSum / weight : 0);
      n = Math.max(n, weight);
    }
    return { means, n };
  }
  return { means: null, n: 0 };
}

/** Last `kind:"level"` meta entry in a run — scenarios that navigate mid-run
 * (S4's small auto-launched level, then the big file it opens) log more than
 * one; the last one is the steady-state level the capture window measured. */
function lastLevelMeta(run) {
  const levels = (run.meta ?? []).filter((e) => e.kind === "level");
  return levels[levels.length - 1] ?? null;
}
function firstEnvMeta(run) {
  return (run.meta ?? []).find((e) => e.kind === "env") ?? null;
}

function scenarioColorIndex(scenario) {
  const idx = SCENARIO_ORDER.indexOf(scenario);
  return idx === -1 ? SCENARIO_ORDER.length : idx;
}

/** Groups all loaded runs by `cell.id` (pooling the same cell across
 * multiple input directories — e.g. a calibration dir's 10 s1-idle runs
 * plus another dir's smoke-test s1-idle run all land in one cell). */
function groupCells(allRuns) {
  const cells = new Map();
  for (const run of allRuns) {
    const id = run.cell?.id;
    if (!id) continue;
    if (!cells.has(id)) cells.set(id, { cell: run.cell, runs: [] });
    cells.get(id).runs.push(run);
  }
  // Stable order: canonical scenario order, then variant (baseline first).
  return [...cells.values()].sort((a, b) => {
    const sa = scenarioColorIndex(a.cell.scenario);
    const sb = scenarioColorIndex(b.cell.scenario);
    if (sa !== sb) return sa - sb;
    if (a.cell.variant !== b.cell.variant) return a.cell.variant === "baseline" ? -1 : 1;
    return a.cell.id.localeCompare(b.cell.id);
  });
}

/** Precomputes every derived number a cell's charts need, once, so chart
 * builders stay pure render functions over plain data. */
function aggregateCell(entry, colorIndex) {
  const { cell, runs } = entry;
  const rawDeltas = runs.flatMap((r) => r.rawDeltas ?? []);
  const busyPicks = runs.map(pickBusy);
  const pooledBusyRaw = busyPicks.some((b) => b.raw) ? busyPicks.flatMap((b) => b.raw ?? []) : [];
  const perRunBusyMedian = busyPicks.map((b) => b.stats?.median).filter(Number.isFinite);
  const anySparseBusy = busyPicks.some((b) => b.sparse) && !pooledBusyRaw.length;

  const phasePicks = runs.map(pickPhaseMeans).filter((p) => p.means);
  const phaseMeans = new Map();
  if (phasePicks.length) {
    for (const bucket of PHASE_BUCKETS) {
      const vals = phasePicks.map((p) => p.means.get(bucket.key) ?? 0);
      phaseMeans.set(bucket.key, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }

  const heapSeries = runs.map((r, i) => ({
    runIndex: r.runIndex ?? i + 1,
    samples: (r.heapSamples ?? []).map((s) => ({ t: s.t, usedMB: s.usedMB })),
  }));

  const lastLevel = runs.map(lastLevelMeta).find(Boolean);
  const env = runs.map(firstEnvMeta).find(Boolean);

  return {
    id: cell.id,
    cell,
    color: colorFor(colorIndex),
    runCount: runs.length,
    rawDeltas,
    intervalQuantiles: quantiles(rawDeltas),
    busy: {
      pooledQuantiles: pooledBusyRaw.length ? quantiles(pooledBusyRaw) : quantiles(perRunBusyMedian),
      usingPooledRaw: pooledBusyRaw.length > 0,
      perRunMedian: perRunBusyMedian,
      sparse: anySparseBusy,
    },
    phaseMeans,
    heapSeries,
    lastLevel,
    env,
  };
}

// ---------------------------------------------------------------------------
// SVG primitives
// ---------------------------------------------------------------------------

function svgOpen(width, height, extraClass = "") {
  return `<svg class="chart-svg ${extraClass}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">`;
}

/** Hairline axis box + Y gridlines with tick labels. Returns the gridline
 * markup only — callers draw their own data marks on top within the same
 * plot rect (px0..px1, py0..py1). */
function axisFrame({ px0, px1, py0, py1, yMax, yTicks = 4, yFmt = (v) => fmt(v) }) {
  let s = `<line x1="${px0}" y1="${py1}" x2="${px1}" y2="${py1}" class="axis-line" />`;
  for (let i = 0; i <= yTicks; i += 1) {
    const v = (yMax * i) / yTicks;
    const y = py1 - (py1 - py0) * (i / yTicks);
    s += `<line x1="${px0}" y1="${y.toFixed(1)}" x2="${px1}" y2="${y.toFixed(1)}" class="gridline" />`;
    s += `<text x="${px0 - 6}" y="${(y + 3).toFixed(1)}" class="tick-label" text-anchor="end">${esc(yFmt(v))}</text>`;
  }
  return s;
}

function legendSwatch(colorVar, label, x, y) {
  return `<g transform="translate(${x},${y})"><rect width="10" height="10" rx="2" fill="${colorVar}" /><text x="14" y="9" class="legend-label">${esc(label)}</text></g>`;
}

// ---------------------------------------------------------------------------
// Section 1 — header, environment, level scale
// ---------------------------------------------------------------------------

function buildHeaderSection(cellAggs, dirs) {
  const env = cellAggs.map((c) => c.env).find(Boolean);
  const envRow = env
    ? `<div class="meta-strip">
        <div class="meta-item"><span class="meta-label">CPU cores</span><span class="meta-value">${esc(env.kv.cores ?? "?")}</span></div>
        <div class="meta-item"><span class="meta-label">Memory</span><span class="meta-value">${esc(env.kv.memGB ?? "?")} GB</span></div>
        <div class="meta-item"><span class="meta-label">Device pixel ratio</span><span class="meta-value">${esc(env.kv.dpr ?? "?")}</span></div>
        <div class="meta-item"><span class="meta-label">Screen</span><span class="meta-value">${esc(env.kv.screen ?? "?")}</span></div>
        <div class="meta-item"><span class="meta-label">Viewport</span><span class="meta-value">${esc(env.kv.viewport ?? "?")}</span></div>
      </div>`
    : `<p class="muted">No environment metadata found in the given run directories.</p>`;

  const levelRows = cellAggs
    .map((c) => {
      const lv = c.lastLevel;
      if (!lv) return `<tr><td>${esc(c.id)}</td><td colspan="5" class="muted">no level metadata</td></tr>`;
      return `<tr><td>${esc(c.id)}</td><td>${esc(lv.kv.map ?? "?")}</td><td>${esc(lv.kv.enemies ?? "0")}</td><td>${esc(lv.kv.elite ?? "0")}</td><td>${esc(lv.kv.edgeCase ?? "0")}</td><td>${esc(lv.kv.mines ?? "0")}</td></tr>`;
    })
    .join("");

  return `
  <header class="report-header">
    <h1>Codeenstein Performance Audit</h1>
    <p class="muted">Generated ${esc(new Date().toISOString())} from ${dirs.length} run director${dirs.length === 1 ? "y" : "ies"}: ${dirs.map((d) => `<code>${esc(d)}</code>`).join(", ")}</p>
    ${envRow}
  </header>
  <section class="section">
    <h2>Level scale per cell</h2>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Cell</th><th>Map</th><th>Enemies</th><th>Elite</th><th>Edge-case</th><th>Mines</th></tr></thead>
        <tbody>${levelRows}</tbody>
      </table>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 2 — frame-interval CDFs (small multiples, one series each — no
// legend needed per marks-and-anatomy's single-series rule).
// ---------------------------------------------------------------------------

/** Empirical-CDF polyline, downsampled to at most `maxPoints` vertices via
 * percentile steps — a pooled cell can carry tens of thousands of raw
 * samples (many runs × ~1800 frames), and plotting one vertex per sample
 * would bloat the self-contained HTML for no visible fidelity gain past a
 * couple hundred points on a chart this size. */
function cdfPoints(sorted, width, height, xMax, maxPoints = 200) {
  if (!sorted.length) return "";
  const steps = Math.min(maxPoints, sorted.length);
  const pts = [`0,${height}`];
  for (let i = 1; i <= steps; i += 1) {
    const pct = (100 * i) / steps;
    const v = percentile(sorted, pct);
    const x = Math.min(width, (v / xMax) * width);
    const y = height - (height * i) / steps;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  pts.push(`${width},0`);
  return pts.join(" ");
}

function buildIntervalCdfCard(agg) {
  const W = 300;
  const H = 170;
  const px0 = 34;
  const px1 = W - 8;
  const py0 = 10;
  const py1 = H - 22;
  const sorted = [...agg.rawDeltas].sort((a, b) => a - b);
  if (!sorted.length) {
    return `<figure class="chart-card"><figcaption>${esc(agg.id)}</figcaption><p class="muted small">no frame-interval samples</p></figure>`;
  }
  const xMax = Math.max(40, niceMax(Math.min(sorted[sorted.length - 1], percentile(sorted, 99.9) * 1.1)));
  const plotW = px1 - px0;
  const plotH = py1 - py0;
  const poly = cdfPoints(sorted, plotW, plotH, xMax);
  const refLine = (ms, label) => {
    const x = px0 + Math.min(plotW, (ms / xMax) * plotW);
    return `<line x1="${x.toFixed(1)}" y1="${py0}" x2="${x.toFixed(1)}" y2="${py1}" class="ref-line" /><text x="${x.toFixed(1)}" y="${py0 - 2}" class="ref-label" text-anchor="middle">${label}</text>`;
  };
  let xAxis = "";
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const v = xMax * frac;
    const x = px0 + plotW * frac;
    xAxis += `<text x="${x.toFixed(1)}" y="${H - 6}" class="tick-label" text-anchor="middle">${fmt(v, { maximumFractionDigits: 0 })}</text>`;
  }
  return `<figure class="chart-card">
    <figcaption>${esc(agg.id)} <span class="muted small">(${fmt(agg.runCount)} run${agg.runCount === 1 ? "" : "s"}, n=${fmt(sorted.length)})</span></figcaption>
    ${svgOpen(W, H)}
      <g transform="translate(${px0},${py0})">
        ${axisFrame({ px0: 0, px1: plotW, py0: 0, py1: plotH, yMax: 100, yTicks: 4, yFmt: (v) => `${fmt(v, { maximumFractionDigits: 0 })}%` })}
        ${refLine(16.7, "16.7")}
        ${refLine(33.4, "33.4")}
        <polyline points="${poly}" class="cdf-line" style="stroke:var(--cell-${cssIdx(agg)})" />
      </g>
      ${xAxis}
      <text x="${(px0 + px1) / 2}" y="${H - 0}" class="axis-title" text-anchor="middle">frame interval (ms)</text>
    </svg>
    <p class="stat-line muted small">median ${fmtMs(agg.intervalQuantiles.median)} · p95 ${fmtMs(agg.intervalQuantiles.p95)} · p99 ${fmtMs(agg.intervalQuantiles.p99)}</p>
  </figure>`;
}

function cssIdx(agg) {
  const idx = CATEGORICAL.findIndex((c) => c === agg.color);
  return idx === -1 ? "other" : idx + 1;
}

function buildIntervalSection(cellAggs) {
  const cards = cellAggs.map(buildIntervalCdfCard).join("\n");
  const tableRows = cellAggs
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td>${fmtMs(a.intervalQuantiles?.median)}</td><td>${fmtMs(a.intervalQuantiles?.p95)}</td><td>${fmtMs(a.intervalQuantiles?.p99)}</td><td>${fmtMs(a.intervalQuantiles?.max)}</td></tr>`,
    )
    .join("");
  return `
  <section class="section">
    <h2>Frame-interval distributions</h2>
    <p class="muted">Empirical CDF of pooled frame-to-frame intervals per cell — vertical reference lines mark the 60Hz (16.7ms) and half-rate (33.4ms) vsync budgets. rAF pins these to vsync, so intervals alone under-report small cost deltas (see busy-time section).</p>
    <div class="card-grid">${cards}</div>
    <details class="table-view"><summary>Table view</summary>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Cell</th><th>Median</th><th>p95</th><th>p99</th><th>Max</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </details>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 3 — busy-time per cell (box + per-run median dots)
// ---------------------------------------------------------------------------

function buildBusySection(cellAggs) {
  const W = Math.max(560, cellAggs.length * 90 + 80);
  const H = 320;
  const px0 = 50;
  const px1 = W - 20;
  const py0 = 16;
  const py1 = H - 40;
  const plotW = px1 - px0;
  const plotH = py1 - py0;
  const withData = cellAggs.filter((a) => a.busy.pooledQuantiles);
  const yMax = niceMax(Math.max(1, ...withData.map((a) => a.busy.pooledQuantiles.p95 ?? a.busy.pooledQuantiles.max)) * 1.2);
  const slot = plotW / Math.max(1, cellAggs.length);

  const yOf = (v) => py1 - (v / yMax) * plotH;

  let marks = "";
  cellAggs.forEach((a, i) => {
    const cx = px0 + slot * (i + 0.5);
    const q = a.busy.pooledQuantiles;
    const colorVar = `var(--cell-${cssIdx(a)})`;
    if (!q) {
      marks += `<text x="${cx.toFixed(1)}" y="${(py0 + plotH / 2).toFixed(1)}" class="tick-label" text-anchor="middle">no data</text>`;
      return;
    }
    const yMin = yOf(q.min);
    const yP95 = yOf(a.busy.usingPooledRaw ? q.p95 : q.max);
    const yP25 = yOf(a.busy.usingPooledRaw ? q.p25 : q.min);
    const yP75 = yOf(a.busy.usingPooledRaw ? q.p75 : q.max);
    const yMed = yOf(q.median);
    // whisker
    marks += `<line x1="${cx}" y1="${yMin.toFixed(1)}" x2="${cx}" y2="${yP95.toFixed(1)}" class="whisker" style="stroke:${colorVar}" />`;
    // box (p25-p75, or a thin degenerate box when only min/median/max exist)
    const boxW = 22;
    marks += `<rect x="${(cx - boxW / 2).toFixed(1)}" y="${Math.min(yP25, yP75).toFixed(1)}" width="${boxW}" height="${Math.max(1, Math.abs(yP75 - yP25)).toFixed(1)}" class="box" style="fill:${colorVar}"><title>${esc(a.id)}: p25=${fmtMs(a.busy.usingPooledRaw ? q.p25 : q.min)} p75=${fmtMs(a.busy.usingPooledRaw ? q.p75 : q.max)}</title></rect>`;
    // median tick
    marks += `<line x1="${(cx - boxW / 2).toFixed(1)}" y1="${yMed.toFixed(1)}" x2="${(cx + boxW / 2).toFixed(1)}" y2="${yMed.toFixed(1)}" class="median-tick"><title>median ${fmtMs(q.median)}</title></line>`;
    // per-run median dots, jittered
    const dots = a.busy.perRunMedian;
    dots.forEach((v, di) => {
      const jitter = ((di % 5) - 2) * 4;
      const dy = yOf(v);
      marks += `<circle cx="${(cx + jitter).toFixed(1)}" cy="${dy.toFixed(1)}" r="3" class="run-dot" style="fill:${colorVar}"><title>${esc(a.id)} run ${di + 1}: busy median ${fmtMs(v)}</title></circle>`;
    });
    marks += `<text x="${cx.toFixed(1)}" y="${H - 20}" class="tick-label cat-label" text-anchor="middle">${esc(shortLabel(a.id))}</text>`;
    if (a.busy.sparse) marks += `<text x="${cx.toFixed(1)}" y="${H - 8}" class="tick-label small" text-anchor="middle">(sparse)</text>`;
  });

  const tableRows = cellAggs
    .map((a) => {
      const q = a.busy.pooledQuantiles;
      return `<tr><td>${esc(a.id)}</td><td>${q ? fmtMs(q.median) : "n/a"}</td><td>${q ? fmtMs(a.busy.usingPooledRaw ? q.p95 : q.max) : "n/a"}</td><td>${fmt(a.busy.perRunMedian.length)}</td><td>${a.busy.sparse ? "perfLog snapshot (sparse)" : a.busy.usingPooledRaw ? "per-frame accumulator" : "n/a"}</td></tr>`;
    })
    .join("");

  return `
  <section class="section">
    <h2>Busy-time per cell</h2>
    <p class="muted">Box = pooled 25th–75th percentile busy ms per frame (per-frame accumulator when available, else the sparser console-scrape); whisker to p95; tick = median. Dots are each individual run's own median busy time — never a bare mean — so run-to-run spread is visible.</p>
    ${svgOpen(W, H, "busy-chart")}
      ${axisFrame({ px0, px1, py0, py1, yMax, yTicks: 5, yFmt: (v) => fmtMs(v) })}
      ${marks}
    </svg>
    <details class="table-view"><summary>Table view</summary>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Cell</th><th>Median busy</th><th>p95 busy</th><th>Runs</th><th>Source</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </details>
  </section>`;
}

function shortLabel(id) {
  return id.length > 14 ? `${id.slice(0, 13)}…` : id;
}

// ---------------------------------------------------------------------------
// Section 4 — phase breakdown (stacked horizontal bars)
// ---------------------------------------------------------------------------

function buildPhaseSection(cellAggs) {
  const withPhases = cellAggs.filter((a) => a.phaseMeans.size);
  if (!withPhases.length) {
    return `<section class="section"><h2>Phase breakdown</h2><p class="muted">No per-phase timing data in the given run directories.</p></section>`;
  }
  const rowH = 34;
  const H = withPhases.length * rowH + 40;
  const W = 720;
  const px0 = 130;
  const px1 = W - 20;
  const plotW = px1 - px0;
  const maxTotal = niceMax(Math.max(1, ...withPhases.map((a) => [...a.phaseMeans.values()].reduce((s, v) => s + v, 0))) * 1.1);

  let bars = "";
  withPhases.forEach((a, ri) => {
    const y = 10 + ri * rowH;
    let x = px0;
    PHASE_BUCKETS.forEach((bucket, bi) => {
      const v = a.phaseMeans.get(bucket.key) ?? 0;
      const w = (v / maxTotal) * plotW;
      if (w > 0.4) {
        bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, w - 1.5).toFixed(1)}" height="18" rx="3" style="fill:var(--phase-${bi + 1})"><title>${esc(a.id)} — ${esc(bucket.label)}: ${fmtMs(v)}/frame</title></rect>`;
      }
      x += w;
    });
    bars += `<text x="${px0 - 8}" y="${y + 13}" class="tick-label" text-anchor="end">${esc(shortLabel(a.id))}</text>`;
  });

  const legend = PHASE_BUCKETS.map((b, bi) => legendSwatch(`var(--phase-${bi + 1})`, b.label, 20 + (bi % 4) * 170, H + 4 + Math.floor(bi / 4) * 18)).join("");
  const legendH = Math.ceil(PHASE_BUCKETS.length / 4) * 18 + 12;

  const tableCols = PHASE_BUCKETS.map((b) => `<th>${esc(b.label)}</th>`).join("");
  const tableRows = withPhases
    .map((a) => `<tr><td>${esc(a.id)}</td>${PHASE_BUCKETS.map((b) => `<td>${fmtMs(a.phaseMeans.get(b.key) ?? 0)}</td>`).join("")}</tr>`)
    .join("");

  return `
  <section class="section">
    <h2>Phase breakdown</h2>
    <p class="muted">Mean per-frame cost per engine phase (input-poll/input-actions merged into "input" to stay within the 8-hue categorical ceiling — both are near-zero in every capture to date).</p>
    ${svgOpen(W, H + legendH, "phase-chart")}
      ${bars}
      <g>${legend}</g>
    </svg>
    <details class="table-view"><summary>Table view</summary>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Cell</th>${tableCols}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </details>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 5 — A/B comparisons (baseline vs <flag>-on)
// ---------------------------------------------------------------------------

function findAbPairs(cellAggs) {
  const byGroup = new Map(); // `${scenario}.${browser}` -> {baseline, flagged: []}
  for (const a of cellAggs) {
    const key = `${a.cell.scenario}.${a.cell.browser}`;
    if (!byGroup.has(key)) byGroup.set(key, { baseline: null, flagged: [] });
    const g = byGroup.get(key);
    if (a.cell.variant === "baseline" && !a.cell.flag) g.baseline = a;
    else if (a.cell.variant === "baseline") g.baseline = g.baseline ?? a; // flag cell's own baseline arm
    else g.flagged.push(a);
  }
  const pairs = [];
  for (const [key, g] of byGroup) {
    for (const flagged of g.flagged) pairs.push({ key, baseline: g.baseline, flagged });
  }
  return pairs;
}

function minDetectableDiffPct(dirCalibrations) {
  for (const cal of dirCalibrations) {
    const cov = cal?.busyMedianMs?.cov;
    if (Number.isFinite(cov)) return cov * 2 * 100;
  }
  return null;
}

function buildAbPairCard(pair, mdd) {
  const { baseline, flagged } = pair;
  const W = 420;
  const H = 150;
  const px0 = 90;
  const px1 = W - 20;
  const py0 = 16;
  const py1 = H - 30;
  const bq = baseline?.busy.pooledQuantiles;
  const fq = flagged?.busy.pooledQuantiles;
  if (!bq || !fq) {
    return `<figure class="chart-card"><figcaption>${esc(flagged?.id ?? "?")}</figcaption><p class="muted small">missing baseline or flagged busy data</p></figure>`;
  }
  const yMax = niceMax(Math.max(bq.p95 ?? bq.max, fq.p95 ?? fq.max) * 1.25);
  const yOf = (v) => py1 - (v / yMax) * (py1 - py0);
  const yBase = yOf(bq.median);
  const yFlag = yOf(fq.median);
  const delta = fq.median - bq.median;
  const deltaPct = bq.median ? (delta / bq.median) * 100 : 0;
  const withinNoise = mdd !== null && Math.abs(deltaPct) < mdd;

  const dotsRow = (agg, cy, colorVar) =>
    agg.busy.perRunMedian
      .map((v, i) => {
        const cx = px0 + 40 + ((i % 6) - 2.5) * 8;
        return `<circle cx="${cx.toFixed(1)}" cy="${(cy + ((i % 3) - 1) * 3).toFixed(1)}" r="2.6" class="run-dot" style="fill:${colorVar}"><title>run ${i + 1}: ${fmtMs(v)}</title></circle>`;
      })
      .join("");

  return `<figure class="chart-card">
    <figcaption>${esc(pair.key)}<br/><span class="muted small">${esc(baseline.cell.flag ?? "")}</span></figcaption>
    ${svgOpen(W, H)}
      ${axisFrame({ px0, px1, py0, py1, yMax, yTicks: 3, yFmt: (v) => fmtMs(v) })}
      <line x1="${px0 + 40}" y1="${yBase.toFixed(1)}" x2="${px0 + 40}" y2="${yFlag.toFixed(1)}" class="dumbbell-line" />
      <circle cx="${px0 + 40}" cy="${yBase.toFixed(1)}" r="6" class="dumbbell-dot" style="fill:var(--cell-1)"><title>baseline median ${fmtMs(bq.median)}</title></circle>
      <circle cx="${px0 + 40}" cy="${yFlag.toFixed(1)}" r="6" class="dumbbell-dot" style="fill:var(--cell-6)"><title>${esc(flagged.cell.flag)}-on median ${fmtMs(fq.median)}</title></circle>
      ${dotsRow(baseline, yBase, "var(--cell-1)")}
      ${dotsRow(flagged, yFlag, "var(--cell-6)")}
      <text x="${px1 - 4}" y="${py0 + 10}" text-anchor="end" class="${withinNoise ? "delta-noise" : delta > 0 ? "delta-bad" : "delta-good"}">
        Δ ${delta >= 0 ? "+" : ""}${fmtMs(delta)} (${deltaPct >= 0 ? "+" : ""}${fmtPct(deltaPct)})${withinNoise ? " — within noise" : ""}
      </text>
    </svg>
    <p class="stat-line muted small">baseline ${fmtMs(bq.median)} → ${esc(flagged.cell.flag)}-on ${fmtMs(fq.median)}${mdd !== null ? ` · min. detectable diff ≈${fmt(mdd, { maximumFractionDigits: 1 })}%` : ""}</p>
  </figure>`;
}

function buildAbSection(cellAggs, calibrations) {
  const pairs = findAbPairs(cellAggs).filter((p) => p.baseline && p.flagged);
  const mdd = minDetectableDiffPct(calibrations);
  if (!pairs.length) {
    return `
    <section class="section">
      <h2>A/B comparisons</h2>
      <p class="muted">Findings pending: no baseline/flagged cell pairs found in the given run directories. Re-run <code>npm run perf:report</code> once <code>--flag aa</code> / <code>--flag scaling</code> A/B captures exist.</p>
    </section>`;
  }
  const cards = pairs.map((p) => buildAbPairCard(p, mdd)).join("\n");
  return `
  <section class="section">
    <h2>A/B comparisons</h2>
    <p class="muted">Baseline (blue) vs feature-flag-on (orange) busy-time medians, paired per scenario/browser. Dots are individual run medians. ${mdd !== null ? `Minimum detectable difference from calibration ≈ ${fmt(mdd, { maximumFractionDigits: 1 })}% (2× idle busy-median CoV) — deltas smaller than that are noise, not signal.` : "No calibration.json found to annotate the minimum detectable difference."}</p>
    <div class="card-grid">${cards}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 6 — heap over time
// ---------------------------------------------------------------------------

function buildHeapCard(agg) {
  const W = 300;
  const H = 170;
  const px0 = 40;
  const px1 = W - 10;
  const py0 = 10;
  const py1 = H - 24;
  const plotW = px1 - px0;
  const plotH = py1 - py0;
  const allSamples = agg.heapSeries.flatMap((s) => s.samples);
  if (allSamples.length < 2) {
    return `<figure class="chart-card"><figcaption>${esc(agg.id)}</figcaption><p class="muted small">insufficient heap samples (n=${allSamples.length})</p></figure>`;
  }
  const tMax = Math.max(...allSamples.map((s) => s.t), 1);
  const yMax = niceMax(Math.max(...allSamples.map((s) => s.usedMB)) * 1.15);
  const colorVar = `var(--cell-${cssIdx(agg)})`;
  const lines = agg.heapSeries
    .filter((s) => s.samples.length >= 2)
    .map((s) => {
      const pts = s.samples.map((pt) => `${((pt.t / tMax) * plotW).toFixed(1)},${(plotH - (pt.usedMB / yMax) * plotH).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" class="heap-line" style="stroke:${colorVar}"><title>run ${s.runIndex}</title></polyline>`;
    })
    .join("");
  return `<figure class="chart-card">
    <figcaption>${esc(agg.id)} <span class="muted small">(${agg.heapSeries.length} run${agg.heapSeries.length === 1 ? "" : "s"})</span></figcaption>
    ${svgOpen(W, H)}
      <g transform="translate(${px0},${py0})">
        ${axisFrame({ px0: 0, px1: plotW, py0: 0, py1: plotH, yMax, yTicks: 3, yFmt: (v) => `${fmt(v, { maximumFractionDigits: 0 })}MB` })}
        ${lines}
      </g>
      <text x="${(px0 + px1) / 2}" y="${H - 4}" class="axis-title" text-anchor="middle">capture time</text>
    </svg>
  </figure>`;
}

function buildHeapSection(cellAggs) {
  const cards = cellAggs.map(buildHeapCard).join("\n");
  return `
  <section class="section">
    <h2>Heap growth</h2>
    <p class="muted">Used JS heap (MB) over the capture window, one faint line per run per cell (Chromium <code>--enable-precise-memory-info</code>). A rising trend across the whole window (not just a sawtooth from GC) would indicate a leak; sample counts here are small — see the methodology note.</p>
    <div class="card-grid">${cards}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 7 — findings
// ---------------------------------------------------------------------------

const IMPACT_WEIGHT = { High: 3, Med: 2, Low: 1 };
const EFFORT_WEIGHT = { Low: 3, Med: 2, High: 1 }; // inverse cost — Low effort scores highest
const IMPACT_STATUS = { High: "critical", Med: "warning", Low: "good" };

function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    const sa = (IMPACT_WEIGHT[a.impact] ?? 0) * (EFFORT_WEIGHT[a.effort] ?? 0);
    const sb = (IMPACT_WEIGHT[b.impact] ?? 0) * (EFFORT_WEIGHT[b.effort] ?? 0);
    return sb - sa;
  });
}

function buildFindingCard(f) {
  const statusRole = IMPACT_STATUS[f.impact] ?? "warning";
  const evidence = Array.isArray(f.evidence) ? f.evidence.join("\n") : f.evidence;
  return `<article class="finding-card">
    <header class="finding-head">
      <span class="badge badge-${statusRole}">${esc(f.impact ?? "?")} impact</span>
      <span class="badge badge-effort">${esc(f.effort ?? "?")} effort</span>
      <h3>${esc(f.title ?? f.id ?? "untitled finding")}</h3>
    </header>
    <p class="finding-loc muted small">${esc(f.file ?? "?")}${f.line ? `:${esc(f.line)}` : ""}</p>
    <dl class="finding-body">
      <dt>Symptom</dt><dd>${esc(f.symptom ?? "n/a")}</dd>
      <dt>Likely Culprit</dt><dd>${esc(f.culprit ?? "n/a")}</dd>
      <dt>Estimated Impact</dt><dd>${esc(f.impact ?? "n/a")}</dd>
      <dt>Actionable Refactor</dt><dd>${esc(f.refactor ?? "n/a")}</dd>
    </dl>
    ${evidence ? `<pre class="finding-evidence">${esc(evidence)}</pre>` : ""}
  </article>`;
}

function buildFindingsSection(findings) {
  if (!findings) {
    return `
    <section class="section">
      <h2>Findings</h2>
      <p class="muted findings-pending">Findings pending — pass <code>--findings &lt;path.json&gt;</code> (array of <code>{id,title,file,line,symptom,culprit,impact,effort,refactor,evidence}</code>) to render the ranked static-audit list here.</p>
    </section>`;
  }
  if (!findings.length) {
    return `<section class="section"><h2>Findings</h2><p class="muted">Findings file loaded but contains zero entries.</p></section>`;
  }
  const cards = rankFindings(findings).map(buildFindingCard).join("\n");
  return `
  <section class="section">
    <h2>Findings</h2>
    <p class="muted">Ranked impact-per-effort, highest first (High impact / Low effort leads).</p>
    <div class="finding-list">${cards}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Section 8 — methodology footnote
// ---------------------------------------------------------------------------

function buildMethodologyFootnote() {
  return `
  <section class="section methodology">
    <h2>Methodology</h2>
    <ul>
      <li>Frame intervals are vsync-pinned (rAF) — a cost delta smaller than the frame budget is invisible in interval statistics alone. <strong>Busy time is the primary A/B metric.</strong></li>
      <li>Each run discards its warmup window before the measured capture window begins; only the post-warmup samples are reported.</li>
      <li>A/B runs are interleaved (baseline, flagged, baseline, flagged, …) against thermal/background drift, not run back-to-back.</li>
      <li>Where the newer per-frame busy accumulator is unavailable, this report falls back to the sparser <code>?perfDebug=1</code> console-scrape numbers and marks those cells "(sparse)".</li>
    </ul>
  </section>`;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function buildStyle() {
  const catVars = (mode) => CATEGORICAL.map((c, i) => `--cell-${i + 1}: ${c[mode]}; --phase-${i + 1}: ${c[mode]};`).join(" ");
  return `<style>
    :root {
      color-scheme: light;
      --surface-1: #fcfcfb;
      --page-plane: #f9f9f7;
      --text-primary: #0b0b0b;
      --text-secondary: #52514e;
      --text-muted: #898781;
      --gridline: #e1e0d9;
      --baseline: #c3c2b7;
      --border: rgba(11,11,11,0.10);
      --cell-other: #898781;
      --status-good: ${STATUS.good.light};
      --status-warning: ${STATUS.warning.light};
      --status-serious: ${STATUS.serious.light};
      --status-critical: ${STATUS.critical.light};
      ${catVars("light")}
    }
    @media (prefers-color-scheme: dark) {
      :root:where(:not([data-theme="light"])) {
        color-scheme: dark;
        --surface-1: #1a1a19;
        --page-plane: #0d0d0d;
        --text-primary: #ffffff;
        --text-secondary: #c3c2b7;
        --text-muted: #898781;
        --gridline: #2c2c2a;
        --baseline: #383835;
        --border: rgba(255,255,255,0.10);
        --status-good: ${STATUS.good.dark};
        --status-warning: ${STATUS.warning.dark};
        --status-serious: ${STATUS.serious.dark};
        --status-critical: ${STATUS.critical.dark};
        ${catVars("dark")}
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page-plane: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --status-good: ${STATUS.good.dark};
      --status-warning: ${STATUS.warning.dark};
      --status-serious: ${STATUS.serious.dark};
      --status-critical: ${STATUS.critical.dark};
      ${catVars("dark")}
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px; background: var(--page-plane); color: var(--text-primary);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5;
    }
    h1 { font-size: 1.7rem; margin: 0 0 4px; }
    h2 { font-size: 1.2rem; margin: 0 0 6px; }
    h3 { font-size: 1rem; margin: 0; }
    .muted { color: var(--text-secondary); }
    .muted.small, .small { font-size: 0.82rem; }
    code { background: var(--surface-1); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
    .report-header, .section {
      max-width: 1200px; margin: 0 auto 28px; background: var(--surface-1);
      border: 1px solid var(--border); border-radius: 10px; padding: 20px 24px;
    }
    .meta-strip { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 14px; }
    .meta-item { display: flex; flex-direction: column; }
    .meta-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
    .meta-value { font-size: 1.05rem; font-weight: 600; }
    .table-wrap { overflow-x: auto; }
    table.data-table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; font-size: 0.88rem; }
    table.data-table th, table.data-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--gridline); white-space: nowrap; }
    table.data-table th { color: var(--text-secondary); font-weight: 600; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; margin-top: 12px; }
    figure.chart-card { margin: 0; background: var(--page-plane); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
    figcaption { font-weight: 600; font-size: 0.88rem; margin-bottom: 4px; }
    .chart-svg { width: 100%; height: auto; display: block; }
    .axis-line, .baseline { stroke: var(--baseline); stroke-width: 1; }
    .gridline { stroke: var(--gridline); stroke-width: 1; }
    .tick-label { fill: var(--text-muted); font-size: 8px; }
    .cat-label { font-size: 9px; }
    .axis-title { fill: var(--text-secondary); font-size: 9px; }
    .ref-line { stroke: var(--text-muted); stroke-width: 1; }
    .ref-label { fill: var(--text-muted); font-size: 7px; }
    .cdf-line { fill: none; stroke-width: 2; }
    .heap-line { fill: none; stroke-width: 1.5; opacity: 0.35; }
    .whisker { stroke-width: 2; }
    .box { opacity: 0.55; }
    .median-tick { stroke: var(--text-primary); stroke-width: 2; }
    .run-dot { opacity: 0.85; stroke: var(--surface-1); stroke-width: 1; }
    .dumbbell-line { stroke: var(--text-muted); stroke-width: 2; }
    .dumbbell-dot { stroke: var(--surface-1); stroke-width: 2; }
    .delta-bad { fill: var(--status-critical); font-size: 10px; font-weight: 600; }
    .delta-good { fill: var(--status-good); font-size: 10px; font-weight: 600; }
    .delta-noise { fill: var(--text-muted); font-size: 10px; font-weight: 600; }
    .legend-label { fill: var(--text-secondary); font-size: 9px; }
    .stat-line { margin: 6px 0 0; }
    details.table-view { margin-top: 10px; }
    details.table-view summary { cursor: pointer; color: var(--text-secondary); font-size: 0.85rem; }
    .finding-list { display: flex; flex-direction: column; gap: 14px; margin-top: 12px; }
    .finding-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; background: var(--page-plane); }
    .finding-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
    .badge { font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 10px; color: #fff; }
    .badge-critical { background: var(--status-critical); }
    .badge-warning { background: var(--status-warning); color: #1a1a19; }
    .badge-good { background: var(--status-good); }
    .badge-effort { background: var(--text-muted); color: #fff; }
    .finding-loc { margin: 0 0 8px; }
    dl.finding-body { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 0; }
    dl.finding-body dt { color: var(--text-secondary); font-weight: 600; font-size: 0.85rem; }
    dl.finding-body dd { margin: 0; }
    .finding-evidence { background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 0.8rem; overflow-x: auto; margin: 10px 0 0; white-space: pre-wrap; }
    .findings-pending { font-style: italic; }
    .methodology ul { margin: 8px 0 0; padding-left: 20px; }
    .methodology li { margin-bottom: 6px; }
  </style>`;
}

function buildHtml({ cellAggs, dirs, findings, calibrations }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Codeenstein Performance Audit Report</title>
${buildStyle()}
</head>
<body>
${buildHeaderSection(cellAggs, dirs)}
${buildIntervalSection(cellAggs)}
${buildBusySection(cellAggs)}
${buildPhaseSection(cellAggs)}
${buildAbSection(cellAggs, calibrations)}
${buildHeapSection(cellAggs)}
${buildFindingsSection(findings)}
${buildMethodologyFootnote()}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dirs, findingsPath } = parseArgs(process.argv);
  const allRuns = [];
  const calibrations = [];
  for (const dir of dirs) {
    const { runs, calibration } = loadRunDir(dir);
    allRuns.push(...runs);
    if (calibration) calibrations.push(calibration);
  }
  if (!allRuns.length) throw new Error("no *.run<N>.json files found in the given directories");

  const cells = groupCells(allRuns);
  const cellAggs = cells.map((entry) => aggregateCell(entry, scenarioColorIndex(entry.cell.scenario)));
  const findings = loadFindings(findingsPath);

  const html = buildHtml({ cellAggs, dirs, findings, calibrations });
  fs.writeFileSync(OUT_FILE, html);
  console.log(`[perf:report] wrote ${path.relative(ROOT, OUT_FILE)} (${cellAggs.length} cells, ${allRuns.length} runs, ${findings ? findings.length : 0} findings)`);
}

main();

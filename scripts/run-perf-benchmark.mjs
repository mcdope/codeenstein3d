// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Repeatable frame-time benchmark harness (`npm run perf:bench`).
 *
 * Measures REAL frame timings (unlike the balancing bot's virtual clock):
 * frame intervals via an injected rAF sampler (`scripts/lib/perfSampler.mjs`,
 * zero game-source changes) and per-phase busy time by scraping the
 * `?perfDebug=1` console output (`scripts/lib/perfConsoleParse.mjs`). Busy
 * time is the primary A/B metric — rAF pins intervals to vsync, so a cost
 * delta smaller than the frame budget is invisible in intervals alone.
 *
 * Server: honors CODEENSTEIN_PERF_URL if a server is already running,
 * otherwise spawns its own `vite --port 5199 --strictPort`. It deliberately
 * NEVER touches the user's dev server on 5173.
 *
 * Output: one JSON per run under perf_runs/<timestamp>/ plus a manifest.json
 * updated after every run — a crashed matrix resumes per-cell/per-run via
 * `--resume perf_runs/<timestamp>`, it never restarts finished work.
 *
 * Usage:
 *   node scripts/run-perf-benchmark.mjs --calibrate          # 10× idle, CoV
 *   node scripts/run-perf-benchmark.mjs --scenario s1-idle --runs 5
 *   node scripts/run-perf-benchmark.mjs --scenario s1-idle,s2-replay --flag aa
 *   node scripts/run-perf-benchmark.mjs --resume perf_runs/2026-07-18T...
 * Options: --runs N (default 5), --duration SECS (default 30; s2 uses 60),
 *   --browser chromium|firefox|webkit, --headless (or CODEENSTEIN_PERF_HEADLESS=1),
 *   --warmup SECS (default 5).
 * A/B: --flag aa|scaling temporarily flips the corresponding compile-time
 *   const in-place (working tree for that file must be clean), interleaving
 *   baseline/flagged runs A,B,A,B,... against thermal drift, and ALWAYS
 *   restores the file via `git checkout --` in a finally block.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { installPerfSampler, readSampler, resetSampler } from "./lib/perfSampler.mjs";
import { createPerfLogCollector, numberStats, percentileSorted, summarizeFrameEntries } from "./lib/perfConsoleParse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PERF_PORT = Number(process.env.CODEENSTEIN_PERF_PORT ?? 5199);
const EXTERNAL_URL = process.env.CODEENSTEIN_PERF_URL;

const BROWSERS = { chromium, firefox, webkit };

/** The two A/B feature-flag consts (see plan/performance-testing.md). Flips
 * are textual and exact so an unexpected file shape fails loudly instead of
 * silently benchmarking the wrong variant. */
const FLAG_DEFS = {
  aa: { file: "src/engine/raycaster.ts", name: "WALL_EDGE_ANTIALIASING_ENABLED" },
  scaling: { file: "src/ui/canvasFit.ts", name: "RESPONSIVE_CANVAS_SCALING_ENABLED" },
};

// ---------------------------------------------------------------------------
// Scenario drivers — each puts the page into its measurable steady state.
// All run on the REAL clock (no virtual-clock install, ever, in this harness).
// ---------------------------------------------------------------------------

/** Readiness = the `[perf] level:` line perfDebug prints once map generation
 * finishes. Deliberately NOT `?testHooks=1`/`__codeensteinTestHooks`: that
 * flag switches real telemetry recording on (engine.ts constructor), which
 * would add measurable per-event work normal play doesn't have — the bench
 * must measure normal-play conditions. */
async function waitForLevelReady(collector, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collector.entries.some((e) => e.kind === "level")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no '[perf] level:' console line — level never finished loading?");
}

/** Real-clock overlay dismiss (briefing/summary screens advance on Space).
 * Same synthetic-keydown trick as the balancing harness's headed branch. */
async function dismissOverlay(page) {
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  await page.waitForTimeout(200);
}

const SCENARIOS = {
  /** S1: demo campaign level 1, player standing still — pure render/AI idle
   * baseline and the calibration workload. */
  "s1-idle": {
    defaultDurationSec: 30,
    async setup(page, baseUrl, collector) {
      await page.goto(`${baseUrl}/?perfDebug=1`);
      await page.click("#tab-demo");
      await page.click("#launch-demo-campaign");
      await waitForLevelReady(collector);
      await dismissOverlay(page);
    },
  },
  // s2-replay / s3-stress / s4-magento land with milestone 2 of the audit.
};

// ---------------------------------------------------------------------------
// Dev server management
// ---------------------------------------------------------------------------

async function urlAlive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns `{url, stop()}` — an externally provided server (CODEENSTEIN_PERF_URL)
 * is used as-is and never stopped by us. */
async function ensureServer() {
  if (EXTERNAL_URL) {
    if (!(await urlAlive(EXTERNAL_URL))) throw new Error(`CODEENSTEIN_PERF_URL=${EXTERNAL_URL} is not responding`);
    return { url: EXTERNAL_URL.replace(/\/$/, ""), stop: () => {} };
  }
  const url = `http://localhost:${PERF_PORT}`;
  if (await urlAlive(url)) {
    // Something already listens on our port (likely a previous bench run's
    // leftover, or the user parked a server there) — reuse, don't own.
    console.log(`[perf:bench] reusing already-running server at ${url}`);
    return { url, stop: () => {} };
  }
  console.log(`[perf:bench] starting vite on :${PERF_PORT} (the 5173 dev server is never touched)`);
  // Spawn vite's JS entry under node directly — an `npx vite` wrapper can
  // swallow SIGTERM and leave the real server orphaned on the port.
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(PERF_PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // Drain both pipes — an unread stdout pipe can fill and block the child.
  child.stdout.resume();
  child.stderr.on("data", (buf) => process.stderr.write(`[vite] ${buf}`));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await urlAlive(url)) return { url, stop: () => child.kill("SIGTERM") };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  throw new Error(`vite did not come up on :${PERF_PORT} within 60s`);
}

// ---------------------------------------------------------------------------
// Flag flipping (A/B) — textual, verified, always restored.
// ---------------------------------------------------------------------------

function assertFlagFileClean(def) {
  try {
    execFileSync("git", ["diff", "--quiet", "--", def.file], { cwd: ROOT });
  } catch {
    throw new Error(`${def.file} has uncommitted changes — refusing to flip ${def.name} for A/B`);
  }
}

function setFlag(def, enabled) {
  const filePath = path.join(ROOT, def.file);
  const source = fs.readFileSync(filePath, "utf8");
  const from = `export const ${def.name} = ${enabled ? "false" : "true"};`;
  const to = `export const ${def.name} = ${enabled ? "true" : "false"};`;
  if (source.includes(to)) return; // already in the wanted state
  if (!source.includes(from)) throw new Error(`could not find "${from}" in ${def.file} — flag shape changed?`);
  fs.writeFileSync(filePath, source.replace(from, to));
}

function restoreFlag(def) {
  execFileSync("git", ["checkout", "--", def.file], { cwd: ROOT });
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function pctOver(deltas, thresholdMs) {
  if (!deltas.length) return 0;
  return (100 * deltas.filter((d) => d > thresholdMs).length) / deltas.length;
}

function summarizeIntervals(deltas) {
  const stats = numberStats(deltas);
  if (!stats) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    ...stats,
    p999: percentileSorted(sorted, 99.9),
    pctOver16_7: pctOver(deltas, 16.7),
    pctOver33_4: pctOver(deltas, 33.4),
    approxFps: 1000 / stats.median,
  };
}

/** One measured run: fresh context/page → scenario setup → warmup (discarded)
 * → capture window → read sampler + perf-log collector. */
async function measureRun(browser, scenarioId, baseUrl, { warmupSec, durationSec }) {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`unknown scenario "${scenarioId}" (have: ${Object.keys(SCENARIOS).join(", ")})`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const collector = createPerfLogCollector();
    page.on("console", collector.onConsole);
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
    await installPerfSampler(page);

    const startedAt = new Date().toISOString();
    await scenario.setup(page, baseUrl, collector);
    await page.waitForTimeout(warmupSec * 1000);

    const meta = collector.entries.filter((e) => e.kind === "env" || e.kind === "level");
    await resetSampler(page);
    collector.reset();
    await page.waitForTimeout(durationSec * 1000);

    const { frames, heapSamples } = await readSampler(page);
    return {
      startedAt,
      warmupSec,
      durationSec,
      meta,
      intervals: summarizeIntervals(frames.deltas),
      frameCount: frames.total,
      rawDeltas: frames.deltas, // kept raw for the report's histograms/CDFs
      heapSamples,
      perfLog: summarizeFrameEntries(collector.entries),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Cells, manifest, orchestration
// ---------------------------------------------------------------------------

function loadManifest(outDir) {
  const file = path.join(outDir, "manifest.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return { createdAt: new Date().toISOString(), cells: {} };
}

function saveManifest(outDir, manifest) {
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Runs one cell (scenario × variant × browser × N runs), resuming from the
 * manifest's per-run progress. Variant "flagged" flips the flag around each
 * of its runs; interleaving happens at the caller via run-major order. */
async function runCell(browser, cell, baseUrl, outDir, manifest) {
  const entry = (manifest.cells[cell.id] ??= { status: "pending", runsDone: 0, runs: cell.runs });
  if (entry.status === "done") {
    console.log(`[perf:bench] ${cell.id}: already done, skipping`);
    return;
  }
  entry.status = "running";
  saveManifest(outDir, manifest);

  for (let i = entry.runsDone; i < cell.runs; i += 1) {
    const flagDef = cell.flag ? FLAG_DEFS[cell.flag] : null;
    if (flagDef) setFlag(flagDef, cell.variant === "flagged");
    try {
      console.log(`[perf:bench] ${cell.id}: run ${i + 1}/${cell.runs}`);
      const run = await measureRun(browser, cell.scenario, baseUrl, cell);
      const outFile = path.join(outDir, `${cell.id}.run${i + 1}.json`);
      fs.writeFileSync(outFile, `${JSON.stringify({ cell, runIndex: i + 1, ...run }, null, 2)}\n`);
      const iv = run.intervals;
      console.log(
        `[perf:bench]   median=${iv.median.toFixed(2)}ms p95=${iv.p95.toFixed(2)}ms ` +
          `>16.7ms=${iv.pctOver16_7.toFixed(1)}% busy(med)=${run.perfLog.busyMs ? run.perfLog.busyMs.median.toFixed(2) : "n/a"}ms ` +
          `ticks=${run.perfLog.tickCount} slow=${run.perfLog.slowCount}`,
      );
    } finally {
      if (flagDef) restoreFlag(flagDef);
    }
    entry.runsDone = i + 1;
    saveManifest(outDir, manifest);
  }
  entry.status = "done";
  saveManifest(outDir, manifest);
}

/** Build the cell list for this invocation. With --flag, baseline and flagged
 * cells alternate per run index (A,B,A,B,...) — see runMatrix. */
function buildCells(opts) {
  const cells = [];
  for (const scenario of opts.scenarios) {
    const durationSec = opts.durationSec ?? SCENARIOS[scenario]?.defaultDurationSec ?? 30;
    const base = { scenario, browser: opts.browser, runs: opts.runs, durationSec, warmupSec: opts.warmupSec };
    if (opts.flag) {
      cells.push({ ...base, id: `${scenario}.${opts.browser}.baseline`, flag: opts.flag, variant: "baseline" });
      cells.push({ ...base, id: `${scenario}.${opts.browser}.${opts.flag}-on`, flag: opts.flag, variant: "flagged" });
    } else {
      cells.push({ ...base, id: `${scenario}.${opts.browser}.baseline`, flag: null, variant: "baseline" });
    }
  }
  return cells;
}

/** Interleaved execution: one run of every cell, then the next run of every
 * cell — so A/B variants sample the same thermal/background conditions. */
async function runMatrix(browser, cells, baseUrl, outDir, manifest) {
  const maxRuns = Math.max(...cells.map((c) => c.runs));
  for (let round = 0; round < maxRuns; round += 1) {
    for (const cell of cells) {
      const entry = (manifest.cells[cell.id] ??= { status: "pending", runsDone: 0, runs: cell.runs });
      if (entry.status === "done" || entry.runsDone > round) continue;
      await runCell(browser, { ...cell, runs: Math.min(cell.runs, round + 1) }, baseUrl, outDir, manifest);
      entry.runs = cell.runs; // runCell capped it for interleaving; restore target
      entry.status = entry.runsDone >= cell.runs ? "done" : "running";
      saveManifest(outDir, manifest);
    }
  }
}

// ---------------------------------------------------------------------------
// Calibration — quantifies machine noise so A/B deltas below it are reported
// as "no measurable difference" instead of false findings.
// ---------------------------------------------------------------------------

function coefficientOfVariation(values) {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
  return { mean: m, sd, cov: m ? sd / m : 0 };
}

function writeCalibration(outDir) {
  const runs = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith("s1-idle.") && f.includes(".run"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")));
  const metrics = {
    intervalMedianMs: runs.map((r) => r.intervals.median),
    intervalP95Ms: runs.map((r) => r.intervals.p95),
    busyMedianMs: runs.map((r) => r.perfLog.busyMs?.median).filter((v) => v !== undefined),
  };
  const calibration = {};
  for (const [name, values] of Object.entries(metrics)) {
    if (values.length >= 2) calibration[name] = { ...coefficientOfVariation(values), runs: values };
  }
  fs.writeFileSync(path.join(outDir, "calibration.json"), `${JSON.stringify(calibration, null, 2)}\n`);
  console.log("[perf:bench] calibration (across-run spread — the minimum detectable difference is ~2× this):");
  for (const [name, c] of Object.entries(calibration)) {
    console.log(`  ${name}: mean=${c.mean.toFixed(3)}ms sd=${c.sd.toFixed(3)}ms cov=${(100 * c.cov).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    scenarios: ["s1-idle"],
    runs: 5,
    durationSec: undefined,
    warmupSec: 5,
    browser: "chromium",
    headless: Boolean(process.env.CODEENSTEIN_PERF_HEADLESS),
    flag: null,
    calibrate: false,
    resume: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--scenario") opts.scenarios = next().split(",");
    else if (arg === "--runs") opts.runs = Number(next());
    else if (arg === "--duration") opts.durationSec = Number(next());
    else if (arg === "--warmup") opts.warmupSec = Number(next());
    else if (arg === "--browser") opts.browser = next();
    else if (arg === "--headless") opts.headless = true;
    else if (arg === "--flag") opts.flag = next();
    else if (arg === "--calibrate") opts.calibrate = true;
    else if (arg === "--resume") opts.resume = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.flag && !FLAG_DEFS[opts.flag]) throw new Error(`--flag must be one of: ${Object.keys(FLAG_DEFS).join(", ")}`);
  if (!BROWSERS[opts.browser]) throw new Error(`--browser must be one of: ${Object.keys(BROWSERS).join(", ")}`);
  if (opts.calibrate) {
    opts.scenarios = ["s1-idle"];
    opts.runs = 10;
    opts.flag = null;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const outDir = opts.resume
    ? path.resolve(ROOT, opts.resume)
    : path.join(ROOT, "perf_runs", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = loadManifest(outDir);

  if (opts.flag) assertFlagFileClean(FLAG_DEFS[opts.flag]);

  const server = await ensureServer();
  const browser = await BROWSERS[opts.browser].launch({
    headless: opts.headless,
    args:
      opts.browser === "chromium"
        ? ["--enable-precise-memory-info", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
        : [],
  });
  try {
    const cells = buildCells(opts);
    console.log(`[perf:bench] output: ${path.relative(ROOT, outDir)} — cells: ${cells.map((c) => c.id).join(", ")}`);
    await runMatrix(browser, cells, server.url, outDir, manifest);
    if (opts.calibrate) writeCalibration(outDir);
    console.log(`[perf:bench] done — ${path.relative(ROOT, outDir)}`);
  } finally {
    await browser.close().catch(() => {});
    server.stop();
    if (opts.flag) restoreFlag(FLAG_DEFS[opts.flag]); // belt & braces on top of runCell's finally
  }
}

main().catch((err) => {
  console.error("run-perf-benchmark crashed:", err);
  process.exit(1);
});

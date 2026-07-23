// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Large-scale data-collection orchestrator: repeatedly spawns
 * `scripts/run-balancing-telemetry.mjs` (as separate OS processes, one per
 * combo-batch) until every profile×difficulty combo has accumulated at
 * least `TARGET_QUALIFYING` qualifying (level-4+) full-campaign runs,
 * keeping every batch's output as its own file under `balancing_runs/` for
 * later analysis rather than overwriting a single shared output.
 *
 * Distinct from `npm run balancing:telemetry` (one process, one shared
 * output file, fixed 3-qualifying-runs target) and `npm run balancing:scan`
 * (behavior-regression detector, not data collection) — this is specifically
 * for building up a large sample size across many separate, resumable runs.
 *
 * Resumable by construction: before touching a combo, sums each existing
 * saved file's `qualifyingRunCount` for that combo rather than tracking
 * progress in any separate state file — killing and restarting this script
 * picks up exactly where it left off.
 *
 * Runs `LANES` combos concurrently as independent child processes (each
 * with its own internal `CODEENSTEIN_TELEMETRY_CONCURRENCY`-way browser
 * concurrency), each wrapped in a wall-clock watchdog (SIGTERM, then SIGKILL
 * after a grace period, if it runs longer than `WATCHDOG_MS`) — there is no
 * internal safety net in run-balancing-telemetry.mjs for a genuinely wedged
 * `page.evaluate()`/virtual-clock pump (every internal "stuck" resolution is
 * a bounded tick-count give-up that resolves normally; a real hang would
 * leave a `Promise.all` waiting forever with nothing to catch it), so an
 * external OS-level kill is the only thing that can actually stop that.
 *
 * Usage: `npm run balancing:campaign`. Tunable via env vars (see the
 * CODEENSTEIN_CAMPAIGN_* constants below) — defaults assume a modern
 * multi-core desktop; lower CODEENSTEIN_CAMPAIGN_LANES/_CONCURRENCY on
 * weaker hardware. CODEENSTEIN_CAMPAIGN_PROFILE/_DIFFICULTY scope the whole
 * campaign to a subset of combos (e.g. for a quick smoke test or resuming
 * just one lagging combo). Not CI-wired — this is a long-running (hours to
 * days), unattended background job, not a fast smoke test by default.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { LocalRunner, runLaneOrchestrator } from "./lib/laneOrchestrator.mjs";
import { buildSshRunners } from "./lib/sshRunner.mjs";
import { PROFILES, DIFFICULTIES } from "./run-balancing-telemetry.mjs";

const TELEMETRY_SCRIPT = path.join(REPO_ROOT, "scripts/run-balancing-telemetry.mjs");
const RUNS_DIR = path.join(REPO_ROOT, "balancing_runs");
const LOGS_DIR = path.join(RUNS_DIR, "logs");

// How many qualifying (level-4+) full-campaign runs each combo needs before
// it's considered done.
const TARGET_QUALIFYING = process.env.CODEENSTEIN_CAMPAIGN_TARGET ? Number(process.env.CODEENSTEIN_CAMPAIGN_TARGET) : 50;
// Qualifying runs collected per single spawned invocation/file — keeps each
// saved file a meaningful sample while bounding how many times the fixed
// per-invocation overhead (Node/Chromium startup, level parsing) is paid.
const BATCH_SIZE = process.env.CODEENSTEIN_CAMPAIGN_BATCH_SIZE ? Number(process.env.CODEENSTEIN_CAMPAIGN_BATCH_SIZE) : 5;
// Secondary safety net independent of the wall-clock watchdog: bounds a
// single invocation's total attempts so a combo with an unexpectedly low
// qualifying rate over a full (non-level-limited) campaign can't spin
// unboundedly within one invocation. If hit before BATCH_SIZE qualifying
// runs accumulate, the invocation still exits normally with fewer runs than
// hoped — the resumability scan below just tries again on the next pass.
const ATTEMPT_CAP = process.env.CODEENSTEIN_CAMPAIGN_ATTEMPT_CAP ? Number(process.env.CODEENSTEIN_CAMPAIGN_ATTEMPT_CAP) : 80;
// Internal browser-context concurrency *within* one spawned invocation.
// Lower than run-balancing-telemetry.mjs's own default (12) since LANES of
// these run concurrently as separate processes — see the doc comment above.
// NOTE: since this is > BATCH_SIZE, a single batch almost always contains
// enough successes to satisfy BATCH_SIZE whenever the true per-attempt
// success rate is reasonably high — run-balancing-telemetry.mjs's runCombo()
// then stops after one batch and trims to BATCH_SIZE, which mechanically
// floors the observed qualifyingRunCount/attemptsUsed ratio at
// BATCH_SIZE/CONCURRENCY_PER_LANE (5/8=62.5%) rather than measuring the real
// rate. Use each file's trueQualifyingCount field (untrimmed) for an honest
// per-attempt rate, not qualifyingRunCount.
const CONCURRENCY_PER_LANE = process.env.CODEENSTEIN_CAMPAIGN_CONCURRENCY ? Number(process.env.CODEENSTEIN_CAMPAIGN_CONCURRENCY) : 8;
// How many combos to process concurrently (each as its own child process).
const LANES = process.env.CODEENSTEIN_CAMPAIGN_LANES ? Number(process.env.CODEENSTEIN_CAMPAIGN_LANES) : 2;
// Wall-clock ceiling per spawned invocation before it's presumed hung and
// killed. Calibrated 2026-07-15 on the actual campaign machine (Ryzen
// 5800X): one real, production-representative invocation (full 17-level
// campaign, CONCURRENCY=8, QUALIFYING_TARGET=5) took 5m13s for 8 attempts to
// reach 5 qualifying (level-4+) runs. With ATTEMPT_CAP=80, a genuinely hard
// combo could need up to 10 such batches before giving up naturally — worst
// case roughly 50 minutes of legitimate (not hung) work. 90 minutes gives
// real headroom above that estimate while still being a meaningful ceiling.
// Re-calibrate (a single-combo run, no LEVEL_LIMIT) if hardware changes.
const WATCHDOG_MS = process.env.CODEENSTEIN_CAMPAIGN_WATCHDOG_MS ? Number(process.env.CODEENSTEIN_CAMPAIGN_WATCHDOG_MS) : 90 * 60 * 1000;
// Grace period between SIGTERM and SIGKILL when the watchdog fires, so
// Playwright gets a chance to close its Chromium subprocesses cleanly
// before a hard kill.
const SIGTERM_GRACE_MS = 5000;

function comboKey(combo) {
  return `${combo.profile}-${combo.difficulty}`;
}

function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/** Sums `qualifyingRunCount` (buildComboOutput's own field, see
 * run-balancing-telemetry.mjs) across every previously-saved file for this
 * combo — the sole source of truth for how much progress exists, so a
 * killed/restarted campaign resumes correctly with no separate state file
 * that could drift out of sync with what's actually on disk. A corrupted or
 * partially-written file (e.g. one whose invocation was mid-write when the
 * whole campaign process itself was killed) is skipped rather than crashing
 * the scan — its qualifying runs are simply not counted, which just means
 * this combo does a bit more work than strictly necessary, not a hard
 * failure. */
function scanExisting(combo) {
  const prefix = `${comboKey(combo)}-`;
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  let qualifying = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      qualifying += data.profiles?.[combo.profile]?.[combo.difficulty]?.qualifyingRunCount ?? 0;
    } catch (err) {
      console.log(`  [campaign] warning: skipping unreadable ${f}: ${err.message}`);
    }
  }
  return { qualifying, fileCount: files.length };
}

function outputPathFor(combo, sequence) {
  return path.join(RUNS_DIR, `${comboKey(combo)}-${String(sequence).padStart(3, "0")}.json`);
}

function logPathFor(combo, sequence) {
  return path.join(LOGS_DIR, `${comboKey(combo)}-${String(sequence).padStart(3, "0")}.log`);
}

/** Per-invocation env — CODEENSTEIN_TELEMETRY_OUTPUT_FILE is the caller's
 * own local `outputPath`; a remote `SshRunner` scp/rsyncs its own result
 * back to that exact path before `runInvocation` resolves, so this stays
 * identical for local and remote lanes. */
function envFor(combo, sequence, outputPath) {
  const env = {
    ...process.env,
    CODEENSTEIN_TELEMETRY_PROFILE: combo.profile,
    CODEENSTEIN_TELEMETRY_DIFFICULTY: combo.difficulty,
    CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET: String(BATCH_SIZE),
    CODEENSTEIN_TELEMETRY_ATTEMPT_CAP: String(ATTEMPT_CAP),
    CODEENSTEIN_TELEMETRY_CONCURRENCY: String(CONCURRENCY_PER_LANE),
    CODEENSTEIN_TELEMETRY_OUTPUT_FILE: outputPath,
  };
  delete env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT; // always the full campaign for this data-collection run
  return env;
}

function formatElapsed(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

async function main() {
  ensureDirs();

  // Scope the campaign itself to a subset of combos — useful for a quick
  // smoke test, or for resuming just one lagging combo later without
  // re-scanning (harmlessly) every other already-finished combo too.
  // Distinct from CODEENSTEIN_TELEMETRY_PROFILE/_DIFFICULTY, which this
  // script doesn't read directly — those are set explicitly per invocation's
  // own env in envFor() instead.
  const profileFilter = process.env.CODEENSTEIN_CAMPAIGN_PROFILE || null;
  const difficultyFilter = process.env.CODEENSTEIN_CAMPAIGN_DIFFICULTY || null;
  const profileNames = profileFilter ? [profileFilter] : Object.keys(PROFILES);
  const difficulties = difficultyFilter ? [difficultyFilter] : DIFFICULTIES;

  const combos = [];
  for (const profile of profileNames) {
    for (const difficulty of difficulties) {
      combos.push({ profile, difficulty });
    }
  }

  const localRunners = Array.from({ length: LANES }, () => new LocalRunner({ label: "local", cwd: REPO_ROOT }));
  const sshRunners = await buildSshRunners();
  const runners = [...localRunners, ...sshRunners];

  console.log(
    `Balancing campaign: ${combos.length} combos × ${TARGET_QUALIFYING} qualifying runs, batch size ${BATCH_SIZE}, ` +
      `${localRunners.length} local lane(s) + ${sshRunners.length} SSH lane(s), ${CONCURRENCY_PER_LANE}-way concurrency per lane, ` +
      `${ATTEMPT_CAP} attempt cap/invocation, ${formatElapsed(WATCHDOG_MS)} watchdog.`,
  );
  console.log(`Output: ${RUNS_DIR}\n`);

  await runLaneOrchestrator({
    combos,
    comboKey,
    scanExisting,
    targetQualifying: TARGET_QUALIFYING,
    outputPathFor,
    logPathFor,
    envFor,
    scriptPath: TELEMETRY_SCRIPT,
    runners,
    watchdogMs: WATCHDOG_MS,
    sigtermGraceMs: SIGTERM_GRACE_MS,
    formatElapsed,
  });

  console.log("\nCampaign complete — all combos reached their qualifying-run target.");
}

main().catch((err) => {
  console.error("run-balancing-campaign crashed:", err);
  process.exit(1);
});

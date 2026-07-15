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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
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

function comboKey(profile, difficulty) {
  return `${profile}-${difficulty}`;
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
function scanExisting(profile, difficulty) {
  const prefix = `${comboKey(profile, difficulty)}-`;
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  let qualifying = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      qualifying += data.profiles?.[profile]?.[difficulty]?.qualifyingRunCount ?? 0;
    } catch (err) {
      console.log(`  [campaign] warning: skipping unreadable ${f}: ${err.message}`);
    }
  }
  return { qualifying, fileCount: files.length };
}

function prefixedWrite(stream, chunk, prefix) {
  const text = chunk.toString();
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) stream.write(`${prefix}${line}\n`);
}

/** Spawns one `run-balancing-telemetry.mjs` invocation scoped to a single
 * combo, writing directly to its own unique output path (via
 * CODEENSTEIN_TELEMETRY_OUTPUT_FILE — no shared-file race with other
 * concurrently-running lanes), wrapped in the wall-clock watchdog. Resolves
 * once the child exits (killed or not) — never rejects, so one bad
 * invocation can't take down the whole campaign loop. */
function runOneInvocation(profile, difficulty, sequence) {
  return new Promise((resolve) => {
    const fileBase = `${comboKey(profile, difficulty)}-${String(sequence).padStart(3, "0")}`;
    const outputPath = path.join(RUNS_DIR, `${fileBase}.json`);
    const logPath = path.join(LOGS_DIR, `${fileBase}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const prefix = `[${comboKey(profile, difficulty)} #${sequence}] `;

    const env = {
      ...process.env,
      CODEENSTEIN_TELEMETRY_PROFILE: profile,
      CODEENSTEIN_TELEMETRY_DIFFICULTY: difficulty,
      CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET: String(BATCH_SIZE),
      CODEENSTEIN_TELEMETRY_ATTEMPT_CAP: String(ATTEMPT_CAP),
      CODEENSTEIN_TELEMETRY_CONCURRENCY: String(CONCURRENCY_PER_LANE),
      CODEENSTEIN_TELEMETRY_OUTPUT_FILE: outputPath,
    };
    delete env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT; // always the full campaign for this data-collection run

    const startedAt = Date.now();
    const child = spawn(process.execPath, [TELEMETRY_SCRIPT], { cwd: REPO_ROOT, env });

    let settled = false;
    let killedForTimeout = false;

    child.stdout.on("data", (chunk) => {
      prefixedWrite(process.stdout, chunk, prefix);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      prefixedWrite(process.stderr, chunk, prefix);
      logStream.write(chunk);
    });

    const watchdog = setTimeout(() => {
      if (settled) return;
      killedForTimeout = true;
      console.log(`${prefix}WATCHDOG: exceeded ${WATCHDOG_MS}ms — sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          console.log(`${prefix}WATCHDOG: still alive ${SIGTERM_GRACE_MS}ms after SIGTERM — sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, SIGTERM_GRACE_MS);
    }, WATCHDOG_MS);

    child.on("exit", (code, signal) => {
      settled = true;
      clearTimeout(watchdog);
      logStream.end();
      resolve({ code, signal, killedForTimeout, elapsedMs: Date.now() - startedAt, outputPath });
    });

    child.on("error", (err) => {
      settled = true;
      clearTimeout(watchdog);
      logStream.end();
      console.log(`${prefix}spawn error: ${err.message}`);
      resolve({ code: null, signal: null, killedForTimeout: false, elapsedMs: Date.now() - startedAt, outputPath, spawnError: err.message });
    });
  });
}

function formatElapsed(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

/** Drives one combo's queue of invocations until it reaches
 * TARGET_QUALIFYING or is told to stop. Runs as one of LANES concurrent
 * lanes, each pulling combos off the shared queue as they free up. */
async function driveCombo(profile, difficulty) {
  for (;;) {
    const { qualifying, fileCount } = scanExisting(profile, difficulty);
    if (qualifying >= TARGET_QUALIFYING) {
      console.log(`[${comboKey(profile, difficulty)}] done — ${qualifying}/${TARGET_QUALIFYING} qualifying across ${fileCount} files`);
      return;
    }
    const sequence = fileCount + 1;
    console.log(
      `[${comboKey(profile, difficulty)}] starting invocation #${sequence} (${qualifying}/${TARGET_QUALIFYING} qualifying so far)`,
    );
    const result = await runOneInvocation(profile, difficulty, sequence);
    if (result.killedForTimeout) {
      console.log(`[${comboKey(profile, difficulty)}] invocation #${sequence} KILLED by watchdog after ${formatElapsed(result.elapsedMs)} — retrying`);
      // Nothing was written (run-balancing-telemetry.mjs only writes once,
      // at the very end) — the next loop iteration's scanExisting() will
      // simply not see this sequence number, and the next invocation reuses
      // it (fileCount didn't grow), so no gap is left in the sequence.
      continue;
    }
    if (result.code !== 0) {
      console.log(
        `[${comboKey(profile, difficulty)}] invocation #${sequence} exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""} after ${formatElapsed(result.elapsedMs)}${result.spawnError ? ` — ${result.spawnError}` : ""} — retrying`,
      );
      continue;
    }
    const written = fs.existsSync(result.outputPath);
    console.log(
      `[${comboKey(profile, difficulty)}] invocation #${sequence} finished in ${formatElapsed(result.elapsedMs)}${written ? "" : " (no output file — treating as failed, retrying)"}`,
    );
  }
}

async function runLane(queue) {
  for (;;) {
    const combo = queue.shift();
    if (!combo) return;
    await driveCombo(combo.profile, combo.difficulty);
  }
}

async function main() {
  ensureDirs();

  // Scope the campaign itself to a subset of combos — useful for a quick
  // smoke test, or for resuming just one lagging combo later without
  // re-scanning (harmlessly) every other already-finished combo too.
  // Distinct from CODEENSTEIN_TELEMETRY_PROFILE/_DIFFICULTY, which this
  // script doesn't read directly — those are set explicitly per spawned
  // invocation's own env in runOneInvocation() instead.
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

  console.log(
    `Balancing campaign: ${combos.length} combos × ${TARGET_QUALIFYING} qualifying runs, batch size ${BATCH_SIZE}, ` +
      `${LANES} lane(s), ${CONCURRENCY_PER_LANE}-way concurrency per lane, ${ATTEMPT_CAP} attempt cap/invocation, ` +
      `${formatElapsed(WATCHDOG_MS)} watchdog.`,
  );
  console.log(`Output: ${RUNS_DIR}\n`);

  const queue = [...combos];
  await Promise.all(Array.from({ length: LANES }, () => runLane(queue)));

  console.log("\nCampaign complete — all combos reached their qualifying-run target.");
}

main().catch((err) => {
  console.error("run-balancing-campaign crashed:", err);
  process.exit(1);
});

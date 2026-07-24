// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Multiplayer sibling of `run-balancing-campaign.mjs`: repeatedly spawns
 * `scripts/run-balancing-telemetry-multiplayer.mjs`, each invocation scoped
 * to exactly one profile-combo × difficulty × player-count combo (via that
 * script's own `CODEENSTEIN_MP_TELEMETRY_COMBO_PROFILES`/`_DIFFICULTY`), one
 * per spawned OS process, keeping each invocation's own output as its own
 * file under `balancing_runs_multiplayer/` — the same resumable,
 * scan-existing-files design `run-balancing-campaign.mjs` already uses,
 * shared via `scripts/lib/laneOrchestrator.mjs`.
 *
 * Exists because `run-balancing-telemetry-multiplayer.mjs` on its own has no
 * lane/orchestrator layer at all: one monolithic process iterating every
 * combo in sequence, writing one shared JSON only once at the very end —
 * a real, unbounded combo (a weak profile at Hard difficulty, say) can eat
 * hours with zero incremental progress saved, and a kill loses every
 * already-finished combo along with the stuck one. Splitting each combo
 * into its own spawned invocation/file fixes both at once: a crash or kill
 * only ever costs the one in-flight invocation, and separate lanes (local
 * `child_process`es, or SSH hosts via `scripts/lib/sshRunner.mjs` — see
 * `ssh-hosts.env.dist`) can work through different combos in parallel.
 *
 * Local lane count defaults to 1, not `run-balancing-campaign.mjs`'s 2:
 * every local invocation starts its own isolated signaling+dev server pair
 * on the same fixed ports (`scripts/lib/multiplayerTestServers.mjs`,
 * 8788/5174) — two *local* lanes running concurrently would collide on
 * those ports today (no per-lane port allocation exists yet). SSH lanes
 * don't have this problem (each is its own remote machine), so real
 * parallelism here is expected to come from `ssh-hosts.env`, not raising
 * `CODEENSTEIN_MP_CAMPAIGN_LANES`.
 *
 * Usage: `npm run balancing:campaign-multiplayer`. Not CI-wired — a
 * long-running, unattended background job, same as `balancing:campaign`.
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { LocalRunner, runLaneOrchestrator } from "./lib/laneOrchestrator.mjs";
import { buildSshRunners } from "./lib/sshRunner.mjs";
import { PROFILES, DIFFICULTIES } from "./run-balancing-telemetry.mjs";
import { curateMixedProfiles } from "./run-balancing-telemetry-multiplayer.mjs";

const TELEMETRY_SCRIPT = path.join(REPO_ROOT, "scripts/run-balancing-telemetry-multiplayer.mjs");
const RUNS_DIR = path.join(REPO_ROOT, "balancing_runs_multiplayer");
const LOGS_DIR = path.join(RUNS_DIR, "logs");

// How many qualifying runs each combo needs before it's considered done.
// Much smaller than run-balancing-campaign.mjs's default (50) — real
// wall-clock cost per attempt here (no virtual clock, real Web-Worker-timer
// pacing) is on the order of minutes, not near-free, per
// run-balancing-telemetry-multiplayer.mjs's own doc comment.
const TARGET_QUALIFYING = process.env.CODEENSTEIN_MP_CAMPAIGN_TARGET ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_TARGET) : 10;
// Qualifying runs collected per single spawned invocation/file.
const BATCH_SIZE = process.env.CODEENSTEIN_MP_CAMPAIGN_BATCH_SIZE ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_BATCH_SIZE) : 2;
// Real lesson from this session: an unbounded attempt cap let one genuinely
// low-qualifying-rate combo (Casual/Hard/2p) run 50+ real attempts before
// anyone could tell it apart from a hang. A real cap here means a combo
// that blows through it just resumes on the next invocation instead of
// silently consuming the whole campaign's wall-clock budget.
const ATTEMPT_CAP = process.env.CODEENSTEIN_MP_CAMPAIGN_ATTEMPT_CAP ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_ATTEMPT_CAP) : 30;
// Internal attempt concurrency *within* one spawned invocation — kept at the
// underlying script's own conservative default (1); see its own doc comment
// on why raising this is a real, unmeasured resource-contention risk.
const CONCURRENCY_PER_LANE = process.env.CODEENSTEIN_MP_CAMPAIGN_CONCURRENCY ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_CONCURRENCY) : 1;
// See this file's own top doc comment for why this defaults to 1, not 2.
const LANES = process.env.CODEENSTEIN_MP_CAMPAIGN_LANES ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_LANES) : 1;
// Real per-attempt cost (minutes) × ATTEMPT_CAP means a single invocation's
// worst-case legitimate runtime is measured in hours, not the single-player
// campaign's ~50 minutes — a generous ceiling above that.
const WATCHDOG_MS = process.env.CODEENSTEIN_MP_CAMPAIGN_WATCHDOG_MS ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_WATCHDOG_MS) : 4 * 60 * 60 * 1000;
const SIGTERM_GRACE_MS = 5000;

function playerCountLabel(n) {
  return `${n}p`;
}

function comboKey(combo) {
  return `${combo.label}-${combo.difficulty}-${playerCountLabel(combo.playerCount)}`;
}

/** The key `run-balancing-telemetry-multiplayer.mjs`'s own output uses
 * (`${label}/${difficulty}/${playerCountLabel}`) — distinct from
 * `comboKey` above only in using `/` instead of `-` (a JSON object key
 * doesn't need to be filesystem-safe; a filename does). */
function comboReportKey(combo) {
  return `${combo.label}/${combo.difficulty}/${playerCountLabel(combo.playerCount)}`;
}

function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/** Same role as run-balancing-campaign.mjs's own `scanExisting` — sums
 * `qualifyingRunCount` across every previously-saved file for this combo,
 * the sole source of resumability state. */
function scanExisting(combo) {
  const prefix = `${comboKey(combo)}-`;
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  const key = comboReportKey(combo);
  let qualifying = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8"));
      qualifying += data.combos?.[key]?.qualifyingRunCount ?? 0;
    } catch (err) {
      console.log(`  [campaign-mp] warning: skipping unreadable ${f}: ${err.message}`);
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

function envFor(combo, sequence, outputPath) {
  const env = {
    ...process.env,
    CODEENSTEIN_MP_TELEMETRY_COMBO_PROFILES: combo.profileNames.join(","),
    CODEENSTEIN_MP_TELEMETRY_DIFFICULTY: combo.difficulty,
    CODEENSTEIN_MP_TELEMETRY_QUALIFYING_TARGET: String(BATCH_SIZE),
    CODEENSTEIN_MP_TELEMETRY_ATTEMPT_CAP: String(ATTEMPT_CAP),
    CODEENSTEIN_MP_TELEMETRY_CONCURRENCY: String(CONCURRENCY_PER_LANE),
    CODEENSTEIN_MP_TELEMETRY_OUTPUT_FILE: outputPath,
  };
  // Superseded by COMBO_PROFILES for a pinned combo — see that env var's own
  // doc comment in run-balancing-telemetry-multiplayer.mjs.
  delete env.CODEENSTEIN_MP_TELEMETRY_PROFILE;
  delete env.CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS;
  return env;
}

function formatElapsed(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

/** Same shape as run-balancing-telemetry-multiplayer.mjs's own matrix
 * (uniform combos for every profile tier, plus curated mixed-skill combos,
 * across every difficulty × player-count) — flattened into one list of
 * `{label, difficulty, playerCount, profileNames}` combos this orchestrator
 * can each spawn as its own invocation. `CODEENSTEIN_MP_CAMPAIGN_PROFILE`
 * scopes to one tier (disabling mixed combos, same convention as every
 * other filter in this family); `_DIFFICULTY`/`_PLAYER_COUNTS` scope the
 * other two dimensions independently. */
function buildCombos() {
  const profileFilter = process.env.CODEENSTEIN_MP_CAMPAIGN_PROFILE || null;
  const difficultyFilter = process.env.CODEENSTEIN_MP_CAMPAIGN_DIFFICULTY || null;
  const playerCounts = process.env.CODEENSTEIN_MP_CAMPAIGN_PLAYER_COUNTS
    ? process.env.CODEENSTEIN_MP_CAMPAIGN_PLAYER_COUNTS.split(",").map((s) => Number(s.trim()))
    : [2, 3, 4];

  const profileNames = profileFilter ? [profileFilter] : Object.keys(PROFILES);
  const difficulties = difficultyFilter ? [difficultyFilter] : DIFFICULTIES;
  const allTierNames = Object.keys(PROFILES);

  const combos = [];
  for (const difficulty of difficulties) {
    for (const playerCount of playerCounts) {
      for (const name of profileNames) {
        combos.push({ label: name, difficulty, playerCount, profileNames: Array(playerCount).fill(name) });
      }
      if (!profileFilter) {
        for (const mix of curateMixedProfiles(allTierNames, playerCount)) {
          combos.push({ label: mix.join("+"), difficulty, playerCount, profileNames: mix });
        }
      }
    }
  }
  return combos;
}

async function main() {
  ensureDirs();

  const combos = buildCombos();
  const localRunners = Array.from({ length: LANES }, () => new LocalRunner({ label: "local", cwd: REPO_ROOT }));
  const sshRunners = await buildSshRunners();
  const runners = [...localRunners, ...sshRunners];

  console.log(
    `Multiplayer balancing campaign: ${combos.length} combos × ${TARGET_QUALIFYING} qualifying runs, batch size ${BATCH_SIZE}, ` +
      `${localRunners.length} local lane(s) + ${sshRunners.length} SSH lane(s), ${ATTEMPT_CAP} attempt cap/invocation, ` +
      `${formatElapsed(WATCHDOG_MS)} watchdog.`,
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
  console.error("run-balancing-campaign-multiplayer crashed:", err);
  process.exit(1);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Multiplayer sibling of `run-balancing-telemetry.mjs` — step 11 (Phase 1) of
 * `doc/dev/multiplayer-balancing-telemetry-spec.md`. Drives N (2-4)
 * simultaneous `MultiplayerBot` instances through one real, live multiplayer
 * session per attempt, against the spec's own dedicated isolated signaling +
 * dev server pair (`scripts/lib/multiplayerTestServers.mjs`), and writes
 * aggregated telemetry to `multiplayer_balancing_telemetry.json`.
 *
 * **Phase 1 MVP scope, deliberately narrower than the full spec** (later
 * phases fill these in — see `multiplayer-step11-state.md`):
 *  - **One bundled level per run, not the full campaign.** Multiplayer level
 *    transition (all players reaching the exit, the host-authoritative
 *    countdown, the next level generating) is already covered on its own by
 *    `verify-multiplayer-transition.mjs` — re-driving that whole sequence
 *    here for every combo would multiply this tool's already-real-time-only
 *    cost for no new signal. A run's own "qualifying" condition is simply
 *    every bot reaching the exit tile alive (`teamOutcome ===
 *    "allReachedExit"`) — mirrors single-player's own "reached a target
 *    level" qualifying convention, just scoped to one level instead of one
 *    of several campaign milestones.
 *  - **Coarse gameplay-health signals only, not the full 7-category
 *    per-player breakdown.** `RaycasterEngine.getMultiplayerTelemetrySnapshot(id)`
 *    doesn't exist yet — that's Phase 2a. This script instead reads what's
 *    already exposed today: `getBotPlayerState(id)` (health/ammo/position/
 *    distance), `getEnemiesSnapshot()` (a team-wide before/after alive-count
 *    kill estimate — not per-player-attributable without Phase 2a), plus its
 *    own fps/tick-skew sampling (the same technique
 *    `verify-multiplayer-multiguest.mjs` already uses informationally).
 *  - **`netcodeHealth` (ping/RTT, missed ticks, reconciliation corrections)
 *    is Phase 2b** — not present in this report yet.
 *  - **Uniform bot-skill profiles only** (one `PROFILES` entry applied to
 *    every bot in a run) — the curated mixed-skill combos are Phase 3.
 *
 * No virtual clock exists for multiplayer (`multiplayerBot.mjs`'s own doc
 * comment) — every attempt costs real wall-clock time, so this script's
 * defaults are deliberately modest (sequential attempts, a small qualifying
 * target) rather than copying single-player's cheap virtual-time
 * concurrency. Not CI-wired, not fast — run manually
 * (`npm run balancing:telemetry-multiplayer`) against no pre-existing dev
 * server: this script always starts its own isolated signaling+dev server
 * pair (`scripts/lib/multiplayerTestServers.mjs`) rather than share whatever
 * a developer's own manual session is pointed at (signaling-server rate
 * limits are per-IP, not per-session — see that module's own doc comment).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { PROFILES, DIFFICULTIES } from "./run-balancing-telemetry.mjs";
import { MultiplayerBot } from "./lib/multiplayerBot.mjs";
import { runQualifyLoop } from "./lib/qualifyLoop.mjs";
import { bootstrapMultiplayerSession, closeMultiplayerSession } from "./lib/multiplayerSessionBootstrap.mjs";
import { startIsolatedMultiplayerServers } from "./lib/multiplayerTestServers.mjs";

const OUTPUT_FILE = process.env.CODEENSTEIN_MP_TELEMETRY_OUTPUT_FILE
  ? path.resolve(process.env.CODEENSTEIN_MP_TELEMETRY_OUTPUT_FILE)
  : path.join(REPO_ROOT, "multiplayer_balancing_telemetry.json");

const PROFILE_FILTER = process.env.CODEENSTEIN_MP_TELEMETRY_PROFILE || null;
const DIFFICULTY_FILTER = process.env.CODEENSTEIN_MP_TELEMETRY_DIFFICULTY || null;
const PLAYER_COUNTS = process.env.CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS
  ? process.env.CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS.split(",").map((s) => Number(s.trim()))
  : [2, 3, 4];

// Real wall-clock cost per attempt (bootstrap + a full level's worth of BFS
// legs at MultiplayerBot's real ~400ms/decision pace) means even a "small"
// target here is a genuinely meaningful sample — see this file's own doc
// comment for why these are much smaller than single-player's own defaults.
const REQUIRED_QUALIFYING_RUNS = process.env.CODEENSTEIN_MP_TELEMETRY_QUALIFYING_TARGET
  ? Number(process.env.CODEENSTEIN_MP_TELEMETRY_QUALIFYING_TARGET)
  : 2;
const ATTEMPT_CAP = process.env.CODEENSTEIN_MP_TELEMETRY_ATTEMPT_CAP ? Number(process.env.CODEENSTEIN_MP_TELEMETRY_ATTEMPT_CAP) : Infinity;
// Modest by default (sequential) — several concurrent real multiplayer
// sessions against one dedicated signaling+dev server pair is a real
// resource-contention risk this tool hasn't been measured against; raise
// deliberately, not by copying single-player's cheap virtual-time default.
const CONCURRENCY = process.env.CODEENSTEIN_MP_TELEMETRY_CONCURRENCY ? Number(process.env.CODEENSTEIN_MP_TELEMETRY_CONCURRENCY) : 1;
const VERBOSE = process.env.CODEENSTEIN_MP_TELEMETRY_VERBOSE === "1";
const NAV_DIAG = process.env.CODEENSTEIN_MP_TELEMETRY_NAV_DIAG === "1";
// Same "free anomaly detection" wiring `run-balancing-telemetry.mjs` uses —
// see spec §5: the existing Bot stall/frozen-health/rotation detectors work
// for MultiplayerBot unchanged, they just need the trace collector turned on.
const ANOMALY_SCAN = process.env.CODEENSTEIN_MP_TELEMETRY_ANOMALY_SCAN === "1" || NAV_DIAG;
const HEADED = process.env.CODEENSTEIN_MP_TELEMETRY_HEADED === "1";
const PROGRESS_LOG_INTERVAL = 2; // attempts between "still working" heartbeats — real-time cost means far fewer attempts per combo than single-player.

const TARGET_TICK = 60; // matches verify-multiplayer-multiguest.mjs's own default: 2s of ticking, comfortably past session bootstrap.
const FINAL_APPROACH_TICKS = 80; // same constant/value as run-balancing-telemetry.mjs's own, though each "tick" here is a real ~400ms MultiplayerBot decision, not a virtual one.
const SAMPLER_INTERVAL_FPS_WINDOW_MS = 300; // short fps sample window so the background health/perf sampler stays responsive rather than blocking a full 1s each iteration.

const PLAYER_COUNT_LABEL = (n) => `${n}p`;

// ---------------------------------------------------------------------------
// Background per-attempt health/perf sampler
// ---------------------------------------------------------------------------

/** Real render-fps sample — identical technique to
 * `verify-multiplayer-multiguest.mjs`'s own `sampleFps` (duplicated, not
 * imported: that's a script, not a shared lib, matching this project's
 * "each script owns its own bookkeeping" convention for this kind of small
 * self-contained helper). */
async function sampleFps(page, durationMs) {
  return page
    .evaluate(
      (durationMs) =>
        new Promise((resolve) => {
          let frames = 0;
          const start = performance.now();
          function tick() {
            frames++;
            const elapsed = performance.now() - start;
            if (elapsed < durationMs) requestAnimationFrame(tick);
            else resolve(Math.round((frames * 1000) / elapsed));
          }
          requestAnimationFrame(tick);
        }),
      durationMs,
    )
    .catch(() => null); // a page that's gone mid-sample (context closed by another concurrent path) shouldn't crash the whole sampler.
}

/**
 * Runs a background polling loop alongside the bots' own driving, gathering
 * three real-time-only signals no virtual-clock replay could substitute for:
 * real render fps per player, real simulation-tick skew between every pair
 * of peers (`verify-multiplayer-multiguest.mjs`'s own `sampleTickSkewMs`
 * technique, generalized to every pair instead of a fixed 3-peer set), and
 * the minimum `healthFraction` each bot is ever observed at (a coarse
 * "how close did this run come to a death" proxy — `minHealthReached` proper
 * is Phase 2a's `TelemetryState`, not available yet). Call `stop()` once the
 * bots are done driving; it resolves only after the loop's current iteration
 * finishes, so the returned samples are never read mid-append.
 */
function createHealthPerfSampler(pages, playerIds) {
  const fpsSamples = Object.fromEntries(playerIds.map((id) => [id, []]));
  const healthFractionMin = Object.fromEntries(playerIds.map((id) => [id, 1]));
  const tickSkewSamples = {};
  const pairs = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const key = `${playerIds[i]}<->${playerIds[j]}`;
      pairs.push({ key, a: i, b: j });
      tickSkewSamples[key] = [];
    }
  }

  let stopped = false;
  const loopPromise = (async () => {
    while (!stopped) {
      const healthFractions = await Promise.all(
        pages.map((page, i) =>
          page
            .evaluate((id) => window.__codeensteinMultiplayerTestHooks?.getBotPlayerState(id)?.healthFraction ?? null, playerIds[i])
            .catch(() => null),
        ),
      );
      healthFractions.forEach((hf, i) => {
        if (typeof hf === "number") healthFractionMin[playerIds[i]] = Math.min(healthFractionMin[playerIds[i]], hf);
      });

      const fps = await Promise.all(pages.map((page) => sampleFps(page, SAMPLER_INTERVAL_FPS_WINDOW_MS)));
      fps.forEach((f, i) => {
        if (typeof f === "number") fpsSamples[playerIds[i]].push(f);
      });

      const ticks = await Promise.all(
        pages.map((page) => page.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getSimTick() ?? null).catch(() => null)),
      );
      for (const { key, a, b } of pairs) {
        if (typeof ticks[a] === "number" && typeof ticks[b] === "number") {
          tickSkewSamples[key].push(Math.abs(ticks[a] - ticks[b]) * (1000 / 30)); // TICK_RATE_HZ
        }
      }
    }
  })();

  return {
    fpsSamples,
    healthFractionMin,
    tickSkewSamples,
    async stop() {
      stopped = true;
      await loopPromise;
    },
  };
}

// ---------------------------------------------------------------------------
// One bot's own drive
// ---------------------------------------------------------------------------

/**
 * Drives one `MultiplayerBot` from wherever the engine actually spawned it
 * (read live, not assumed from `map.multiplayerSpawns` ourselves — the
 * engine's own `spawnFor()` roster-order assignment is the source of truth)
 * to the level's exit tile. Returns `{playerId, outcome, ...}` —
 * `outcome` is one of `"reachedExit"` (this bot's own qualifying condition),
 * `"died"`, `"stuck"` (ran out of the route/approach's own tick budget),
 * `"notPlaying"` (already not playing before driving even started — e.g. an
 * immediate elimination), or `"routeFailed"` (no BFS path from this bot's
 * live spawn to the exit — a real, if rare, map-generation edge case worth
 * surfacing rather than silently skipping).
 */
async function driveOneBot(page, playerId, profile, map, label) {
  const bot = new MultiplayerBot(page, profile, playerId, {
    logger: { trace: ANOMALY_SCAN, navDiag: NAV_DIAG },
  });
  bot.startLevel(map);

  const player0 = await bot.readState();
  if (player0.state !== "playing") {
    return { playerId, outcome: "notPlaying", detail: player0.state, distanceTraveled: 0, finalHealthFraction: player0.healthFraction };
  }

  const liveSpawnTile = { x: Math.floor(player0.x), y: Math.floor(player0.y) };
  const route = planRoute({ ...map, spawn: liveSpawnTile });
  if (!route.ok) {
    return { playerId, outcome: "routeFailed", detail: route.reason, distanceTraveled: 0, finalHealthFraction: player0.healthFraction };
  }

  let finalState = await bot.driveLegs(route.legs);
  if (finalState.state === "playing") {
    const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
    finalState = await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
  }
  bot.reportAnomalies(label, 0); // levelIndex is always 0 here — one level per run, see this file's own doc comment.

  const finalPlayer = await bot.readState();
  const outcome = finalState.state === "over" ? "died" : finalState.reason === "arrived" ? "reachedExit" : "stuck";
  return {
    playerId,
    outcome,
    finalHealthFraction: finalPlayer.healthFraction,
    distanceTraveled: finalPlayer.distanceTraveled,
    levelTime: finalPlayer.levelTime,
  };
}

// ---------------------------------------------------------------------------
// One full attempt: bootstrap a real session, drive every bot, tear down
// ---------------------------------------------------------------------------

async function runOneAttempt(browser, devServerUrl, profileName, profile, difficulty, playerCount) {
  let session;
  try {
    session = await bootstrapMultiplayerSession(browser, {
      engineName: "chromium",
      devServerUrl,
      playerCount,
      difficulty,
      targetTick: TARGET_TICK,
      log: VERBOSE ? (msg) => console.log(`  [bootstrap] ${msg}`) : () => {},
    });
    const { pages, playerIds } = session;
    const label = `${profileName}/${difficulty}/${PLAYER_COUNT_LABEL(playerCount)}`;

    const map = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getMap());
    const enemiesBefore = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getEnemiesSnapshot());
    const aliveBefore = enemiesBefore.filter((e) => e.alive).length;

    const sampler = createHealthPerfSampler(pages, playerIds);
    let perPlayer;
    try {
      perPlayer = await Promise.all(pages.map((page, i) => driveOneBot(page, playerIds[i], profile, map, label)));
    } finally {
      // Must run even if a bot's own drive throws — otherwise the sampler's
      // background polling loop never learns to stop and spins forever
      // against pages this attempt is about to close.
      await sampler.stop();
    }

    const enemiesAfter = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getEnemiesSnapshot()).catch(() => enemiesBefore);
    const aliveAfter = enemiesAfter.filter((e) => e.alive).length;

    const outcomes = perPlayer.map((p) => p.outcome);
    const teamOutcome = outcomes.every((o) => o === "reachedExit")
      ? "allReachedExit"
      : outcomes.every((o) => o === "died" || o === "notPlaying")
        ? "teamWiped"
        : "partial";

    await closeMultiplayerSession(session);
    return {
      playerCount,
      teamOutcome,
      reason: teamOutcome, // qualifyLoop's own failureReasons bookkeeping convention — see run-balancing-telemetry.mjs's identical `run.reason` usage.
      perPlayer,
      // Team-wide only — not per-player-attributable without Phase 2a's
      // per-player kill tracking (assist/finishing-blow can't be told apart
      // from a bare alive-count delta).
      enemiesKilledEstimate: Math.max(0, aliveBefore - aliveAfter),
      fpsSamples: sampler.fpsSamples,
      healthFractionMin: sampler.healthFractionMin,
      tickSkewSamples: sampler.tickSkewSamples,
    };
  } catch (err) {
    // Same discarded-non-qualifying-attempt shape as
    // run-balancing-telemetry.mjs's own runOneAttempt — a single flaky
    // context/page/session must not take down the whole combo.
    console.log(`  [attempt crashed] ${err.message}`);
    if (session) await closeMultiplayerSession(session).catch(() => {});
    return { playerCount, teamOutcome: "crashed", reason: `attemptCrashed: ${err.message}`, perPlayer: [] };
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/** Same `{mean|max|min: value, samples}` convention as
 * `run-balancing-telemetry.mjs`'s own `spread()` — kept as a small local
 * duplicate rather than an import (that module doesn't export it, and this
 * report's own aggregation shape is genuinely different enough — top-level
 * per-combo keys instead of per-level — that sharing the helper isn't worth
 * a cross-module export just for this one function). */
function spread(nums, kind) {
  const finite = nums.filter((n) => Number.isFinite(n));
  const value = finite.length === 0 ? 0 : kind === "max" ? Math.max(...finite) : kind === "min" ? Math.min(...finite) : mean(finite);
  return { [kind]: value, samples: nums };
}

function buildComboOutput(combo) {
  const { qualifyingRuns, attemptsUsed, failureReasons, trueQualifyingCount } = combo;

  const outcomeTally = {};
  for (const r of [...qualifyingRuns, ...failureReasons]) {
    const key = r.teamOutcome ?? r.reason ?? "unknown";
    outcomeTally[key] = (outcomeTally[key] ?? 0) + 1;
  }

  const playerIds = qualifyingRuns[0]?.perPlayer.map((p) => p.playerId) ?? [];
  const minHealthFractionByPlayer = {};
  const fpsByPlayer = {};
  for (const id of playerIds) {
    minHealthFractionByPlayer[id] = spread(
      qualifyingRuns.map((r) => r.healthFractionMin[id]).filter((v) => v !== undefined),
      "min",
    );
    fpsByPlayer[id] = spread(
      qualifyingRuns.flatMap((r) => r.fpsSamples[id] ?? []),
      "mean",
    );
  }
  const tickSkewMsByPair = {};
  for (const key of Object.keys(qualifyingRuns[0]?.tickSkewSamples ?? {})) {
    tickSkewMsByPair[key] = spread(
      qualifyingRuns.flatMap((r) => r.tickSkewSamples[key] ?? []),
      "mean",
    );
  }

  return {
    attemptsUsed,
    qualifyingRunCount: qualifyingRuns.length,
    // Same divergence-from-the-sample-size-trim caveat as
    // run-balancing-telemetry.mjs's own `trueQualifyingCount` — use this,
    // not qualifyingRunCount, for a true qualifying-rate stat.
    trueQualifyingCount,
    failureReasons,
    gameplayHealth: {
      outcomeTally,
      enemiesKilledEstimate: spread(
        qualifyingRuns.map((r) => r.enemiesKilledEstimate),
        "mean",
      ),
      minHealthFractionByPlayer,
    },
    perf: {
      fpsByPlayer,
      tickSkewMsByPair,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  for (const n of PLAYER_COUNTS) {
    if (!Number.isInteger(n) || n < 2 || n > 4) {
      throw new Error(`CODEENSTEIN_MP_TELEMETRY_PLAYER_COUNTS: every entry must be an integer 2-4, got "${n}"`);
    }
  }

  console.log("Starting an isolated multiplayer signaling+dev server pair (not sharing any manually-run dev session)...");
  const servers = await startIsolatedMultiplayerServers();
  console.log(`  dev server:       ${servers.devServerUrl}`);
  console.log(`  signaling server: ${servers.signalingServerUrl}`);

  const profileNames = PROFILE_FILTER ? [PROFILE_FILTER] : Object.keys(PROFILES);
  const difficulties = DIFFICULTY_FILTER ? [DIFFICULTY_FILTER] : DIFFICULTIES;

  const browser = await chromium.launch({ headless: !HEADED });
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      scope: "Phase 1 MVP — one bundled demo-campaign level per run, coarse gameplay-health signals only. No full 7-category per-player telemetry (Phase 2a) or netcodeHealth (Phase 2b) yet — see doc/dev/multiplayer-balancing-telemetry-spec.md.",
      difficulties: DIFFICULTIES,
      playerCounts: PLAYER_COUNTS,
      profiles: PROFILES,
      requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
    },
    combos: {},
  };

  try {
    for (const profileName of profileNames) {
      const profile = PROFILES[profileName];
      for (const difficulty of difficulties) {
        for (const playerCount of PLAYER_COUNTS) {
          const key = `${profileName}/${difficulty}/${PLAYER_COUNT_LABEL(playerCount)}`;
          console.log(`\n=== ${key} ===`);
          const combo = await runQualifyLoop({
            runAttempt: () => runOneAttempt(browser, servers.devServerUrl, profileName, profile, difficulty, playerCount),
            isQualifying: (run) => run.teamOutcome === "allReachedExit",
            requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
            attemptCap: ATTEMPT_CAP,
            concurrency: CONCURRENCY,
            onProgress: (attempts, qualifying) => {
              if (attempts % PROGRESS_LOG_INTERVAL === 0) {
                console.log(`  [${key}] still working — attempt ${attempts}, qualifying ${qualifying}/${REQUIRED_QUALIFYING_RUNS}`);
              }
            },
            onAttemptResult: (run, attempts) => {
              if (VERBOSE || run.teamOutcome !== "allReachedExit") {
                console.log(`  [${key}] attempt ${attempts}: ${run.teamOutcome}`);
              }
            },
          });
          output.combos[key] = buildComboOutput(combo);
          console.log(`  qualifying runs: ${combo.qualifyingRuns.length}/${REQUIRED_QUALIFYING_RUNS} (attempts used: ${combo.attemptsUsed})`);
        }
      }
    }
  } finally {
    await browser.close();
    await servers.stop();
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nMultiplayer telemetry saved to ${OUTPUT_FILE}`);
}

// Guarded like run-balancing-telemetry.mjs's own — lets a future script
// import this module's exports without triggering the full combo run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("run-balancing-telemetry-multiplayer crashed:", err);
    process.exit(1);
  });
}

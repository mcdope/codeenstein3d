// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Multiplayer sibling of `run-balancing-telemetry.mjs` — step 11
 * (`doc/dev/multiplayer-balancing-telemetry-spec.md`), Phases 1, 2a, 2b, 3.
 * Drives N (2-4) simultaneous `MultiplayerBot` instances through one real,
 * live multiplayer session per attempt, against the spec's own dedicated
 * isolated signaling + dev server pair
 * (`scripts/lib/multiplayerTestServers.mjs`), and writes aggregated
 * telemetry to `multiplayer_balancing_telemetry.json`.
 *
 * **One bundled level per run, not the full campaign** — the one deliberate
 * scope boundary that stays even with the full spec implemented. Multiplayer
 * level transition (the host-authoritative countdown, the next level
 * generating) is already covered on its own by `verify-multiplayer-
 * transition.mjs` — re-driving that whole sequence here for every combo would
 * multiply this tool's already-real-time-only cost for no new signal. A run's
 * own "qualifying" condition is every bot ending in `"reachedExit"` or
 * `"levelAdvanced"` (`teamOutcome === "allReachedExit"`, see `driveOneBot`'s
 * own doc comment) — mirrors single-player's own "reached a target level"
 * qualifying convention, just scoped to one level instead of one of several
 * campaign milestones.
 *
 * **A level transition can start mid-run even though this tool never asks
 * for one.** `checkExit()` (`engine.ts`) starts the countdown once *any
 * single* alive player touches the exit, not the whole team — a real,
 * intended co-op mechanic ("exit touch is a shared simulation event"), not a
 * bug. Whichever bot's own BFS route finishes first can trigger this while a
 * teammate is still mid-route, silently carrying that teammate to the next
 * level's spawn. Confirmed via live repro: this used to strand the
 * still-driving bot in a real, reproducible ~600-tick stall (exactly
 * `MAX_TICKS_PER_WAYPOINT`) — its own `Bot` instance kept trying to reach a
 * waypoint planned against the *old* level's map, using that same stale map
 * for every navigation decision, on a live position that had actually moved
 * to a different level entirely. Fixed at the shared-code level
 * (`bot.mjs`'s `driveLegs`/`driveTowardWithReplan`/`maybeDetourForLoot` now
 * stop immediately on a mid-route `"teleported"` result instead of
 * continuing) — this file's own `driveOneBot` maps that into the
 * `"levelAdvanced"` outcome described above rather than the generic `"stuck"`
 * it used to fall into.
 *
 * `perPlayerTelemetry` (step 11 Phase 2a/4) reuses
 * `run-balancing-telemetry.mjs`'s own `aggregateLevelRuntime()` unchanged —
 * `RaycasterEngine.getMultiplayerTelemetrySnapshot(id)`'s shape is built from
 * the exact same `buildTelemetrySnapshotFor` field set as single-player's own
 * `getTelemetrySnapshot()`, so the same 7-category breakdown (map density,
 * combat pacing, AI danger, damage/healing, weapon efficiency, economy, nav)
 * applies per-player as-is, minus `routeEfficiencyScore` (each bot spawns at
 * a different tile, so there's no one shortest-path figure for the whole
 * team — left for a future pass rather than shipped as a misleading zero).
 * `netcodeHealth` (RTT, missed-tick fraction, reconciliation corrections) is
 * real, from Phase 2b's session-handle hooks —
 * `getConnectionStats`/`getMissedTickStats`/`getReconciliationCorrections`
 * (`multiplayerSessionHost.ts`/`Guest.ts`). Reconciliation corrections are a
 * guest-only signal (the host is authoritative, never applies a snapshot to
 * itself) — a host's own `reconciliationCorrectionsByPlayer` entries are
 * always `{count: 0, avgMagnitudeTiles: 0}`, not missing data.
 *
 * **Phase 3** (curated mixed-skill combos + two new cross-peer detectors) is
 * also folded in now: when no `CODEENSTEIN_MP_TELEMETRY_PROFILE` filter is
 * set, every player-count's uniform combos (one tier for the whole team) run
 * alongside a curated set of *mixed*-tier combos (see `curateMixedProfiles`)
 * — deliberately not a blind cartesian product across up to 4 slots, that
 * would multiply this tool's already-real-time-only cost for combos with
 * little new signal over their neighbors. A `PROFILE` filter still means
 * "just this one tier," so it disables mixed combos entirely — a filter
 * requesting one specific tier and a curated-mix generator disagreeing about
 * team composition would just be confusing. `perf.tickSkewGrowthByPair` (is
 * skew between a pair of peers actually widening over the run, not just its
 * mean) and a standalone `disconnectIsolation` report section (a real,
 * scored mid-run disconnect — see `runDisconnectIsolationScenario`) round
 * out the report; the latter runs once per invocation, gated by
 * `CODEENSTEIN_MP_TELEMETRY_DISCONNECT_SCENARIO` (default on, disabled in
 * the fast `balancing:scan-multiplayer` preset).
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
import { PROFILES, DIFFICULTIES, aggregateLevelRuntime } from "./run-balancing-telemetry.mjs";
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
// On by default for the full telemetry run — off in the fast
// balancing:scan-multiplayer preset (see package.json), since a real
// disconnect-detection wait (up to DISCONNECT_ISOLATION_DETECT_TIMEOUT_MS)
// would dominate that preset's own runtime budget for one fixed scenario
// that doesn't vary with the rest of the scan's dimensions.
const DISCONNECT_SCENARIO = process.env.CODEENSTEIN_MP_TELEMETRY_DISCONNECT_SCENARIO !== "0";
const PROGRESS_LOG_INTERVAL = 2; // attempts between "still working" heartbeats — real-time cost means far fewer attempts per combo than single-player.

const TARGET_TICK = 60; // matches verify-multiplayer-multiguest.mjs's own default: 2s of ticking, comfortably past session bootstrap.
const FINAL_APPROACH_TICKS = 80; // same constant/value as run-balancing-telemetry.mjs's own, though each "tick" here is a real ~400ms MultiplayerBot decision, not a virtual one.
const SAMPLER_INTERVAL_FPS_WINDOW_MS = 300; // short fps sample window so the background health/perf sampler stays responsive rather than blocking a full 1s each iteration.

const PLAYER_COUNT_LABEL = (n) => `${n}p`;

// ---------------------------------------------------------------------------
// Phase 3 — curated mixed-skill combos
// ---------------------------------------------------------------------------

/**
 * Curated mixed-tier combos for a given player count, as arrays of profile
 * names (index-aligned with `bootstrapMultiplayerSession`'s own roster order
 * — `["host", "guest-1", ...]`). Deliberately NOT a blind cartesian product
 * (`PROFILES.length ** playerCount` combos, most of them redundant with a
 * neighbor): 2p gets only *adjacent*-tier pairs (one tier apart — a
 * same-tier pair is already covered by the uniform combos above, and a
 * two-tier-apart pair like Casual+Pro is less representative of a real co-op
 * pairing than either adjacent pair, while costing the same real wall-clock
 * time as one). 3-4p get a single weakest+strongest+filler shape per size —
 * both tier extremes represented (the combination most likely to surface a
 * carry-or-be-carried balance issue), with the remaining slot(s) filled by
 * the middle tier (repeated for 4p) rather than more copies of either
 * extreme, so the filler doesn't just restate the uniform-Casual or
 * uniform-Pro combo already in the matrix.
 */
export function curateMixedProfiles(tierNames, playerCount) {
  if (tierNames.length < 2) return [];
  const weakest = tierNames[0];
  const strongest = tierNames[tierNames.length - 1];
  const middle = tierNames[Math.floor(tierNames.length / 2)];
  if (playerCount === 2) {
    const pairs = [];
    for (let i = 0; i < tierNames.length - 1; i++) pairs.push([tierNames[i], tierNames[i + 1]]);
    return pairs;
  }
  if (playerCount === 3) return [[weakest, middle, strongest]];
  if (playerCount === 4) return [[weakest, middle, middle, strongest]];
  return [];
}

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
 * four real-time-only signals no virtual-clock replay could substitute for:
 * real render fps per player, real simulation-tick skew between every pair
 * of peers (`verify-multiplayer-multiguest.mjs`'s own `sampleTickSkewMs`
 * technique, generalized to every pair instead of a fixed 3-peer set), the
 * minimum `healthFraction` each bot is ever observed at (a coarse "how close
 * did this run come to a death" proxy — `minHealthReached` proper is Phase
 * 2a's `TelemetryState`, not available yet), and — new in step 11 Phase 2b —
 * round-trip time on every real link this session actually has (star
 * topology: host<->each guest, never guest<->guest). Call `stop()` once the
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

  // RTT links (Phase 2b): star topology — bootstrapMultiplayerSession()
  // always orders playerIds ["host", ...guests], so index 0 is always the
  // host's own page. One directional read per real link, both ways (a
  // guest's own view of its link toward the host is a genuinely different
  // measurement point than the host's view of that same link, not a
  // redundant duplicate — see connectionStats.ts's own doc comment on why
  // there's no single "true" RTT).
  const rttMsSamples = {};
  const rttLinks = [];
  for (let i = 1; i < playerIds.length; i++) {
    const hostToGuestKey = `${playerIds[0]}->${playerIds[i]}`;
    const guestToHostKey = `${playerIds[i]}->${playerIds[0]}`;
    rttLinks.push({ key: hostToGuestKey, readerPageIndex: 0, targetId: playerIds[i] });
    rttLinks.push({ key: guestToHostKey, readerPageIndex: i, targetId: playerIds[0] });
    rttMsSamples[hostToGuestKey] = [];
    rttMsSamples[guestToHostKey] = [];
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

      const rtts = await Promise.all(
        rttLinks.map(({ readerPageIndex, targetId }) =>
          pages[readerPageIndex]
            .evaluate((id) => window.__codeensteinMultiplayerTestHooks?.getConnectionStats(id), targetId)
            .then((stats) => stats?.rttMs ?? null)
            .catch(() => null),
        ),
      );
      rtts.forEach((rttMs, i) => {
        if (typeof rttMs === "number") rttMsSamples[rttLinks[i].key].push(rttMs);
      });
    }
  })();

  return {
    fpsSamples,
    healthFractionMin,
    tickSkewSamples,
    rttMsSamples,
    async stop() {
      stopped = true;
      await loopPromise;
    },
  };
}

/**
 * Reads the two cumulative, session-lifetime netcode counters
 * (`getMissedTickStats`/`getReconciliationCorrections` — step 11 Phase 2b)
 * once per page, at the end of an attempt's own driving — unlike fps/RTT/
 * tick-skew above, these are running totals, not point-in-time samples, so
 * there's nothing gained by polling them throughout the run, only a read
 * right before the session closes.
 */
async function readNetcodeCounters(pages, playerIds) {
  const missedTickStats = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getMissedTickStats() ?? { totalTicks: 0, missedTicksByPlayer: {} }).catch(
        () => ({ totalTicks: 0, missedTicksByPlayer: {} }),
      ),
    ),
  );
  const reconciliationCorrections = await Promise.all(
    pages.map((page) => page.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getReconciliationCorrections() ?? {}).catch(() => ({}))),
  );
  return Object.fromEntries(playerIds.map((id, i) => [id, { missedTicks: missedTickStats[i], reconciliationCorrections: reconciliationCorrections[i] }]));
}

/**
 * Reads `RaycasterEngine.getMultiplayerTelemetrySnapshot(id)` (step 11
 * Phase 2a) for every player, once at the end of an attempt's own driving —
 * same "cumulative session-lifetime state, one read at teardown" reasoning
 * as `readNetcodeCounters` above, not a point-in-time sample. `null` per
 * player is a real, reachable outcome (telemetry recording disabled this
 * run, or the player disconnected before this read) — carried through
 * as-is, filtered out at aggregation time in `buildPerPlayerBreakdown`.
 */
async function readPerPlayerTelemetry(pages, playerIds) {
  const snapshots = await Promise.all(
    pages.map((page, i) => page.evaluate((id) => window.__codeensteinMultiplayerTestHooks?.getMultiplayerTelemetrySnapshot(id) ?? null, playerIds[i]).catch(() => null)),
  );
  return Object.fromEntries(playerIds.map((id, i) => [id, snapshots[i]]));
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
 * `"levelAdvanced"` (a teammate reached the exit first and the whole roster
 * got carried to the next level together — `checkExit()`'s own `.some()`
 * semantics, "exit touch is a shared simulation event," a real, intended
 * co-op mechanic, not a bug — see `bot.mjs`'s `driveLegs` doc comment for the
 * full mechanism; this bot survived and the team cleared the level, exactly
 * as real a team success as personally standing on the exit tile), `"died"`,
 * `"stuck"` (ran out of the route/approach's own tick budget), `"notPlaying"`
 * (already not playing before driving even started — e.g. an immediate
 * elimination), or `"routeFailed"` (no BFS path from this bot's live spawn to
 * the exit — a real, if rare, map-generation edge case worth surfacing
 * rather than silently skipping).
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
  // A "teleported" result here means a teammate already reached the exit and
  // this bot's live position just got carried to the next level's spawn —
  // `map`/`map.exit` are now stale (a different level entirely), so don't
  // keep driving toward them (that's exactly the bug this outcome exists to
  // avoid: real repro showed a bot grinding ~600 ticks trying to reach a
  // now-meaningless waypoint on the wrong level's geometry).
  if (finalState.state === "playing" && finalState.reason !== "teleported") {
    const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
    finalState = await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
  }
  bot.reportAnomalies(label, 0); // levelIndex is always 0 here — one level per run, see this file's own doc comment.

  const finalPlayer = await bot.readState();
  const outcome =
    finalState.state === "over"
      ? "died"
      : finalState.reason === "arrived"
        ? "reachedExit"
        : finalState.reason === "teleported"
          ? "levelAdvanced"
          : "stuck";
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

async function runOneAttempt(browser, devServerUrl, comboLabel, profilesByPlayer, difficulty, playerCount) {
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
    const label = `${comboLabel}/${difficulty}/${PLAYER_COUNT_LABEL(playerCount)}`;

    const map = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getMap());
    const enemiesBefore = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getEnemiesSnapshot());
    const aliveBefore = enemiesBefore.filter((e) => e.alive).length;

    const sampler = createHealthPerfSampler(pages, playerIds);
    let perPlayer;
    try {
      perPlayer = await Promise.all(pages.map((page, i) => driveOneBot(page, playerIds[i], profilesByPlayer[i], map, label)));
    } finally {
      // Must run even if a bot's own drive throws — otherwise the sampler's
      // background polling loop never learns to stop and spins forever
      // against pages this attempt is about to close.
      await sampler.stop();
    }

    const enemiesAfter = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getEnemiesSnapshot()).catch(() => enemiesBefore);
    const aliveAfter = enemiesAfter.filter((e) => e.alive).length;

    // Read once, right before teardown — see readNetcodeCounters's own doc
    // comment for why these two are a single end-of-run read, unlike the
    // sampler's own point-in-time polling above.
    const netcodeCounters = await readNetcodeCounters(pages, playerIds);
    const perPlayerTelemetry = await readPerPlayerTelemetry(pages, playerIds);

    const outcomes = perPlayer.map((p) => p.outcome);
    // "levelAdvanced" counts the same as "reachedExit" here — both mean this
    // player survived and the team cleared the level (see driveOneBot's own
    // doc comment on why a teammate-triggered level advance is exactly as
    // real a team success as personally standing on the exit tile).
    const teamOutcome = outcomes.every((o) => o === "reachedExit" || o === "levelAdvanced")
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
      rttMsSamples: sampler.rttMsSamples,
      netcodeCounters,
      perPlayerTelemetry,
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
// Phase 3 — disconnect-isolation scored scenario (runs once, not per combo)
// ---------------------------------------------------------------------------

// Grace (DISCONNECT_GRACE_MS, netcodeConstants.ts) is 10s; real ICE
// disconnect detection on top of that is inherently variable (STUN
// consent-freshness checks, not an instant signal — see
// verify-multiplayer-disconnect.mjs's own doc comment, which uses a 90s
// budget for the same reason). This scenario doesn't need that script's full
// margin — it isn't also proving the loot-conversion/comparison-table paths,
// just "does the remaining peer keep functioning and how long until it
// notices" — so a smaller, still-generous 40s bound keeps this fast enough
// to run by default without chasing a rare worst case.
const DISCONNECT_ISOLATION_DETECT_TIMEOUT_MS = 40_000;

/** Same continuous-curve evasion technique as
 * `verify-multiplayer-disconnect.mjs`'s own `startEvading`/`stopEvading`
 * (duplicated, not imported — that file is a script owning its own
 * bookkeeping, this project's existing convention for this kind of small
 * self-contained helper): a straight line reliably ends at a wall, and a
 * bot stationary at a wall for up to `DISCONNECT_ISOLATION_DETECT_TIMEOUT_MS`
 * is exactly as exposed to the demo campaign's real roaming enemies as never
 * moving at all. */
async function startEvading(page) {
  await page.focus("canvas.scene-canvas");
  await page.keyboard.down("KeyW");
  await page.keyboard.down("KeyE");
}
async function stopEvading(page) {
  await page.keyboard.up("KeyW").catch(() => {});
  await page.keyboard.up("KeyE").catch(() => {});
}

/**
 * A real, repeatable, *scored* version of
 * `verify-multiplayer-disconnect.mjs`'s scenario 1 (guest disconnects) —
 * that script only has ad hoc inline pass/fail assertions for one specific
 * run; this measures real detection latency and whether the remaining peer
 * keeps ticking, as a reusable signal in the telemetry report. Runs once per
 * invocation (gated by `CODEENSTEIN_MP_TELEMETRY_DISCONNECT_SCENARIO`), not
 * once per combo — the disconnect-handling path doesn't vary by bot skill
 * profile or difficulty, so repeating it across the whole combo matrix would
 * just multiply real wall-clock cost for no new signal, the same reasoning
 * `runOneAttempt`'s own doc comment gives for one bundled level per run.
 * Always a fixed 2-player session — the scenario itself (one peer gone,
 * does the other survive) doesn't need higher player counts to be
 * meaningful, and a 3-4p version would only add more real time per run.
 */
export async function runDisconnectIsolationScenario(browser, devServerUrl) {
  console.log("\n=== disconnectIsolation scenario ===");
  let session;
  try {
    session = await bootstrapMultiplayerSession(browser, {
      engineName: "chromium",
      devServerUrl,
      playerCount: 2,
      targetTick: TARGET_TICK,
      log: VERBOSE ? (msg) => console.log(`  [disconnect-scenario bootstrap] ${msg}`) : () => {},
    });
    const { hostPage, contexts, playerIds } = session;
    const guestId = playerIds[1];
    const guestContext = contexts[1];

    await startEvading(hostPage);
    const tickBeforeDisconnect = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    console.log("  Closing the guest's browser context (a real transport-level teardown)...");
    const disconnectStartedAt = Date.now();
    await guestContext.close();

    let guestFinalStatus = "undetected";
    let detectedWithinMs = null;
    try {
      const handle = await hostPage.waitForFunction(
        (id) => {
          const s = window.__codeensteinMultiplayerTestHooks.getPlayerStatus(id);
          return s === "disconnected" || s === "dead" ? s : false;
        },
        guestId,
        { timeout: DISCONNECT_ISOLATION_DETECT_TIMEOUT_MS },
      );
      guestFinalStatus = await handle.jsonValue();
      detectedWithinMs = Date.now() - disconnectStartedAt;
      console.log(`  Guest reached "${guestFinalStatus}" after ${detectedWithinMs}ms.`);
    } catch (err) {
      console.log(`  [disconnect-scenario] never detected within ${DISCONNECT_ISOLATION_DETECT_TIMEOUT_MS}ms: ${err.message}`);
    }

    // Sampled after the detection window (or the timeout), not before — this
    // reflects the sim's state *through* the disconnect, not just up to it.
    const tickAfterWindow = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    const hostKeptTicking = typeof tickAfterWindow === "number" && typeof tickBeforeDisconnect === "number" && tickAfterWindow > tickBeforeDisconnect;
    await stopEvading(hostPage);
    const hostFinalStatus = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("host")).catch(() => null);

    return {
      guestFinalStatus,
      detectedWithinMs,
      hostKeptTicking,
      hostSurvived: hostFinalStatus === "alive",
    };
  } catch (err) {
    console.log(`  [disconnectIsolation crashed] ${err.message}`);
    return { crashed: err.message };
  } finally {
    if (session) await closeMultiplayerSession(session).catch(() => {});
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

// Phase 3 — a mean/max tick-skew number alone can't tell "briefly spiked
// then settled" apart from "steadily widening," and only the latter is a
// real desync-growth signal worth flagging. Sub-5ms deltas are within this
// sampler's own real-clock noise floor (a 300ms fps-sample window plus two
// more evaluate() round trips separate consecutive samples, not a fixed
// tick), so a "growing" call additionally requires the last-third mean to be
// at least 1.5x the first-third mean, not just numerically larger.
const TICK_SKEW_GROWTH_MIN_ABS_MS = 5;
const TICK_SKEW_GROWTH_MIN_RATIO = 1.5;

/** One run's own tick-skew series (time-ordered, real polling-loop order —
 * concatenating multiple runs' series before this analysis would corrupt
 * that ordering, so this is deliberately called once per run, never on a
 * flattened cross-run array). `null` when there aren't enough samples for a
 * meaningful first/last-third split (a very short attempt, or a crashed one
 * that never got far). */
export function analyzeSkewGrowthForRun(samples) {
  if (samples.length < 6) return null;
  const third = Math.floor(samples.length / 3);
  const firstThirdMeanMs = mean(samples.slice(0, third));
  const lastThirdMeanMs = mean(samples.slice(-third));
  const growing = lastThirdMeanMs - firstThirdMeanMs >= TICK_SKEW_GROWTH_MIN_ABS_MS && lastThirdMeanMs >= firstThirdMeanMs * TICK_SKEW_GROWTH_MIN_RATIO;
  return { firstThirdMeanMs, lastThirdMeanMs, growing };
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
  const tickSkewGrowthByPair = {};
  for (const key of Object.keys(qualifyingRuns[0]?.tickSkewSamples ?? {})) {
    tickSkewMsByPair[key] = spread(
      qualifyingRuns.flatMap((r) => r.tickSkewSamples[key] ?? []),
      "mean",
    );
    const perRunGrowth = qualifyingRuns.map((r) => analyzeSkewGrowthForRun(r.tickSkewSamples[key] ?? [])).filter(Boolean);
    tickSkewGrowthByPair[key] = {
      runsAnalyzed: perRunGrowth.length,
      growingRunCount: perRunGrowth.filter((g) => g.growing).length,
      avgFirstThirdMeanMs: mean(perRunGrowth.map((g) => g.firstThirdMeanMs)),
      avgLastThirdMeanMs: mean(perRunGrowth.map((g) => g.lastThirdMeanMs)),
    };
  }

  // netcodeHealth (Phase 2b) — RTT is a point-in-time sample like fps/tick-
  // skew above (same spread() aggregation); missed-tick fraction and
  // reconciliation corrections are cumulative session-lifetime counters
  // (readNetcodeCounters's own doc comment), summed across qualifying runs
  // rather than averaged per-run, so one very short run can't dilute a real
  // problem a longer run surfaced.
  const rttMsByLink = {};
  for (const key of Object.keys(qualifyingRuns[0]?.rttMsSamples ?? {})) {
    rttMsByLink[key] = spread(
      qualifyingRuns.flatMap((r) => r.rttMsSamples[key] ?? []),
      "mean",
    );
  }
  const missedTickFractionByPlayer = {};
  const reconciliationCorrectionsByPlayer = {};
  for (const id of playerIds) {
    let missedTicks = 0;
    let totalTicks = 0;
    let correctionCount = 0;
    let correctionMagnitudeTiles = 0;
    for (const r of qualifyingRuns) {
      const counters = r.netcodeCounters?.[id];
      if (!counters) continue;
      missedTicks += counters.missedTicks.missedTicksByPlayer[id] ?? 0;
      totalTicks += counters.missedTicks.totalTicks ?? 0;
      const corrections = counters.reconciliationCorrections[id];
      if (corrections) {
        correctionCount += corrections.count;
        correctionMagnitudeTiles += corrections.totalMagnitudeTiles;
      }
    }
    missedTickFractionByPlayer[id] = totalTicks > 0 ? missedTicks / totalTicks : 0;
    reconciliationCorrectionsByPlayer[id] = {
      count: correctionCount,
      // Same "0 when nothing happened, not NaN from a 0/0 divide" shape
      // spread()/missedTickFractionByPlayer above already use.
      avgMagnitudeTiles: correctionCount > 0 ? correctionMagnitudeTiles / correctionCount : 0,
    };
  }

  // perPlayerTelemetry (step 11 Phase 2a/4) — reuses
  // run-balancing-telemetry.mjs's own aggregateLevelRuntime() unchanged: the
  // multiplayer per-player snapshot (RaycasterEngine.getMultiplayerTelemetrySnapshot)
  // is built from the exact same field set as single-player's own
  // getTelemetrySnapshot(), so the same 7-category breakdown applies as-is.
  // shortestPathTiles is null (unlike single-player's real BFS-shortest
  // figure) — each bot in a run spawns at a different tile, so there's no
  // one shortest-path number shared by the whole team; per-player route
  // efficiency is left for a future pass rather than a rough approximation.
  const perPlayerTelemetry = {};
  for (const id of playerIds) {
    const samples = qualifyingRuns.map((r) => ({ snapshot: r.perPlayerTelemetry?.[id], incomplete: false })).filter((s) => s.snapshot);
    const breakdown = aggregateLevelRuntime(samples, null);
    // aggregateLevelRuntime's own `routeEfficiencyScore` is a real value only
    // when single-player's caller later overwrites it from a whole-run BFS
    // figure (`buildCampaignAggregate`) — with `shortestPathTiles: null` it's
    // a `{mean: 0, samples: [0, 0, ...]}` placeholder, not a real "0%
    // efficiency" result. Nothing here computes the real replacement (see
    // this function's own comment above), so drop the misleading zeros
    // rather than ship a number that looks real but isn't.
    if (breakdown.navigationMapFlow) delete breakdown.navigationMapFlow.routeEfficiencyScore;
    perPlayerTelemetry[id] = breakdown;
  }

  return {
    attemptsUsed,
    qualifyingRunCount: qualifyingRuns.length,
    // Same divergence-from-the-sample-size-trim caveat as
    // run-balancing-telemetry.mjs's own `trueQualifyingCount` — use this,
    // not qualifyingRunCount, for a true qualifying-rate stat.
    trueQualifyingCount,
    failureReasons,
    perPlayerTelemetry,
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
      tickSkewGrowthByPair,
    },
    netcodeHealth: {
      rttMsByLink,
      missedTickFractionByPlayer,
      reconciliationCorrectionsByPlayer,
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
  // Mixed combos need to know every tier, in weakest->strongest order, even
  // when a difficulty/player-count filter narrows other dimensions — only a
  // *profile* filter disables them (see curateMixedProfiles's own doc
  // comment for why: a filter means "just this one tier," which a curated
  // mix would contradict).
  const allTierNames = Object.keys(PROFILES);

  const browser = await chromium.launch({ headless: !HEADED });
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      scope: "Full spec (Phases 1, 2a, 2b, 3) — one bundled demo-campaign level per run: real per-player 7-category telemetry (perPlayerTelemetry, minus routeEfficiencyScore), real netcodeHealth (RTT/missed-tick fraction/reconciliation corrections), curated mixed-skill combos, and tick-skew-growth detection. See doc/dev/multiplayer-balancing-telemetry-spec.md and doc/dev/balancing-telemetry.md. disconnectIsolation (if present) is a separate, single scored scenario, not part of the combo matrix.",
      difficulties: DIFFICULTIES,
      playerCounts: PLAYER_COUNTS,
      profiles: PROFILES,
      requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
    },
    combos: {},
  };

  try {
    for (const difficulty of difficulties) {
      for (const playerCount of PLAYER_COUNTS) {
        const comboDefs = profileNames.map((name) => ({ label: name, profilesByPlayer: Array(playerCount).fill(PROFILES[name]) }));
        if (!PROFILE_FILTER) {
          for (const mix of curateMixedProfiles(allTierNames, playerCount)) {
            comboDefs.push({ label: mix.join("+"), profilesByPlayer: mix.map((name) => PROFILES[name]) });
          }
        }
        for (const { label, profilesByPlayer } of comboDefs) {
          const key = `${label}/${difficulty}/${PLAYER_COUNT_LABEL(playerCount)}`;
          console.log(`\n=== ${key} ===`);
          const combo = await runQualifyLoop({
            runAttempt: () => runOneAttempt(browser, servers.devServerUrl, label, profilesByPlayer, difficulty, playerCount),
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
    if (DISCONNECT_SCENARIO) {
      output.disconnectIsolation = await runDisconnectIsolationScenario(browser, servers.devServerUrl);
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

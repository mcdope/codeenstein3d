// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof that a real multiplayer session survives *several*
 * consecutive level transitions, not just one. Two genuinely deliberate
 * gaps this closes, both flagged (not fixed) elsewhere:
 *  - `verify-multiplayer-transition.mjs` proves the transition mechanism
 *    itself works, but only across a single level boundary, and with the
 *    host made invulnerable (`debugSetGodMode`) so combat variance can't
 *    make that script flaky — see its own doc comment. It never chains
 *    transitions.
 *  - `run-balancing-telemetry-multiplayer.mjs` deliberately stays scoped to
 *    "one bundled level per run" (its own doc comment's opening line) —
 *    re-driving a real multi-level campaign for every combo in that tool's
 *    matrix would multiply its already-real-time-only cost for no new
 *    per-combo signal.
 *
 * This script is the one place that actually chains levels: a real 2-player
 * `easy`/`Casual` session (the friendliest combo — see
 * `project-mp-balancing-campaign-2026-07-24-results` for why: Easy/Normal
 * clear ~83-85%, Hard is a cliff), **both** peers bot-driven (unlike
 * `verify-multiplayer-transition.mjs`'s idle guest) with real, un-god-moded
 * combat, looping "drive both bots to the exit, wait for the transition,
 * repeat" for as long as the team keeps clearing levels. `MIN_LEVEL_INDEX`
 * (4) is the pass/fail bar, not a stopping point — the loop is deliberately
 * NOT capped there; it keeps going until the session itself ends (team
 * wiped, or a genuine `"campaign-complete"` if the team clears the whole
 * real 17-level demo campaign) or `MAX_LEVEL_ITERATIONS` (a runaway-loop
 * safety net well above the real 17, never expected to bind) is hit.
 *
 * Chromium-only, starts its own isolated dev+signaling server pair
 * (`multiplayerTestServers.mjs`) rather than assuming a developer's own
 * manually-run dev session — same reasoning as
 * `run-balancing-telemetry-multiplayer.mjs`'s identical choice: this is a
 * real-time-only, potentially many-minutes-long tool, not a quick CI leg.
 * **Not CI-wired** for the same reason that script isn't: an uncapped,
 * potentially-full-campaign run has no bounded worst-case wall-clock cost,
 * which every existing CI job (even the two dedicated "genuinely slow"
 * ones) still has. Run manually: `npm run verify:multiplayer-campaign`.
 */
import { chromium } from "playwright";
import { MultiplayerBot } from "./lib/multiplayerBot.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { PROFILES } from "./run-balancing-telemetry.mjs";
import { bootstrapMultiplayerSession, closeMultiplayerSession } from "./lib/multiplayerSessionBootstrap.mjs";
import { startIsolatedMultiplayerServers } from "./lib/multiplayerTestServers.mjs";

const PLAYER_COUNT = 2;
const DIFFICULTY = "easy";
const BOT_PROFILE = PROFILES.Casual;
const TARGET_TICK = 60; // matches bootstrapMultiplayerSession's own default — 2s of ticking, comfortably past session bootstrap.
const FINAL_APPROACH_TICKS = 80; // same value as run-balancing-telemetry(-multiplayer).mjs's own FINAL_APPROACH_TICKS.
const LEVEL_BOUNDARY_TIMEOUT_MS = 30_000; // countdown (5s) + chunked broadcast + ack round-trip + real map generation — same budget verify-multiplayer-transition.mjs uses for the identical wait.

// Pass/fail bar, not a stopping point — see this file's own top doc comment.
// Overridable only for fast local smoke-testing of this script itself.
const MIN_LEVEL_INDEX = process.env.CODEENSTEIN_MP_CAMPAIGN_MIN_LEVEL ? Number(process.env.CODEENSTEIN_MP_CAMPAIGN_MIN_LEVEL) : 4;
// The real bundled demo campaign is exactly 17 levels (`demo-campaign/`) —
// this is a runaway-loop backstop, not a real target, and should never bind.
const MAX_LEVEL_ITERATIONS = 20;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Exact `#multiplayer-status` text `onMultiplayerSessionEnded` (`main.ts`)
 * sets per `SessionEndReason` — the only place a session's own end reason is
 * observable from outside (the comparison overlay itself is drawn on canvas,
 * not real DOM). Same technique `verify-multiplayer-disconnect.mjs`'s own
 * scenario 2 already uses for its one `"host-disconnected"` case; this
 * generalizes it to all four reasons. */
const SESSION_END_MESSAGES = {
  "Multiplayer session ended — every player was eliminated.": "team-eliminated",
  "Multiplayer session ended — the host disconnected.": "host-disconnected",
  "Multiplayer session ended — campaign complete!": "campaign-complete",
  "Multiplayer session ended — the level transition failed to complete.": "level-transition-failed",
};

/**
 * Drives one `MultiplayerBot` (real combat, no god mode — unlike
 * `verify-multiplayer-transition.mjs`'s invulnerable host) from wherever it
 * actually spawned on this level to the exit. Same outcome vocabulary as
 * `run-balancing-telemetry-multiplayer.mjs`'s own `driveOneBot` (that
 * function isn't exported, and this project's own convention is each script
 * owns its own bookkeeping rather than share a small helper like this one
 * across scripts): `"reachedExit"`, `"levelAdvanced"` (a teammate reached the
 * exit first and this bot got carried along, real and intended — see
 * `driveOneBot`'s own doc comment for the full mechanism), `"died"`,
 * `"stuck"`, `"notPlaying"`, or `"routeFailed"`.
 */
async function driveOnePlayerToExit(page, playerId, map, label) {
  const bot = new MultiplayerBot(page, BOT_PROFILE, playerId, { logger: { trace: true, navDiag: false } });
  bot.startLevel(map);

  const player0 = await bot.readState();
  if (player0.state !== "playing") {
    return { playerId, outcome: "notPlaying", detail: player0.state };
  }

  const liveSpawnTile = { x: Math.floor(player0.x), y: Math.floor(player0.y) };
  const route = planRoute({ ...map, spawn: liveSpawnTile });
  if (!route.ok) {
    return { playerId, outcome: "routeFailed", detail: route.reason };
  }

  let finalState = await bot.driveLegs(route.legs);
  // See driveOneBot's own doc comment: a "teleported" mid-route result means
  // a teammate already reached the exit and this bot's live position just
  // got carried to the next level's spawn — map/map.exit are stale here, so
  // don't keep driving toward them.
  if (finalState.state === "playing" && finalState.reason !== "teleported") {
    const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
    finalState = await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
  }
  bot.reportAnomalies(`${label}/${playerId}`, 0);

  const outcome =
    finalState.state === "over"
      ? "died"
      : finalState.reason === "arrived"
        ? "reachedExit"
        : finalState.reason === "teleported"
          ? "levelAdvanced"
          : "stuck";
  return { playerId, outcome, finalState };
}

/** Waits until either a genuine level transition has happened on every page
 * (a non-null grid that differs from `prevGrid` — same null-guard as
 * `verify-multiplayer-transition.mjs`'s identical check, for the same reason:
 * once a peer's whole session ends, `getMapGrid()` starts returning `null`,
 * and a bare inequality against `null` would misread that as "the grid
 * changed") or the session has ended for any reason (`#multiplayer-status`
 * text). Returns `{type: "transition"}` or `{type: "ended", reason}`. */
async function waitForLevelBoundary(pages, prevGrid) {
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        (prevGrid) => {
          const hooks = window.__codeensteinMultiplayerTestHooks;
          const grid = hooks.getMapGrid();
          if (grid !== null && JSON.stringify(grid) !== JSON.stringify(prevGrid)) return true;
          const status = document.querySelector("#multiplayer-status")?.textContent ?? "";
          return status.startsWith("Multiplayer session ended");
        },
        prevGrid,
        { timeout: LEVEL_BOUNDARY_TIMEOUT_MS },
      ),
    ),
  );
  const hostStatusText = await pages[0].textContent("#multiplayer-status").catch(() => "");
  if (hostStatusText.startsWith("Multiplayer session ended")) {
    return { type: "ended", reason: SESSION_END_MESSAGES[hostStatusText] ?? `unknown ("${hostStatusText}")` };
  }
  return { type: "transition" };
}

async function runScenario(browser, devServerUrl) {
  const session = await bootstrapMultiplayerSession(browser, {
    engineName: "chromium",
    devServerUrl,
    playerCount: PLAYER_COUNT,
    difficulty: DIFFICULTY,
    targetTick: TARGET_TICK,
    log: (msg) => console.log(`  [bootstrap] ${msg}`),
  });
  const { pages, playerIds } = session;
  const label = `campaign/${DIFFICULTY}/${PLAYER_COUNT}p`;

  try {
    let highestLevelReached = 1;
    let endReason = null;
    let stoppedForFailure = false;

    for (let levelIndex = 1; levelIndex <= MAX_LEVEL_ITERATIONS; levelIndex++) {
      console.log(`\n--- Level ${levelIndex} ---`);
      const map = await pages[0].evaluate(() => window.__codeensteinMultiplayerTestHooks.getMap());
      if (!map) {
        check(`level ${levelIndex}: has a real generated map to navigate`, false, "getMap() returned null — session already ended?");
        stoppedForFailure = true;
        break;
      }
      const prevGrid = map.grid;

      const results = await Promise.all(pages.map((page, i) => driveOnePlayerToExit(page, playerIds[i], map, label)));
      console.log(`  outcomes: ${results.map((r) => `${r.playerId}=${r.outcome}`).join(", ")}`);
      const outcomes = results.map((r) => r.outcome);
      const anyReachedOrAdvanced = outcomes.some((o) => o === "reachedExit" || o === "levelAdvanced");
      const teamWiped = outcomes.every((o) => o === "died" || o === "notPlaying");

      if (!anyReachedOrAdvanced && !teamWiped) {
        check(`level ${levelIndex}: at least one bot reaches the exit`, false, JSON.stringify(results));
        stoppedForFailure = true;
        break;
      }

      if (teamWiped) {
        console.log(`  Team wiped on level ${levelIndex} — waiting for the session's own end state...`);
        const boundary = await waitForLevelBoundary(pages, prevGrid);
        endReason = boundary.type === "ended" ? boundary.reason : "unknown (grid changed unexpectedly after a full team wipe)";
        break;
      }

      check(`level ${levelIndex}: team survives to the exit (directly or carried by a teammate)`, true);
      const boundary = await waitForLevelBoundary(pages, prevGrid);
      if (boundary.type === "ended") {
        endReason = boundary.reason;
        console.log(`  Session ended ("${endReason}") instead of a further transition.`);
        break;
      }

      const grids = await Promise.all(pages.map((page) => page.evaluate(() => window.__codeensteinMultiplayerTestHooks.getMapGrid())));
      check(
        `level ${levelIndex}: every peer agrees on the new level's grid (lockstep held across the transition)`,
        grids.every((g) => JSON.stringify(g) === JSON.stringify(grids[0])),
      );

      highestLevelReached = levelIndex + 1;
      console.log(`  Landed on level ${highestLevelReached}.`);
    }

    if (!stoppedForFailure && endReason === null) {
      check(
        `session reaches a real end state within ${MAX_LEVEL_ITERATIONS} levels`,
        false,
        `hit the safety cap without the session ever ending — investigate before trusting this run`,
      );
    }

    console.log(`\nHighest level reached: ${highestLevelReached}${endReason ? ` (session ended: "${endReason}")` : ""}`);
    check(`team reaches at least level ${MIN_LEVEL_INDEX}`, highestLevelReached >= MIN_LEVEL_INDEX, `highest level reached: ${highestLevelReached}`);
  } finally {
    await closeMultiplayerSession(session);
  }
}

async function main() {
  console.log("Starting an isolated multiplayer signaling+dev server pair (not sharing any manually-run dev session)...");
  const servers = await startIsolatedMultiplayerServers();
  console.log(`  dev server:       ${servers.devServerUrl}`);
  console.log(`  signaling server: ${servers.signalingServerUrl}`);

  const browser = await chromium.launch();
  try {
    await runScenario(browser, servers.devServerUrl);
  } finally {
    await browser.close();
    await servers.stop();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-campaign crashed:", err);
  process.exit(1);
});

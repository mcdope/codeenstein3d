// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Replay-playback verifier: plays a shipped highscore entry back through the
 * real app and asserts it reproduces the run it recorded.
 *
 * This is the check whose absence let a fully broken leaderboard ship green.
 * `astHash` guards a level's *content* and `balanceHash` guards "is this still
 * the same game", but nothing asserted that a replay still *plays back* the
 * way it was recorded — so when the bot's rotation-speed multiplier turned out
 * to be a simulation input the replay format didn't carry, every shipped
 * replay diverged within seconds while CI stayed green. See
 * `ReplayLevelSegment.rotSpeedMultiplier` and `doc/dev/history.md`.
 *
 * It also closes the scope note `verify-campaign-playthrough.mjs` carries:
 * that script verifies a recorded payload's *structural* integrity (frame
 * count, seed, per-level `astHash`) and explicitly does not re-simulate it.
 * This one re-simulates.
 *
 * **How it observes.** Through the real UI — it clicks "Highscores" and then a
 * row's own "Watch" button, so `highscorePanel.ts`'s
 * `entry.replay?.version === 2 && levels.length > 0` gate is part of what's
 * being tested: a board shipped without payloads renders no button and fails
 * here loudly instead of silently verifying nothing. Outcomes come from
 * `window.__codeensteinReplayTestHooks` (`src/main.ts`), because nothing else
 * can distinguish them: the win/death overlays are drawn on the canvas, and a
 * natural end and a mid-run failure both funnel into the same
 * "return to highscores" path.
 *
 * **What it asserts, per entry.**
 *  1. A "Watch" button exists at all.
 *  2. `endReason === null` — no refusal, and in particular not "ran out of
 *     recorded input before the level concluded", which is exactly what a
 *     diverged replay does. This single check is what would have caught the
 *     rotation-multiplier bug.
 *  3. Per level, `framesConsumed === framesRecorded`. Exact, not approximate:
 *     `simulate()` records a frame *before* the end-of-run check fires, so the
 *     terminal frame is part of the recording and a faithful playback ends on
 *     it. If this is ever off by one for a legitimate reason, investigate
 *     rather than loosening it — the equality is derived, not tuned.
 *  4. The carryover ladder. `advanceToNextLevel` writes `priorScore:
 *     stats.score` into the *next* level's carryover, so a recorded payload is
 *     its own per-level expected-value table — level i's replayed score must
 *     equal level i+1's recorded `priorScore`, and likewise health/swap/ammo.
 *     No external fixture, and a `LEVEL_LIMIT`-shortened run still checks
 *     something real. `ownedWeapons` is compared as a subset, since the
 *     recorded carryover is `effectiveCarryover`, which force-adds weapons at
 *     campaign levels 4/8/12.
 *  5. Final score and level count match the entry's own headline numbers.
 *
 * **Score parity is asserted under dev-only conditions.** `PLAYER_STATS_ENABLED`
 * is `false` (`playerStats.ts`) and `telemetryEnabled = PLAYER_STATS_ENABLED ||
 * isTestHooksActive()`, so `computeLevelScoreBreakdown` scores a zero accuracy
 * bonus without test hooks — and this script runs with `?testHooks=1`, as the
 * board was recorded with. That is benign in production (`buildStats` leaves
 * `runScoreBreakdown` undefined, so a player's replay shows no stats rows at
 * all) but it does mean a *production* playback would not reproduce the score.
 * Simulation parity — frame counts, win/death, the carryover ladder — is what
 * holds unconditionally, and is why check 3 leads.
 *
 * **Chromium only, deliberately.** `verify:multiplayer-determinism` exists
 * precisely because transcendental math is not bit-identical across browser
 * engines, so a Firefox leg here would be measuring engine float behaviour
 * rather than replay fidelity, and a failure would be unattributable.
 * `CODEENSTEIN_VERIFY_BROWSER` is honoured for manual experiments; don't wire
 * it into the CI matrix.
 *
 * Requires a dev server (`npm run dev`) — `?testHooks=1` is DEV-only by
 * design, so this cannot run against a built bundle.
 *
 * **Measured, not estimated** (local, headless Chromium, 2026-08-09): all
 * three entries end to end — 51 segments, 186,430 recorded frames, 450 checks
 * — is **360s** at `CONCURRENCY=3`. One entry at `LEVEL_LIMIT=2` is **28s**.
 * A CI runner has no GPU (SwiftShader), so budget several times that; the job
 * is capped at 45 minutes.
 *
 * Env knobs:
 *  - `CODEENSTEIN_DEV_URL` (default `http://localhost:5183`)
 *  - `CODEENSTEIN_REPLAY_ENTRIES` (default `0`) — comma-separated board
 *    indices, or `all`. One entry is the default because a full 17-level
 *    playback is minutes of real CPU.
 *  - `CODEENSTEIN_REPLAY_LEVEL_LIMIT` (default: all) — stop after N levels.
 *  - `CODEENSTEIN_REPLAY_CONCURRENCY` (default 2) — entries in parallel.
 *  - `CODEENSTEIN_REPLAY_SPEED` (default 1) — 1/2/4, via the transport bar.
 *    Same total `advance()` count, fewer rAF ticks.
 *  - `CODEENSTEIN_CONSOLE_FORWARD=1` — forward page console output.
 *  - `CODEENSTEIN_REPLAY_TRACE=1` — one progress line per pump chunk.
 */
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5183";
const LEVEL_LIMIT = process.env.CODEENSTEIN_REPLAY_LEVEL_LIMIT ? Number(process.env.CODEENSTEIN_REPLAY_LEVEL_LIMIT) : null;
const CONCURRENCY = Number(process.env.CODEENSTEIN_REPLAY_CONCURRENCY ?? 2);
const SPEED = Number(process.env.CODEENSTEIN_REPLAY_SPEED ?? 1);
const CONSOLE_FORWARD = process.env.CODEENSTEIN_CONSOLE_FORWARD === "1";
/** Per-chunk progress lines — the trace to read when a run stops concluding,
 * rather than reasoning about it from the final counters. */
const TRACE = process.env.CODEENSTEIN_REPLAY_TRACE === "1";

/** One recorded frame per rAF tick at 1x, so the pump step is a frame's worth
 * of virtual time. The value only has to be *a* fixed step — playback advances
 * the engine by each frame's own recorded `dt`, not by this. */
const PUMP_STEP_MS = 1000 / 60;
/** rAF ticks per `page.evaluate` round-trip. Big enough that a 14k-frame level
 * costs single-digit round-trips, small enough to keep progress reporting and
 * the stall watchdog responsive. */
const PUMP_CHUNK_TICKS = 2000;
/** Consecutive chunks with no change in (level, frame) before giving up.
 * A level transition legitimately makes no frame progress while it re-reads,
 * re-parses and re-hashes its file, so this has to tolerate real async work —
 * `waitForTimeout` below makes each stalled round a real 100ms wait. */
const MAX_STALLED_CHUNKS = 100;

let failures = 0;
const log = [];

function check(label, condition, detail) {
  if (condition) {
    log.push(`  [PASS] ${label}`);
  } else {
    failures += 1;
    log.push(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label, why) {
  log.push(`  [SKIP] ${label} — ${why}`);
}

/** The board as the dialog will render it, reduced in-page to just what this
 * script compares against — the full payload carries six figures of frames per
 * entry and there is no reason to serialize those across the boundary. */
async function readExpectedBoard(page) {
  return page.evaluate(async () => {
    const { loadHighscoresForDisplay } = await import("/src/engine/highscores.ts");
    const board = await loadHighscoresForDisplay();
    return board.map((e) => ({
      score: e.score,
      levelsCleared: e.levelsCleared,
      campaignName: e.campaignName,
      source: e.source ?? null,
      hasReplay: e.replay?.version === 2 && e.replay.levels?.length > 0,
      levels: (e.replay?.levels ?? []).map((l) => ({
        filePath: l.filePath,
        framesRecorded: l.frames.length,
        rotSpeedMultiplier: l.rotSpeedMultiplier ?? null,
        carryover: l.carryover
          ? {
              priorScore: l.carryover.priorScore ?? null,
              health: l.carryover.health,
              swap: l.carryover.swap,
              bullets: l.carryover.bullets,
              rockets: l.carryover.rockets,
              smg: l.carryover.smg,
              gas: l.carryover.gas,
              ownedWeapons: l.carryover.ownedWeapons ?? [],
            }
          : null,
      })),
    }));
  });
}

/** Drives one entry's replay to its conclusion, returning the hook state. */
async function playEntry(page, rowIndex, expected) {
  await page.click("#view-highscores");
  await page.waitForSelector("#highscore-dialog tbody tr", { timeout: 15000 });

  const watch = page.locator(`#highscore-dialog tbody tr:nth-child(${rowIndex + 1}) .replay-btn`).first();
  const watchCount = await watch.count();
  if (watchCount === 0) return { missingButton: true };
  await watch.click();

  // `startReplay` rebuilds the demo workspace and re-reads/re-parses/re-hashes
  // the first level before any engine exists, so "the hooks report an active
  // viewing" is the real ready signal, not the click returning.
  await page.waitForFunction(
    () => window.__codeensteinReplayTestHooks?.getState().active === true,
    undefined,
    { timeout: 30000, polling: 100 },
  );

  if (SPEED > 1) {
    // seekBack, playPause, seekForward, speedDown, speedUp, record
    const speedUp = page.locator(".replay-controls .replay-btn").nth(4);
    for (let s = 1; s < SPEED; s *= 2) await speedUp.click();
  }

  let stalled = 0;
  let lastProgress = "";
  let ticks = 0;
  let chunks = 0;
  // Budgeted on *frames consumed*, not on ticks pumped. Those are not the same
  // thing: a level transition re-reads, re-parses and re-hashes its file
  // asynchronously, and every pump chunk that lands during one advances the
  // clock without consuming a recorded frame. With 16 transitions at
  // PUMP_CHUNK_TICKS each, a tick budget sized off the frame count is
  // exceeded by the transitions alone — which is a property of the harness,
  // not of the replay, and made a correct playback look like a runaway.
  // Genuine hangs are the stall watchdog's job; this bounds the other
  // runaway, a replay that somehow keeps consuming frames forever.
  const totalRecorded = expected.levels.reduce((sum, l) => sum + l.framesRecorded, 0);
  const frameBudget = totalRecorded * 1.05 + 5000;

  for (;;) {
    const state = await page.evaluate(
      ({ chunkTicks, stepMs }) => {
        window.__pumpVirtualTime(chunkTicks * stepMs, stepMs);
        return window.__codeensteinReplayTestHooks.getState();
      },
      { chunkTicks: PUMP_CHUNK_TICKS, stepMs: PUMP_STEP_MS },
    );
    ticks += PUMP_CHUNK_TICKS;
    chunks += 1;

    if (state.ended) return state;
    if (LEVEL_LIMIT !== null && state.levels.length >= LEVEL_LIMIT) return { ...state, truncatedByLimit: true };

    const consumed = state.levels.reduce((sum, l) => sum + l.framesConsumed, 0) + (state.probe?.frameIndex ?? 0);
    if (TRACE) {
      console.log(
        `    [entry ${rowIndex}] chunk ${chunks}: level ${state.probe?.levelIndex}, frame ${state.probe?.frameIndex}/${state.probe?.framesRecorded}, ${consumed}/${totalRecorded} frames, ${ticks} ticks`,
      );
    }

    const progress = `${state.probe?.levelIndex}:${state.probe?.frameIndex}`;
    if (progress === lastProgress) {
      stalled += 1;
      if (stalled > MAX_STALLED_CHUNKS) return { ...state, stalled: true };
      // A level transition makes no frame progress while its async re-parse
      // and re-hash run; the synchronous pump can never let those settle.
      await page.waitForTimeout(100);
    } else {
      stalled = 0;
      lastProgress = progress;
    }
    if (consumed > frameBudget) return { ...state, budgetExhausted: true, consumed, totalRecorded };
  }
}

function verifyEntry(index, expected, state) {
  log.push(`\n--- Entry ${index}: ${expected.campaignName}, ${expected.levelsCleared} levels, score ${expected.score} ---`);

  if (state.crashed) {
    check(
      `Entry ${index} ran to completion`,
      false,
      `${state.crashed}${state.crashed.includes("Execution context was destroyed") ? " — if you edited anything under src/ while this ran, that is Vite hot-reloading the page; re-run without touching it" : ""}`,
    );
    return;
  }
  if (state.missingButton) {
    check(`Entry ${index} renders a "Watch" button`, false, "no .replay-btn in that row — the board shipped without a usable replay payload");
    return;
  }
  check(`Entry ${index} renders a "Watch" button`, true);

  if (state.stalled) {
    check(`Entry ${index} kept making progress`, false, `stalled at level ${state.probe?.levelIndex}, frame ${state.probe?.frameIndex}`);
    return;
  }
  if (state.budgetExhausted) {
    check(`Entry ${index} finished within its recorded frame budget`, false, `consumed ${state.consumed} of ${state.totalRecorded} recorded frames without concluding`);
    return;
  }

  // The headline check. A diverged replay ends here with "ran out of recorded
  // input before the level concluded"; a refused one names its reason.
  check(`Entry ${index} played back without any refusal or early end`, state.endReason === null, state.endReason ?? undefined);

  const limit = LEVEL_LIMIT ?? expected.levels.length;
  const checked = Math.min(state.levels.length, limit);
  for (let i = 0; i < checked; i++) {
    const got = state.levels[i];
    const want = expected.levels[i];
    const where = `level ${i + 1} (${want.filePath})`;

    check(`${where}: consumed exactly the frames it recorded`, got.framesConsumed === want.framesRecorded, `${got.framesConsumed} vs ${want.framesRecorded}`);

    const next = expected.levels[i + 1];
    if (next?.carryover) {
      // The recorded payload is its own expected-value table — see the module
      // comment on the carryover ladder.
      check(`${where}: score matches the next level's recorded priorScore`, got.score === next.carryover.priorScore, `${got.score} vs ${next.carryover.priorScore}`);
      for (const field of ["health", "swap", "bullets", "rockets", "smg", "gas"]) {
        check(`${where}: ${field} carried over as recorded`, got[field] === next.carryover[field], `${got[field]} vs ${next.carryover[field]}`);
      }
      const carriedAll = got.ownedWeapons.every((w) => next.carryover.ownedWeapons.includes(w));
      check(`${where}: owned weapons are a subset of the recorded carryover`, carriedAll, `${JSON.stringify(got.ownedWeapons)} vs ${JSON.stringify(next.carryover.ownedWeapons)}`);
    }
  }

  if (state.truncatedByLimit) {
    skip(`Entry ${index} final score/level count`, `stopped after ${limit} level(s) by CODEENSTEIN_REPLAY_LEVEL_LIMIT`);
    return;
  }

  if (expected.levels.length !== expected.levelsCleared) {
    // A payload truncated by MAX_REPLAY_FRAMES_PER_LEVEL genuinely holds fewer
    // segments than the run cleared. That is a recording-side limitation, not
    // a determinism regression, and must not be reported as one.
    skip(
      `Entry ${index} final score/level count`,
      `payload holds ${expected.levels.length} segments for a ${expected.levelsCleared}-level run (frame-cap truncation)`,
    );
    return;
  }

  check(`Entry ${index} replayed every recorded level`, state.levels.length === expected.levels.length, `${state.levels.length} vs ${expected.levels.length}`);
  const last = state.levels[state.levels.length - 1];
  check(`Entry ${index} every level ended in a win`, state.levels.every((l) => l.outcome === "won"), state.levels.map((l) => l.outcome).join(","));
  check(`Entry ${index} final score matches the board`, last?.score === expected.score, `${last?.score} vs ${expected.score}`);
}

async function main() {
  const { name: browserName, engine } = resolveBrowserEngine();
  console.log(`Replay verification — ${browserName} against ${DEV_SERVER_URL}`);
  const browser = await engine.launch();

  // One page just to read what the board claims, before any replay runs.
  const probeContext = await browser.newContext();
  const probePage = await probeContext.newPage();
  await installVirtualClock(probePage);
  await probePage.goto(`${DEV_SERVER_URL}/?testHooks=1`);
  await probePage.waitForSelector("#view-highscores");
  const board = await readExpectedBoard(probePage);
  await probeContext.close();

  const raw = process.env.CODEENSTEIN_REPLAY_ENTRIES ?? "0";
  const indices = raw === "all" ? board.map((_, i) => i) : raw.split(",").map((s) => Number(s.trim()));
  console.log(`Board has ${board.length} entr(y|ies); verifying ${indices.join(", ")}${LEVEL_LIMIT ? ` (first ${LEVEL_LIMIT} level(s))` : " (full runs)"}\n`);

  for (const i of indices) {
    if (!board[i]) {
      check(`Entry ${i} exists on the board`, false, `board has ${board.length} entries`);
      indices.splice(indices.indexOf(i), 1);
    }
  }

  const started = Date.now();
  const queue = [...indices];
  const results = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const context = await browser.newContext();
      const page = await context.newPage();
      if (CONSOLE_FORWARD) page.on("console", (m) => console.log(`    [page ${index}] ${m.text()}`));
      await installVirtualClock(page);
      // No `botRotSpeedMul`, deliberately: reproducing the recorded rotation
      // must come from the replay payload, exactly as it does for a player.
      await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);
      await page.waitForSelector("#view-highscores");
      // No `installDifficulty` either — playback must use each segment's own
      // recorded difficulty, not whatever preference the page happens to hold.
      try {
        results.push({ index, state: await playEntry(page, index, board[index]) });
      } catch (err) {
        // One entry blowing up must not take the other two with it — and the
        // message matters, because the most common cause is self-inflicted:
        // editing anything under `src/` while this runs makes Vite hot-reload
        // the page, which destroys the execution context mid-`evaluate`.
        results.push({ index, state: { crashed: err.message } });
      } finally {
        await context.close();
      }
    }
  });
  await Promise.all(workers);
  await browser.close();

  results.sort((a, b) => a.index - b.index);
  for (const { index, state } of results) verifyEntry(index, board[index], state);

  console.log(log.join("\n"));
  console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll replay checks passed.");
}

await main();

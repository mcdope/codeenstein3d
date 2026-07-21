// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 10's actual deliverable — real N-player (>2)
 * multiplayer, replacing the old hard-coded 2-player MVP. Picks up exactly
 * where `verify-multiplayer-connect.mjs`/`verify-multiplayer-netcode.mjs`
 * leave off for the 2-player case, but drives a real 1-host/2-guest session:
 * the host picks `maxPlayers=3`, guest 1 joins, guest 2 joins *after* it
 * against the *same* code (the new auto-rearm flow — `armNextGuestSlot` in
 * `main.ts` republishes a fresh offer under the same code the instant a
 * guest connects, no manual "ready for next joiner" action), "Start Session"
 * finalizes a real 3-player roster, then real cross-peer movement (each of
 * the three holding a distinct real key — the same synthetic-`KeyboardEvent`
 * technique `verify-multiplayer-netcode.mjs`'s own "holding W to move"
 * section already uses for the 2-player case, deliberately not
 * `MultiplayerBot`'s full navigation/combat AI here — that's a much heavier
 * dependency this smoke test's actual new proof points don't need: 3-peer
 * join via auto-rearm, 3-way lockstep agreement, Elite scaling at
 * `playerCount=3`, and per-guest disconnect isolation) proves lockstep
 * agreement across all three peers, Elite HP scaling actually engaging at
 * `playerCount=3`, and — the concrete new guarantee this step adds — that
 * one guest disconnecting never touches the *other* guest's or the host's
 * own session.
 *
 * Same `?testHooks=1` read-only-introspection discipline, and "not run
 * against Firefox in CI" reasoning as every sibling `verify-multiplayer-*`
 * script — see `verify-multiplayer-connect.mjs`'s own doc comment for the
 * full WebRTC ICE-gathering writeup (a confirmed, Mozilla-WONTFIX,
 * CI-sandbox-only limitation, not an app bug). This script's own scenario
 * logic below (evasion, fps/tick-skew sampling, the Elite-scaling check, the
 * disconnect scenario) still owns its own `check()`/`failures` bookkeeping,
 * matching every sibling script's convention — but the actual "get from
 * nothing to a real running N-player session" sequence (step 10's own new
 * contribution, not something any 2-player sibling script has) is step 11's
 * shared `scripts/lib/multiplayerSessionBootstrap.mjs`, not copy-pasted here
 * anymore — this is the one place that sequence already existed before it
 * had a canonical shared home.
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";
import {
  bootstrapMultiplayerSession,
  closeMultiplayerSession,
  DEFAULT_TICKING_TIMEOUT_MS,
  FIREFOX_LAUNCH_OPTIONS,
} from "./lib/multiplayerSessionBootstrap.mjs";

const DISCONNECT_GRACE_MS = 10_000; // netcodeConstants.ts's own value — kept in sync manually, same as every sibling script.
const DISCONNECT_DETECT_TIMEOUT_MS = 90_000; // same generous real-ICE-detection budget as verify-multiplayer-disconnect.mjs.
const TARGET_TICK = 60; // 2s of real ticking at TICK_RATE_HZ(30) — comfortably past session bootstrap.
// eliteScalingFor(3): extra = 2, hp = 1 + 2*0.5 = 2 (src/engine/multiplayerScaling.ts).
// ELITE_HP_MULTIPLIER = 4 is baked into an Elite's own maxHp at map-generation
// time (src/map/generation/enemies.ts), independent of player count — so an
// Elite's maxHp / a same-level grunt's maxHp should be that base 4x times
// this session's own 2x on top of it, regardless of difficulty's own HP
// rescale (which multiplies both equally and so cancels out of the ratio).
const EXPECTED_ELITE_TO_GRUNT_HP_RATIO = 4 * 2;
const ELITE_RATIO_TOLERANCE = 0.05; // 5% slack for integer-rounding of rescaled HP values.

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function samePosition(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

/**
 * Holds "move forward" and "turn" together so the page walks in a continuous
 * curve rather than a straight line that reliably ends stuck against a wall
 * — same technique `verify-multiplayer-disconnect.mjs`'s own
 * `startEvading`/`stopEvading` uses. That script only ever needs this to
 * survive a bounded, typically-short window before its own scenario's real
 * disconnect resolves; this script's own scenario needs host+guest-1 to
 * survive real, unscripted combat for considerably longer (elite check +
 * perf sampling + guest-2's own disconnect-detection wait, cumulatively) —
 * a real (if imperfect) survivability risk this script's own
 * `MAX_SCENARIO_ATTEMPTS` retry budget exists to absorb, the same "real
 * combat variance, not a bug" acceptance `verify-multiplayer-transition.mjs`'s
 * own retry budget already established for this exact demo campaign. */
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
 * Real render-fps sample: counts `requestAnimationFrame` callbacks over
 * `durationMs` of real wall-clock time — a standard, self-contained
 * technique needing no production-code hook. Deliberately NOT reusing
 * `perfDebug.ts`'s `?perfDebug=1` console-log diagnostics: those are
 * designed for a human to screen-record and read by eye (see that module's
 * own doc comment), not to be scraped programmatically here.
 */
async function sampleFps(page, durationMs = 1000) {
  return page.evaluate(
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
  );
}

/** Lightweight network-lag proxy: how many simulation ticks apart two peers'
 * own `getSimTick()` reads are at the same real instant. A perfectly
 * keeping-up lockstep session reads identical (or off-by-one) ticks; a
 * peer meaningfully behind (real WebRTC/tick-worker backlog) shows up as a
 * larger skew. Converted to milliseconds via the netcode's own 30Hz tick
 * rate for a human-readable "~Nms behind" figure — informational only, not
 * a pass/fail assertion (this is a correctness smoke test, not a perf
 * benchmark; `npm run perf:bench`/`scripts/poc-cross-browser-determinism.mjs`
 * already exist for heavier profiling). */
async function sampleTickSkewMs(pageA, pageB) {
  const [a, b] = await Promise.all([
    pageA.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getSimTick() ?? null),
    pageB.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getSimTick() ?? null),
  ]);
  if (a === null || b === null) return null;
  return Math.abs(a - b) * (1000 / 30);
}

// Real, unscripted combat against the bundled demo campaign's 18 enemies
// (no cheats — permanently disabled in multiplayer) over the real time this
// scenario's disconnect-detection wait can take has been observed to
// occasionally wipe the whole team despite host/guest-1 evading continuously
// — the same class of accepted real-combat variance
// `verify-multiplayer-transition.mjs`'s own `MAX_SCENARIO_ATTEMPTS` retry
// budget already exists for elsewhere in this codebase, applied here for the
// same reason: a team wipe here says nothing about whether per-guest
// disconnect isolation actually works, only that this run's real, randomly-
// seeded level happened to be rough. A genuine correctness failure (a
// connect/lockstep/setup problem, or guest-1 actually going down specifically
// because of guest-2's disconnect rather than unrelated combat) is not
// retried — only a real team-eliminated wipe is.
const MAX_SCENARIO_ATTEMPTS = 5;

/** Runs one full attempt at the scenario against fresh browser contexts.
 * Returns `{ failureCount, teamWiped }` — `teamWiped` signals "retry, this
 * run's own real combat variance wiped the team before the isolation check
 * could even mean anything," distinct from every other failure mode (a
 * connect/lockstep/protocol problem), which is reported as-is, not retried. */
async function runAttempt(browser, engineName, attempt) {
  failures = 0;
  let teamWiped = false;
  console.log(`\n--- Attempt ${attempt}/${MAX_SCENARIO_ATTEMPTS} ---`);

  let session;
  try {
    // Steps 10/11's shared bootstrap: 3 contexts, load an eligible workspace
    // in each, host picks maxPlayers=3 and creates, guest-1 joins directly,
    // guest-2 joins the same code racing (and, via its own built-in retry
    // budget, absorbing) armNextGuestSlot's async re-arm cycle, host clicks
    // Start Session, all three peers ticked past TARGET_TICK — see
    // `scripts/lib/multiplayerSessionBootstrap.mjs`'s own doc comment for
    // the full mechanics and the real-CI-measured timing behind its retry
    // defaults.
    session = await bootstrapMultiplayerSession(browser, {
      engineName,
      playerCount: 3,
      targetTick: TARGET_TICK,
      log: (msg) => console.log(msg),
    });
    check("all three peers connected, roster finalized, ticking past target", true);
    const { hostPage, guestPages } = session;
    const [guest1Page, guest2Page] = guestPages;

    // Real combat starts ticking immediately (the bundled demo campaign is a
    // real, fully-populated 18-enemy level, no cheats — permanently disabled
    // in multiplayer) — all three players evade continuously from here
    // through the rest of this script (elite check, perf sampling, the
    // disconnect wait), same technique `verify-multiplayer-disconnect.mjs`
    // uses, just held for this script's own longer real-time span instead of
    // just around its own disconnect moment: an idle player here has been
    // observed to die well before this script would otherwise reach its own
    // disconnect scenario. Only stopped for the two peers meant to survive
    // it (host/guest-1) in that scenario's own `finally` below; guest-2's
    // own evasion just ends when its context is closed.
    await Promise.all([startEvading(hostPage), startEvading(guest1Page), startEvading(guest2Page)]);

    console.log("Polling for the first moment all three pages' full 3-player position views agree (real movement, from the continuous evasion above)...");
    // Each page independently reports what it believes every roster player's
    // position is (its own local `host`/`getPlayerPosition("guest-1")`/etc.)
    // — full 3-way lockstep agreement means all three pages' views of *all
    // three* players match, not just pairwise spot checks.
    const PLAYER_IDS = ["host", "guest-1", "guest-2"];
    const readAllPagesFullView = async () => {
      const [hostView, guest1View, guest2View] = await Promise.all(
        [hostPage, guest1Page, guest2Page].map((page) =>
          page.evaluate((ids) => {
            const hooks = window.__codeensteinMultiplayerTestHooks;
            return Object.fromEntries(ids.map((id) => [id, hooks?.getPlayerPosition(id) ?? null]));
          }, PLAYER_IDS),
        ),
      );
      return { host: hostView, "guest-1": guest1View, "guest-2": guest2View };
    };
    const pageLabels = ["host", "guest-1", "guest-2"];
    const allPairsAgree = (views) =>
      PLAYER_IDS.every((playerId) =>
        pageLabels.every((pageA) => pageLabels.every((pageB) => samePosition(views[pageA][playerId], views[pageB][playerId]))),
      );
    const deadline = Date.now() + DEFAULT_TICKING_TIMEOUT_MS;
    let lastViews;
    let converged = false;
    while (Date.now() < deadline) {
      lastViews = await readAllPagesFullView();
      if (allPairsAgree(lastViews)) {
        converged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    check(
      "all three pages agree on every roster player's position (full 3-way lockstep)",
      converged,
      JSON.stringify(lastViews),
    );

    console.log("Checking Elite HP scaling engaged at playerCount=3 (integration confirmation of the already-unit-tested formula)...");
    const enemies = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getEnemiesSnapshot());
    const elite = enemies.find((e) => e.elite);
    const grunt = enemies.find((e) => !e.elite && !e.edgeCase);
    if (elite && grunt) {
      const ratio = elite.maxHp / grunt.maxHp;
      check(
        `Elite/grunt maxHp ratio matches eliteScalingFor(3) (expected ~${EXPECTED_ELITE_TO_GRUNT_HP_RATIO}x)`,
        Math.abs(ratio - EXPECTED_ELITE_TO_GRUNT_HP_RATIO) / EXPECTED_ELITE_TO_GRUNT_HP_RATIO <= ELITE_RATIO_TOLERANCE,
        `elite.maxHp=${elite.maxHp} grunt.maxHp=${grunt.maxHp} ratio=${ratio.toFixed(2)}`,
      );
    } else {
      console.log(
        `  (this run's real, randomly-seeded level has no [elite, grunt] pair to compare — elite=${!!elite} grunt=${!!grunt}; skipping, not a failure — map content genuinely varies run to run)`,
      );
    }

    console.log("Sampling lightweight perf/lag telemetry during real play (informational, not pass/fail)...");
    // Real movement already running continuously (the evasion started right
    // after "Start Session") — sampling an idle scene would understate real
    // per-frame cost (raycasting/sprite-projection work scales with what's
    // actually moving/visible).
    const fpsSamples = { host: [], guest1: [], guest2: [] };
    const skewSamples = { "host-guest1": [], "host-guest2": [], "guest1-guest2": [] };
    for (let i = 0; i < 3; i++) {
      const [hFps, g1Fps, g2Fps] = await Promise.all([sampleFps(hostPage), sampleFps(guest1Page), sampleFps(guest2Page)]);
      fpsSamples.host.push(hFps);
      fpsSamples.guest1.push(g1Fps);
      fpsSamples.guest2.push(g2Fps);
      skewSamples["host-guest1"].push(await sampleTickSkewMs(hostPage, guest1Page));
      skewSamples["host-guest2"].push(await sampleTickSkewMs(hostPage, guest2Page));
      skewSamples["guest1-guest2"].push(await sampleTickSkewMs(guest1Page, guest2Page));
    }
    const summarize = (label, values) => {
      const nums = values.filter((v) => typeof v === "number");
      if (nums.length === 0) return console.log(`  ${label}: no samples`);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      console.log(`  ${label}: min=${Math.min(...nums)} avg=${avg.toFixed(1)} max=${Math.max(...nums)} (n=${nums.length})`);
    };
    console.log("  --- fps (real render frame rate, requestAnimationFrame-sampled) ---");
    summarize("host   ", fpsSamples.host);
    summarize("guest-1", fpsSamples.guest1);
    summarize("guest-2", fpsSamples.guest2);
    console.log("  --- tick skew (ms; simulation-tick agreement between peers at the same real instant) ---");
    summarize("host<->guest-1  ", skewSamples["host-guest1"]);
    summarize("host<->guest-2  ", skewSamples["host-guest2"]);
    summarize("guest-1<->guest-2", skewSamples["guest1-guest2"]);

    console.log("Disconnecting guest-2 specifically (a real transport-level teardown, mirroring verify-multiplayer-disconnect.mjs)...");
    // Host and guest-1 have both been evading continuously since "Start
    // Session" (see the comment there) — real combat exposure is cumulative
    // across this whole script, not just around this moment, so evasion
    // needs to have started long before this point, not just here.
    const [tickBeforeHost, tickBeforeGuest1] = await Promise.all([
      hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick()),
      guest1Page.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick()),
    ]);
    await session.contexts[2].close();

    try {
      console.log("  Waiting for the host to observe guest-2 go disconnected (real ICE detection + grace period)...");
      const waitStart = Date.now();
      let guest2Status = null;
      try {
        const handle = await hostPage.waitForFunction(
          () => {
            const s = window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest-2");
            return s === "disconnected" || s === "dead" ? s : false;
          },
          undefined,
          { timeout: DISCONNECT_DETECT_TIMEOUT_MS },
        );
        guest2Status = await handle.jsonValue();
        console.log(`  [diag] guest-2 reached "${guest2Status}" after ${Date.now() - waitStart}ms real wait`);
        // Same real-combat-death-is-a-legitimate-outcome acceptance as
        // verify-multiplayer-disconnect.mjs's own scenario 1 — either outcome
        // means "gone from the shared simulation," which is what matters here.
        check("host: guest-2 eventually leaves the shared simulation (disconnected, or dead in combat first)", true, `status="${guest2Status}"`);
      } catch (err) {
        check("host: guest-2 eventually leaves the shared simulation (disconnected, or dead in combat first)", false, err.message);
      }

      console.log("  Confirming per-guest isolation: host and guest-1 both keep ticking, guest-1's own status untouched...");
      await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS / 2));
      const [tickAfterHost, tickAfterGuest1, guest1Status, guest1SessionEnded] = await Promise.all([
        hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick()),
        guest1Page.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick()),
        hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest-1")),
        guest1Page.textContent("#multiplayer-status").catch(() => ""),
      ]);
      // Real, unscripted combat (no cheats) occasionally wipes host+guest-1
      // too despite continuous evasion — see `MAX_SCENARIO_ATTEMPTS`'s own
      // doc comment. That's this run's own real bad luck, not a signal about
      // per-guest isolation one way or the other — skip the fine-grained
      // (and, in that case, inevitably failing) checks below and let the
      // caller retry with a fresh session instead of reporting misleading
      // per-check noise.
      if (guest1SessionEnded.toLowerCase().includes("eliminated")) {
        teamWiped = true;
        console.log(
          `  (real combat wiped the whole team during this real wait — guest-1's own #multiplayer-status="${guest1SessionEnded}"; this run's own bad luck, not an isolation-logic failure — will retry)`,
        );
      } else {
        check(
          "host: its own simulation kept advancing while guest-2 disconnected (never stalled waiting on a gone peer)",
          typeof tickAfterHost === "number" && tickAfterHost > tickBeforeHost,
          `before=${tickBeforeHost} after=${tickAfterHost}`,
        );
        check(
          "guest-1: its own simulation kept advancing too — one guest's disconnect never stalls another guest",
          typeof tickAfterGuest1 === "number" && tickAfterGuest1 > tickBeforeGuest1,
          `before=${tickBeforeGuest1} after=${tickAfterGuest1}`,
        );
        check(
          "host: guest-1's own status is completely untouched by guest-2's disconnect (still \"alive\", not \"disconnected\")",
          guest1Status === "alive",
          `guest-1 status="${guest1Status}"`,
        );
        check(
          "guest-1: never itself reached a session-ended state from guest-2's disconnect",
          !guest1SessionEnded.toLowerCase().includes("disconnected") && !guest1SessionEnded.toLowerCase().includes("ended"),
          `guest-1's own #multiplayer-status="${guest1SessionEnded}"`,
        );
      }
    } finally {
      await Promise.all([stopEvading(hostPage), stopEvading(guest1Page)]);
    }

    // guest-2's own context is already closed above (the disconnect
    // scenario itself) — closeMultiplayerSession() closes every context
    // independently/best-effort, so re-closing it here is a harmless no-op,
    // not a double-close error.
    await closeMultiplayerSession(session);
  } catch (err) {
    console.error(`Attempt ${attempt} crashed:`, err);
    failures += 1;
    if (session) await closeMultiplayerSession(session);
  }

  return { failureCount: failures, teamWiped };
}

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName} (three contexts per attempt: host + guest-1 + guest-2)...`);
  const browser = await engine.launch(engineName === "firefox" ? FIREFOX_LAUNCH_OPTIONS : undefined);

  let result = { failureCount: 1, teamWiped: false };
  try {
    for (let attempt = 1; attempt <= MAX_SCENARIO_ATTEMPTS; attempt++) {
      result = await runAttempt(browser, engineName, attempt);
      if (!result.teamWiped) break;
      if (attempt < MAX_SCENARIO_ATTEMPTS) console.log(`Retrying (attempt ${attempt + 1}/${MAX_SCENARIO_ATTEMPTS})...`);
    }
  } finally {
    await browser.close();
  }

  // A `teamWiped` result on the very last attempt means the retry budget
  // was exhausted without the isolation check ever actually running once —
  // `runAttempt` itself never counts that as a failure (there's nothing to
  // check yet), so this must be caught here explicitly, or a fully-exhausted
  // budget would silently report "All checks passed" despite never having
  // verified the one thing this script exists to prove.
  if (result.teamWiped) {
    console.log(
      `\n[FAIL] exhausted all ${MAX_SCENARIO_ATTEMPTS} attempts — real combat wiped the team every time before the per-guest isolation check could run.`,
    );
    result.failureCount += 1;
  }

  console.log(`\n${result.failureCount === 0 ? "All checks passed." : `${result.failureCount} check(s) FAILED.`}`);
  process.exit(result.failureCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-multiguest crashed:", err);
  process.exit(1);
});

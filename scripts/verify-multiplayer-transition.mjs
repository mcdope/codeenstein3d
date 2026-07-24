// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 8's level-transition deliverable — a real host
 * peer navigates (via `MultiplayerBot`, reusing the existing single-player
 * balancing bot's decision logic — see `scripts/lib/multiplayerBot.mjs`'s
 * own doc comment) onto the real generated exit tile, the multiplayer exit
 * countdown runs to zero, and the host broadcasts a real chunked
 * `LevelTransitionMessage` sequence that both peers apply, landing on a
 * genuinely new level with carried-over state. Unit tests
 * (`multiplayerSessionHost.test.ts`/`Guest.test.ts`) already cover the wire
 * protocol and exact carryover values against hand-built fixture maps; this
 * script is the only thing that exercises the real path — actual map
 * generation, real per-tick worker pacing, real cross-peer chunk delivery,
 * and (as a nice side effect of using the real, combat-populated demo
 * campaign) a real in-combat death feeding the revival path — end to end,
 * at real network/timer speed.
 *
 * **The host is made invulnerable for its own walk to the exit**, via
 * `RaycasterEngine.debugSetGodMode` (a narrow, test-only hook, gated behind
 * `?testHooks=1`, never reachable from real gameplay — distinct from the
 * real IDDQD cheat, which stays correctly disabled in multiplayer for real
 * players). This script cares about proving level-transition mechanics
 * work, not about proving a bot can solo-survive the demo campaign's full,
 * real 18-enemy combat gauntlet — those turned out to be two different
 * things conflated into one flaky test: real CI data showed even the
 * best-performing bot profile needing up to 20+ retries purely from organic
 * combat variance, unrelated to any actual bug (see this file's own git
 * history for the investigation). The host still does real BFS-planned
 * navigation through real walls/doors/keys/mines on the real generated
 * level — only combat death is taken off the table, since that was the
 * actual source of the flakiness, not navigation itself.
 *
 * The **guest is deliberately left vulnerable** (idle, not bot-driven,
 * god-mode never applied to it) — the demo campaign's own real, roaming
 * enemies reliably kill an idle player within several real seconds
 * (confirmed directly while building `verify-multiplayer-disconnect.mjs`),
 * which is *useful* here: it's the simplest real way to reach the "a player
 * killed pre-transition is alive at `REVIVE_HEALTH` post-transition"
 * scenario this script needs to cover, without needing to script combat
 * deliberately. Making the host invulnerable does *not* touch this — if the
 * guest happens to survive on a particular run (a sparser map, more distant
 * enemies), the revival-specific checks below are skipped rather than
 * failed, same as before this change.
 *
 * Same `?testHooks=1` read-only-introspection discipline, and "not run
 * against Firefox in CI" reasoning as `verify-multiplayer-connect.mjs` — see
 * that script's own doc comment for the full WebRTC ICE-gathering writeup (a
 * confirmed, Mozilla-WONTFIX, CI-sandbox-only limitation, not an app bug).
 * This script duplicates rather than imports the other multiplayer verify
 * scripts' connect-to-ticking boilerplate — matches this project's own
 * existing convention of each verify script owning its own `check()`/
 * `failures` bookkeeping.
 *
 * Numeric carryover exactness (exact health/ammo values, weapon ownership)
 * is already unit-tested against hand-built fixtures; this script checks the
 * qualitative, only-provable-end-to-end things instead: the countdown
 * signal appears on both real peers, the sim keeps advancing underneath it,
 * both peers actually land on a *different* generated level, both peers'
 * views of that new level agree (lockstep held across the swap), and a
 * player who died before the transition is alive again after it.
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";
import { MultiplayerBot } from "./lib/multiplayerBot.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { PROFILES } from "./run-balancing-telemetry.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const CONNECT_TIMEOUT_MS = 30_000;
const TICKING_TIMEOUT_MS = 30_000;
const TARGET_TICK = 30; // 1s of real ticking at TICK_RATE_HZ(30) — comfortably past session bootstrap.
const COUNTDOWN_TIMEOUT_MS = 15_000; // COUNTDOWN_TICKS is 5s at 30Hz; well beyond that for real timer/broadcast jitter.
const TRANSITION_TIMEOUT_MS = 30_000; // countdown (5s) + chunked broadcast + ack round-trip + real map generation.
const FINAL_APPROACH_TICKS = 80; // mirrors run-balancing-telemetry.mjs's own FINAL_APPROACH_TICKS.
// Combat performance no longer matters for the host's own profile choice
// (it's invulnerable — see this file's own top doc comment) — `Casual` is
// kept simply as a reasonable, already-proven-safe default for the
// navigation-only decisions the bot still makes (route-following pace,
// mine-avoidance caution), not because it out-fights any other profile.
const BOT_PROFILE = PROFILES.Casual;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** See `verify-multiplayer-connect.mjs`'s identical helper for the full "why
 * retry at all" writeup — a freshly launched headless browser's very first
 * navigation has been observed to hit connection-refused for several real
 * seconds even against an already-serving dev server. */
async function gotoWithRetry(page, url, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`  [retry] page.goto(${url}) failed (attempt ${attempt}/${attempts}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

/** Loads the bundled demo campaign — the cheapest way to reach an
 * `isMultiplayerEligibleWorkspace()` state (no GitHub fetch needed) *and* a
 * `currentParsedFile`/`currentLevelPath` the host needs to actually
 * generate a level from — and waits for the Multiplayer tab to enable.
 * `botRotSpeedMul`, when given, mirrors `run-balancing-telemetry.mjs`'s own
 * use of the same URL param — see `PlayerState.rotSpeedMultiplier`'s doc
 * comment (`engine.ts`) — approximating a realistic mouse-look turn speed
 * for whichever peer is actually bot-driven (the host, never the guest). */
async function makeEligible(page, engineName, botRotSpeedMul) {
  const query = botRotSpeedMul ? `?testHooks=1&botRotSpeedMul=${botRotSpeedMul}` : "?testHooks=1";
  await gotoWithRetry(page, `${DEV_SERVER_URL}/${query}`);
  await grantFakeMediaForFirefox(page, engineName);
  await page.click("#tab-demo");
  await page.click("#launch-demo-campaign");
  await page.waitForFunction(
    () => {
      const tab = document.querySelector("#tab-multiplayer");
      return tab instanceof HTMLButtonElement && !tab.disabled;
    },
    undefined,
    { timeout: 20_000 },
  );
  // The demo campaign's own level finishes auto-launching slightly after the
  // Multiplayer tab enables — the host's own `startMultiplayerSessionAsHost`
  // guard needs `currentParsedFile`/`currentLevelPath` to already be set.
  await page.waitForSelector(".canvas-area:not([hidden])", { timeout: 20_000 });
}

/** See `verify-multiplayer-connect.mjs`'s identical helper for the full
 * Firefox single-default-route-interface writeup. */
async function grantFakeMediaForFirefox(page, engineName) {
  if (engineName !== "firefox") return;
  try {
    await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true, video: true }));
    console.log("[diag] getUserMedia() resolved");
  } catch (err) {
    console.log("[diag] getUserMedia() rejected:", err.message);
  }
}

/** Polls `window.__codeensteinMultiplayerTestHooks.getConnectionState()`
 * until it reports `"connected"`, or throws once it reports `"error"` or
 * `CONNECT_TIMEOUT_MS` elapses — whichever comes first. */
async function waitForConnected(page, label) {
  try {
    await page.waitForFunction(
      () => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const state = hooks?.getConnectionState();
        if (state?.state === "error") throw new Error("multiplayer connect flow reported an error state");
        return state?.state === "connected";
      },
      undefined,
      { timeout: CONNECT_TIMEOUT_MS },
    );
  } catch (err) {
    const status = await page.textContent("#multiplayer-status").catch(() => "<unavailable>");
    throw new Error(`${label} never reached "connected" (status: "${status}"): ${err.message}`);
  }
}

/** Waits until this page's own `getSimTick()` reaches `TARGET_TICK` — proof
 * the session is really ticking, not just that it started once. */
async function waitForTargetTick(page, label) {
  try {
    await page.waitForFunction(
      (targetTick) => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const tick = hooks?.getSimTick();
        return tick !== null && tick !== undefined && tick >= targetTick;
      },
      TARGET_TICK,
      { timeout: TICKING_TIMEOUT_MS },
    );
  } catch (err) {
    throw new Error(`${label} never reached tick ${TARGET_TICK}: ${err.message}`);
  }
}

/** Drives a fresh host+guest pair all the way through connect -> "Start
 * Session" -> both peers well past bootstrap (`TARGET_TICK`) — the baseline
 * this script's scenario starts from. Only the host gets `botRotSpeedMul`
 * (see `makeEligible`'s own doc comment) — the guest is never bot-driven. */
async function setupSession(browser, engineName) {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  hostPage.on("pageerror", (err) => console.log("[host pageerror]", err.message));
  guestPage.on("pageerror", (err) => console.log("[guest pageerror]", err.message));

  console.log("  Loading an eligible workspace (demo campaign) in both browsers...");
  // Sequential, not concurrent — see verify-multiplayer-connect.mjs's own
  // comment on why: a cold dev server, hit by two contexts at the same
  // instant right after browser launch, has been observed to reliably
  // connection-refuse both.
  await makeEligible(hostPage, engineName, BOT_PROFILE.rotSpeedMultiplier);
  await makeEligible(guestPage, engineName);

  console.log("  Host: creating a session...");
  await hostPage.click("#tab-multiplayer");
  await hostPage.click("#multiplayer-host-create");
  await hostPage.waitForSelector("#multiplayer-host-code:not([hidden])", { timeout: 15_000 });
  const code = (await hostPage.textContent("#multiplayer-host-code")).trim();

  console.log("  Guest: joining with the host's code...");
  await guestPage.click("#tab-multiplayer");
  await guestPage.click("#multiplayer-subtab-join");
  await guestPage.fill("#multiplayer-join-code-input", code);
  await guestPage.click("#multiplayer-join-connect");

  console.log("  Waiting for both peers to report a connected data channel...");
  await Promise.all([waitForConnected(hostPage, "host"), waitForConnected(guestPage, "guest")]);

  console.log("  Host: starting the session...");
  await hostPage.click("#multiplayer-start-session");

  console.log(`  Waiting for both peers to reach tick ${TARGET_TICK}...`);
  await Promise.all([waitForTargetTick(hostPage, "host"), waitForTargetTick(guestPage, "guest")]);

  return { hostContext, guestContext, hostPage, guestPage };
}

/**
 * Drives the host's real player, navigating (via `MultiplayerBot`, reusing
 * `scripts/lib/bot.mjs`'s proven single-player decision logic) from wherever
 * it currently is onto `map.exit`. Route-planned Node-side from the real
 * generated map (`planRoute` — doors/keys included, unlike a plain bfs
 * walker), seeded from the host's *actual* multiplayer spawn tile rather
 * than `map.spawn` (the single-player-only spawn field `planRoute` itself
 * reads by default — multiplayer assigns the host a different tile, see
 * `sessionEngine.ts`'s `spawnFor`). Assumes the caller already made the host
 * invulnerable (this file's own top doc comment) — `state === "over"` (the
 * host's own status went from "alive" to dead, see
 * `RaycasterEngine.getBotPlayerState`'s doc comment) should therefore be
 * structurally unreachable here; still checked and thrown as a real, fatal
 * (non-retried) error rather than silently ignored, since it firing anyway
 * would mean the god-mode call itself failed or was skipped — a genuine bug
 * worth surfacing immediately, not a condition to retry through.
 */
async function driveHostToExit(hostPage, map) {
  const hostSpawn = await hostPage.evaluate(() => {
    const pos = window.__codeensteinMultiplayerTestHooks.getPlayerPosition("host");
    return { x: Math.floor(pos.x), y: Math.floor(pos.y) };
  });
  const route = planRoute({ ...map, spawn: hostSpawn });
  if (!route.ok) throw new Error(`planRoute() couldn't find a route to the exit: ${JSON.stringify(route)}`);

  // trace/navDiag on: a "stuck" outcome below dumps the same per-decision
  // anomaly detail (position, threat/mine distance, held keys) the
  // balancing-scan tooling uses, instead of a bare {state, reason} — this
  // script previously had none of that, so a first real "stuck" occurrence
  // (see git history) produced zero diagnostic detail beyond the final
  // outcome. Real, ongoing cost is negligible (trace recording is a plain
  // array push per decision, already proven cheap elsewhere).
  // ignoreThreats: true — see `Bot`'s own doc comment on this option for the
  // full reasoning (root-caused directly against this exact script's own real
  // CI failure: a tanky enemy pinned the host in a long melee grind that
  // never counted as a "stall" internally since every landed hit reset that
  // counter, eating real wall-clock time without navigation progress). The
  // host is already invulnerable — fighting was never a survival need, just
  // an unwanted side effect of `tick()`'s default combat engagement.
  const bot = new MultiplayerBot(hostPage, BOT_PROFILE, "host", { logger: { trace: true, navDiag: true }, ignoreThreats: true });
  bot.startLevel(map);

  const legOutcome = await bot.driveLegs(route.legs);
  if (legOutcome.state === "over") throw new Error(`host died despite god mode — the debugSetGodMode call itself must have failed: ${JSON.stringify(legOutcome)}`);
  if (legOutcome.reason === "stuck") {
    bot.reportAnomalies("host-route", 0);
    throw new Error(`host got stuck navigating the planned route: ${JSON.stringify(legOutcome)}`);
  }

  const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
  const pushed = await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
  if (pushed.state === "over") throw new Error(`host died despite god mode — the debugSetGodMode call itself must have failed: ${JSON.stringify(pushed)}`);
  if (pushed.reason === "stuck") {
    bot.reportAnomalies("host-final-approach", 0);
    throw new Error(`host got stuck on the final approach to the exit: ${JSON.stringify(pushed)}`);
  }
}

const FIREFOX_LAUNCH_OPTIONS = {
  firefoxUserPrefs: {
    "media.peerconnection.ice.obfuscate_host_addresses": false,
    "media.navigator.streams.fake": true,
    "media.navigator.permission.disabled": true,
  },
};

/** Runs the whole connect -> navigate -> countdown -> transition scenario
 * once, against a fresh host+guest pair. Any thrown error is fatal — no
 * retry loop above this call anymore (see this file's own top doc comment
 * for why the host no longer needs one). Always tears down its own contexts
 * before returning or throwing. */
async function runScenario(browser, engineName) {
  const { hostContext, guestContext, hostPage, guestPage } = await setupSession(browser, engineName);

  try {
    // Applied to *both* pages, not just the host's — `debugSetGodMode`
    // (`RaycasterEngine.debugSetGodMode`) is a purely local mutation
    // (`this.players.get(playerId)!.godMode = enabled`) with no wire message
    // broadcasting it to the other peer. Each side runs its own full
    // simulation in lockstep from the same inputs; calling this on the host
    // page alone made the *host*'s own local copy of itself invulnerable
    // but left the *guest*'s own local copy of "host" exactly as vulnerable
    // as before — a real, confirmed cross-peer divergence (not a hypothetical
    // one): the demo campaign's real enemies could then kill "host" on the
    // guest's own local simulation while the host's own simulation never
    // took any damage at all, occasionally leaving the guest's own engine
    // believing the whole team was eliminated (both its own local player and
    // its own copy of "host" dead) and ending its session entirely — while
    // the host's session, whose own view of itself was genuinely
    // invulnerable, carried on completely normally. Confirmed directly via a
    // real CI failure: the guest's own `activeMultiplayerSession` had already
    // gone null (session ended) by the time this script checked its status
    // right before the transition, and every guest-side check after that
    // read stale nulls. Setting the same flag on both pages keeps both
    // peers' own local simulations in agreement about "host" being
    // invulnerable, exactly like a real, correctly-synced piece of game
    // state would be — this is a test-script-only fix (the hook itself stays
    // a narrow, non-networked debug mutation, appropriate for its own
    // single-peer IDDQD-cheat use in real single-player gameplay; broadcasting
    // it over the wire would be over-scoped for a hook real players never
    // reach in multiplayer at all).
    await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.debugSetGodMode("host", true));
    await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.debugSetGodMode("host", true));

    const before = await hostPage.evaluate(() => {
      const hooks = window.__codeensteinMultiplayerTestHooks;
      return { map: hooks.getMap(), exit: hooks.getMapExit() };
    });
    check("host: has a real generated map to navigate", before.map !== null && before.exit !== null, JSON.stringify(before.exit));

    console.log("  Guest: left idle and vulnerable — the demo campaign's own real enemies are the simplest way to reach a genuine pre-transition death.");

    console.log("  Host: navigating (invulnerable) to the real exit...");
    try {
      await driveHostToExit(hostPage, before.map);
    } catch (err) {
      const statusText = await hostPage.textContent("#multiplayer-status").catch(() => "<unavailable>");
      console.log(`  [diag] #multiplayer-status at failure time: "${statusText}"`);
      throw err;
    }
    check("host: reached the exit alive", true);

    // The countdown (`COUNTDOWN_TICKS`, 5 real seconds — it runs on real
    // sim ticks, not virtual time) starts the moment any player's *tile*
    // position touches the exit, which real per-tick engine state can
    // satisfy well before `MultiplayerBot`'s own tighter arrival epsilon
    // does — `driveHostToExit`'s final approach (up to `FINAL_APPROACH_TICKS`
    // real bot decisions, each hundreds of ms) can easily take longer than
    // those 5 seconds on its own. So by the time control returns here, the
    // countdown may already be running, already have finished, or (rarely,
    // if the final approach was fast) not started yet — polling for "is
    // currently active" alone raced and missed it entirely on a real run.
    // Accept either signal as proof the mechanism fired: still-active *or*
    // already-transitioned (a different grid than before touching the exit).
    console.log("  Waiting for the exit countdown to appear (or, if it already ran, the transition to already show) on both peers...");
    try {
      await Promise.all([
        hostPage.waitForFunction(
          (prevGrid) =>
            window.__codeensteinMultiplayerTestHooks.getExitCountdownRemaining() !== null ||
            JSON.stringify(window.__codeensteinMultiplayerTestHooks.getMapGrid()) !== JSON.stringify(prevGrid),
          before.map.grid,
          { timeout: COUNTDOWN_TIMEOUT_MS },
        ),
        guestPage.waitForFunction(
          (prevGrid) =>
            window.__codeensteinMultiplayerTestHooks.getExitCountdownRemaining() !== null ||
            JSON.stringify(window.__codeensteinMultiplayerTestHooks.getMapGrid()) !== JSON.stringify(prevGrid),
          before.map.grid,
          { timeout: COUNTDOWN_TIMEOUT_MS },
        ),
      ]);
      check("host: exit countdown becomes active (or has already run)", true);
      check("guest: exit countdown becomes active (or has already run), same lockstep tick as the host", true);
    } catch (err) {
      const hostRemaining = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getExitCountdownRemaining()).catch(() => "<unavailable>");
      const guestRemaining = await guestPage
        .evaluate(() => window.__codeensteinMultiplayerTestHooks.getExitCountdownRemaining())
        .catch(() => "<unavailable>");
      check("host/guest: exit countdown becomes active on both peers", false, `host=${hostRemaining} guest=${guestRemaining}: ${err.message}`);
    }

    console.log("  Confirming the sim keeps advancing (whether still counting down or already on the new level)...");
    const tickBefore = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    await hostPage.waitForTimeout(500);
    const tickAfter = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    check("host: the sim keeps advancing", typeof tickAfter === "number" && tickAfter > tickBefore, `before=${tickBefore} after=${tickAfter}`);

    const guestStatusBeforeTransition = await guestPage
      .evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest-1"))
      .catch(() => null);
    console.log(`  Guest status right before the transition completes: "${guestStatusBeforeTransition}"`);

    console.log("  Waiting for both peers to land on a genuinely new level...");
    try {
      // `grid !== null &&` guards against a false-positive pass: if a peer's
      // whole session ends (e.g. `activeMultiplayerSession` goes null),
      // every hook — including `getMapGrid()` — starts returning `null`,
      // and a bare `JSON.stringify(null) !== JSON.stringify(prevGrid)` reads
      // as "the grid changed" even though nothing actually transitioned —
      // confirmed directly as a real failure mode (a peer's session ending
      // for an unrelated reason read as this check spuriously passing).
      await Promise.all([
        hostPage.waitForFunction(
          (prevGrid) => {
            const grid = window.__codeensteinMultiplayerTestHooks.getMapGrid();
            return grid !== null && JSON.stringify(grid) !== JSON.stringify(prevGrid);
          },
          before.map.grid,
          { timeout: TRANSITION_TIMEOUT_MS },
        ),
        guestPage.waitForFunction(
          (prevGrid) => {
            const grid = window.__codeensteinMultiplayerTestHooks.getMapGrid();
            return grid !== null && JSON.stringify(grid) !== JSON.stringify(prevGrid);
          },
          before.map.grid,
          { timeout: TRANSITION_TIMEOUT_MS },
        ),
      ]);
      check("host/guest: land on a new level after the transition", true);
    } catch (err) {
      check("host/guest: land on a new level after the transition", false, err.message);
    }

    const [hostAfter, guestAfter] = await Promise.all([
      hostPage.evaluate(() => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { exit: hooks.getMapExit(), grid: hooks.getMapGrid(), status: hooks.getPlayerStatus("host") };
      }),
      guestPage.evaluate(() => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { exit: hooks.getMapExit(), grid: hooks.getMapGrid(), status: hooks.getPlayerStatus("guest-1") };
      }),
    ]);
    check(
      "host: landed on a level with a different grid than before (a genuinely new level, not a re-run countdown)",
      JSON.stringify(hostAfter.grid) !== JSON.stringify(before.map.grid),
    );
    check(
      "host and guest agree on the new level's exit (lockstep held across the transition)",
      JSON.stringify(hostAfter.exit) === JSON.stringify(guestAfter.exit),
      `host=${JSON.stringify(hostAfter.exit)} guest=${JSON.stringify(guestAfter.exit)}`,
    );
    check(
      "host and guest agree on the new level's grid (lockstep held across the transition)",
      JSON.stringify(hostAfter.grid) === JSON.stringify(guestAfter.grid),
    );
    check("host: alive on the new level", hostAfter.status === "alive", `status="${hostAfter.status}"`);

    if (guestStatusBeforeTransition === "dead") {
      check("guest: revived (alive again) on the new level after dying pre-transition", guestAfter.status === "alive", `status="${guestAfter.status}"`);
    } else {
      console.log(
        `  (guest was "${guestStatusBeforeTransition}" right before the transition, not "dead" — revival check not applicable this run, skipping)`,
      );
    }
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
}

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName}...`);
  const browser = await engine.launch(engineName === "firefox" ? FIREFOX_LAUNCH_OPTIONS : undefined);

  try {
    await runScenario(browser, engineName);
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-transition crashed:", err);
  process.exit(1);
});

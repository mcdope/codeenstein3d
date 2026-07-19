// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 7's actual deliverable — periodic host-authoritative
 * state reconciliation actually corrects a real, diverged guest, over a real
 * WebRTC connection — picking up exactly where `verify-multiplayer-netcode.mjs`
 * leaves off (two real peers ticking in lockstep) and driving it further.
 *
 * Real cross-engine float drift (confirmed by `scripts/poc-cross-browser-determinism.mjs`)
 * doesn't reliably appear within a short end-to-end run — it compounds from
 * single-ULP transcendental-math errors, which took roughly the first 1% of
 * a 500,000-iteration *stress* loop to surface there, not a couple seconds of
 * ordinary light gameplay. Waiting for it to happen organically here would be
 * slow and flaky. Instead this script uses the guest's own `?testHooks=1`
 * `injectDesync()` hook (`main.ts`) to deliberately force exactly the kind of
 * divergence the spec's PRNG-state-gap section calls out, then proves the
 * host's next periodic snapshot actually corrects it — real wire traffic,
 * real timing, not a mocked channel. The convergence *math* itself (both
 * magnitude-threshold branches, the PRNG-stream-position resync) is already
 * unit-tested directly in `src/engine/engine.test.ts`'s "multiplayer
 * reconciliation" describe block — this script's job is proving the real
 * host -> broadcast -> guest -> apply pipeline actually delivers it, not
 * re-proving the mechanism in isolation.
 *
 * Same assumptions, `?testHooks=1` introspection discipline (with one
 * deliberate exception — see `injectDesync` below), and "not run against
 * Firefox in CI" reasoning as `verify-multiplayer-netcode.mjs` — see that
 * script's own doc comment for the full WebRTC ICE-gathering writeup (a
 * confirmed, Mozilla-WONTFIX, CI-sandbox-only limitation, not an app bug).
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const CONNECT_TIMEOUT_MS = 30_000;
const TICKING_TIMEOUT_MS = 30_000;
// RECONCILE_INTERVAL_TICKS is 30 (once/sec at 30Hz) — generous enough for at
// least one full interval to land within this window.
const CONVERGE_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 150;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** See `verify-multiplayer-netcode.mjs`'s identical helper for the full
 * "why retry at all" writeup. */
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

async function makeEligible(page, engineName) {
  await gotoWithRetry(page, `${DEV_SERVER_URL}/?testHooks=1`);
  await grantFakeMediaForFirefox(page, engineName);
  await page.click("#tab-demo");
  await page.click("#launch-demo-campaign");
  await page.waitForFunction(
    () => {
      const tab = document.querySelector("#tab-multiplayer");
      return tab instanceof HTMLButtonElement && !tab.disabled;
    },
    { timeout: 20_000 },
  );
  await page.waitForSelector(".canvas-area:not([hidden])", { timeout: 20_000 });
}

async function grantFakeMediaForFirefox(page, engineName) {
  if (engineName !== "firefox") return;
  try {
    await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true, video: true }));
    console.log("[diag] getUserMedia() resolved");
  } catch (err) {
    console.log("[diag] getUserMedia() rejected:", err.message);
  }
}

async function waitForConnected(page, label) {
  try {
    await page.waitForFunction(
      () => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const state = hooks?.getConnectionState();
        if (state?.state === "error") throw new Error("multiplayer connect flow reported an error state");
        return state?.state === "connected";
      },
      { timeout: CONNECT_TIMEOUT_MS },
    );
  } catch (err) {
    const status = await page.textContent("#multiplayer-status").catch(() => "<unavailable>");
    throw new Error(`${label} never reached "connected" (status: "${status}"): ${err.message}`);
  }
}

async function waitForFirstTick(page, label) {
  try {
    await page.waitForFunction(() => window.__codeensteinMultiplayerTestHooks?.getSimTick() !== null, { timeout: TICKING_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`${label} never reached its first applied tick: ${err.message}`);
  }
}

function samePosition(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

/**
 * Polls `readHost()`/`readGuest()` (each an async () => value) repeatedly
 * and returns the *first* moment their values satisfy `matches(hostValue,
 * guestValue)`, rather than waiting a fixed duration and comparing once at
 * the end. This distinction matters: the demo campaign's own roaming
 * enemies keep drawing from the shared PRNG stream throughout the whole
 * run, so real (uninjected) cross-engine float drift — the very thing
 * reconciliation exists to bound, confirmed measurably worse on WebKit than
 * Chromium/Firefox by `scripts/poc-cross-browser-determinism.mjs` — can
 * plausibly reappear in the seconds *after* a correcting snapshot lands and
 * *before* a fixed-wait-then-check-once assertion gets around to reading
 * it. Catching the moment convergence first happens proves the correction
 * mechanism actually worked, without requiring the two peers to still
 * agree on every single later sample, which was never reconciliation's own
 * guarantee — periodic correction bounds drift, it doesn't freeze it.
 */
async function pollUntilConverged(readHost, readGuest, matches, timeoutMs = CONVERGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastHost;
  let lastGuest;
  while (Date.now() < deadline) {
    [lastHost, lastGuest] = await Promise.all([readHost(), readGuest()]);
    if (matches(lastHost, lastGuest)) return { converged: true, host: lastHost, guest: lastGuest };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { converged: false, host: lastHost, guest: lastGuest };
}

const FIREFOX_LAUNCH_OPTIONS = {
  firefoxUserPrefs: {
    "media.peerconnection.ice.obfuscate_host_addresses": false,
    "media.navigator.streams.fake": true,
    "media.navigator.permission.disabled": true,
  },
};

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName} (two contexts: host + guest)...`);
  const browser = await engine.launch(engineName === "firefox" ? FIREFOX_LAUNCH_OPTIONS : undefined);

  try {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();
    hostPage.on("pageerror", (err) => console.log("[host pageerror]", err.message));
    guestPage.on("pageerror", (err) => console.log("[guest pageerror]", err.message));

    console.log("Loading an eligible workspace (demo campaign) in both browsers...");
    await makeEligible(hostPage, engineName);
    await makeEligible(guestPage, engineName);

    console.log("Host: creating a session...");
    await hostPage.click("#tab-multiplayer");
    await hostPage.click("#multiplayer-host-create");
    await hostPage.waitForSelector("#multiplayer-host-code:not([hidden])", { timeout: 15_000 });
    const code = (await hostPage.textContent("#multiplayer-host-code")).trim();

    console.log("Guest: joining with the host's code...");
    await guestPage.click("#tab-multiplayer");
    await guestPage.click("#multiplayer-subtab-join");
    await guestPage.fill("#multiplayer-join-code-input", code);
    await guestPage.click("#multiplayer-join-connect");

    console.log("Waiting for both peers to report a connected data channel...");
    await Promise.all([waitForConnected(hostPage, "host"), waitForConnected(guestPage, "guest")]);

    console.log("Host: starting the session...");
    await hostPage.click("#multiplayer-start-session");

    console.log("Waiting for both peers' first applied tick...");
    await Promise.all([waitForFirstTick(hostPage, "host"), waitForFirstTick(guestPage, "guest")]);
    check("host: reached its first applied tick", true);
    check("guest: reached its first applied tick", true);

    // --- Case 1: a small (below-threshold) position desync, smoothed correction ---
    console.log("Injecting a small position desync on the guest's own local player...");
    const beforeSmall = await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerPosition("guest"));
    await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.injectDesync({ kind: "position", deltaTiles: 0.2 }));
    const afterInjectionSmall = await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerPosition("guest"));
    check(
      "small desync: guest's own position actually moved after injection",
      !samePosition(beforeSmall, afterInjectionSmall),
      `before=${JSON.stringify(beforeSmall)} after=${JSON.stringify(afterInjectionSmall)}`,
    );

    console.log("Waiting for the host's next periodic snapshot to correct it (polling for the first moment of convergence)...");
    const readGuestPosFromHost = () => hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerPosition("guest"));
    const readGuestPosFromGuest = () => guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerPosition("guest"));
    const smallResult = await pollUntilConverged(readGuestPosFromHost, readGuestPosFromGuest, samePosition);
    check(
      "small desync: guest's simulated position reconverges with the host's authoritative view",
      smallResult.converged,
      `host-side=${JSON.stringify(smallResult.host)} guest-side=${JSON.stringify(smallResult.guest)}`,
    );
    // Diagnostic only, not a pass/fail check: `hasActiveRenderOffset` decays
    // to `false` on its own after `CORRECTION_SMOOTH_MS` (150ms) — genuinely
    // shorter than this script's own poll interval plus cross-process
    // evaluate() round-trip latency can reliably beat, especially on
    // WebKit. The smoothed-vs-instant-snap distinction itself is already
    // asserted deterministically (no wall-clock race) in
    // `src/engine/engine.test.ts`'s "multiplayer reconciliation" describe
    // block — this is just a "did we plausibly catch it in time" log.
    const smallOffsetting = await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.hasActiveRenderOffset("guest"));
    console.log(`  [info] small desync: hasActiveRenderOffset() sampled as ${smallOffsetting} shortly after convergence`);

    // --- Case 2: a large (at/above-threshold) position desync, instant-snap correction ---
    console.log("Injecting a large position desync on the guest's own local player...");
    await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.injectDesync({ kind: "position", deltaTiles: 5 }));
    console.log("Waiting for the host's next periodic snapshot to correct it...");
    const largeResult = await pollUntilConverged(readGuestPosFromHost, readGuestPosFromGuest, samePosition);
    check(
      "large desync: guest's simulated position reconverges with the host's authoritative view",
      largeResult.converged,
      `host-side=${JSON.stringify(largeResult.host)} guest-side=${JSON.stringify(largeResult.guest)}`,
    );
    const largeOffsetting = await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.hasActiveRenderOffset("guest"));
    check("large desync: no render offset at all — an instant snap, not smoothed", largeOffsetting === false, `hasActiveRenderOffset()=${largeOffsetting}`);

    // --- Case 3: a PRNG-stream-position desync (the spec's own most-emphasized failure mode) ---
    // Deliberately doesn't assert the streams start in sync here: the demo
    // campaign's own roaming enemies keep drawing from the shared stream
    // throughout the whole run, so real (uninjected) cross-engine drift can
    // plausibly already exist by this point — confirmed measurably worse on
    // WebKit than Chromium/Firefox by poc-cross-browser-determinism.mjs, and
    // exactly the reason this mechanism exists in the first place. Asserting
    // "starts in sync" would make this script fail on the very drift it's
    // here to prove gets corrected. The real, robust claim is narrower and
    // doesn't depend on any pre-existing relationship to the host: the
    // injection changes the guest's own state, and the next snapshot brings
    // host and guest into agreement regardless of where either started.
    console.log("Injecting an extra local rng() draw on the guest, desyncing the shared PRNG stream position...");
    const readHostRng = () => hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getRngState());
    const readGuestRng = () => guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getRngState());
    const guestRngBeforeInjection = await readGuestRng();

    await guestPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.injectDesync({ kind: "extraRngDraw" }));
    const guestRngAfterInjection = await readGuestRng();
    check(
      "the injection genuinely changed the guest's own PRNG stream state",
      guestRngAfterInjection !== guestRngBeforeInjection,
      `guest before=${guestRngBeforeInjection} after=${guestRngAfterInjection}`,
    );

    console.log("Waiting for the host's next periodic snapshot to resync the PRNG stream (polling for the first moment of convergence)...");
    const rngResult = await pollUntilConverged(readHostRng, readGuestRng, (a, b) => a === b);
    check(
      "PRNG stream position resyncs — not just visible state, the actual internal counter",
      rngResult.converged,
      `host=${rngResult.host} guest=${rngResult.guest}`,
    );
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-reconciliation crashed:", err);
  process.exit(1);
});

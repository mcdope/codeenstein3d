// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 6c's actual deliverable — two real peers driving
 * one shared simulation in lockstep — picking up exactly where
 * `verify-multiplayer-connect.mjs` leaves off (an open `RTCDataChannel`
 * pair) and continuing through a real "Start Session" click, real ticking,
 * and real cross-peer input propagation. Unit tests mock WebRTC/the tick
 * worker entirely; this is the only thing that exercises the real
 * handshake -> worker-paced ticking -> bundle broadcast -> guest-applies
 * loop end to end, at real network/timer speed.
 *
 * Same assumptions, `?testHooks=1` read-only-introspection discipline, and
 * "not run against Firefox in CI" reasoning as `verify-multiplayer-connect.mjs`
 * — see that script's own doc comment for the full WebRTC ICE-gathering
 * writeup (a confirmed, Mozilla-WONTFIX, CI-sandbox-only limitation, not an
 * app bug). This script duplicates rather than imports that script's
 * connect-to-"connected" boilerplate (`makeEligible`, `waitForConnected`,
 * the Firefox workarounds, `gotoWithRetry`) — matches this project's own
 * existing convention of each verify script owning its own `check()`/
 * `failures` bookkeeping rather than sharing it (see
 * `verify-campaign-playthrough.mjs` and `verify-wad-textures.mjs`).
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const CONNECT_TIMEOUT_MS = 30_000;
const TICKING_TIMEOUT_MS = 30_000;
const TARGET_TICK = 60; // 2s of real ticking at TICK_RATE_HZ(30) — comfortably past session bootstrap.

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** See `verify-multiplayer-connect.mjs`'s identical helper for the full
 * "why retry at all" writeup — a freshly launched headless browser's very
 * first navigation has been observed to hit connection-refused for several
 * real seconds even against an already-serving dev server. */
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
 * generate a level from — and waits for the Multiplayer tab to enable. */
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
      { timeout: CONNECT_TIMEOUT_MS },
    );
  } catch (err) {
    const status = await page.textContent("#multiplayer-status").catch(() => "<unavailable>");
    throw new Error(`${label} never reached "connected" (status: "${status}"): ${err.message}`);
  }
}

/** Waits until this page's own view of the session has applied at least one
 * tick with both players' positions known, and returns the earliest such
 * snapshot — the baseline every later comparison (spawn spread, movement
 * propagation) is measured against. Captured via `waitForFunction`'s return
 * value itself (not a follow-up `evaluate`), so it's exactly the instant the
 * predicate first became true, not whatever tick has ticked by since. */
async function captureEarliestSnapshot(page, label) {
  try {
    const handle = await page.waitForFunction(
      () => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const tick = hooks?.getSimTick();
        if (tick === null || tick === undefined) return false;
        const host = hooks.getPlayerPosition("host");
        const guest = hooks.getPlayerPosition("guest");
        if (!host || !guest) return false;
        return { tick, host, guest };
      },
      { timeout: TICKING_TIMEOUT_MS },
    );
    return await handle.jsonValue();
  } catch (err) {
    throw new Error(`${label} never reached its first applied tick: ${err.message}`);
  }
}

/** Waits until this page's own `getSimTick()` reaches `TARGET_TICK`, then
 * returns a fresh `{tick, host, guest}` snapshot — proof the session kept
 * ticking well past bootstrap, not just that it started once. */
async function waitForTargetTick(page, label) {
  try {
    const handle = await page.waitForFunction(
      (targetTick) => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const tick = hooks?.getSimTick();
        if (tick === null || tick === undefined || tick < targetTick) return false;
        const host = hooks.getPlayerPosition("host");
        const guest = hooks.getPlayerPosition("guest");
        if (!host || !guest) return false;
        return { tick, host, guest };
      },
      TARGET_TICK,
      { timeout: TICKING_TIMEOUT_MS },
    );
    return await handle.jsonValue();
  } catch (err) {
    throw new Error(`${label} never reached tick ${TARGET_TICK}: ${err.message}`);
  }
}

function samePosition(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

/**
 * Polls `readHost()`/`readGuest()` repeatedly and returns the *first* moment
 * their values satisfy `matches(hostValue, guestValue)`, rather than waiting
 * a fixed duration and comparing once at the end. Real movement math
 * (turning/moving is `Math.sin`/`cos`-heavy) is confirmed to diverge
 * measurably faster on WebKit than Chromium/Firefox
 * (`scripts/poc-cross-browser-determinism.mjs`), and step 7's own periodic
 * reconciliation only corrects it once a second — a fixed-wait-then-check-
 * once assertion shortly after real movement can land in the window where a
 * fresh, genuine (if small) divergence has reappeared but the next
 * correction hasn't landed yet. Catching the moment agreement first happens
 * proves lockstep is working, without requiring it to still hold at an
 * arbitrary later instant.
 */
async function pollUntilConverged(readHost, readGuest, matches, timeoutMs = TICKING_TIMEOUT_MS, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastHost;
  let lastGuest;
  while (Date.now() < deadline) {
    [lastHost, lastGuest] = await Promise.all([readHost(), readGuest()]);
    if (matches(lastHost, lastGuest)) return { converged: true, host: lastHost, guest: lastGuest };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
    // Sequential, not concurrent — see verify-multiplayer-connect.mjs's own
    // comment on why: a cold dev server, hit by two contexts at the same
    // instant right after browser launch, has been observed to reliably
    // connection-refuse both.
    await makeEligible(hostPage, engineName);
    await makeEligible(guestPage, engineName);
    check("host: Multiplayer tab enabled", true);
    check("guest: Multiplayer tab enabled", true);

    console.log("Host: creating a session...");
    await hostPage.click("#tab-multiplayer");
    await hostPage.click("#multiplayer-host-create");
    await hostPage.waitForSelector("#multiplayer-host-code:not([hidden])", { timeout: 15_000 });
    const code = (await hostPage.textContent("#multiplayer-host-code")).trim();
    console.log(`Host code: ${code}`);

    console.log("Guest: joining with the host's code...");
    await guestPage.click("#tab-multiplayer");
    await guestPage.click("#multiplayer-subtab-join");
    await guestPage.fill("#multiplayer-join-code-input", code);
    await guestPage.click("#multiplayer-join-connect");

    console.log("Waiting for both peers to report a connected data channel...");
    await Promise.all([waitForConnected(hostPage, "host"), waitForConnected(guestPage, "guest")]);
    check("host: reports state \"connected\"", true);
    check("guest: reports state \"connected\"", true);

    console.log("Host: starting the session...");
    await hostPage.click("#multiplayer-start-session");

    console.log("Waiting for both peers' first applied tick...");
    const [hostEarly, guestEarly] = await Promise.all([
      captureEarliestSnapshot(hostPage, "host"),
      captureEarliestSnapshot(guestPage, "guest"),
    ]);
    check("host: reached its first applied tick", true, `tick ${hostEarly.tick}`);
    check("guest: reached its first applied tick", true, `tick ${guestEarly.tick}`);
    check(
      "spawns are spread apart (not stacked on the same tile)",
      !samePosition(hostEarly.host, hostEarly.guest),
      `host=${JSON.stringify(hostEarly.host)} guest=${JSON.stringify(hostEarly.guest)}`,
    );

    console.log(`Waiting for both peers to reach tick ${TARGET_TICK}...`);
    const [hostAtTarget, guestAtTarget] = await Promise.all([
      waitForTargetTick(hostPage, "host"),
      waitForTargetTick(guestPage, "guest"),
    ]);
    check(`host: reached tick ${TARGET_TICK}`, true, `actual tick ${hostAtTarget.tick}`);
    check(`guest: reached tick ${TARGET_TICK}`, true, `actual tick ${guestAtTarget.tick}`);
    // Neither peer has moved yet — an idle player's position never drifts on
    // its own, so both peers' views of both players must still agree exactly,
    // proving lockstep convergence independent of the exact tick each
    // snapshot landed on.
    check(
      "host's and guest's views of the host player's position agree",
      samePosition(hostAtTarget.host, guestAtTarget.host),
      `host-side=${JSON.stringify(hostAtTarget.host)} guest-side=${JSON.stringify(guestAtTarget.host)}`,
    );
    check(
      "host's and guest's views of the guest player's position agree",
      samePosition(hostAtTarget.guest, guestAtTarget.guest),
      `host-side=${JSON.stringify(hostAtTarget.guest)} guest-side=${JSON.stringify(guestAtTarget.guest)}`,
    );

    console.log("Host: holding W to move, checking it propagates to the guest's view...");
    const guestsViewOfHostBefore = guestAtTarget.host;
    await hostPage.focus("canvas.scene-canvas");
    await hostPage.keyboard.down("KeyW");
    await hostPage.waitForTimeout(500);
    await hostPage.keyboard.up("KeyW");

    try {
      await guestPage.waitForFunction(
        (before) => {
          const hooks = window.__codeensteinMultiplayerTestHooks;
          const pos = hooks?.getPlayerPosition("host");
          return !!pos && (pos.x !== before.x || pos.y !== before.y);
        },
        guestsViewOfHostBefore,
        { timeout: TICKING_TIMEOUT_MS },
      );
      check("guest: sees the host's real movement (cross-peer input propagation)", true);
    } catch (err) {
      check("guest: sees the host's real movement (cross-peer input propagation)", false, err.message);
    }

    console.log("Letting the movement settle, then polling for the first moment of final lockstep agreement...");
    await hostPage.waitForTimeout(500);
    const readHostView = () =>
      hostPage.evaluate(() => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { tick: hooks.getSimTick(), host: hooks.getPlayerPosition("host"), guest: hooks.getPlayerPosition("guest") };
      });
    const readGuestView = () =>
      guestPage.evaluate(() => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        return { tick: hooks.getSimTick(), host: hooks.getPlayerPosition("host"), guest: hooks.getPlayerPosition("guest") };
      });
    const hostAgreement = await pollUntilConverged(readHostView, readGuestView, (h, g) => samePosition(h.host, g.host));
    check(
      "after movement settles, both peers still agree on the host player's position",
      hostAgreement.converged,
      `host-side=${JSON.stringify(hostAgreement.host?.host)} guest-side=${JSON.stringify(hostAgreement.guest?.host)}`,
    );
    const guestAgreement = await pollUntilConverged(readHostView, readGuestView, (h, g) => samePosition(h.guest, g.guest));
    check(
      "after movement settles, both peers still agree on the guest player's position",
      guestAgreement.converged,
      `host-side=${JSON.stringify(guestAgreement.host?.guest)} guest-side=${JSON.stringify(guestAgreement.guest?.guest)}`,
    );
    const hostFinal = await readHostView();
    check(
      "the host player actually moved from its spawn",
      !samePosition(hostEarly.host, hostFinal.host),
      `spawn=${JSON.stringify(hostEarly.host)} final=${JSON.stringify(hostFinal.host)}`,
    );
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-netcode crashed:", err);
  process.exit(1);
});

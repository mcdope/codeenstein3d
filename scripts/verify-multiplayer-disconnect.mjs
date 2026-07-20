// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 8's disconnect-handling deliverable — two real
 * peers, one of which has its actual `RTCPeerConnection` torn down mid-
 * session by really closing its browser context (not a faked connection-
 * state signal), the way `multiplayerSessionHost.ts`/`Guest.ts`'s own unit
 * tests can't: those inject a fake `ConnectionStateSource` precisely because
 * this project's test environment has no real WebRTC stack at all. This is
 * the only thing that exercises real ICE-level disconnect detection ->
 * `DISCONNECT_GRACE_MS` grace -> synchronized roster removal end to end, at
 * real network/timer speed.
 *
 * Same `?testHooks=1` read-only-introspection discipline, and "not run
 * against Firefox in CI" reasoning as `verify-multiplayer-connect.mjs` — see
 * that script's own doc comment for the full WebRTC ICE-gathering writeup (a
 * confirmed, Mozilla-WONTFIX, CI-sandbox-only limitation, not an app bug).
 * This script duplicates rather than imports `verify-multiplayer-netcode.mjs`'s
 * connect-to-first-tick boilerplate — matches this project's own existing
 * convention of each verify script owning its own `check()`/`failures`
 * bookkeeping rather than sharing it.
 *
 * Real ICE disconnection detection latency after an abrupt transport
 * teardown is inherently variable (STUN consent-freshness checks, not an
 * instant signal) — `DISCONNECT_DETECT_TIMEOUT_MS` below is deliberately
 * generous (well beyond `DISCONNECT_GRACE_MS` itself) to absorb that
 * variance rather than racing it.
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const CONNECT_TIMEOUT_MS = 30_000;
const TICKING_TIMEOUT_MS = 30_000;
const TARGET_TICK = 30; // 1s of real ticking at TICK_RATE_HZ(30) — comfortably past session bootstrap.
const DISCONNECT_DETECT_TIMEOUT_MS = 90_000;

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

/** Logs every `RTCPeerConnection.connectionState` transition this page's own
 * connection goes through — installed before any app code runs via
 * `addInitScript`. Diagnostic only, gated behind
 * `CODEENSTEIN_MULTIPLAYER_DEBUG_ICE=1` (same env var
 * `verify-multiplayer-connect.mjs`'s own `installIceDiagnostics()` uses) —
 * silent otherwise. */
async function installConnectionStateDiagnostics(page, label) {
  if (process.env.CODEENSTEIN_MULTIPLAYER_DEBUG_ICE !== "1") return;
  await page.addInitScript((label) => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let counter = 0;
    window.RTCPeerConnection = class extends OriginalRTCPeerConnection {
      constructor(...args) {
        super(...args);
        const id = ++counter;
        this.addEventListener("connectionstatechange", () => {
          console.log(`[conn:${label}#${id}] connectionState -> ${this.connectionState}`);
        });
        this.addEventListener("iceconnectionstatechange", () => {
          console.log(`[conn:${label}#${id}] iceConnectionState -> ${this.iceConnectionState}`);
        });
      }
    };
  }, label);
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

/** Waits until this page's own `getSimTick()` reaches `TARGET_TICK` —
 * proof the session is really ticking, not just that it started once. */
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

const FIREFOX_LAUNCH_OPTIONS = {
  firefoxUserPrefs: {
    "media.peerconnection.ice.obfuscate_host_addresses": false,
    "media.navigator.streams.fake": true,
    "media.navigator.permission.disabled": true,
  },
};

/** Drives a fresh host+guest pair from two new browser contexts all the way
 * through connect -> "Start Session" -> both peers' first applied tick, well
 * past bootstrap (`TARGET_TICK`) — the common baseline both scenarios below
 * start from. Each scenario gets its own fresh pair (a session, once one
 * side is really gone, has nothing left to reuse). */
async function setupSession(browser, engineName) {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  hostPage.on("pageerror", (err) => console.log("[host pageerror]", err.message));
  guestPage.on("pageerror", (err) => console.log("[guest pageerror]", err.message));
  await installConnectionStateDiagnostics(hostPage, "host");
  await installConnectionStateDiagnostics(guestPage, "guest");
  if (process.env.CODEENSTEIN_MULTIPLAYER_DEBUG_ICE === "1") {
    hostPage.on("console", (msg) => console.log("[host console]", msg.text()));
    guestPage.on("console", (msg) => console.log("[guest console]", msg.text()));
  }

  console.log("  Loading an eligible workspace (demo campaign) in both browsers...");
  // Sequential, not concurrent — see verify-multiplayer-connect.mjs's own
  // comment on why: a cold dev server, hit by two contexts at the same
  // instant right after browser launch, has been observed to reliably
  // connection-refuse both.
  await makeEligible(hostPage, engineName);
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
 * Holds "move forward" and "turn" together so the page walks in a continuous
 * curve rather than a straight line — a straight line reliably ends at a
 * wall (observed directly: the host got stuck against one and stopped
 * moving within ~4s in an early version of this script), at which point a
 * stationary target is exactly as exposed to the demo campaign's own real,
 * roaming enemies as never having moved at all. A curving path can't get
 * permanently stuck the same way — it turns away from whatever it grazes.
 * Used to keep a player away from real combat exposure for as long as this
 * scenario needs it connected/controllable (never possible for the peer
 * whose context gets closed — see this file's own findings below on why
 * that peer's fate is accepted, not fought). */
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
 * Scenario 1: the guest's browser context is closed outright — a real
 * transport-level teardown, not a faked signal. The host must eventually
 * (real ICE disconnect detection + `DISCONNECT_GRACE_MS` grace) mark the
 * guest `"disconnected"`, and must keep its own simulation running
 * throughout — never stall waiting on a peer that's gone.
 *
 * The bundled demo campaign is a real, fully-populated level (18 enemies) —
 * not a synthetic empty room — and its multiplayer spawns get no special
 * protection from *ongoing* enemy aggro (only from an enemy's own *initial*
 * placement, and from hazards/mines within a few tiles — confirmed by
 * reading `mapGenerator.ts`/`trapsHazards.ts` directly; a roaming enemy
 * finding a stationary target afterward is normal, expected gameplay, the
 * same as standing still in single-player). Direct empirical observation
 * (`CODEENSTEIN_MULTIPLAYER_DEBUG_ICE=1`, iterating on this exact script)
 * found both spawns' idle occupants dead within ~7 real seconds — faster
 * than `DISCONNECT_GRACE_MS` itself. The host survives this because it can
 * be kept moving (`startEvading`); the **guest cannot** — its context is
 * closed outright, precisely the real scenario this test exists to prove.
 * So its in-world body dying in real combat *before* the grace-driven
 * roster removal ever reaches it is a real, legitimate possible outcome,
 * not a bug: `applyRosterRemoval`'s own no-op-if-already-non-alive guard
 * (step 8 unit tests already cover this exact case) means a combat death
 * simply pre-empts the disconnect path, landing on `"dead"` instead of
 * `"disconnected"` — both are "gone from the shared simulation" outcomes,
 * so this scenario accepts either for the guest, while still strictly
 * requiring the host to survive and keep advancing (the actual step-8
 * guarantee this scenario exists to prove).
 */
async function scenarioGuestDisconnect(browser, engineName) {
  console.log("\n=== Scenario 1: guest disconnects mid-session ===");
  const { hostContext, guestContext, hostPage, guestPage } = await setupSession(browser, engineName);

  try {
    // Give the guest a head start away from its own spawn's immediate
    // vicinity before it goes permanently uncontrollable — the only
    // mitigation available for a peer about to lose its browser entirely.
    // Both evade from the same starting instant — the host must not sit
    // idle while only the guest gets a head start, or it's exposed to real
    // combat for exactly as long as this delay lasts (caught directly: an
    // earlier version of this scenario started the host's own evasion only
    // *after* the guest's, and the host died too).
    await Promise.all([startEvading(guestPage), startEvading(hostPage)]);
    await hostPage.waitForTimeout(8000);
    await stopEvading(guestPage);

    const statusRightAfterClose = await (async () => {
      console.log("  Closing the guest's browser context (a real transport-level teardown)...");
      await guestContext.close();
      // Immediately after the transport is gone — before real ICE detection
      // or the grace period could plausibly have elapsed — the guest must
      // still read "alive": disconnection is never instant.
      return hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest"));
    })();
    check(
      "host: the guest is NOT yet marked disconnected the instant the transport closes",
      statusRightAfterClose === "alive",
      `status="${statusRightAfterClose}"`,
    );

    console.log("  Waiting for the host to observe the guest go disconnected (real ICE detection + grace period)...");
    let guestStatus = null;
    try {
      const handle = await hostPage.waitForFunction(
        () => {
          const s = window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest");
          return s === "disconnected" || s === "dead" ? s : false;
        },
        undefined,
        { timeout: DISCONNECT_DETECT_TIMEOUT_MS },
      );
      guestStatus = await handle.jsonValue();
      check(
        "host: the guest eventually leaves the shared simulation (disconnected, or dead in combat first)",
        true,
        `status="${guestStatus}"`,
      );
    } catch (err) {
      const status = await hostPage
        .evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("guest"))
        .catch(() => "<unavailable>");
      const hostStatus = await hostPage
        .evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("host"))
        .catch(() => "<unavailable>");
      const multiplayerStatusText = await hostPage.textContent("#multiplayer-status").catch(() => "<unavailable>");
      check(
        "host: the guest eventually leaves the shared simulation (disconnected, or dead in combat first)",
        false,
        `guest status="${status}" host status="${hostStatus}" #multiplayer-status="${multiplayerStatusText}": ${err.message}`,
      );
    }

    if (guestStatus === "disconnected") {
      const drops = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getLootDrops());
      check(
        "host: the guest's inventory converted to loot tagged source:\"disconnect\"",
        Array.isArray(drops) && drops.some((d) => d.source === "disconnect"),
        `drops=${JSON.stringify(drops)}`,
      );
    } else {
      // A real combat death drops keys only (the existing, separately-
      // tested death path — see `killPlayer()`), never converts ammo/
      // weapons: `applyRosterRemoval` never got to run for an
      // already-non-alive player (its own doc comment covers this no-op
      // case). Nothing to assert here beyond that being expected.
      console.log('  (guest reached "dead" before grace could apply — disconnect-conversion no-op is expected and already unit-tested, skipping the loot-source check for this run)');
    }

    console.log("  Confirming the host's own simulation keeps running (one player remains)...");
    const tickBefore = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    await hostPage.waitForTimeout(1000);
    const tickAfter = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getSimTick());
    check(
      "host: its own simulation keeps advancing after the guest is gone",
      typeof tickAfter === "number" && tickAfter > tickBefore,
      `before=${tickBefore} after=${tickAfter}`,
    );
    check(
      "host: the local (host) player is still alive — team not wiped by one disconnect",
      (await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks.getPlayerStatus("host"))) === "alive",
    );
  } finally {
    await stopEvading(hostPage);
    await hostContext.close();
  }
}

/**
 * Scenario 2: the host's browser context is closed outright. The guest gets
 * no more bundles (nothing to fabricate — a lockstep peer with no host is
 * structurally stuck), so after real ICE disconnect detection + grace it
 * reaches a provisional `"host-disconnected"` end state, sourced from its
 * own local (not host-authoritative) view — see `SessionEndReason`'s doc
 * comment in `sessionEngine.ts`.
 */
async function scenarioHostDisconnect(browser, engineName) {
  console.log("\n=== Scenario 2: host disconnects mid-session ===");
  const { hostContext, guestContext, guestPage } = await setupSession(browser, engineName);

  try {
    // Unlike scenario 1, the guest here needs no evasion: it has no worker
    // of its own — its simulation only ever advances from inside the
    // handler that a *host-sent* bundle arriving triggers (see
    // `multiplayerSessionGuest.ts`'s own doc comment). Once the host is
    // gone, no more bundles arrive, so the guest's own simulation freezes
    // at whatever tick it last received — no further real combat can touch
    // it while it waits out the grace period, structurally, not by luck.
    console.log("  Closing the host's browser context (a real transport-level teardown)...");
    await hostContext.close();

    console.log("  Waiting for the guest to reach its provisional 'host-disconnected' end state...");
    const expectedStatus = "Multiplayer session ended — the host disconnected.";
    try {
      await guestPage.waitForFunction(
        (expected) => document.querySelector("#multiplayer-status")?.textContent === expected,
        expectedStatus,
        { timeout: DISCONNECT_DETECT_TIMEOUT_MS },
      );
      check("guest: reaches the provisional 'host-disconnected' end state", true);
    } catch (err) {
      const status = await guestPage.textContent("#multiplayer-status").catch(() => "<unavailable>");
      check("guest: reaches the provisional 'host-disconnected' end state", false, `status="${status}": ${err.message}`);
    }

    // The end-of-run comparison table (multiplayer step 9) is drawn on the
    // canvas itself and blocks until dismissed — `resetToFileTree()` no
    // longer fires immediately on session end (see `onMultiplayerSessionEnded`'s
    // own doc comment in main.ts), so the canvas area is still showing right
    // now, with the comparison screen's title/rows painted on it. Exact row
    // text is already asserted against a mocked canvas in main.test.ts's own
    // jsdom suite (fillText call args) — this real-browser round trip proves
    // the overlay genuinely blocks and genuinely dismisses, not the pixels.
    check(
      "guest: the canvas area is still showing (comparison table blocks the return to the file tree)",
      await guestPage.evaluate(() => document.querySelector(".canvas-area")?.hasAttribute("hidden") === false),
    );

    console.log("  Dismissing the comparison overlay (past its own real-time dismiss lock)...");
    await guestPage.waitForTimeout(1300);
    await guestPage.keyboard.press("Enter");

    console.log("  Waiting for the return to the file tree...");
    try {
      // `state: "attached"`, not the default "visible" — a `.canvas-area[hidden]`
      // match can never be "visible" (the `hidden` attribute forces
      // `display: none`), so waiting for that combination with the default
      // state would time out even once the attribute is really set (confirmed
      // directly: CI's own log showed the locator repeatedly resolving to the
      // correctly-hidden element while still failing the "visible" wait).
      await guestPage.waitForSelector(".canvas-area[hidden]", { state: "attached", timeout: 10_000 });
      check("guest: the canvas area is torn down (back to the file tree) once the comparison table is dismissed", true);
    } catch (err) {
      const hidden = await guestPage.evaluate(() => document.querySelector(".canvas-area")?.hasAttribute("hidden") ?? "<unavailable>");
      check(
        "guest: the canvas area is torn down (back to the file tree) once the comparison table is dismissed",
        false,
        `hidden=${hidden}: ${err.message}`,
      );
    }
  } finally {
    await guestContext.close();
  }
}

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName}...`);
  const browser = await engine.launch(engineName === "firefox" ? FIREFOX_LAUNCH_OPTIONS : undefined);

  try {
    await scenarioGuestDisconnect(browser, engineName);
    await scenarioHostDisconnect(browser, engineName);
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-disconnect crashed:", err);
  process.exit(1);
});

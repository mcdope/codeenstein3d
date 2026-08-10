// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shared N-player (2-4) multiplayer session bootstrap — the connect/join/
 * start sequence `scripts/verify-multiplayer-multiguest.mjs` (step 10)
 * originally proved out for a fixed host/guest-1/guest-2 shape, extracted
 * and generalized here (step 11) so both that script and the new bot-driven
 * telemetry tooling can share it instead of each duplicating it.
 *
 * This module used to say the connect/tick-wait helpers were deliberately
 * "still copied, not imported" by the sibling 2-player scripts, mirroring an
 * "each verify script owns its own bookkeeping" convention. **That convention
 * is retired, because it cost more than it bought.** The five copies were
 * byte-identical to each other — same `DEV_SERVER_URL` expression, same
 * `CONNECT_TIMEOUT_MS = 30_000`, same `FIREFOX_LAUNCH_OPTIONS` — so the
 * independence it promised was fictional, while the drift was real: a
 * `waitForSelector(".canvas-area:not([hidden])")` fix landed in five of the six
 * copies of `makeEligible` and was never back-ported to
 * `verify-multiplayer-connect.mjs`, leaving a blocking CI job racing a level
 * load for however long nobody noticed.
 *
 * Every 2-player script now imports these from here. Note the extraction that
 * created this module was *lossy* — it dropped `gotoWithRetry`'s retry line and
 * `grantFakeMediaForFirefox`'s `[diag]` lines — so those were restored here
 * before the migration, making this a strict superset of what each script had.
 *
 * The *N-player* bootstrap sequence below is separate: genuinely new machinery
 * step 10 needed (every pre-step-10 script is hardcoded to exactly 2 peers),
 * shared from the start rather than copy-pasted into every future N-player
 * script.
 *
 * All the real timing/retry decisions here (the guest-join race against
 * `armNextGuestSlot`'s own async re-arm, its 9-attempt/5s-spacing budget,
 * the signaling server's guess-sensitive rate limit that budget stays under)
 * are unchanged from `verify-multiplayer-multiguest.mjs`'s own doc comment —
 * see that file for the full "why retry at all" writeup and the real CI
 * evidence (both chromium and webkit) that sized these defaults.
 */

/** Two independent Firefox-only WebRTC quirks, both only reachable via
 * `firefoxUserPrefs` (Chromium/WebKit need neither):
 *  - `media.peerconnection.ice.obfuscate_host_addresses: false` — Firefox
 *    delays starting its mDNS responder for local ICE candidates until
 *    `setRemoteDescription()` actually runs (Mozilla bug 1691189), which
 *    this app's non-trickle ICE design (see `webrtcConnection.ts`'s doc
 *    comment) blocks on, and a sandboxed CI runner has no mDNS/avahi
 *    service to resolve it at all.
 *  - `media.navigator.streams.fake` / `media.navigator.permission.disabled`
 *    — paired with `grantFakeMediaForFirefox()`'s actual `getUserMedia()`
 *    call, lets that call resolve instantly against a synthetic stream
 *    instead of hanging on (or being denied) a real camera/mic prompt.
 */
export const FIREFOX_LAUNCH_OPTIONS = {
  firefoxUserPrefs: {
    "media.peerconnection.ice.obfuscate_host_addresses": false,
    "media.navigator.streams.fake": true,
    "media.navigator.permission.disabled": true,
  },
};

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_TICKING_TIMEOUT_MS = 30_000;
export const DEFAULT_GUEST_JOIN_RETRY_DELAY_MS = 5_000;
export const DEFAULT_GUEST_JOIN_MAX_ATTEMPTS = 9;

/** See `verify-multiplayer-connect.mjs`'s identical helper for the full "why
 * retry at all" writeup — a freshly launched headless browser's very first
 * navigation has been observed to hit connection-refused for several real
 * seconds even against an already-serving dev server. */
export async function gotoWithRetry(page, url, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      // Only ever printed when a navigation actually failed, so this is
      // silent on a healthy run — but a cold-start retry is exactly the kind
      // of thing you want in a CI log when a multiplayer job goes red for
      // reasons that look like the app and aren't.
      console.log(`  [retry] page.goto(${url}) failed (attempt ${attempt}/${attempts}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

/** See `verify-multiplayer-connect.mjs`'s top doc comment for the full Firefox
 * single-default-route-interface writeup.
 *
 * Both outcomes are logged rather than swallowed: whether the fake grant
 * actually landed decides whether Firefox gathers ICE candidates from more
 * than one interface, so "did getUserMedia resolve" is the first thing worth
 * knowing when a Firefox run gathers nothing. Fires once per page, on Firefox
 * only — every chromium/webkit caller sees nothing at all. */
export async function grantFakeMediaForFirefox(page, engineName) {
  if (engineName !== "firefox") return;
  try {
    await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true, video: true }));
    console.log("[diag] getUserMedia() resolved");
  } catch (err) {
    console.log("[diag] getUserMedia() rejected:", err.message);
  }
}

/** Loads the bundled demo campaign — the cheapest way to reach an
 * `isMultiplayerEligibleWorkspace()` state (no GitHub fetch needed) *and* a
 * `currentParsedFile`/`currentLevelPath` the host needs to actually generate
 * a level from — and waits for the Multiplayer tab to enable. */
export async function makeEligible(page, engineName, devServerUrl, botRotSpeedMul) {
  // `botRotSpeedMul` mirrors `run-balancing-telemetry.mjs`'s single-player use
  // of the same URL param, and its absence here was a real measurement bug:
  // the bot sizes every turn-key hold with `turnBurstMs`, which scales by the
  // profile's `rotSpeedMultiplier` (2/3.5/5), while the engine — never told
  // about it — turned at the bare `ROT_SPEED` of 2.6 rad/s. Every multiplayer
  // telemetry run therefore under-rotated by 2-5x, and `rotSpeedMultiplier`,
  // one of the few knobs that genuinely differentiates the skill tiers, was
  // inert on the multiplayer axis entirely.
  //
  // Optional on purpose: callers that pass nothing (the verify scripts) get
  // the byte-identical URL they had before, so no CI job changes behaviour.
  // The engine clamps the value to [1, 10] (`engine.ts`).
  const query = botRotSpeedMul ? `?testHooks=1&botRotSpeedMul=${botRotSpeedMul}` : "?testHooks=1";
  await gotoWithRetry(page, `${devServerUrl}/${query}`);
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
  await page.waitForSelector(".canvas-area:not([hidden])", { timeout: 20_000 });
}

/** Polls `window.__codeensteinMultiplayerTestHooks.getConnectionState()`
 * until it reports `"connected"`, or throws once it reports `"error"` or
 * `timeoutMs` elapses — whichever comes first. */
export async function waitForConnected(page, label, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      () => {
        const hooks = window.__codeensteinMultiplayerTestHooks;
        const state = hooks?.getConnectionState();
        if (state?.state === "error") throw new Error("multiplayer connect flow reported an error state");
        return state?.state === "connected";
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (err) {
    const status = await page.textContent("#multiplayer-status").catch(() => "<unavailable>");
    throw new Error(`${label} never reached "connected" (status: "${status}"): ${err.message}`);
  }
}

/** Waits until the host's own `getConnectionState()` reports at least
 * `count` connected guests — the auto-rearm loop's own observable progress
 * signal (`main.ts`'s `armNextGuestSlot`/`getConnectionState`'s
 * `connectedGuestCount` field, step 10). */
export async function waitForGuestCount(hostPage, count, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  try {
    await hostPage.waitForFunction(
      (n) => (window.__codeensteinMultiplayerTestHooks?.getConnectionState()?.connectedGuestCount ?? 0) >= n,
      count,
      { timeout: timeoutMs },
    );
  } catch (err) {
    const state = await hostPage.evaluate(() => window.__codeensteinMultiplayerTestHooks?.getConnectionState()).catch(() => "<unavailable>");
    throw new Error(`host never reported connectedGuestCount >= ${count} (state: ${JSON.stringify(state)}): ${err.message}`);
  }
}

/** Thrown by `waitForTargetTick` specifically — a distinct type (not a bare
 * `Error`) so a caller can deliberately choose to retry on it, the same way
 * `verify-multiplayer-transition.mjs`'s own `HostDiedDuringNavigation` lets
 * that script retry one specific, real-world-timing-sensitive condition
 * without silently retrying every other failure mode too. Real CI runs
 * (multiple headless browser contexts, real WebRTC, real per-tick work) do
 * occasionally miss `timeoutMs` under resource contention with nothing
 * actually wrong — confirmed directly: reproduced with a *different* peer
 * lagging each time, in the same CI run where an unrelated script's own
 * combat-timing retry budget was also visibly under real pressure. */
export class TickSyncTimeoutError extends Error {}

/** Waits until `page`'s own `getSimTick()` reaches `targetTick`. */
export async function waitForTargetTick(page, label, targetTick, timeoutMs = DEFAULT_TICKING_TIMEOUT_MS) {
  try {
    await page.waitForFunction(
      (t) => (window.__codeensteinMultiplayerTestHooks?.getSimTick() ?? -1) >= t,
      targetTick,
      { timeout: timeoutMs },
    );
  } catch (err) {
    throw new TickSyncTimeoutError(`${label} never reached tick ${targetTick}: ${err.message}`);
  }
}

/**
 * Bootstraps one full real N-player (2-4) multiplayer session: launches
 * `playerCount` browser contexts (1 host + `playerCount - 1` guests), loads
 * an eligible workspace in each, has the host create a session at that
 * `maxPlayers`, joins every guest sequentially against the *same* code
 * (guest 1 via the host's own first, non-racing offer; every guest after
 * that racing `armNextGuestSlot`'s async re-arm cycle, absorbed by the
 * retry loop described in this module's own doc comment), clicks "Start
 * Session", and waits for every peer to reach `targetTick`.
 *
 * Returns the live pages/contexts/roster for the caller to drive further
 * (bots, assertions, telemetry sampling, disconnect scenarios, ...) — call
 * `closeMultiplayerSession()` when done with them.
 *
 * `playerCount` is required and must be an integer 2-4 (the same range the
 * host's own `#multiplayer-max-players` select offers) — this module makes
 * no attempt to support more, matching the app's own current UI cap.
 */
export async function bootstrapMultiplayerSession(browser, options) {
  const {
    engineName,
    devServerUrl = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173",
    playerCount,
    targetTick = 60,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    tickingTimeoutMs = DEFAULT_TICKING_TIMEOUT_MS,
    guestJoinRetryDelayMs = DEFAULT_GUEST_JOIN_RETRY_DELAY_MS,
    guestJoinMaxAttempts = DEFAULT_GUEST_JOIN_MAX_ATTEMPTS,
    // Per-player engine turn rate, index-aligned with `playerIds` — see
    // `makeEligible`. Undefined (every verify script) keeps the engine at its
    // default 1x, byte-identical to before this existed; the telemetry runner
    // passes each bot's own profile multiplier so the engine turns as fast as
    // the bot's `turnBurstMs` already assumes it does.
    botRotSpeedMuls = [],
    // Host-authoritative (`main.ts`'s `currentDifficulty`, read from
    // localStorage at module-load time — same key/mechanism
    // `run-balancing-telemetry.mjs`'s own `installDifficulty` uses for
    // single-player) — undefined leaves every context's difficulty at
    // whatever it would otherwise default to (existing callers, e.g.
    // `verify-multiplayer-multiguest.mjs`, never set this and are
    // unaffected). Applied to every context, not just the host's: a guest's
    // own localStorage is never actually read for a joined session (the
    // host's `difficulty` wins, propagated via `session-init`), but setting
    // it everywhere keeps every context's local UI state consistent too.
    difficulty,
    // Per-player chosen display name, index-aligned with `playerIds`
    // (`["host", "guest-1", ...]`). Undefined/empty for a player means it
    // types nothing, which is the fallback path — so the default (every
    // existing caller) drives exactly the pre-names behaviour.
    playerNames = [],
    log = () => {},
    logBrowserConsole = false,
  } = options;

  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 4) {
    throw new Error(`bootstrapMultiplayerSession: playerCount must be an integer 2-4, got ${playerCount}`);
  }
  const guestCount = playerCount - 1;
  const playerIds = ["host", ...Array.from({ length: guestCount }, (_, i) => `guest-${i + 1}`)];

  const contexts = await Promise.all(Array.from({ length: playerCount }, () => browser.newContext()));
  if (difficulty) {
    // Confirmed directly (real smoke-testing): a fresh context's own initial
    // `about:blank` document — which `addInitScript` also re-runs against,
    // before the real `page.goto` below ever happens — has an opaque origin
    // in Chromium, so `localStorage` throws "Access is denied" there. Caught
    // and ignored rather than left to surface as a `pageerror`: harmless
    // (the same init script re-runs again on the real navigation, where it
    // succeeds normally), just noisy logging otherwise.
    await Promise.all(
      contexts.map((ctx) =>
        ctx.addInitScript((d) => {
          try {
            localStorage.setItem("codeenstein-difficulty", d);
          } catch {
            // See this call site's own comment above.
          }
        }, difficulty),
      ),
    );
  }
  const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));
  const [hostPage, ...guestPages] = pages;
  pages.forEach((page, i) => {
    page.on("pageerror", (err) => log(`[${playerIds[i]} pageerror] ${err.message}`));
    // Opt-in (default off — every other caller stays exactly as noisy as
    // before): forwards every real console.log/warn/error the app itself
    // emits, not just uncaught exceptions. Added for diagnosing a real,
    // deterministic N=3 hang (ticking never starts at all, no pageerror —
    // see verify-multiplayer-multiguest.mjs's own use of this flag and this
    // repo's recent git history for the investigation); a silent hang like
    // that produces nothing on the `pageerror` channel above, so there was
    // previously no way to see where main.ts's own host-setup sequence
    // actually got stuck.
    if (logBrowserConsole) page.on("console", (msg) => log(`[${playerIds[i]} console] ${msg.text()}`));
  });

  log(`Loading an eligible workspace (demo campaign) in all ${playerCount} browsers...`);
  // Sequential, not concurrent — a cold dev server hit by several contexts
  // at the same instant right after browser launch has been observed to
  // reliably connection-refuse them (see verify-multiplayer-connect.mjs's
  // own comment for the original finding).
  for (const [i, page] of pages.entries()) await makeEligible(page, engineName, devServerUrl, botRotSpeedMuls[i]);

  // Typed before Create/Join, because that is when each side reads it — the
  // host at "Start Session", a guest at connect time. It lives in the general
  // settings (it also names your highscore entries), so it needs no tab click
  // and is reachable whichever tab is showing.
  for (const [i, page] of pages.entries()) {
    if (!playerNames[i]) continue;
    await page.fill("#player-name-input", playerNames[i]);
    log(`${playerIds[i]}: chose the name "${playerNames[i]}"`);
  }

  log(`Host: selecting maxPlayers=${playerCount} and creating a session...`);
  await hostPage.click("#tab-multiplayer");
  await hostPage.selectOption("#multiplayer-max-players", String(playerCount));
  await hostPage.click("#multiplayer-host-create");
  await hostPage.waitForSelector("#multiplayer-host-code-wrap:not([hidden])", { timeout: 15_000 });
  const code = (await hostPage.textContent("#multiplayer-host-code")).trim();
  log(`Host code: ${code}`);

  // Guest 1 joins the host's very first offer directly — nothing to race
  // yet (armNextGuestSlot only starts re-arming once a guest has connected).
  if (guestCount >= 1) {
    const guest1Page = guestPages[0];
    log("guest-1: joining with the host's code...");
    await guest1Page.click("#tab-multiplayer");
    await guest1Page.click("#multiplayer-subtab-join");
    await guest1Page.fill("#multiplayer-join-code-input", code);
    await guest1Page.click("#multiplayer-join-connect");
    await Promise.all([waitForConnected(hostPage, "host", connectTimeoutMs), waitForConnected(guest1Page, "guest-1", connectTimeoutMs)]);
    await waitForGuestCount(hostPage, 1, connectTimeoutMs);
  }

  // Every guest after the first races armNextGuestSlot's own async re-arm
  // cycle under the same code — see this module's own doc comment for the
  // full "why retry, why these defaults" writeup.
  for (let i = 2; i <= guestCount; i++) {
    const guestPage = guestPages[i - 1];
    const label = `guest-${i}`;
    log(`${label}: joining with the SAME code, after guest-${i - 1} (the auto-rearm flow)...`);
    await guestPage.click("#tab-multiplayer");
    await guestPage.click("#multiplayer-subtab-join");
    let connected = false;
    for (let attempt = 1; attempt <= guestJoinMaxAttempts && !connected; attempt++) {
      await guestPage.fill("#multiplayer-join-code-input", code);
      await guestPage.click("#multiplayer-join-connect");
      try {
        await waitForConnected(guestPage, label, connectTimeoutMs);
        connected = true;
      } catch (err) {
        if (attempt === guestJoinMaxAttempts) throw err;
        log(`  [retry] ${label} join attempt ${attempt}/${guestJoinMaxAttempts} failed (${err.message}), retrying...`);
        await guestPage.waitForTimeout(guestJoinRetryDelayMs);
      }
    }
    await waitForGuestCount(hostPage, i, connectTimeoutMs);
  }

  log("Host: starting the session (finalizes the real roster)...");
  await hostPage.click("#multiplayer-start-session");

  log(`Waiting for all ${playerCount} peers to reach tick ${targetTick}...`);
  await Promise.all(pages.map((page, i) => waitForTargetTick(page, playerIds[i], targetTick, tickingTimeoutMs)));

  return { contexts, pages, hostPage, guestPages, playerIds, code };
}

/** Closes every browser context a `bootstrapMultiplayerSession()` call
 * opened. Each close is independently best-effort (`.catch(() => {})`) so
 * one already-closed context (e.g. a caller that closed a guest mid-scenario
 * to test a disconnect) never stops the rest from being cleaned up. */
export async function closeMultiplayerSession(session) {
  await Promise.all(session.contexts.map((ctx) => ctx.close().catch(() => {})));
}

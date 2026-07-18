// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end proof of step 2's actual deliverable — "two browsers hold an
 * open RTCDataChannel" — driven through the real UI in two genuinely
 * separate Playwright browser **contexts** (not just pages/tabs: each needs
 * its own real `RTCPeerConnection` stack, which contexts give and pages
 * don't). Promoted to a required part of this step, not optional: unit
 * tests mock WebRTC and can't catch the class of bug this script exists to
 * catch — a real ordering deadlock in the guest's own data-channel handshake
 * was found this exact way while building the feature (see
 * `src/multiplayer/webrtcConnection.ts`'s `GuestAnswerResult.channelsPromise`
 * doc comment), not by any mock-based test.
 *
 * Assumes a real dev server (`npm run dev`, `VITE_MULTIPLAYER_SERVER_URL`
 * pointed at a running `scripts/multiplayer-server.mjs` instance *before*
 * the dev server started — Vite inlines `VITE_*` at server-start time, not
 * per-request) is already up, at `CODEENSTEIN_DEV_URL` (default
 * `http://localhost:5173`) — same "externally started, this script is only
 * a consumer" shape as `verify-campaign-playthrough.mjs`. Doesn't spawn or
 * manage either server itself.
 *
 * Real DOM clicks/typing drive both browsers' Host/Join flow — the only use
 * of `?testHooks=1` is *reading* `getConnectionState()` (see `main.ts`'s own
 * doc comment on that global — deliberately a separate global from the
 * engine's `__codeensteinTestHooks`, so as not to disturb what that means
 * elsewhere) to assert the end state, never to fake an action.
 *
 * **Not run against Firefox in CI** (`.github/workflows/verify.yml`'s
 * `verify-browser` job skips this step there) — a real, confirmed WebRTC
 * ICE-gathering limitation, not a Playwright-build gap or an app bug. Real
 * local Firefox connects fine (verified directly, repeatedly); GitHub
 * Actions' sandboxed runner network apparently has no internet-routable
 * default route for Firefox's own interface-discovery heuristic (it opens a
 * UDP socket and `connect()`s it toward a public IP purely to ask the OS
 * "which local interface would you use," with no packet ever sent — the
 * "connected UDP trick") to find, so it gathers zero host candidates and
 * `iceConnectionState` jumps straight to `"failed"` within milliseconds of
 * construction, logging "WebRTC: ICE failed, add a TURN server". Confirmed
 * via `installIceDiagnostics()` below (candidate/gathering-state logging) —
 * Chromium and WebKit gather real host candidates and connect within
 * seconds in the identical CI job, so this isn't a general sandbox network
 * block. Tried and ruled out, in order: `media.peerconnection.ice.obfuscate_host_addresses`
 * (a different, real Firefox mDNS quirk — kept, still correct, just not
 * this problem), a granted fake `getUserMedia()` stream (the documented fix
 * for Firefox's *single*-default-route-interface restriction — doesn't
 * apply here, since there's no default route interface at all to restrict
 * to), and `network.dns.disableIPv6` (no effect, removed). Matches Mozilla
 * bug 1659672 exactly ("ICE gathering fails in a pure LAN environment, no
 * internet-routable default route") — closed **RESOLVED INVALID** by
 * Mozilla themselves, i.e. never fixed. The one remaining lever,
 * `media.peerconnection.ice.force_interface`, needs the runner's exact
 * network interface name, which GitHub Actions' ephemeral runners don't
 * expose in any stable, discoverable way — not a viable general fix. This
 * project's own multiplayer design deliberately ships STUN-only, no TURN
 * relay (see `multiplayer-research.md`), so "add a TURN server" isn't a
 * path taken here either. See doc/dev/testing.md's cross-browser section
 * for the full writeup.
 */
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const CONNECT_TIMEOUT_MS = 30_000;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** `page.goto()`, retried on a connection-level failure (as opposed to a
 * real 4xx/5xx from the dev server, which retrying can't fix). A freshly
 * `engine.launch()`ed headless browser's very first navigation — even a
 * single page, no concurrency involved — has been observed in CI to hit
 * `NS_ERROR_CONNECTION_REFUSED` for several seconds straight, even though
 * the dev server itself is already confirmed up and had just served a
 * different verify script's request moments earlier: the freshly-spawned
 * browser process's own network stack isn't fully ready yet, not a
 * dev-server problem. Generous attempt count/backoff since the whole
 * point is absorbing a real multi-second cold-start window, not a
 * sub-second blip. */
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
 * `isMultiplayerEligibleWorkspace()` state (no GitHub fetch needed) — and
 * waits for the Multiplayer tab to actually enable before returning.
 * `grantFakeMediaForFirefox` runs first (before any UI interaction), so it's
 * in place well before the Host/Join buttons ever construct a real
 * `RTCPeerConnection`. */
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
}

/** Without a granted media (camera/mic) permission, Firefox restricts host
 * ICE candidate gathering to a *single* "default route" interface — a real,
 * separate quirk from the "no default route interface exists at all" CI
 * limitation this script's own top doc comment documents (that one has no
 * app-side fix; this one does). Granting a fake `getUserMedia()` stream
 * switches Firefox out of the single-interface restriction;
 * `media.navigator.streams.fake`/`media.navigator.permission.disabled` (set
 * at launch, see `FIREFOX_LAUNCH_OPTIONS`) make the grant instant, no real
 * camera/mic needed. Kept even though CI itself skips Firefox for this
 * script (see the top doc comment) — this still matters for anyone running
 * `CODEENSTEIN_VERIFY_BROWSER=firefox` locally, which works correctly (a
 * real machine has a real default route). This workaround stays entirely
 * inside this verify script — the real app never requests media
 * permissions, which would be a genuine, unjustified UX intrusion for a
 * game with no media features. */
async function grantFakeMediaForFirefox(page, engineName) {
  if (engineName !== "firefox") return;
  try {
    await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true, video: true }));
    console.log("[diag] getUserMedia() resolved");
  } catch (err) {
    console.log("[diag] getUserMedia() rejected:", err.message);
  }
}

/** Logs every `RTCPeerConnection` this page constructs, its
 * `iceGatheringState` transitions, and every ICE candidate it discovers (or
 * the explicit "done gathering, no more candidates" null-candidate signal)
 * — installed before any app code runs via `addInitScript`, no changes to
 * the app itself. Diagnostic only, gated behind
 * `CODEENSTEIN_MULTIPLAYER_DEBUG_ICE=1` — silent otherwise. */
async function installIceDiagnostics(page, label) {
  if (process.env.CODEENSTEIN_MULTIPLAYER_DEBUG_ICE !== "1") return;
  await page.addInitScript((label) => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let counter = 0;
    window.RTCPeerConnection = class extends OriginalRTCPeerConnection {
      constructor(...args) {
        super(...args);
        const id = ++counter;
        console.log(`[ice:${label}#${id}] constructed`, JSON.stringify(args[0] ?? {}));
        this.addEventListener("icegatheringstatechange", () => {
          console.log(`[ice:${label}#${id}] iceGatheringState -> ${this.iceGatheringState}`);
        });
        this.addEventListener("icecandidate", (event) => {
          if (!event.candidate) {
            console.log(`[ice:${label}#${id}] icecandidate: end-of-candidates (null)`);
          } else {
            console.log(`[ice:${label}#${id}] icecandidate:`, event.candidate.candidate);
          }
        });
        this.addEventListener("iceconnectionstatechange", () => {
          console.log(`[ice:${label}#${id}] iceConnectionState -> ${this.iceConnectionState}`);
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
      { timeout: CONNECT_TIMEOUT_MS },
    );
  } catch (err) {
    const status = await page.textContent("#multiplayer-status").catch(() => "<unavailable>");
    throw new Error(`${label} never reached "connected" (status: "${status}"): ${err.message}`);
  }
  return page.evaluate(() => window.__codeensteinMultiplayerTestHooks.getConnectionState());
}

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
    await installIceDiagnostics(hostPage, "host");
    await installIceDiagnostics(guestPage, "guest");
    if (process.env.CODEENSTEIN_MULTIPLAYER_DEBUG_ICE === "1") {
      hostPage.on("console", (msg) => console.log("[host console]", msg.text()));
      guestPage.on("console", (msg) => console.log("[guest console]", msg.text()));
    }

    console.log("Loading an eligible workspace (demo campaign) in both browsers...");
    // Sequential, not `Promise.all` — two contexts navigating to a cold dev
    // server at the exact same instant, right after a fresh headless
    // browser launch, was observed in CI to reliably hit
    // `NS_ERROR_CONNECTION_REFUSED` on *both* simultaneously, surviving
    // several retries with real backoff in between (so not a sub-second
    // blip `gotoWithRetry` alone could absorb) — while the same dev server
    // had just successfully served a different verify script's single-page
    // navigation moments earlier. Setting up one browser fully before
    // starting the other removes that concurrent-cold-start pattern
    // entirely, at the cost of a few extra seconds of total runtime.
    await makeEligible(hostPage, engineName);
    await makeEligible(guestPage, engineName);
    check("host: Multiplayer tab enabled", true);
    check("guest: Multiplayer tab enabled", true);

    console.log("Host: creating a session...");
    await hostPage.click("#tab-multiplayer");
    await hostPage.click("#multiplayer-host-create");
    await hostPage.waitForSelector("#multiplayer-host-code:not([hidden])", { timeout: 15_000 });
    const code = (await hostPage.textContent("#multiplayer-host-code")).trim();
    check("host: session code generated", /^[0-9A-Z]{6}$/.test(code), `got "${code}"`);
    console.log(`Host code: ${code}`);

    console.log("Guest: joining with the host's code...");
    await guestPage.click("#tab-multiplayer");
    await guestPage.click("#multiplayer-subtab-join");
    await guestPage.fill("#multiplayer-join-code-input", code);
    await guestPage.click("#multiplayer-join-connect");

    console.log("Waiting for both peers to report a connected data channel...");
    const [hostState, guestState] = await Promise.all([
      waitForConnected(hostPage, "host"),
      waitForConnected(guestPage, "guest"),
    ]);

    check("host: reports state \"connected\"", hostState.state === "connected");
    check("host: \"input\" channel open", hostState.channels?.input === "open", JSON.stringify(hostState.channels));
    check(
      "host: \"reconciliation\" channel open",
      hostState.channels?.reconciliation === "open",
      JSON.stringify(hostState.channels),
    );
    check("guest: reports state \"connected\"", guestState.state === "connected");
    check("guest: \"input\" channel open", guestState.channels?.input === "open", JSON.stringify(guestState.channels));
    check(
      "guest: \"reconciliation\" channel open",
      guestState.channels?.reconciliation === "open",
      JSON.stringify(guestState.channels),
    );
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify:multiplayer-connect crashed:", err);
  process.exit(1);
});

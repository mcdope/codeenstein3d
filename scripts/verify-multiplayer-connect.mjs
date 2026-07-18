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

/** Loads the bundled demo campaign — the cheapest way to reach an
 * `isMultiplayerEligibleWorkspace()` state (no GitHub fetch needed) — and
 * waits for the Multiplayer tab to actually enable before returning. */
async function makeEligible(page) {
  await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);
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

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName} (two contexts: host + guest)...`);
  const browser = await engine.launch();

  try {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();
    hostPage.on("pageerror", (err) => console.log("[host pageerror]", err.message));
    guestPage.on("pageerror", (err) => console.log("[guest pageerror]", err.message));

    console.log("Loading an eligible workspace (demo campaign) in both browsers...");
    await Promise.all([makeEligible(hostPage), makeEligible(guestPage)]);
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

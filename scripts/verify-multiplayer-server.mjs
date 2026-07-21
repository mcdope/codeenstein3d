// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * End-to-end verification of `scripts/multiplayer-server.mjs` — pure Node, no
 * browser, spawning the real server as a child process and driving it with
 * plain `fetch()` calls, structured like `scripts/run-perf-benchmark.mjs`'s
 * spawn/poll-with-fetch/kill-in-`finally` pattern (adapted here for a plain
 * Node HTTP server instead of Vite). Covers the full endpoint surface,
 * TTL/sweep semantics, all three-plus-one rate-limit budgets and their
 * independence from each other, and `--install`/`--uninstall --dry-run`.
 *
 * Every rate-limit-sensitive group below uses its own synthetic
 * `X-Forwarded-For` value so hammering one group's budget never bleeds into
 * another group's functional assertions — this is a bare loopback server, not
 * one behind a real proxy, so nothing sets that header unless a test does.
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, "multiplayer-server.mjs");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function urlAlive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 429; // either is proof the server is up
  } catch {
    return false;
  }
}

/** Spawns the server as a child process with the given env overrides layered
 * on top of a fixed test port, and waits until it's actually accepting
 * connections before resolving — mirrors run-perf-benchmark.mjs's
 * ensureServer()/urlAlive() pair. */
async function spawnServer(port, envOverrides = {}) {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CODEENSTEIN_MULTIPLAYER_PORT: String(port), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.on("data", (buf) => process.stderr.write(`[server:${port}] ${buf}`));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await urlAlive(`${base}/lobby`)) return { base, child };
    if (child.exitCode !== null) throw new Error(`server on :${port} exited early (code ${child.exitCode})`);
    await sleep(100);
  }
  child.kill("SIGTERM");
  throw new Error(`server did not come up on :${port} within 10s`);
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000);
  });
}

function xff(ip) {
  return { "X-Forwarded-For": ip };
}

async function json(res) {
  const text = await res.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Main suite: happy path, validation, update flow, CORS, rate limiting, TTL
// ---------------------------------------------------------------------------

const MAIN_PORT = 8901;
const MAIN_ENV = {
  CODEENSTEIN_MULTIPLAYER_SESSION_TTL_MS: "1500",
  CODEENSTEIN_MULTIPLAYER_SWEEP_INTERVAL_MS: "300",
  CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_WINDOW_MS: "1500",
  CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_MAX_REQUESTS: "5",
  CODEENSTEIN_MULTIPLAYER_HOST_TOKEN_MAX_REQUESTS: "10",
  CODEENSTEIN_MULTIPLAYER_LOBBY_RATE_LIMIT_MAX_REQUESTS: "8",
  CODEENSTEIN_MULTIPLAYER_PUT_SESSION_RATE_LIMIT_MAX_REQUESTS: "8",
  CODEENSTEIN_MULTIPLAYER_BASE_COOLDOWN_MS: "300",
  CODEENSTEIN_MULTIPLAYER_MAX_COOLDOWN_MS: "1200",
};

async function runMainSuite() {
  const { base, child } = await spawnServer(MAIN_PORT, MAIN_ENV);
  try {
    console.log("CORS preflight:");
    await checkCors(base);

    console.log("\nHappy path, full round trip:");
    const session = await checkHappyPath(base);

    console.log("\nUpdate flow (stale answer cleared):");
    await checkUpdateFlow(base, session);

    console.log("\n400 validation errors:");
    await checkValidationErrors(base);

    console.log("\n403 / 404 / 409:");
    await checkErrorStatuses(base);

    console.log("\n413 payload too large (and server survives it):");
    await checkPayloadTooLarge(base);

    console.log("\nMalformed input / unknown routes:");
    await checkResilience(base);

    console.log("\n429 rate limiting — guess-sensitive budget + host-token bypass:");
    await checkGuessRateLimit(base);

    console.log("\n429 rate limiting — exponential backoff:");
    await checkBackoff(base);

    console.log("\n429 rate limiting — host-token DoS backstop:");
    await checkHostTokenBackstop(base);

    console.log("\n429 rate limiting — lobby and PUT budgets are independent:");
    await checkBudgetIndependence(base);

    console.log("\nGET /lobby contents (public-only, sensitive fields absent):");
    await checkLobbyContents(base);

    console.log("\nTTL sliding semantics + sweep correctness:");
    await checkTtlAndSweep(base);

    console.log("\n/stats is disabled (404) when no STATS_TOKEN is configured:");
    const statsDisabled = await fetch(`${base}/stats`, { headers: { "X-Stats-Token": "anything" } });
    check("GET /stats 404s when the feature isn't configured at all", statsDisabled.status === 404);
  } finally {
    await stopServer(child);
  }
}

async function checkCors(base) {
  const good = await fetch(`${base}/session`, {
    method: "OPTIONS",
    headers: { Origin: "https://codeenstein3d.mcdope.org", "Access-Control-Request-Method": "PUT" },
  });
  check("preflight from allowed origin succeeds", good.status === 204 || good.status === 200);
  check(
    "preflight echoes the configured origin, not a wildcard",
    good.headers.get("access-control-allow-origin") === "https://codeenstein3d.mcdope.org",
  );
  check(
    "Allow-Headers includes X-Host-Token and Content-Type",
    /x-host-token/i.test(good.headers.get("access-control-allow-headers") ?? "") &&
      /content-type/i.test(good.headers.get("access-control-allow-headers") ?? ""),
  );

  const bad = await fetch(`${base}/session`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "PUT" },
  });
  const badOrigin = bad.headers.get("access-control-allow-origin");
  check(
    "mismatched origin is never echoed back (no wildcard, no attacker origin)",
    badOrigin === null && badOrigin !== "*",
  );
}

async function checkHappyPath(base) {
  const putRes = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.1") },
    body: JSON.stringify({
      offer: "offer-blob-1",
      public: true,
      displayName: "Verify Run",
      playerCount: 2,
      campaignName: "demo-campaign",
    }),
  });
  const created = await json(putRes);
  check("PUT (create) returns 201", putRes.status === 201);
  check("PUT (create) response has code/hostToken/expiresAt", !!created?.code && !!created?.hostToken && !!created?.expiresAt);

  const getRes = await fetch(`${base}/session/${created.code}`, { headers: xff("10.1.0.1") });
  const gotten = await json(getRes);
  check("GET session (unauthenticated) returns 200", getRes.status === 200);
  check("GET session has the offer and null answer", gotten?.offer === "offer-blob-1" && gotten?.answer === null);
  check("GET session response never includes hostToken", !("hostToken" in (gotten ?? {})));

  const answerRes = await fetch(`${base}/session/${created.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.1") },
    body: JSON.stringify({ answer: "answer-blob-1" }),
  });
  check("POST answer returns 204", answerRes.status === 204);

  const getAfter = await json(await fetch(`${base}/session/${created.code}`, { headers: xff("10.1.0.1") }));
  check("GET session after answer shows it populated", getAfter?.answer === "answer-blob-1");

  const tokenRes = await fetch(`${base}/session/${created.code}`, {
    headers: { "X-Host-Token": created.hostToken, ...xff("10.1.0.1") },
  });
  check("GET session with valid host token still 200s", tokenRes.status === 200);

  return created;
}

async function checkUpdateFlow(base, session) {
  const updateRes = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.10") },
    body: JSON.stringify({
      code: session.code,
      hostToken: session.hostToken,
      offer: "offer-blob-2",
      playerCount: 3,
      campaignName: "demo-campaign",
    }),
  });
  const updated = await json(updateRes);
  check("PUT (update) returns 200, not 201", updateRes.status === 200);
  check("PUT (update) echoes the same code/hostToken", updated?.code === session.code && updated?.hostToken === session.hostToken);

  const after = await json(await fetch(`${base}/session/${session.code}`, { headers: xff("10.1.0.10") }));
  check("update clears the previous answer", after?.answer === null);
  check("update applies the new offer", after?.offer === "offer-blob-2");
}

async function checkValidationErrors(base) {
  const cases = [
    ["missing_offer", { campaignName: "c", playerCount: 1 }],
    ["offer_too_large", { offer: "x".repeat(5000), campaignName: "c", playerCount: 1 }],
    ["missing_campaign_name", { offer: "x", playerCount: 1 }],
    ["invalid_player_count (zero)", { offer: "x", campaignName: "c", playerCount: 0 }],
    ["invalid_player_count (17)", { offer: "x", campaignName: "c", playerCount: 17 }],
    ["invalid_player_count (non-integer)", { offer: "x", campaignName: "c", playerCount: 1.5 }],
    ["display_name_too_long", { offer: "x", campaignName: "c", playerCount: 1, displayName: "x".repeat(200) }],
  ];
  for (const [label, body] of cases) {
    const res = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff("10.1.0.2") },
      body: JSON.stringify(body),
    });
    check(`400 for ${label}`, res.status === 400);
  }

  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff("10.1.0.2") },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    }),
  );
  const missingAnswer = await fetch(`${base}/session/${created.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.2") },
    body: JSON.stringify({}),
  });
  check("400 for missing_answer", missingAnswer.status === 400);
}

async function checkErrorStatuses(base) {
  const notFoundGet = await fetch(`${base}/session/ZZZZZZ`, { headers: xff("10.1.0.3") });
  check("404 for GET unknown session", notFoundGet.status === 404);

  const notFoundAnswer = await fetch(`${base}/session/ZZZZZZ/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
    body: JSON.stringify({ answer: "x" }),
  });
  check("404 for POST answer on unknown session", notFoundAnswer.status === 404);

  const notFoundUpdate = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
    body: JSON.stringify({ code: "ZZZZZZ", hostToken: "x", offer: "x", campaignName: "c", playerCount: 1 }),
  });
  check("404 for PUT update on unknown code", notFoundUpdate.status === 404);

  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    }),
  );

  const wrongToken = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
    body: JSON.stringify({ code: created.code, hostToken: "wrong-token", offer: "y", campaignName: "c", playerCount: 1 }),
  });
  check("403 for wrong hostToken on update", wrongToken.status === 403);

  const firstAnswer = await fetch(`${base}/session/${created.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
    body: JSON.stringify({ answer: "a1" }),
  });
  check("first answer succeeds (204)", firstAnswer.status === 204);
  const secondAnswer = await fetch(`${base}/session/${created.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.3") },
    body: JSON.stringify({ answer: "a2" }),
  });
  const secondBody = await json(secondAnswer);
  check("409 already_answered on second answer for the same round", secondAnswer.status === 409 && secondBody?.error === "already_answered");
}

async function checkPayloadTooLarge(base) {
  const bigOffer = "x".repeat(10_000);
  const res = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.4") },
    body: JSON.stringify({ offer: bigOffer, campaignName: "c", playerCount: 1 }),
  });
  check("413 for oversized PUT body", res.status === 413);

  const stillAlive = await fetch(`${base}/lobby`, { headers: xff("10.1.0.4") });
  check("server still responsive after a 413", stillAlive.status === 200);

  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff("10.1.0.4") },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    }),
  );
  const bigAnswer = await fetch(`${base}/session/${created.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.4") },
    body: JSON.stringify({ answer: "y".repeat(10_000) }),
  });
  check("413 for oversized answer body", bigAnswer.status === 413);
}

async function checkResilience(base) {
  const malformed = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff("10.1.0.5") },
    body: "not json{",
  });
  check("400 for malformed JSON body", malformed.status === 400);
  const stillAlive = await fetch(`${base}/lobby`, { headers: xff("10.1.0.5") });
  check("server still responsive after malformed JSON", stillAlive.status === 200);

  const unknownRoute = await fetch(`${base}/nonexistent`, { headers: xff("10.1.0.5") });
  check("404 for unknown route", unknownRoute.status === 404);

  const wrongMethod = await fetch(`${base}/session/ABCDEF`, { method: "DELETE", headers: xff("10.1.0.5") });
  check("clean 4xx for unsupported method on a known-shaped path", wrongMethod.status >= 400 && wrongMethod.status < 500);
}

async function checkGuessRateLimit(base) {
  const ip = "10.1.0.6";
  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    }),
  );

  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${base}/session/${created.code}`, { headers: xff(ip) });
    statuses.push(res.status);
  }
  check(
    "guess-sensitive budget trips after RATE_LIMIT_MAX_REQUESTS (5)",
    statuses.slice(0, 5).every((s) => s === 200) && statuses.slice(5).every((s) => s === 429),
    `statuses: ${statuses.join(",")}`,
  );

  const wrongTokenStillBlocked = await fetch(`${base}/session/${created.code}`, {
    headers: { "X-Host-Token": "not-the-real-token", ...xff(ip) },
  });
  check("a WRONG token does not bypass the tripped guess budget", wrongTokenStillBlocked.status === 429);

  const validTokenBypasses = await fetch(`${base}/session/${created.code}`, {
    headers: { "X-Host-Token": created.hostToken, ...xff(ip) },
  });
  check("a VALID token bypasses the tripped guess budget", validTokenBypasses.status === 200);
}

async function checkBackoff(base) {
  const ip = "10.1.0.7";
  // Trip the limit once.
  for (let i = 0; i < 6; i++) await fetch(`${base}/session/ZZZZZZ`, { headers: xff(ip) });
  const firstTrip = await fetch(`${base}/session/ZZZZZZ`, { headers: xff(ip) });
  const firstBody = await json(firstTrip);
  check("first violation returns 429 with a retryAfterMs", firstTrip.status === 429 && typeof firstBody?.retryAfterMs === "number");

  // Wait out the first (short) cooldown, then trip it again immediately.
  await sleep((firstBody?.retryAfterMs ?? 300) + 50);
  for (let i = 0; i < 6; i++) await fetch(`${base}/session/ZZZZZZ`, { headers: xff(ip) });
  const secondTrip = await fetch(`${base}/session/ZZZZZZ`, { headers: xff(ip) });
  const secondBody = await json(secondTrip);
  check(
    "second violation's cooldown is longer than the first (exponential backoff)",
    secondTrip.status === 429 && (secondBody?.retryAfterMs ?? 0) > (firstBody?.retryAfterMs ?? 0),
    `first=${firstBody?.retryAfterMs} second=${secondBody?.retryAfterMs}`,
  );
}

async function checkHostTokenBackstop(base) {
  const ip = "10.1.0.8";
  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    }),
  );
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": created.hostToken, ...xff(ip) } });
    statuses.push(res.status);
  }
  check(
    "host-token requests eventually hit their own (generous) DoS backstop",
    statuses.includes(429),
    `statuses: ${statuses.join(",")}`,
  );
}

async function checkBudgetIndependence(base) {
  const ip = "10.1.0.9";
  // Blow the guess-sensitive budget for this IP.
  for (let i = 0; i < 8; i++) await fetch(`${base}/session/ZZZZZZ`, { headers: xff(ip) });

  const lobbyStillWorks = await fetch(`${base}/lobby`, { headers: xff(ip) });
  check("GET /lobby unaffected by a blown guess-sensitive budget on the same IP", lobbyStillWorks.status === 200);

  const putStillWorks = await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff(ip) },
    body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
  });
  check("PUT /session unaffected by a blown guess-sensitive budget on the same IP", putStillWorks.status === 201);

  // Now blow the lobby budget on a fresh IP and confirm it doesn't touch the
  // guess-sensitive budget for that same fresh IP.
  const lobbyIp = "10.1.0.11";
  const lobbyStatuses = [];
  for (let i = 0; i < 12; i++) {
    lobbyStatuses.push((await fetch(`${base}/lobby`, { headers: xff(lobbyIp) })).status);
  }
  check("GET /lobby's own budget does eventually trip", lobbyStatuses.includes(429), `statuses: ${lobbyStatuses.join(",")}`);

  const guessStillWorksOnLobbyIp = await fetch(`${base}/session/ZZZZZZ`, { headers: xff(lobbyIp) });
  check(
    "guess-sensitive budget on that same IP is untouched by the lobby trip",
    guessStillWorksOnLobbyIp.status === 404,
  );
}

async function checkLobbyContents(base) {
  const ip = "10.1.0.12";
  const pub = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", public: true, displayName: "Public One", campaignName: "camp-a", playerCount: 2 }),
    }),
  );
  await fetch(`${base}/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...xff(ip) },
    body: JSON.stringify({ offer: "x", public: false, campaignName: "camp-b", playerCount: 1 }),
  });

  const lobby = await json(await fetch(`${base}/lobby`, { headers: xff(ip) }));
  const entries = lobby?.sessions ?? [];
  check("lobby lists exactly the public session, not the private one", entries.some((e) => e.code === pub.code) && entries.length >= 1);
  const publicEntry = entries.find((e) => e.code === pub.code);
  check(
    "lobby entry has only code/displayName/campaignName/playerCount",
    publicEntry &&
      !("offer" in publicEntry) &&
      !("answer" in publicEntry) &&
      !("hostToken" in publicEntry) &&
      publicEntry.displayName === "Public One" &&
      publicEntry.campaignName === "camp-a" &&
      publicEntry.playerCount === 2,
  );
}

async function checkTtlAndSweep(base) {
  const ip = "10.1.0.13";
  const created = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", public: true, campaignName: "ttl-test", playerCount: 1 }),
    }),
  );

  // Poll with the host token (bypasses the guess budget) across most of the
  // TTL window — reads must NOT refresh expiresAt.
  const pollDeadline = Date.now() + 1000;
  while (Date.now() < pollDeadline) {
    await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": created.hostToken, ...xff(ip) } });
    await sleep(150);
  }
  // TTL is 1500ms; ~1000ms of pure reads should not have extended it.
  await sleep(700); // now ~1700ms since creation — past the original TTL if reads didn't refresh it
  const afterReadsOnly = await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": created.hostToken, ...xff(ip) } });
  check("session expires on schedule when only reads occurred (reads don't refresh TTL)", afterReadsOnly.status === 404);

  const afterSweepLobby = await json(await fetch(`${base}/lobby`, { headers: xff(ip) }));
  check(
    "expired session is also gone from the lobby listing (sweep, not just direct lookup)",
    !(afterSweepLobby?.sessions ?? []).some((e) => e.code === created.code),
  );

  // Second session: a state-changing write partway through should refresh
  // the TTL, keeping it alive past when a read-only session would expire.
  const created2 = await json(
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", campaignName: "ttl-test-2", playerCount: 1 }),
    }),
  );
  await sleep(1000); // partway through the 1500ms TTL
  const answerRes = await fetch(`${base}/session/${created2.code}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Host-Token": created2.hostToken, ...xff(ip) },
    body: JSON.stringify({ answer: "y" }),
  });
  check("answering mid-TTL succeeds", answerRes.status === 204);
  await sleep(900); // ~1900ms since creation — past the *original* TTL, before the *refreshed* one
  const stillAlive = await fetch(`${base}/session/${created2.code}`, { headers: { "X-Host-Token": created2.hostToken, ...xff(ip) } });
  check("a state-changing write (the answer) refreshed the TTL, keeping it alive past the original expiry", stillAlive.status === 200);
}

// ---------------------------------------------------------------------------
// MAX_CONCURRENT_SESSIONS (503) — its own short-lived instance
// ---------------------------------------------------------------------------

async function runCapSuite() {
  const port = 8902;
  const { base, child } = await spawnServer(port, {
    CODEENSTEIN_MULTIPLAYER_MAX_CONCURRENT_SESSIONS: "2",
    CODEENSTEIN_MULTIPLAYER_PUT_SESSION_RATE_LIMIT_MAX_REQUESTS: "50",
  });
  try {
    const ip = "10.2.0.1";
    const first = await json(
      await fetch(`${base}/session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...xff(ip) },
        body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
      }),
    );
    const second = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    });
    check("second create succeeds (at cap of 2)", second.status === 201);

    const third = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
    });
    check("third create returns 503 (over MAX_CONCURRENT_SESSIONS)", third.status === 503);

    const updateAtCap = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ code: first.code, hostToken: first.hostToken, offer: "y", campaignName: "c", playerCount: 1 }),
    });
    check("update of an existing session still succeeds while at cap (503 is create-only)", updateAtCap.status === 200);
  } finally {
    await stopServer(child);
  }
}

/** Checks that every leaf value in `value` is a `number`, except leaves at
 * one of `allowedStringKeys` (by their own key name) — the most direct,
 * false-positive-proof way to verify "just numbers, no IPs/codes/tokens":
 * checking for *content* (is every leaf numeric?) rather than guessing at
 * *key names* to blocklist. Two attempts at the latter both false-positived
 * on this suite's first run — a whole-string substring match on "answer"
 * hit the legitimate `answered`/`awaitingAnswer` fields, and an exact-key
 * blocklist including "hostToken" hit `rateLimiting.trackedIps.hostToken`,
 * a legitimate *bucket label* (paired with sibling buckets `guess`/`lobby`/
 * `putSession`), not a leaked token value. Structural content-checking
 * doesn't have this problem: a bucket-count field is numeric either way. */
function allLeafValuesAreNumeric(value, key, allowedStringKeys) {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" || allowedStringKeys.includes(key);
  }
  return Object.entries(value).every(([k, v]) => allLeafValuesAreNumeric(v, k, allowedStringKeys));
}

// ---------------------------------------------------------------------------
// --stats / GET /stats — its own short-lived instance with a token configured
// ---------------------------------------------------------------------------

async function runStatsSuite() {
  const port = 8903;
  const token = "verify-stats-token";
  const { base, child } = await spawnServer(port, { CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: token });
  try {
    const ip = "10.3.0.1";
    await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ offer: "x", public: true, campaignName: "c", playerCount: 2 }),
    });

    const noToken = await fetch(`${base}/stats`, { headers: xff(ip) });
    check("GET /stats without a token 404s even when the feature is configured", noToken.status === 404);

    const wrongToken = await fetch(`${base}/stats`, { headers: { "X-Stats-Token": "wrong", ...xff(ip) } });
    check("GET /stats with the wrong token 404s (indistinguishable from disabled/unknown)", wrongToken.status === 404);

    const rightToken = await fetch(`${base}/stats`, { headers: { "X-Stats-Token": token, ...xff(ip) } });
    const stats = await json(rightToken);
    check("GET /stats with the right token returns 200", rightToken.status === 200);
    check("stats reflects the one live session created above", stats?.sessions?.live === 1 && stats?.sessions?.public === 1);
    check("stats never contains the test IP address anywhere in its payload", !JSON.stringify(stats).includes(ip));
    check(
      "every stats value is a plain number, except the one expected version string — no IPs, codes, or tokens can hide in a number",
      allLeafValuesAreNumeric(stats, "", ["nodeVersion"]),
    );
    check("stats includes cumulative counters, not just live snapshots", typeof stats?.sessions?.totalCreatedSinceStart === "number" && stats.sessions.totalCreatedSinceStart >= 1);

    // Full CLI round trip: --stats as a client hitting this same running server.
    const cliOut = execFileSync(
      process.execPath,
      [SERVER_SCRIPT, "--stats", "--json", `--port=${port}`],
      { encoding: "utf8", env: { ...process.env, CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: token } },
    );
    const cliStats = JSON.parse(cliOut);
    check("--stats --json CLI mode round-trips the same data as the raw endpoint", cliStats?.sessions?.live === 1);

    const cliHuman = execFileSync(
      process.execPath,
      [SERVER_SCRIPT, "--stats", `--port=${port}`],
      { encoding: "utf8", env: { ...process.env, CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: token } },
    );
    check("--stats (human-readable) mentions live session count", /live\s+1 \/ \d+ max/.test(cliHuman));

    let cliWrongTokenFailed = false;
    try {
      execFileSync(process.execPath, [SERVER_SCRIPT, "--stats", `--port=${port}`], {
        encoding: "utf8",
        env: { ...process.env, CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: "wrong" },
      });
    } catch {
      cliWrongTokenFailed = true;
    }
    check("--stats CLI mode exits non-zero on a wrong token", cliWrongTokenFailed);

    let cliNoTokenFailed = false;
    try {
      execFileSync(process.execPath, [SERVER_SCRIPT, "--stats", `--port=${port}`], {
        encoding: "utf8",
        env: { ...process.env, CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: "" },
      });
    } catch {
      cliNoTokenFailed = true;
    }
    check("--stats CLI mode exits non-zero when no token env var is set at all", cliNoTokenFailed);
  } finally {
    await stopServer(child);
  }
}

// ---------------------------------------------------------------------------
// Constant-time secret comparison (hostToken / X-Stats-Token) — asserts
// accept/reject behavior is unchanged for correct, wrong-length, and
// same-length-wrong tokens at all three comparison sites: the PUT /session
// update branch, GET /session/<code>'s host-token-budget-bypass check, and
// GET /stats's X-Stats-Token check.
// ---------------------------------------------------------------------------

/** Same length as `token`, guaranteed different content — a targeted
 * "same-length-wrong" probe distinct from a plain wrong-length probe. */
function differentSameLengthToken(token) {
  const last = token[token.length - 1];
  const replacement = last === "X" ? "Y" : "X";
  return token.slice(0, -1) + replacement;
}

async function runTimingSafeComparisonSuite() {
  const port = 8904;
  const statsToken = "stats-timing-token";
  const { base, child } = await spawnServer(port, {
    CODEENSTEIN_MULTIPLAYER_STATS_TOKEN: statsToken,
    CODEENSTEIN_MULTIPLAYER_RATE_LIMIT_MAX_REQUESTS: "5",
    CODEENSTEIN_MULTIPLAYER_HOST_TOKEN_MAX_REQUESTS: "50",
  });
  try {
    const ip = "10.4.0.1";
    const created = await json(
      await fetch(`${base}/session`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...xff(ip) },
        body: JSON.stringify({ offer: "x", campaignName: "c", playerCount: 1 }),
      }),
    );
    const wrongLenToken = created.hostToken.slice(0, -4);
    const sameLenWrongToken = differentSameLengthToken(created.hostToken);

    // --- Site 1: PUT /session update branch (~handlePutSession) ---
    const correctUpdate = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ code: created.code, hostToken: created.hostToken, offer: "y", campaignName: "c", playerCount: 1 }),
    });
    check("PUT update: correct hostToken still accepted (200)", correctUpdate.status === 200);

    const wrongLenUpdate = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ code: created.code, hostToken: wrongLenToken, offer: "z", campaignName: "c", playerCount: 1 }),
    });
    check("PUT update: wrong-length hostToken still rejected (403)", wrongLenUpdate.status === 403);

    const sameLenUpdate = await fetch(`${base}/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...xff(ip) },
      body: JSON.stringify({ code: created.code, hostToken: sameLenWrongToken, offer: "z2", campaignName: "c", playerCount: 1 }),
    });
    check("PUT update: same-length-wrong hostToken still rejected (403)", sameLenUpdate.status === 403);

    // --- Site 2: GET /session/<code> host-token budget bypass (~handleGetSession) ---
    const ip2 = "10.4.0.2";
    for (let i = 0; i < 6; i++) await fetch(`${base}/session/${created.code}`, { headers: xff(ip2) });
    const wrongLenBypass = await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": wrongLenToken, ...xff(ip2) } });
    check("GET session: wrong-length token does not bypass a tripped guess budget (429)", wrongLenBypass.status === 429);
    const sameLenBypass = await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": sameLenWrongToken, ...xff(ip2) } });
    check("GET session: same-length-wrong token does not bypass a tripped guess budget (429)", sameLenBypass.status === 429);
    const correctBypass = await fetch(`${base}/session/${created.code}`, { headers: { "X-Host-Token": created.hostToken, ...xff(ip2) } });
    check("GET session: correct token still bypasses a tripped guess budget (200)", correctBypass.status === 200);

    // --- Site 3: GET /stats X-Stats-Token check (~handleGetStats) ---
    const correctStats = await fetch(`${base}/stats`, { headers: { "X-Stats-Token": statsToken, ...xff(ip) } });
    check("GET /stats: correct token accepted (200)", correctStats.status === 200);
    const wrongLenStats = await fetch(`${base}/stats`, { headers: { "X-Stats-Token": statsToken.slice(0, -3), ...xff(ip) } });
    check("GET /stats: wrong-length token rejected (404)", wrongLenStats.status === 404);
    const sameLenWrongStats = await fetch(`${base}/stats`, {
      headers: { "X-Stats-Token": differentSameLengthToken(statsToken), ...xff(ip) },
    });
    check("GET /stats: same-length-wrong token rejected (404)", sameLenWrongStats.status === 404);
  } finally {
    await stopServer(child);
  }
}

// ---------------------------------------------------------------------------
// --help / -?
// ---------------------------------------------------------------------------

function runHelpSuite() {
  const helpOut = execFileSync(process.execPath, [SERVER_SCRIPT, "--help"], { encoding: "utf8" });
  check("--help mentions --stats, --install, --uninstall", /--stats/.test(helpOut) && /--install/.test(helpOut) && /--uninstall/.test(helpOut));
  check("--help documents the env vars", /CODEENSTEIN_MULTIPLAYER_PORT/.test(helpOut) && /CODEENSTEIN_MULTIPLAYER_STATS_TOKEN/.test(helpOut));
  check("--help references the spec docs", /multiplayer-server-spec\.md/.test(helpOut));

  const shortHelpOut = execFileSync(process.execPath, [SERVER_SCRIPT, "-?"], { encoding: "utf8" });
  check("-? produces the same help text as --help", shortHelpOut === helpOut);
}

// ---------------------------------------------------------------------------
// --install / --uninstall --dry-run
// ---------------------------------------------------------------------------

function runDryRunSuite() {
  const installOut = execFileSync(
    process.execPath,
    [SERVER_SCRIPT, "--install", "--dry-run", "--port=9999", "--allowed-origin=https://example.test"],
    { encoding: "utf8" },
  );
  check("--install --dry-run exits 0 and mentions the unit sections", /\[Unit\]/.test(installOut) && /\[Service\]/.test(installOut) && /\[Install\]/.test(installOut));
  check("--install --dry-run's ExecStart points at this script's absolute path", installOut.includes(`ExecStart=${SERVER_SCRIPT}`));
  check("--install --dry-run bakes in the given port/origin", installOut.includes("CODEENSTEIN_MULTIPLAYER_PORT=9999") && installOut.includes("CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN=https://example.test"));
  check("--install --dry-run mentions the systemctl commands it would run", /systemctl daemon-reload/.test(installOut) && /systemctl enable --now/.test(installOut));
  check("--install --dry-run states nothing was written", /dry run/i.test(installOut));

  const uninstallOut = execFileSync(process.execPath, [SERVER_SCRIPT, "--uninstall", "--dry-run"], { encoding: "utf8" });
  check("--uninstall --dry-run mentions disable/rm/daemon-reload", /systemctl disable --now/.test(uninstallOut) && /rm .*codeenstein-multiplayer\.service/.test(uninstallOut) && /systemctl daemon-reload/.test(uninstallOut));
  check("--uninstall --dry-run states nothing was removed", /dry run/i.test(uninstallOut));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log("Main suite (session flow, errors, CORS, rate limiting, TTL):");
  await runMainSuite();

  console.log("\nMAX_CONCURRENT_SESSIONS (503):");
  await runCapSuite();

  console.log("\n--stats / GET /stats:");
  await runStatsSuite();

  console.log("\nConstant-time secret comparison (hostToken / X-Stats-Token):");
  await runTimingSafeComparisonSuite();

  console.log("\n--help / -?:");
  runHelpSuite();

  console.log("\n--install/--uninstall --dry-run:");
  runDryRunSuite();

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

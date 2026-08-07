// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Make sure a dev server exists, and tell me whether I own it."
 *
 * Extracted from `run-perf-benchmark.mjs`'s own `ensureServer`, which had the
 * shape right and was the only script that did. Every other browser-driving
 * script assumes a server is *already* up at `CODEENSTEIN_DEV_URL` (default
 * `:5173`) — fine at a keyboard, where the developer's own `npm run dev` is
 * running, and quietly fatal anywhere else.
 *
 * Anywhere else turned out to include **every SSH lane host**: an unattended
 * remote invocation has no dev server, so `page.goto` fails with
 * `ERR_CONNECTION_REFUSED` on every attempt while the script still writes its
 * aggregate and exits zero. Measured 2026-08-05 — remote invocations
 * "finished" in 2-5 seconds against a local lane's 4 minutes, banking nothing.
 * Single-player lanes had therefore never actually worked; the multiplayer
 * campaign only worked because `multiplayerTestServers.mjs` starts its own.
 *
 * Two rules this keeps from the original:
 *
 * - **Reuse, never own, a server that is already listening.** The user's own
 *   `:5173` must survive whatever a script does, and a leftover from an
 *   earlier run is worth reusing rather than fighting over a `--strictPort`.
 * - **Spawn vite's JS entry directly under node, not via `npx`.** An `npx`
 *   wrapper can swallow SIGTERM and leave the real server orphaned on the
 *   port, which then breaks the *next* run with a port conflict.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { REPO_ROOT } from "./loadEngineModules.mjs";

const STARTUP_TIMEOUT_MS = 60_000;

async function urlAlive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolves `{url, stop()}`. `stop()` is a no-op for a server we did not
 * start, so a caller can always call it unconditionally in a `finally`
 * without risking someone else's process.
 *
 * @param {object} [opts]
 * @param {string} [opts.url] - an explicit server to use. Verified reachable
 *   and never stopped by us; throws if it is not responding, because silently
 *   falling back to spawning one would hide a typo'd URL.
 * @param {number} [opts.port] - port to spawn on when nothing is given/alive.
 * @param {string} [opts.label] - log prefix.
 */
export async function ensureDevServer({ url: explicitUrl, port = 5199, label = "dev-server" } = {}) {
  if (explicitUrl) {
    const url = explicitUrl.replace(/\/$/, "");
    if (!(await urlAlive(url))) throw new Error(`${label}: ${url} is not responding`);
    return { url, stop: () => {}, owned: false };
  }

  // Try every way of naming this machine, not just `localhost`.
  //
  // Measured 2026-08-07 on a lane host: vite bound IPv6 only while `localhost`
  // resolved to IPv4, so `http://localhost:5199` was unreachable from Node's
  // fetch even though vite had reported "ready in 735 ms". Every invocation on
  // that host died with "vite did not come up within 60s" and the host looked
  // broken or slow — it was neither, we simply could not address it. curl hid
  // the problem by falling back between families; Node's fetch does not.
  //
  // Whichever candidate answers is the URL returned, because the caller hands
  // it to Playwright and that has to be an address which actually works.
  const candidates = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
  const firstAlive = async () => {
    for (const candidate of candidates) {
      if (await urlAlive(candidate)) return candidate;
    }
    return null;
  };

  const already = await firstAlive();
  if (already) {
    const url = already;
    console.log(`[${label}] reusing already-running server at ${url}`);
    return { url, stop: () => {}, owned: false };
  }

  console.log(`[${label}] starting vite on :${port}`);
  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // Drain both pipes — an unread stdout pipe can fill and block the child.
  child.stdout.resume();
  child.stderr.on("data", (buf) => process.stderr.write(`[vite] ${buf}`));

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const alive = await firstAlive();
    if (alive) {
      if (alive !== candidates[0]) console.log(`[${label}] reachable at ${alive} (localhost did not resolve to it)`);
      return { url: alive, stop: () => child.kill("SIGTERM"), owned: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  throw new Error(
    `${label}: vite did not come up on :${port} within ${STARTUP_TIMEOUT_MS / 1000}s (tried ${candidates.join(", ")})`,
  );
}

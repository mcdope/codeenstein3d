// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Spins up an isolated signaling server + dev server pair for the
 * multiplayer telemetry tooling (step 11) — mirrors
 * `.github/workflows/verify.yml`'s own "Start multiplayer signaling server"
 * / "Start dev server" two-step sequence (signaling server first, since
 * Vite inlines `VITE_MULTIPLAYER_SERVER_URL` at server-*start* time, not
 * per-request) as reusable Node child-process management instead of inline
 * CI shell.
 *
 * Deliberately never the ports a developer's own manually-run dev session
 * would use (5173/8787) — running many bot-driven telemetry sessions
 * against the *shared* signaling server a developer might be pointed at
 * risks tripping its per-IP rate limits (`multiplayer-server-spec.md` §4:
 * 20 req/60s guess-sensitive, 30/min `PUT /session`) purely from this
 * tool's own traffic, on top of whatever a real manual session is doing.
 * `scripts/multiplayer-server.mjs`'s every limit is already env-var-
 * overridable (see its own `--help`), so a caller here that wants a looser
 * budget for a large sweep can pass `rateLimitEnvOverrides` rather than
 * this tool silently inheriting a budget sized for one human's manual
 * testing.
 */
import { spawn } from "node:child_process";

const DEFAULT_SIGNALING_PORT = 8788;
const DEFAULT_DEV_SERVER_PORT = 5174;

/** Polls `url` until it responds (any status below 500 counts as "the
 * process is up and answering," matching CI's own `curl -s -o /dev/null`
 * readiness check — this isn't validating the response body, just that
 * something is listening), or throws after `timeoutMs`. */
/** `npm run dev` spawns `vite` as its own child process — killing the `npm`
 * wrapper process alone does not reliably terminate `vite` (confirmed
 * directly: it kept serving on its port after `npm`'s own process exited).
 * Spawning detached and killing the whole process group (negative pid, the
 * standard POSIX idiom for this) takes the real listening process down with
 * it, regardless of how many process layers sit between what was spawned
 * and what's actually bound to the port. */
function killProcessGroup(proc) {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // Already gone (e.g. exited on its own, or a partial-startup failure
    // that never got a pid) — nothing left to kill.
  }
}

async function waitForHttpReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url} to become reachable within ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ""}`);
}

/**
 * Starts an isolated signaling server (`scripts/multiplayer-server.mjs`)
 * and a dev server pointed at it, both on non-default ports, and waits for
 * both to be reachable. Returns `{ devServerUrl, signalingServerUrl,
 * stop() }` — always call `stop()` when done, even on error, or the two
 * child processes leak past this script's own lifetime.
 */
export async function startIsolatedMultiplayerServers(options = {}) {
  const {
    signalingPort = DEFAULT_SIGNALING_PORT,
    devServerPort = DEFAULT_DEV_SERVER_PORT,
    readyTimeoutMs = 30_000,
    rateLimitEnvOverrides = {},
  } = options;

  // Explicit `127.0.0.1`, never bare "localhost" — confirmed directly as a
  // real failure on a real SSH-lane host: Vite's own default bind (no
  // `--host` given) came up IPv6-only (`::1`) there, while this module's own
  // `waitForHttpReachable` uses Node's `fetch()`, which resolved "localhost"
  // to the IPv4 address and got `ECONNREFUSED` — even though the server was
  // genuinely up and a plain `curl` against the same "localhost" succeeded
  // (curl's own happy-eyeballs resolution tried IPv6 first). Pinning both
  // the dev server's own `--host` (below) and the URL used to check it to
  // the same explicit `127.0.0.1` makes this deterministic instead of
  // depending on whatever a given host's default resolution/bind happens to
  // pick — matching `signalingServerUrl`, which already did this correctly.
  const devServerUrl = `http://127.0.0.1:${devServerPort}`;
  const signalingServerUrl = `http://127.0.0.1:${signalingPort}`;

  const signalingProc = spawn("node", ["scripts/multiplayer-server.mjs"], {
    env: {
      ...process.env,
      CODEENSTEIN_MULTIPLAYER_PORT: String(signalingPort),
      CODEENSTEIN_MULTIPLAYER_ALLOWED_ORIGIN: devServerUrl,
      ...rateLimitEnvOverrides,
    },
    stdio: "ignore",
    detached: true,
  });
  signalingProc.on("error", (err) => {
    throw new Error(`Failed to spawn scripts/multiplayer-server.mjs: ${err.message}`);
  });

  let devProc;
  try {
    await waitForHttpReachable(`${signalingServerUrl}/lobby`, readyTimeoutMs);

    // `npm run dev` (not `vite` directly): keeps the same `predev` WAD-asset-
    // fetch hook every other dev-server launch in this project goes through
    // (see `.github/workflows/verify.yml`'s identical "Start dev server"
    // step), at the cost of `npm` sitting between this process and the real
    // `vite` listener — `killProcessGroup()` (below) is what makes that
    // extra layer harmless to tear down.
    devProc = spawn("npm", ["run", "dev", "--", "--port", String(devServerPort), "--strictPort", "--host", "127.0.0.1"], {
      // CODEENSTEIN_VITE_NO_WATCH: this dev server only ever serves one
      // short-lived, headless-Playwright-driven script — nothing ever edits
      // source mid-run, so HMR/file-watching serves no purpose here, and
      // Vite's own watcher can hit a real ENOSPC ("system limit for number
      // of file watchers reached") on a host where something else (Dropbox,
      // other sync/indexing tools) already consumes a big share of the
      // OS-wide inotify budget — confirmed directly against a real SSH-lane
      // host. Always set here, unconditionally: this module is exclusively
      // used by automated verify/telemetry scripts, never a developer's own
      // interactive `npm run dev` (see this module's own top doc comment).
      env: { ...process.env, VITE_MULTIPLAYER_SERVER_URL: signalingServerUrl, CODEENSTEIN_VITE_NO_WATCH: "1" },
      stdio: "ignore",
      detached: true,
    });
    devProc.on("error", (err) => {
      throw new Error(`Failed to spawn the dev server: ${err.message}`);
    });
    await waitForHttpReachable(`${devServerUrl}/`, readyTimeoutMs);
  } catch (err) {
    // Partial startup failure — kill whatever did come up rather than
    // leaking a signaling server with no dev server (or vice versa) past
    // this function's own throw.
    killProcessGroup(signalingProc);
    killProcessGroup(devProc);
    throw err;
  }

  return {
    devServerUrl,
    signalingServerUrl,
    async stop() {
      killProcessGroup(devProc);
      killProcessGroup(signalingProc);
    },
  };
}

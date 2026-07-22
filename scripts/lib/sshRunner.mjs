// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Remote-host `Runner` (see `scripts/lib/laneOrchestrator.mjs`'s own doc
 * comment for the `Runner` contract) for spreading compute-bound balancing
 * scripts across N SSH hosts, per `notes`' "SSH-host parallelism for
 * compute-bound verify/balancing scripts" item.
 *
 * Host list: a very simple, gitignored `ssh-hosts.env` at repo root, one
 * `user@host` per line (`#`-prefixed/blank lines ignored) — nothing else to
 * configure. See `ssh-hosts.env.dist` for the committed template. Auth is
 * deliberately out of this module's scope entirely: a host resolves however
 * plain `ssh`/`scp` already resolve it (a `~/.ssh/config` alias or a literal
 * `user@host`), and authenticates however the local `ssh-agent` already
 * would for a manual `ssh` call — this module never touches credentials.
 *
 * **One-time, one-command-per-host setup, done separately from every
 * automated run.** `scripts/setup-ssh-lane-host.mjs` (run manually — not by
 * this module — once per host, real interactive TTY) installs whatever's
 * missing (git, a modern-enough Node, and Playwright's Chromium system
 * deps) with real, unscoped sudo, then clones the repo and runs `npm ci`.
 * Doing all of that interactively, once, rather than automatically on every
 * campaign run is deliberate, not laziness — two of those steps genuinely
 * can't be made both automatic *and* narrowly sudo-scoped (see that
 * script's own doc comment for exactly why), so splitting "provision this
 * host" from "run a campaign against it" is what lets the *automated* path
 * below need no sudo at all. `buildSshRunners()`'s own `bootstrapHost()`
 * only ever does what's safe to redo unattended on every single invocation:
 * checks git/an adequate Node are already there (and fails with a pointer
 * to the setup script if not — never installs anything itself), then
 * clone-or-fetch + force-checkout the exact local `HEAD` sha + `npm ci` +
 * `npx playwright install chromium` (browser binary only; every balancing
 * script in this family only ever launches Chromium — see
 * `run-balancing-telemetry.mjs`'s own doc comment). A host that fails any
 * step is logged as a warning and simply excluded from the returned runner
 * list — one bad host must never wedge the whole orchestrator, the same
 * "don't let one participant block everything" lesson a real stuck combo
 * already taught this session.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./loadEngineModules.mjs";

const execFileAsync = promisify(execFile);

/** Exported for `scripts/setup-ssh-lane-host.mjs` — it appends a newly
 * set-up host here directly (see `appendHostIfMissing`) rather than making
 * the user copy it in by hand afterward. */
export const HOSTS_FILE = path.join(REPO_ROOT, "ssh-hosts.env");
/** Exported for `scripts/setup-ssh-lane-host.mjs` — the one-time setup
 * script and this module's own per-run bootstrap must agree on where the
 * checkout lives. */
export const REMOTE_DIR = "/tmp/codeenstein3d-ssh-lane";

/** Exported for `scripts/setup-ssh-lane-host.mjs` — same host list either
 * script reads, so "which hosts does this apply to" never needs asking
 * twice. */
export function readHostList() {
  if (!fs.existsSync(HOSTS_FILE)) return [];
  return fs
    .readFileSync(HOSTS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Appends `userHost` to `ssh-hosts.env` if it isn't already listed —
 * creates the file if it doesn't exist yet (a host set up via an explicit
 * CLI argument, not already in the file, is the common case this handles;
 * a host that was already listed, e.g. every no-args "set up everything"
 * run, is correctly left untouched — no duplicate lines pile up on repeat
 * setup runs). Used by `scripts/setup-ssh-lane-host.mjs` right after a
 * host's setup succeeds, so a freshly-provisioned host is immediately
 * usable by the campaign orchestrators without a separate manual edit. */
export function appendHostIfMissing(userHost) {
  if (readHostList().includes(userHost)) return;
  fs.appendFileSync(HOSTS_FILE, `${userHost}\n`);
}

/** Single-quotes a value for safe inclusion in the remote shell command —
 * every dynamic value this module ever interpolates (the origin URL, a git
 * sha, an env var's value) goes through this rather than being trusted raw. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Rewrites a local absolute path under `REPO_ROOT` to the equivalent path
 * under this host's own bootstrapped remote checkout — both checkouts share
 * the same relative structure, only the root differs. */
function toRemotePath(localAbsolutePath) {
  return path.posix.join(REMOTE_DIR, path.relative(REPO_ROOT, localAbsolutePath).split(path.sep).join("/"));
}

/** Normalizes a git remote URL to `https://` for the *remote* host's own
 * clone — never trust `git remote get-url origin` as-is for that. It
 * reflects *this* machine's own configured access method (commonly an SSH
 * `git@host:owner/repo.git` URL, since that's the natural default for a
 * repo owner who pushes), which says nothing about whether an arbitrary SSH
 * lane host also has a matching SSH key/known_hosts entry for that git
 * host — confirmed directly as a real failure, not a theoretical one: a
 * real lane host had no GitHub SSH key at all and failed to clone. `https://`
 * needs no credentials at all for a public repo, which every host in this
 * project's own lane list clones. Handles the two common SSH forms
 * (`git@host:owner/repo.git` and `ssh://git@host/owner/repo.git`); anything
 * else (already `https://`, or some other scheme this doesn't recognize) is
 * passed through unchanged rather than guessed at. */
export function toHttpsCloneUrl(originUrl) {
  const scpLike = originUrl.match(/^git@([^:]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;
  const sshUrl = originUrl.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshUrl) return `https://${sshUrl[1]}/${sshUrl[2]}`;
  return originUrl;
}

async function runSsh(userHost, remoteCommand, { timeoutMs } = {}) {
  // `-tt` forces a pseudo-terminal, so a local disconnect/kill of this ssh
  // client propagates a HUP to the remote command's controlling terminal —
  // best-effort remote cleanup on a local watchdog kill, not a guarantee
  // (a genuinely dropped connection can still leave an orphaned remote
  // process; a real fix needs a remote supervisor, out of scope for a first
  // cut — see this repo's own `notes` item on the real gaps this leaves).
  return execFileAsync("ssh", ["-tt", "-o", "BatchMode=yes", userHost, remoteCommand], { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64 });
}

// Kept in sync with `scripts/setup-ssh-lane-host.mjs`'s own install target —
// this side only ever *checks* against it, never installs.
export const NODE_MIN_MAJOR = 18;

/** One remote host's own bootstrap for a single automated run — safe to
 * redo unattended on every invocation, unlike the one-time
 * `setup-ssh-lane-host.mjs` step this assumes already ran. Checks git and
 * an adequate Node exist (never installs — see this module's own doc
 * comment for why that's a separate, interactive, one-time script instead),
 * clones-or-fetches, force-checks-out the exact local commit, installs
 * deps. Throws on any failure — including the precondition check, with a
 * message pointing at the setup script — the caller (`buildSshRunners`) is
 * responsible for catching and excluding the host. */
async function bootstrapHost(userHost, originUrl, headSha) {
  const cmd = [
    `(command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge ${NODE_MIN_MAJOR} ]) || ` +
      `{ echo "missing git/Node ${NODE_MIN_MAJOR}+ — run 'node scripts/setup-ssh-lane-host.mjs ${userHost}' from your own machine first" >&2; exit 1; }`,
    `mkdir -p ${REMOTE_DIR}`,
    // Clone only if this is genuinely the first time; otherwise fetch —
    // avoids re-cloning the whole repo on every campaign invocation.
    `if [ -d ${REMOTE_DIR}/.git ]; then git -C ${REMOTE_DIR} fetch origin; else git clone ${shellQuote(originUrl)} ${REMOTE_DIR}; fi`,
    `git -C ${REMOTE_DIR} checkout --force ${shellQuote(headSha)}`,
    `cd ${REMOTE_DIR} && npm ci`,
    // Browser binary only, no sudo — system deps are `setup-ssh-lane-host.mjs`'s
    // job (see this module's own doc comment for why that split exists).
    `cd ${REMOTE_DIR} && npx playwright install chromium`,
  ].join(" && ");
  await runSsh(userHost, cmd, { timeoutMs: 15 * 60 * 1000 }); // no apt/NodeSource install possible here anymore — a first-time clone+npm ci+browser download is still real but much shorter than before
}

/** Remote-host lane — see this module's own doc comment for the bootstrap
 * contract this assumes already succeeded before construction. */
export class SshRunner {
  constructor(userHost) {
    this.userHost = userHost;
    this.label = `ssh:${userHost}`;
  }

  /** Only the explicit `CODEENSTEIN_*` assignments a caller's `envFor` built
   * are forwarded — never the full local `process.env` a `LocalRunner`
   * naturally inherits (that would leak this machine's own `PATH`/`HOME`/etc
   * across the wire, none of which apply to the remote shell's own login
   * environment). */
  runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs, outputPath }) {
    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const startedAt = Date.now();

      const remoteScriptPath = toRemotePath(scriptPath);
      const remoteOutputPath = toRemotePath(outputPath);
      const envAssignments = Object.entries(env)
        .filter(([key]) => key.startsWith("CODEENSTEIN_"))
        .map(([key, value]) => `${key}=${shellQuote(value === outputPath ? remoteOutputPath : value)}`)
        .join(" ");
      const remoteCommand = `mkdir -p ${path.posix.dirname(remoteOutputPath)} && cd ${REMOTE_DIR} && ${envAssignments} node ${remoteScriptPath}`;

      let settled = false;
      let killedForTimeout = false;
      const child = spawn("ssh", ["-tt", "-o", "BatchMode=yes", this.userHost, remoteCommand]);

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        for (const line of text.split("\n").filter((l) => l.length > 0)) process.stdout.write(`${prefix}${line}\n`);
        logStream.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        for (const line of text.split("\n").filter((l) => l.length > 0)) process.stderr.write(`${prefix}${line}\n`);
        logStream.write(chunk);
      });

      const watchdog = setTimeout(() => {
        if (settled) return;
        killedForTimeout = true;
        console.log(`${prefix}WATCHDOG: exceeded ${watchdogMs}ms — sending SIGTERM to local ssh client`);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, sigtermGraceMs);
      }, watchdogMs);

      child.on("exit", async (code, signal) => {
        settled = true;
        clearTimeout(watchdog);
        logStream.end();
        if (code === 0) {
          try {
            await execFileAsync("scp", ["-o", "BatchMode=yes", `${this.userHost}:${remoteOutputPath}`, outputPath]);
          } catch (err) {
            console.log(`${prefix}scp of remote result failed: ${err.message}`);
          }
        }
        resolve({ code, signal, killedForTimeout, elapsedMs: Date.now() - startedAt });
      });

      child.on("error", (err) => {
        settled = true;
        clearTimeout(watchdog);
        logStream.end();
        console.log(`${prefix}ssh spawn error: ${err.message}`);
        resolve({ code: null, signal: null, killedForTimeout: false, elapsedMs: Date.now() - startedAt, spawnError: err.message });
      });
    });
  }
}

/** Reads `ssh-hosts.env`, bootstraps every listed host in parallel, and
 * returns one `SshRunner` per host that bootstrapped successfully — a host
 * that's unreachable or fails any bootstrap step is logged as a warning and
 * simply left out, never thrown as a fatal error (an empty/missing
 * `ssh-hosts.env` is the common case: local-only, zero SSH lanes). */
export async function buildSshRunners() {
  const hosts = readHostList();
  if (hosts.length === 0) return [];

  const { stdout: originUrl } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT });
  const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
  const httpsOriginUrl = toHttpsCloneUrl(originUrl.trim());

  const results = await Promise.all(
    hosts.map(async (userHost) => {
      try {
        console.log(`[ssh] bootstrapping ${userHost}...`);
        await bootstrapHost(userHost, httpsOriginUrl, headSha.trim());
        console.log(`[ssh] ${userHost} ready`);
        return new SshRunner(userHost);
      } catch (err) {
        console.log(`[ssh] warning: excluding ${userHost} — bootstrap failed: ${err.message}`);
        return null;
      }
    }),
  );
  return results.filter((runner) => runner !== null);
}

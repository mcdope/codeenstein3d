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
 * **No pre-existing remote checkout — or even Node/git — is assumed.**
 * `buildSshRunners()` does a one-time bootstrap per configured host, all
 * *before* any combo work starts (not lazily per-invocation — the local
 * commit under test can't change mid-campaign, so there's no reason to redo
 * this per attempt): installs `git`/a modern-enough Node via `apt`/NodeSource
 * if either is missing or too old, clone-or-fetch into a fixed
 * `/tmp/codeenstein3d-ssh-lane` on the remote host, force-checkout the exact
 * local `HEAD` sha, `npm ci`, and `npx playwright install --with-deps chromium`
 * (every balancing script in this family only ever launches Chromium — see
 * `run-balancing-telemetry.mjs`'s own doc comment). **Debian/Ubuntu-only by
 * design** — the apt-based prerequisite install assumes one of those (or a
 * derivative); a host on a different distro would fail that step and simply
 * get excluded, same as any other bootstrap failure. Needs passwordless
 * `sudo` on the remote host for the apt/NodeSource steps. A host that fails
 * any bootstrap step (unreachable, apt error, git error, npm error) is
 * logged as a warning and simply excluded from the returned runner list —
 * one bad host must never wedge the whole orchestrator, the same "don't let
 * one participant block everything" lesson a real stuck combo already
 * taught this session.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./loadEngineModules.mjs";

const execFileAsync = promisify(execFile);

const HOSTS_FILE = path.join(REPO_ROOT, "ssh-hosts.env");
const REMOTE_DIR = "/tmp/codeenstein3d-ssh-lane";

function readHostList() {
  if (!fs.existsSync(HOSTS_FILE)) return [];
  return fs
    .readFileSync(HOSTS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Single-quotes a value for safe inclusion in the remote shell command —
 * every dynamic value this module ever interpolates (the origin URL, a git
 * sha, an env var's value) goes through this rather than being trusted raw. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Rewrites a local absolute path under `REPO_ROOT` to the equivalent path
 * under this host's own bootstrapped remote checkout — both checkouts share
 * the same relative structure, only the root differs. */
function toRemotePath(localAbsolutePath) {
  return path.posix.join(REMOTE_DIR, path.relative(REPO_ROOT, localAbsolutePath).split(path.sep).join("/"));
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

// Debian/Ubuntu-only, deliberately — see this module's own doc comment.
// NodeSource's own setup script is used instead of the distro's default
// `nodejs` package: Debian/Ubuntu's own repos ship wildly different, often
// too-old Node majors depending on release (this project needs 18+ today,
// heading toward 20+ — see `notes`' Node-version item), while NodeSource
// still installs via `apt-get` underneath, just from a repo pinned to a
// specific modern major instead of the distro's own stale default.
const NODE_INSTALL_MAJOR = 20;
const NODE_MIN_MAJOR = 18;

/** One remote host's own bootstrap — installs missing prerequisites
 * (git, a modern-enough Node/npm) via `apt`, clones-or-fetches, force-
 * checks-out the exact local commit, installs deps. Throws on any failure;
 * the caller (`buildSshRunners`) is responsible for catching and excluding
 * the host. Needs passwordless `sudo` for the `apt-get`/NodeSource-script
 * steps — a host without it fails bootstrap the same way any other missing
 * prerequisite does (excluded with a warning, not fatal to the whole run). */
async function bootstrapHost(userHost, originUrl, headSha) {
  const cmd = [
    `command -v git >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y git)`,
    // Skip the (slow) Node install entirely if an adequate Node already
    // exists — `&&`/`||` short-circuit exactly like the git check above:
    // install only runs when node is missing *or* too old. Deliberately NOT
    // NodeSource's own `curl | sudo bash` setup script: that pipes arbitrary
    // downloaded script content into a root shell, which can't be scoped in
    // sudoers at all (sudo matches the executable, `bash`, not what's piped
    // into its stdin — a NOPASSWD rule for `bash` is unrestricted root, not
    // a scoped install step). This does the same thing NodeSource's script
    // does, by hand, entirely with fixed, sudoers-scopable commands — see
    // this repo's `doc/dev/balancing-telemetry.md` "SSH-host parallelism"
    // section for the exact sudoers entries this enables.
    `(command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge ${NODE_MIN_MAJOR} ]) || ` +
      `(sudo apt-get install -y ca-certificates curl gnupg && ` +
      `sudo mkdir -p -m 755 /etc/apt/keyrings && ` +
      `curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && ` +
      `echo ${shellQuote(`deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_INSTALL_MAJOR}.x nodistro main`)} | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null && ` +
      `sudo apt-get update -y && sudo apt-get install -y nodejs)`,
    `mkdir -p ${REMOTE_DIR}`,
    // Clone only if this is genuinely the first time; otherwise fetch —
    // avoids re-cloning the whole repo on every campaign invocation.
    `if [ -d ${REMOTE_DIR}/.git ]; then git -C ${REMOTE_DIR} fetch origin; else git clone ${shellQuote(originUrl)} ${REMOTE_DIR}; fi`,
    `git -C ${REMOTE_DIR} checkout --force ${shellQuote(headSha)}`,
    `cd ${REMOTE_DIR} && npm ci`,
    // Deliberately *not* `--with-deps`: that flag has Playwright itself
    // decide and `apt-get install` an arbitrary, version/OS-state-dependent
    // package list at run time — not something a sudoers rule can pin ahead
    // of time (confirmed directly: a `--dry-run` against this exact
    // Playwright version needed a different package set depending on what
    // was already on the machine). A one-time `sudo npx playwright
    // install-deps chromium`, run manually per host during setup, covers
    // this once with full interactive sudo instead of trying to scope an
    // open-ended package list — see this repo's `ssh-hosts.env.dist`/
    // `doc/dev/balancing-telemetry.md` for the full setup checklist.
    `cd ${REMOTE_DIR} && npx playwright install chromium`,
  ].join(" && ");
  await runSsh(userHost, cmd, { timeoutMs: 30 * 60 * 1000 }); // a first-time apt install+clone+npm ci+playwright install is genuinely slow — 30min ceiling
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

  const results = await Promise.all(
    hosts.map(async (userHost) => {
      try {
        console.log(`[ssh] bootstrapping ${userHost}...`);
        await bootstrapHost(userHost, originUrl.trim(), headSha.trim());
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

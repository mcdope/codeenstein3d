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

/** Port for `bootstrapHost`'s vite smoke test. Deliberately not the capture's
 * own 5199: the probe must never collide with a run already in flight on a
 * shared host, and the failure it catches (vite unable to start at all) does
 * not depend on which port is asked for. */
const VITE_PROBE_PORT = 5399;

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

/**
 * Lowest Node major this repo can actually run, read from `package.json`'s
 * own `engines.node` rather than hardcoded.
 *
 * It *was* hardcoded, at 18, and drifted: `engines` moved on and the constant
 * did not, so a lane host with the distro's Node 18 passed every check this
 * toolchain makes and then failed on `playwright install-deps` ("Playwright
 * requires Node.js 20 or higher") after a full clone and `npm ci`. Deriving it
 * means the check cannot disagree with the manifest again.
 *
 * Takes the minimum major across the range's `||` alternatives — for
 * `^22.22.2 || ^24.15.0 || >=26.0.0` that is 22 — because any one of them
 * satisfies npm. Major-only is deliberate: npm's own `EBADENGINE` is a
 * warning rather than an error, so the binding constraint in practice is
 * Playwright's, and a host one patch under the manifest is worth a warning,
 * not a refusal to run.
 */
function lowestSupportedNodeMajor() {
  const FALLBACK = 20;
  try {
    const range = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).engines?.node;
    if (!range) return FALLBACK;
    const majors = range
      .split("||")
      .map((clause) => clause.match(/(\d+)/)?.[1])
      .filter(Boolean)
      .map(Number);
    return majors.length > 0 ? Math.min(...majors) : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export const NODE_MIN_MAJOR = lowestSupportedNodeMajor();

/**
 * Shell prelude that puts an nvm-installed Node on `PATH`, prepended to every
 * remote command this project runs.
 *
 * **Why it is needed at all.** `ssh host 'cmd'` runs a *non-interactive*
 * shell, and nvm works purely by editing `PATH` from `~/.bashrc` — which
 * Debian/Ubuntu's stock `~/.bashrc` guards with an early
 * `case $- in *i*) ;; *) return;; esac`, so the nvm lines never execute. A
 * host where Node exists *only* via nvm therefore looks, over SSH, exactly
 * like a host with no Node at all. That misdiagnosis reached all three call
 * sites: setup tried to `apt-get install nodejs` over the top of a perfectly
 * good nvm install, the per-run bootstrap refused the host and told the
 * operator to run the setup that had already run, and the campaign
 * invocation itself would have failed on a bare `node`. `npm`/`npx` share
 * the same bin directory and so were equally unavailable.
 *
 * **Why it does not source `nvm.sh`.** That script is bash/zsh-only and the
 * remote login shell is not guaranteed to be either — under `dash` sourcing
 * it fails outright. Adding the version directory to `PATH` is plain POSIX
 * sh and needs nvm's own machinery not at all.
 *
 * **Selection rule**: only consulted when the `PATH` Node is missing or
 * older than `NODE_MIN_MAJOR`, so a host with an adequate system Node keeps
 * using it and nothing silently changes underneath an already-working
 * machine. Among nvm's installed versions it takes the **newest that clears
 * the floor** rather than nvm's `default` alias, which can hold an
 * unresolved label (`lts/*`, `20`) that only nvm itself can expand.
 *
 * `sort -V` is coreutils; this whole family is Debian/Ubuntu-only by design
 * (see this module's doc comment).
 */
export const NVM_PATH_PRELUDE =
  `if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)" -lt ${NODE_MIN_MAJOR} ]; then ` +
  `NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; ` +
  `for v in $(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | sort -rV); do ` +
  `if [ -x "$NVM_DIR/versions/node/$v/bin/node" ] && [ "$(echo "$v" | sed 's/^v//' | cut -d. -f1)" -ge ${NODE_MIN_MAJOR} ]; then ` +
  `PATH="$NVM_DIR/versions/node/$v/bin:$PATH"; export PATH; break; fi; done; fi`;

/** Prepend {@link NVM_PATH_PRELUDE} to a remote command. Joined with `;`, not
 * `&&`: the prelude finding no nvm is the ordinary case on a host with a
 * system Node, and must not abort the command it is preparing for. */
export function withRemoteNodePath(remoteCommand) {
  return `${NVM_PATH_PRELUDE}; ${remoteCommand}`;
}

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
      // Names the nvm route explicitly, because the setup script's own
      // install path goes through sudo + NodeSource, and a host that denies
      // sudo over SSH (some hardened PAM configs refuse when the parent
      // process is sshd) would otherwise leave the operator bouncing between
      // two commands that both say "run the other one". `nvm install` needs
      // no root at all, and the prelude above finds what it puts down.
      `{ echo "missing git/Node ${NODE_MIN_MAJOR}+ — run 'node scripts/setup-ssh-lane-host.mjs ${userHost}' from your own machine, or install Node ${NODE_MIN_MAJOR}+ on the host directly (nvm works and needs no sudo: 'nvm install ${NODE_MIN_MAJOR}')" >&2; exit 1; }`,
    `mkdir -p ${REMOTE_DIR}`,
    // Clone only if this is genuinely the first time; otherwise fetch —
    // avoids re-cloning the whole repo on every campaign invocation.
    `if [ -d ${REMOTE_DIR}/.git ]; then git -C ${REMOTE_DIR} fetch origin; else git clone ${shellQuote(originUrl)} ${REMOTE_DIR}; fi`,
    `git -C ${REMOTE_DIR} checkout --force ${shellQuote(headSha)}`,
    `cd ${REMOTE_DIR} && npm ci`,
    // Browser binary only, no sudo — system deps are `setup-ssh-lane-host.mjs`'s
    // job (see this module's own doc comment for why that split exists).
    `cd ${REMOTE_DIR} && npx playwright install chromium`,
    // Prove vite can actually START here, not merely that the toolchain
    // installed. "Ready" used to mean "git, Node and npm ci all worked", which
    // is not the same thing.
    //
    // The failure this exists for, 2026-08-07: a lane host with an exhausted
    // inotify watch limit could not start vite at all — `ENOSPC` on `watch`,
    // then "vite did not come up on :5199 within 60s" — and failed **every**
    // invocation after ~63s. `bootstrapHost` had called it ready, so it kept
    // taking work and burned 7 of one combo's 8 invocations; that combo then
    // reported 15 of 60 runs, which reads as a balance result rather than as a
    // dead machine. Starting a real vite is precisely the operation that
    // failed, so a host in that state now fails here instead.
    //
    // **What it cannot catch**: a host that is healthy at bootstrap and
    // degrades under load later. This probe runs once, on an idle host. That
    // case is covered instead by the orchestrator's lane-health rule, which
    // drops a lane that keeps failing while other lanes are producing — the
    // two are complementary and neither replaces the other.
    //
    // A distinct port from the capture's own 5199, so the probe can never
    // collide with a run in flight on a shared host.
    `cd ${REMOTE_DIR} && (npx vite --port ${VITE_PROBE_PORT} --strictPort >/tmp/codeenstein3d-vite-probe.log 2>&1 & echo $! >/tmp/codeenstein3d-vite-probe.pid); ` +
      `probe_ok=0; for i in $(seq 1 30); do sleep 2; if curl -sf -o /dev/null http://localhost:${VITE_PROBE_PORT}/; then probe_ok=1; break; fi; done; ` +
      `kill "$(cat /tmp/codeenstein3d-vite-probe.pid 2>/dev/null)" 2>/dev/null; ` +
      `if [ "$probe_ok" != 1 ]; then echo "vite failed to start on this host — last lines of its log:" >&2; tail -5 /tmp/codeenstein3d-vite-probe.log >&2; exit 1; fi`,
  ].join(" && ");
  await runSsh(userHost, withRemoteNodePath(cmd), { timeoutMs: 15 * 60 * 1000 }); // no apt/NodeSource install possible here anymore — a first-time clone+npm ci+browser download is still real but much shorter than before
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
  runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs, outputPath, eventLogPath }) {
    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const startedAt = Date.now();

      const remoteScriptPath = toRemotePath(scriptPath);
      const remoteOutputPath = toRemotePath(outputPath);
      // Any env value naming a *local* path has to be rewritten, or the
      // remote writes to a path that means nothing on its own filesystem.
      // `outputPath` was always handled; `eventLogPath` joins it, which is
      // what lets a capture collect per-event data from a remote lane at all.
      const remoteEventLogPath = eventLogPath ? toRemotePath(eventLogPath) : null;
      const remapped = new Map([[outputPath, remoteOutputPath]]);
      if (eventLogPath) remapped.set(eventLogPath, remoteEventLogPath);
      const envAssignments = Object.entries(env)
        .filter(([key]) => key.startsWith("CODEENSTEIN_"))
        .map(([key, value]) => `${key}=${shellQuote(remapped.get(value) ?? value)}`)
        .join(" ");
      // The prelude has to be here too, not just in `bootstrapHost`: each
      // invocation is its own SSH session and inherits nothing from the
      // bootstrap's shell, so a host whose Node is nvm-only would pass the
      // bootstrap check and then fail on this bare `node`.
      const remoteCommand = withRemoteNodePath(
        [
          `mkdir -p ${path.posix.dirname(remoteOutputPath)}`,
          // The event-log directory has to exist before the run, not after:
          // `writeEventBatches` appends per attempt, and a missing parent
          // would lose the whole cell's events one attempt at a time while
          // the run itself still exited zero.
          //
          // Emptied as well as created, because a retry can land on the same
          // directory: the orchestrator's sequence counter skips whatever is
          // already on disk, and an invocation killed by the watchdog scp's
          // nothing back, so a retry can be handed a path a dead run already
          // wrote to remotely. `appendEvents` never truncates, so without this
          // the retry's runs would be appended to the dead run's partial ones
          // and the cell would overshoot its denominator with truncated data.
          // Measured: a killed invocation left 2 partial runs behind and the
          // retry's 3 made it "5/3".
          ...(remoteEventLogPath ? [`mkdir -p ${remoteEventLogPath}`, `rm -f ${remoteEventLogPath}/*.ndjson`] : []),
          `cd ${REMOTE_DIR} && ${envAssignments} node ${remoteScriptPath}`,
        ].join(" && "),
      );

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
        let fetchFailed = false;
        if (code === 0) {
          try {
            await execFileAsync("scp", ["-o", "BatchMode=yes", `${this.userHost}:${remoteOutputPath}`, outputPath]);
            if (remoteEventLogPath) {
              // `-r` because the remote path is the directory
              // `writeEventBatches` names its file inside.
              fs.mkdirSync(eventLogPath, { recursive: true });
              await execFileAsync("scp", ["-o", "BatchMode=yes", "-r", `${this.userHost}:${remoteEventLogPath}/.`, eventLogPath]);
            }
          } catch (err) {
            console.log(`${prefix}scp of remote result failed: ${err.message}`);
            // Reported as a failed invocation rather than a zero exit with
            // missing data. For a capture the NDJSON *is* the result, so a
            // run whose events never came home is not a run that succeeded —
            // and the orchestrator's own existsSync check only guards the
            // aggregate, which may well have arrived before the event log
            // did. Without this the lane would look productive while
            // banking nothing the analysis can read.
            fetchFailed = true;
          }
        }
        resolve({ code: fetchFailed ? 1 : code, signal, killedForTimeout, elapsedMs: Date.now() - startedAt });
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
/**
 * Whether `HEAD` exists on any remote — the precondition every SSH lane
 * silently depends on.
 *
 * `bootstrapHost` clones from `origin` over https and then
 * `git checkout --force <local HEAD sha>`. An unpushed commit is simply not
 * there, so that checkout dies with "reference is not a tree object" and the
 * host is excluded. With every host excluded the run continues on the local
 * lane alone — which is the worst shape this failure could take: the thing
 * you turned lanes on for silently does not happen, and the only evidence is
 * a `Lanes: local` line among a wall of bootstrap output.
 *
 * Checked against remote-tracking refs rather than the network, so it costs
 * nothing and cannot hang. That can be stale in the direction of *thinking*
 * something is unpushed when a fetch would say otherwise — a false alarm that
 * tells you to push something already pushed, which is cheap and obvious.
 * The opposite error is the expensive one, and stale refs cannot produce it.
 */
export async function headIsPushed() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: REPO_ROOT });
    return Number(stdout.trim()) === 0;
  } catch {
    return true; // no remotes configured at all — not this check's problem
  }
}

export async function buildSshRunners() {
  const hosts = readHostList();
  if (hosts.length === 0) return [];

  if (!(await headIsPushed())) {
    // Bail before bootstrapping rather than after: each doomed host would
    // otherwise spend minutes on a clone and `npm ci` before failing on the
    // checkout, and report it as a hundred-line dump of the whole ssh command
    // with the actual reason buried in it.
    const { stdout: unpushed } = await execFileAsync("git", ["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd: REPO_ROOT });
    console.log(
      `[ssh] SKIPPING all ${hosts.length} lane host(s): HEAD is not on any remote (${unpushed.trim()} unpushed commit(s)).\n` +
        `[ssh] Lane hosts clone from origin and check out this exact commit, so they cannot run it.\n` +
        `[ssh] Push the branch to use them — otherwise this runs on the local lane alone.`,
    );
    return [];
  }

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

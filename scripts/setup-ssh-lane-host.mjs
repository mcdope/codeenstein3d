// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-time, interactive setup for an SSH-lane host (`scripts/lib/sshRunner.mjs`,
 * `notes`' "SSH-host parallelism" item). Run this by hand, once per host,
 * *before* the host's first real `balancing:campaign`/`balancing:campaign-multiplayer`
 * run — not something the campaign orchestrators ever call themselves.
 *
 * Why this is a separate script instead of folded into the automated
 * per-run bootstrap (`sshRunner.mjs`'s own `bootstrapHost()`): two of the
 * steps here genuinely can't be made both unattended *and* narrowly
 * sudo-scoped —
 *  - Installing a modern-enough Node needs either NodeSource's own
 *    `curl | sudo bash` setup script (sudoers can only match the
 *    executable, `bash`, never what's piped into its stdin — a NOPASSWD
 *    rule for that is unrestricted passwordless root, not a scoped step),
 *    or the equivalent done by hand across several fixed commands. Fine
 *    either way for a real human typing their own password once; not fine
 *    to demand a passwordless sudoers entry for, forever, on every
 *    automated run.
 *  - `npx playwright install-deps` has Playwright itself decide and
 *    `apt-get install` an arbitrary, OS/version-state-dependent package
 *    list at run time — confirmed directly via `--dry-run`, which reported
 *    a different missing-package list on hosts at different patch levels.
 *    There is no fixed command line here a sudoers rule could ever pin.
 *
 * Splitting "provision this host" (here, real interactive sudo, once) from
 * "run a campaign against it" (`sshRunner.mjs`, fully automated, never
 * touches sudo/apt at all) means the *automated* path needs no passwordless
 * sudo configuration whatsoever — only this one-time script does, and it's
 * run by a person sitting at a keyboard who can just type their password.
 *
 * **Debian/Ubuntu only, deliberately** — see `sshRunner.mjs`'s own doc
 * comment for why (this project's own hosts are all Debian/Ubuntu; a
 * different distro would need a different version of this script).
 *
 * Usage: `node scripts/setup-ssh-lane-host.mjs [user@host ...]` — with no
 * arguments, every host listed in `ssh-hosts.env` is set up in turn
 * (sequentially, not concurrently: interactive sudo prompts from several
 * hosts at once would interleave confusingly on one terminal). Pass one or
 * more `user@host` arguments to scope it to specific hosts instead (e.g. to
 * try a host before adding it to `ssh-hosts.env`, or re-run setup on just
 * one after a system update wiped its Node install).
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { NODE_MIN_MAJOR, REMOTE_DIR, readHostList } from "./lib/sshRunner.mjs";

const execFileAsync = promisify(execFile);

// A recent LTS — comfortably clears NODE_MIN_MAJOR, matching sshRunner.mjs's
// own per-run check.
const NODE_INSTALL_MAJOR = 20;

/** Runs `remoteCommand` over a real interactive `ssh -t` session — stdio is
 * inherited wholesale (not piped/captured), so the user sees every prompt
 * live and can type their sudo password directly, exactly like running the
 * command by hand. Rejects on a non-zero exit instead of swallowing it,
 * unlike `sshRunner.mjs`'s own automated paths — a setup failure here
 * should stop and be looked at, not retry or silently move to the next
 * host. */
function runInteractiveSsh(userHost, remoteCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-t", userHost, remoteCommand], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ssh ${userHost} exited with code ${code}`))));
    child.on("error", reject);
  });
}

function buildSetupCommand(originUrl) {
  return [
    // Same "install only if actually needed" shape as sshRunner.mjs's own
    // per-run check, just with real installs on the missing/inadequate
    // branch instead of failing — this is the one place in the whole
    // toolchain allowed to do that.
    `command -v git >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y git)`,
    `(command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge ${NODE_MIN_MAJOR} ]) || ` +
      `(curl -fsSL https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs)`,
    `mkdir -p ${REMOTE_DIR}`,
    `if [ -d ${REMOTE_DIR}/.git ]; then git -C ${REMOTE_DIR} fetch origin; else git clone '${originUrl.replace(/'/g, "'\\''")}' ${REMOTE_DIR}; fi`,
    `cd ${REMOTE_DIR} && npm ci`,
    // Real system dependencies (fonts, X11/graphics libs, etc.) — the whole
    // reason this step needs its own script; see the top doc comment.
    `cd ${REMOTE_DIR} && sudo npx playwright install-deps chromium`,
    // The browser binary itself, too — not strictly required here (the
    // automated per-run bootstrap does this too), but doing it now means
    // the very first real campaign run against this host doesn't also pay
    // for a browser download on top of everything else.
    `cd ${REMOTE_DIR} && npx playwright install chromium`,
  ].join(" && ");
}

async function main() {
  const hosts = process.argv.slice(2).length > 0 ? process.argv.slice(2) : readHostList();
  if (hosts.length === 0) {
    console.error("No hosts given and ssh-hosts.env is empty/missing — nothing to set up. Usage: node scripts/setup-ssh-lane-host.mjs [user@host ...]");
    process.exit(1);
  }

  const { stdout: originUrl } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT });
  const setupCommand = buildSetupCommand(originUrl.trim());

  for (const userHost of hosts) {
    console.log(`\n=== Setting up ${userHost} — you may be prompted for your sudo password ===`);
    await runInteractiveSsh(userHost, setupCommand);
    console.log(`=== ${userHost} ready for automated campaign runs ===`);
  }
}

main().catch((err) => {
  console.error("setup-ssh-lane-host failed:", err.message);
  process.exit(1);
});

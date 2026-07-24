// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Generic combo-queue lane orchestrator, extracted from
 * `run-balancing-campaign.mjs`'s own proven design (resumable purely by
 * scanning existing output files — no separate progress-state file; a
 * wall-clock watchdog per invocation; N concurrent lanes pulling combos off
 * one shared queue) so both the single-player campaign and the new
 * multiplayer campaign orchestrator (`run-balancing-campaign-multiplayer.mjs`)
 * can share it, and so a lane can be either a local `child_process`
 * (`LocalRunner`) or a remote SSH host (`SshRunner`,
 * `scripts/lib/sshRunner.mjs`) without either caller needing to know the
 * difference — a `Runner`'s only contract is `runInvocation(...)` resolving
 * once a *local* result file exists at the given `outputPath` (a remote
 * runner is responsible for pulling it back itself before resolving).
 *
 * Callers stay responsible for anything that's genuinely different between
 * single-player/multiplayer telemetry: the combo list itself, each combo's
 * env vars, and how to read an existing output file's already-qualifying
 * count (single-player's shape nests by profile/difficulty; a per-combo
 * multiplayer file can be read flat) — see `runLaneOrchestrator`'s own
 * param docs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

function defaultFormatElapsed(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

function prefixedWrite(stream, chunk, prefix) {
  const text = chunk.toString();
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) stream.write(`${prefix}${line}\n`);
}

/** Local-machine lane: spawns `scriptPath` as a child Node process (`cwd`
 * given per call, since a `Runner` is reused across every combo/invocation),
 * same wall-clock watchdog (SIGTERM, then SIGKILL after a grace period) as
 * the original `run-balancing-campaign.mjs`. Never rejects — a spawn error
 * resolves with `spawnError` set instead, so one bad invocation can't take
 * down the whole orchestrator. */
export class LocalRunner {
  constructor({ label = "local", cwd } = {}) {
    this.label = label;
    this.cwd = cwd;
  }

  runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs }) {
    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const startedAt = Date.now();
      const child = spawn(process.execPath, [scriptPath], { cwd: this.cwd, env });

      let settled = false;
      let killedForTimeout = false;

      child.stdout.on("data", (chunk) => {
        prefixedWrite(process.stdout, chunk, prefix);
        logStream.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        prefixedWrite(process.stderr, chunk, prefix);
        logStream.write(chunk);
      });

      const watchdog = setTimeout(() => {
        if (settled) return;
        killedForTimeout = true;
        console.log(`${prefix}WATCHDOG: exceeded ${watchdogMs}ms — sending SIGTERM`);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            console.log(`${prefix}WATCHDOG: still alive ${sigtermGraceMs}ms after SIGTERM — sending SIGKILL`);
            child.kill("SIGKILL");
          }
        }, sigtermGraceMs);
      }, watchdogMs);

      child.on("exit", (code, signal) => {
        settled = true;
        clearTimeout(watchdog);
        logStream.end();
        resolve({ code, signal, killedForTimeout, elapsedMs: Date.now() - startedAt });
      });

      child.on("error", (err) => {
        settled = true;
        clearTimeout(watchdog);
        logStream.end();
        console.log(`${prefix}spawn error: ${err.message}`);
        resolve({ code: null, signal: null, killedForTimeout: false, elapsedMs: Date.now() - startedAt, spawnError: err.message });
      });
    });
  }
}

/** One combo's own drive loop: repeatedly scans existing output for this
 * combo, and — while still short of its qualifying target — asks its
 * assigned `runner` for one more invocation, retrying on any failure
 * (watchdog kill, non-zero exit, or a missing output file despite a zero
 * exit) exactly like the original `run-balancing-campaign.mjs`'s
 * `driveCombo`. Every lane calls this same function, so local and remote
 * lanes are interchangeable from the shared queue's point of view. */
async function driveCombo(combo, opts) {
  const { comboKey, scanExisting, targetQualifying, outputPathFor, logPathFor, envFor, scriptPath, runner, watchdogMs, sigtermGraceMs, formatElapsed, log } = opts;
  const key = comboKey(combo);
  for (;;) {
    const { qualifying, fileCount } = scanExisting(combo);
    const target = typeof targetQualifying === "function" ? targetQualifying(combo) : targetQualifying;
    if (qualifying >= target) {
      log(`[${key}] done — ${qualifying}/${target} qualifying across ${fileCount} files`);
      return;
    }
    const sequence = fileCount + 1;
    const outputPath = outputPathFor(combo, sequence);
    const logPath = logPathFor(combo, sequence);
    const env = envFor(combo, sequence, outputPath);
    const prefix = `[${key} #${sequence}] `;
    log(`[${key}] starting invocation #${sequence} (${qualifying}/${target} qualifying so far) via ${runner.label}`);

    const result = await runner.runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs, outputPath });

    if (result.killedForTimeout) {
      log(`[${key}] invocation #${sequence} KILLED by watchdog after ${formatElapsed(result.elapsedMs)} — retrying`);
      continue;
    }
    if (result.code !== 0) {
      log(
        `[${key}] invocation #${sequence} exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""} after ${formatElapsed(result.elapsedMs)}${result.spawnError ? ` — ${result.spawnError}` : ""} — retrying`,
      );
      continue;
    }
    const written = fs.existsSync(outputPath);
    log(`[${key}] invocation #${sequence} finished in ${formatElapsed(result.elapsedMs)}${written ? "" : " (no output file — treating as failed, retrying)"}`);
  }
}

async function runLane(queue, driveComboFn) {
  for (;;) {
    const combo = queue.shift();
    if (!combo) return;
    await driveComboFn(combo);
  }
}

/**
 * Runs every combo in `combos` to its qualifying target, `runners.length`
 * lanes at a time (one per configured `Runner`, local or SSH), each lane
 * pulling the next not-yet-satisfied combo off one shared queue as it frees
 * up — mirrors `run-balancing-campaign.mjs`'s original `LANES`-workers-over-
 * one-queue design, generalized to a mixed local/remote runner list.
 *
 * @param {object} params
 * @param {Array} params.combos - opaque combo objects; only `comboKey` below
 *   needs to understand their shape.
 * @param {(combo) => string} params.comboKey - a stable, filesystem-safe key
 *   per combo (used for output/log filenames and log messages).
 * @param {(combo) => {qualifying: number, fileCount: number}} params.scanExisting -
 *   sums whatever "already qualifying" count existing output files for this
 *   combo represent — shape is entirely caller-defined (single-player nests
 *   by profile/difficulty; a per-combo multiplayer file can read a flat
 *   field directly).
 * @param {number|((combo) => number)} params.targetQualifying - how many
 *   qualifying runs before a combo is done.
 * @param {(combo, sequence) => string} params.outputPathFor - absolute local
 *   path the invocation's result must exist at once `runInvocation` resolves
 *   (a remote `Runner` is responsible for scp/rsync-ing it there itself).
 * @param {(combo, sequence) => string} params.logPathFor - absolute local
 *   path for this invocation's own log file.
 * @param {(combo, sequence, outputPath) => object} params.envFor - builds
 *   the full env object for one invocation.
 * @param {string} params.scriptPath - path to the underlying script entry
 *   point (interpreted by each `Runner` in its own way — a local runner
 *   resolves it directly, an SSH runner resolves the equivalent path inside
 *   its own bootstrapped remote checkout).
 * @param {Array<{label: string, runInvocation: Function}>} params.runners -
 *   one entry per lane; see `LocalRunner`/`SshRunner`.
 * @param {number} [params.watchdogMs]
 * @param {number} [params.sigtermGraceMs]
 * @param {(msg: string) => void} [params.log]
 * @param {(ms: number) => string} [params.formatElapsed]
 */
export async function runLaneOrchestrator(params) {
  const {
    combos,
    comboKey,
    scanExisting,
    targetQualifying,
    outputPathFor,
    logPathFor,
    envFor,
    scriptPath,
    runners,
    watchdogMs = 90 * 60 * 1000,
    sigtermGraceMs = 5000,
    log = (msg) => console.log(msg),
    formatElapsed = defaultFormatElapsed,
  } = params;

  const queue = [...combos];
  await Promise.all(
    runners.map((runner) =>
      runLane(queue, (combo) =>
        driveCombo(combo, { comboKey, scanExisting, targetQualifying, outputPathFor, logPathFor, envFor, scriptPath, runner, watchdogMs, sigtermGraceMs, formatElapsed, log }),
      ),
    ),
  );
}

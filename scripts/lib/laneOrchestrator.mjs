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

/** Exported so a caller can render the utilisation summary this module returns
 * in the same units its own progress lines already use. */
export function defaultFormatElapsed(ms) {
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

  /** `outputPath`/`eventLogPath` are accepted and ignored: a local child
   * already writes straight to whatever `env` names, so there is nothing to
   * bring back. `SshRunner` needs both to rewrite the paths for the remote
   * side and to fetch the results — see its own implementation. */
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

/**
 * The scheduler's per-combo bookkeeping.
 *
 * `spawned` is deliberately NOT `fileCount`: a *crashing* invocation writes no
 * output file, so `fileCount` never advances and a file-based cap would never
 * fire — the loop would retry the same failing invocation forever, which is
 * the exact wedge observed on 2026-07-30 (a Gamer/hard/4p probe whose browser
 * died on every attempt re-ran invocation #1 indefinitely, appending to one
 * log). Counting spawns bounds broken invocations and unclearable combos
 * alike.
 *
 * `inFlight` and `nextSequence` are what make chunk stealing safe; see
 * `claimSequence` and `runLaneOrchestrator`'s `maxConcurrentPerCombo`.
 */
function makeState(combo, key) {
  return { combo, key, spawned: 0, inFlight: 0, nextSequence: 0, retired: false };
}

/**
 * Reserves a sequence number for one invocation.
 *
 * The old code used `fileCount + 1`, which is correct only while a combo has
 * at most one invocation running: two concurrent invocations both see the same
 * `fileCount` and both pick the same number, so they would overwrite each
 * other's output file, log and event-log directory — silently losing a whole
 * chunk of a capture.
 *
 * A monotonic per-combo counter fixes the collision; the `fileCount + 1` floor
 * and the existence scan keep the old resumability property, where a re-run
 * picks up after whatever is already on disk rather than clobbering it.
 *
 * Runs to completion synchronously, with no `await` inside, so two lanes can
 * never interleave inside it.
 */
function claimSequence(state, fileCount, outputPathFor) {
  let seq = Math.max(state.nextSequence, fileCount + 1);
  while (fs.existsSync(outputPathFor(state.combo, seq))) seq += 1;
  state.nextSequence = seq + 1;
  return seq;
}

/**
 * Runs every combo in `combos` to its qualifying target, `runners.length`
 * lanes at a time (one per configured `Runner`, local or SSH).
 *
 * **Lanes claim invocations, not combos.** The original design gave a lane a
 * whole combo and let it drive that combo to completion. With as many combos
 * as lanes — the normal case — nothing is left to pick up the moment a lane
 * finishes, so it stops working while the run continues. Measured on the
 * ripgrep capture of 2026-08-06: three lanes, 132 minutes, and one lane's last
 * event write was at minute 17. It was **idle for 115 of 132 minutes**, and
 * roughly half of all available lane-time produced nothing. A five-repo sweep
 * pays that five times.
 *
 * So a lane now takes the next *invocation* of whichever combo is furthest
 * from its target and has room for another (`maxConcurrentPerCombo`), which is
 * what lets a free lane help finish someone else's combo. Two things make that
 * safe and neither is optional: sequence numbers come from a per-combo counter
 * rather than `fileCount + 1` (concurrent invocations would otherwise pick the
 * same number and overwrite each other — see `claimSequence`), and `envFor`
 * receives `inFlightBefore` so a caller sizing a chunk from remaining work
 * does not hand the same work to two lanes.
 *
 * Returns a utilisation summary; see the bottom of this function.
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
 * @param {(combo, sequence) => string} [params.eventLogPathFor] - absolute
 *   local *directory* this invocation's NDJSON event log must exist in once
 *   `runInvocation` resolves. Omit for a run that only reads aggregates. One
 *   directory per invocation rather than one shared one, because
 *   `writeEventBatches` names the file from profile+difficulty alone: two
 *   invocations of the same combo would otherwise collide on the way back,
 *   and a shared remote directory would be re-copied in full every time.
 *   Note this separation only holds while sequence numbers are unique per
 *   invocation — which is `claimSequence`'s job, and is what makes it safe to
 *   run two invocations of one combo at once.
 * @param {(combo, sequence, outputPath, eventLogPath, ctx) => object} params.envFor -
 *   builds the full env object for one invocation. `ctx.inFlightBefore` is how
 *   many invocations of this same combo were already running when this one was
 *   claimed — a caller that derives an attempt cap from "target minus what is
 *   on disk" must subtract the work those are already doing, or every extra
 *   lane overshoots the target by one chunk.
 * @param {number|((combo, ctx) => number)} [params.maxConcurrentPerCombo=1] -
 *   how many invocations of one combo may run at once; `ctx` is
 *   `{qualifying, target, fileCount, inFlight}`. Left at 1, lanes cannot help
 *   each other and a run with combos <= lanes idles as described above. A
 *   capture that splits a combo into fixed-size chunks wants roughly
 *   `ceil((target - qualifying) / chunk)` — never more invocations than there
 *   is work left to do.
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
    eventLogPathFor,
    envFor,
    scriptPath,
    runners,
    watchdogMs = 90 * 60 * 1000,
    sigtermGraceMs = 5000,
    log = (msg) => console.log(msg),
    formatElapsed = defaultFormatElapsed,
    // Per-combo invocation ceiling. `null`/omitted keeps the historical
    // unbounded behaviour; see `makeState` for why every campaign should
    // set it.
    maxInvocations = null,
    // How many invocations of ONE combo may run at once. The default of 1 is
    // the historical behaviour — a combo is worked serially — and with it a
    // run with as many combos as lanes still leaves every finished lane idle,
    // which is the whole problem. Raise it to let free lanes steal chunks of
    // a combo someone else is already working.
    maxConcurrentPerCombo = 1,
  } = params;

  const states = combos.map((combo) => makeState(combo, comboKey(combo)));
  const targetFor = (combo) => (typeof targetQualifying === "function" ? targetQualifying(combo) : targetQualifying);
  const concurrencyFor = (combo, ctx) =>
    Math.max(1, typeof maxConcurrentPerCombo === "function" ? maxConcurrentPerCombo(combo, ctx) : maxConcurrentPerCombo);

  let inFlightTotal = 0;
  // Lanes park here when there is nothing claimable but work is still running.
  // Every completing invocation wakes all of them to re-decide.
  let waiters = [];
  const wakeAll = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const nextCompletion = () => new Promise((resolve) => waiters.push(resolve));

  // `scanExisting` is expensive for a capture — it re-parses every NDJSON the
  // combo has produced, tens of MB by the end of a cell — and the scheduler
  // has to consult *every* combo to decide where a free lane goes, where the
  // old code only ever looked at the one combo the lane owned. Since nothing
  // that changes a scheduling decision happens between invocation
  // completions, one scan per combo per generation is enough: several lanes
  // woken by the same completion share it instead of each re-reading the
  // whole capture. Counts do drift mid-flight as running invocations append,
  // but scheduling on a slightly stale count is exactly what the old code did
  // too — it read the same disk between spawns.
  let scanCache = new Map();
  const scanOf = (state) => {
    if (!scanCache.has(state.key)) scanCache.set(state.key, scanExisting(state.combo));
    return scanCache.get(state.key);
  };

  /**
   * Picks the next invocation to run, or `null` if nothing may start right now.
   *
   * Entirely synchronous — see `claimSequence`. Two lanes cannot interleave
   * inside it, so `inFlight`/`spawned`/`nextSequence` need no locking.
   */
  function claim() {
    let best = null;
    for (const state of states) {
      if (state.retired) continue;
      const { qualifying, fileCount } = scanOf(state);
      const target = targetFor(state.combo);

      // Satisfied, or out of budget. Either way nothing more may start; the
      // combo is only *retired* (and reported) once its in-flight work lands,
      // so the final message reflects what actually got banked.
      const satisfied = qualifying >= target;
      const exhausted = maxInvocations != null && state.spawned >= maxInvocations;
      if (satisfied || exhausted) {
        if (state.inFlight === 0) {
          state.retired = true;
          log(
            satisfied
              ? `[${state.key}] done — ${qualifying}/${target} qualifying across ${fileCount} files`
              : `[${state.key}] giving up — ${qualifying}/${target} qualifying after ${state.spawned} invocation(s) this run (${fileCount} file(s) on disk), at the ${maxInvocations}-invocation cap`,
          );
        }
        continue;
      }

      const limit = concurrencyFor(state.combo, { qualifying, target, fileCount, inFlight: state.inFlight });
      if (state.inFlight >= limit) continue;
      // Spread lanes across combos before doubling up on one: fewest in-flight
      // first, then whichever is furthest from its target. Without this the
      // first combo in the list would absorb every free lane and the last one
      // would still be starting when everything else had finished.
      const score = [state.inFlight, -(target - qualifying)];
      if (best === null || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
        best = { state, qualifying, target, fileCount, score };
      }
    }
    if (best === null) return null;

    const { state, qualifying, target, fileCount } = best;
    const sequence = claimSequence(state, fileCount, outputPathFor);
    state.spawned += 1;
    state.inFlight += 1;
    inFlightTotal += 1;
    return { state, sequence, qualifying, target };
  }

  const startedAt = Date.now();
  const laneStats = runners.map((runner) => ({ label: runner.label, invocations: 0, busyMs: 0 }));

  async function runLane(runner, stats) {
    for (;;) {
      const work = claim();
      if (!work) {
        // Nothing claimable. If nothing is running either, no future claim can
        // ever succeed — every combo is satisfied, retired or capped — so the
        // whole run is over. Otherwise park until an invocation lands and
        // changes the picture. No `await` between `claim()` and `nextCompletion()`,
        // so a completion cannot slip past an unregistered waiter.
        if (inFlightTotal === 0) return;
        await nextCompletion();
        continue;
      }

      const { state, sequence, qualifying, target } = work;
      const outputPath = outputPathFor(state.combo, sequence);
      const logPath = logPathFor(state.combo, sequence);
      // Optional: only a capture that actually wants per-event data supplies
      // this. A campaign that only reads aggregates leaves it undefined and
      // nothing changes for it.
      const eventLogPath = eventLogPathFor ? eventLogPathFor(state.combo, sequence) : undefined;
      // `inFlightBefore` excludes this invocation. A caller that sizes a chunk
      // from remaining work needs it: without it, two concurrent invocations
      // both read the same `qualifying` off disk and both run a full chunk,
      // overshooting the target by a chunk per extra lane.
      const env = envFor(state.combo, sequence, outputPath, eventLogPath, { inFlightBefore: state.inFlight - 1 });
      const prefix = `[${state.key} #${sequence}] `;
      log(`[${state.key}] starting invocation #${sequence} (${qualifying}/${target} qualifying so far) via ${runner.label}`);

      let result;
      try {
        result = await runner.runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs, outputPath, eventLogPath });
      } finally {
        state.inFlight -= 1;
        inFlightTotal -= 1;
        // New results on disk: every cached count is now stale. Invalidate
        // before waking anyone, so no lane decides against a pre-completion
        // view of the world.
        scanCache = new Map();
      }
      stats.invocations += 1;
      stats.busyMs += result?.elapsedMs ?? 0;

      if (result.killedForTimeout) {
        log(`[${state.key}] invocation #${sequence} KILLED by watchdog after ${formatElapsed(result.elapsedMs)} — retrying`);
      } else if (result.code !== 0) {
        log(
          `[${state.key}] invocation #${sequence} exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""} after ${formatElapsed(result.elapsedMs)}${result.spawnError ? ` — ${result.spawnError}` : ""} — retrying`,
        );
      } else {
        const written = fs.existsSync(outputPath);
        log(`[${state.key}] invocation #${sequence} finished in ${formatElapsed(result.elapsedMs)}${written ? "" : " (no output file — treating as failed, retrying)"}`);
      }
      // A lane freeing up changes what every parked lane may claim.
      wakeAll();
    }
  }

  await Promise.all(runners.map((runner, i) => runLane(runner, laneStats[i])));

  // Idle lane-time was invisible before 2026-08-06, and that is exactly how a
  // lane sat idle for 115 of a 132-minute capture without anyone noticing —
  // the only symptom is a quiet machine. Report it every run.
  const wallMs = Date.now() - startedAt;
  const lanes = laneStats.map((s) => ({ ...s, idleMs: Math.max(0, wallMs - s.busyMs) }));
  const idleMs = lanes.reduce((sum, l) => sum + l.idleMs, 0);
  const totalMs = wallMs * Math.max(1, lanes.length);
  return { wallMs, lanes, idleMs, laneTimeMs: totalMs, idleFraction: totalMs > 0 ? idleMs / totalMs : 0 };
}

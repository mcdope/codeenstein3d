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

/**
 * A `maxConcurrentPerCombo` policy: one lane per attempt still needed, capped
 * by how many lanes exist.
 *
 * The obvious policy — `ceil(remaining / CHUNK)` — is what produced the tail
 * this exists to remove. It reads as "how many full chunks of work are left",
 * but at the end of a cell that is always **one**: with `CHUNK = 20`, a combo
 * two attempts short computes `ceil(2/20) = 1`, so exactly one lane may work
 * it however many are sitting idle. Measured 2026-08-09 across four repos, the
 * end of every single cell looked the same — five of six combos finished, the
 * sixth held by one lane, everyone else stopped. wolf3d idled 36% of its total
 * lane-time (232m of 648m) on a run where every cell reached target.
 *
 * Sizing chunks smaller does not fix it, which is worth stating because it is
 * the intuitive answer and it is wrong: those tail invocations were *already*
 * down to one attempt each (the last one banked 1 attempt in 3m57s). The
 * binding constraint was never the size of the piece, it was permission to
 * start a second one.
 *
 * Spreading lanes across combos does not depend on this cap and is not
 * weakened by raising it — `claim` already scores by fewest-in-flight first, so
 * lanes fan out across combos on their own and only double up once there are
 * more lanes than unsatisfied combos, which is exactly when doubling up is what
 * you want.
 */
export function concurrencyByRemaining(remaining, { laneCount = Infinity } = {}) {
  return Math.min(laneCount, Math.max(0, remaining));
}

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
  /**
   * `env` overrides are merged over each invocation's environment, so several
   * local lanes on one machine can differ from each other — which is the whole
   * point of running more than one.
   *
   * Two settings need it. Each lane must get a *share* of the machine's
   * concurrency rather than the whole of it, and every local lane must be
   * pointed at one shared dev server: a telemetry child that starts its own
   * `stop()`s it on exit, which with parallel lanes would pull the server out
   * from under the lanes still running. `SshRunner` forwards every
   * `CODEENSTEIN_*` key, so a `localhost` URL must never be set globally —
   * per-runner is the only place it can go.
   */
  constructor({ label = "local", cwd, env = {} } = {}) {
    this.label = label;
    this.cwd = cwd;
    this.env = env;
  }

  /** `outputPath`/`eventLogPath` are accepted and ignored: a local child
   * already writes straight to whatever `env` names, so there is nothing to
   * bring back. `SshRunner` needs both to rewrite the paths for the remote
   * side and to fetch the results — see its own implementation. */
  runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs }) {
    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(logPath, { flags: "a" });
      const startedAt = Date.now();
      const child = spawn(process.execPath, [scriptPath], { cwd: this.cwd, env: { ...env, ...this.env } });

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
 * Multiple of `maxInvocations` at which a combo is abandoned regardless of
 * progress. Only a runaway backstop — the real bound is barren invocations, so
 * this exists purely to stop an unbounded loop if something pathological banks
 * one attempt per invocation forever.
 */
const RUNAWAY_FACTOR = 6;

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
  // `relCost` is how expensive this combo is per attempt *relative to the
  // lane that ran it* — dimensionless, so it does not smuggle lane speed into
  // a combo property. 1 means "average work for that host".
  return { combo, key, spawned: 0, barren: 0, inFlight: 0, nextSequence: 0, retired: false, reserved: 0, relCost: 1 };
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
    // Consecutive no-output failures before a lane is dropped from the pool —
    // but only while some *other* lane is producing. See the lane-health block
    // in `runLane` for why that condition is what makes this safe.
    laneFailureLimit = 3,
    // Sizes one invocation's work for the lane about to run it. Omit and every
    // lane gets whatever the caller's own env builder decides, i.e. the old
    // fixed-chunk behaviour.
    chunkFor = null,
    // Seed rates (attempts per minute, by lane label) from what a previous run
    // measured, so a capture does not spend its first round relearning which
    // hosts are fast. See the summary this function returns.
    initialLaneRates = {},
    // Called with (laneLabel, attemptsPerMin) each time a rate is revised, so a
    // caller can persist as it goes. Without it the rates only reach the caller
    // in the summary, and a run killed part-way — which happens a lot during
    // investigation — takes everything it learned with it.
    onLaneRate = null,
    // Seed per-combo relative cost, keyed by `comboKey`. Learned within a run
    // otherwise. Deliberately NOT persisted across runs by the capture driver:
    // cost is a property of the *staged levels*, so carrying it from one
    // repository to the next would be actively wrong.
    initialComboCost = {},
    // Called with (comboKey, relCost) whenever a combo's cost estimate is
    // revised, so a caller can persist it per staged campaign. Same reasoning
    // as `onLaneRate`: a run that is interrupted should not throw away what it
    // learned.
    onComboCost = null,
    // Attempts an invocation actually delivered, as opposed to what it was
    // asked for. Without it a run that fails fast still reports a rate, and a
    // fast failure reads as blazing speed. Measured 2026-08-08: a 45-second
    // invocation that banked nothing pushed one lane's rate to 2.02/min
    // against a true ~0.2, which then earned it oversized chunks and starved
    // the others.
    measureYield = null,
  } = params;

  const states = combos.map((combo) => {
    const state = makeState(combo, comboKey(combo));
    const seed = initialComboCost[state.key];
    if (typeof seed === "number" && seed > 0) state.relCost = seed;
    return state;
  });
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
  function claim(runner) {
    const candidates = [];
    for (const state of states) {
      if (state.retired) continue;
      const { qualifying, fileCount } = scanOf(state);
      const target = targetFor(state.combo);

      // Satisfied, or out of budget. Either way nothing more may start; the
      // combo is only *retired* (and reported) once its in-flight work lands,
      // so the final message reflects what actually got banked.
      const satisfied = qualifying >= target;
      // The cap counts CONSECUTIVE BARREN invocations — ones that did not move
      // the combo forward — not every invocation.
      //
      // Its job is to stop a combo that cannot progress, and a combo banking
      // attempts three at a time is progressing. Counting all spawns cut
      // sinatra off at 27 of 30 on 2026-08-08: every cell hit a 9-invocation
      // cap while still delivering, and reported SHORT — which is exactly the
      // "accounting ceiling looks like an unclearable cell" confusion this
      // capture exists to avoid. The absolute ceiling below still bounds a
      // runaway, generously.
      const exhausted =
        maxInvocations != null && (state.barren >= maxInvocations || state.spawned >= maxInvocations * RUNAWAY_FACTOR);
      if (satisfied || exhausted) {
        if (state.inFlight === 0) {
          state.retired = true;
          log(
            satisfied
              ? `[${state.key}] done — ${qualifying}/${target} qualifying across ${fileCount} files`
              : `[${state.key}] giving up — ${qualifying}/${target} qualifying after ${state.spawned} invocation(s) this run, ${state.barren} of them banking nothing (${fileCount} file(s) on disk), at the ${maxInvocations}-barren-invocation cap`,
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
      candidates.push({ state, qualifying, target, fileCount, score, limit });
    }
    if (candidates.length === 0) return null;

    // Tail guard: with fewer startable units than there are faster lanes, the
    // slow ones stand down and let the fast ones finish.
    //
    // This is the worst case the whole lane-speed effort exists for. Measured
    // 2026-08-07: a host roughly 4x slower than the others took one of the
    // last chunks and held every other lane idle for over an hour. Chunk
    // sizing shrinks that chunk; this stops it being handed out at all.
    //
    // Conditional on something being in flight, or the run could hang: if no
    // other lane is working, refusing means nobody ever claims. Then the slow
    // lane takes it, which is correct — a slow lane beats an idle one.
    const rank = laneRankOf(runner.label);
    if (inFlightTotal > 0 && rank > 0 && chunkFor) {
      // Stand down only when the faster lanes can finish everything left
      // without this one — i.e. the remaining work fits in one of this lane's
      // chunks per faster lane. Anything more than that and helping still
      // pays, however slow this host is.
      //
      // Deliberately measured in WORK, not in concurrency headroom: a combo 40
      // attempts short with one invocation running is mid-run, not a tail, and
      // an earlier version that counted headroom stood lanes down constantly.
      //
      // Conditional on something being in flight, or the run could hang: if no
      // other lane is working, refusing means nobody claims at all. A slow lane
      // beats an idle one.
      const remainingTotal = candidates.reduce((sum, c) => sum + Math.max(0, c.target - c.qualifying - c.state.reserved), 0);
      const probe = candidates[0];
      const myChunk = Math.max(
        1,
        Math.round(
          chunkFor(probe.state.combo, {
            remaining: Math.max(0, probe.target - probe.qualifying - probe.state.reserved),
            laneLabel: runner.label,
            ratePerMin: (laneRates.get(runner.label) ?? 0) * 60000,
            qualifying: probe.qualifying,
            target: probe.target,
          }),
        ),
      );
      if (remainingTotal <= rank * myChunk) return null;
    }

    // Cost-ranked matching, applied only among the least-loaded combos so the
    // existing spread-across-combos property is preserved.
    //
    // Work units are not interchangeable: a Casual/hard run that dies on level
    // 2 is cheap, a Pro/normal run that completes all 15 levels is not. Pair
    // the most expensive available unit with the fastest lane and the cheapest
    // with the slowest, so a slow host is never the one grinding through the
    // costliest combo.
    //
    // Inert until there is something to rank: with equal `relCost` and no
    // measured rates this picks the same candidate the old scoring did.
    const minInFlight = Math.min(...candidates.map((c) => c.score[0]));
    const leastLoaded = candidates.filter((c) => c.score[0] === minInFlight);
    leastLoaded.sort((a, b) => b.state.relCost - a.state.relCost || a.score[1] - b.score[1]);
    const best = leastLoaded[Math.min(rank, leastLoaded.length - 1)];

    const { state, qualifying, target, fileCount } = best;
    const sequence = claimSequence(state, fileCount, outputPathFor);

    // Size this invocation for THIS lane.
    //
    // A fixed chunk makes every lane's invocation cost whatever that host
    // happens to take, so the run ends when the slowest lane finishes its last
    // full-size chunk while everything else sits idle. Measured spread across
    // the configured hosts is about 2x. Sizing by measured rate makes an
    // invocation cost roughly the same wall time everywhere, which is what
    // shortens the tail.
    //
    // `reserved` is the attempts already promised to in-flight invocations of
    // this combo. It has to be tracked rather than derived: the old caller-side
    // reservation multiplied `inFlightBefore` by a constant CHUNK, which is
    // simply wrong once chunks differ per lane, and the combo would overshoot
    // its target by the difference.
    const remaining = Math.max(0, target - qualifying - state.reserved);
    const ratePerMin = (laneRates.get(runner.label) ?? 0) * 60000;
    const chunkAttempts = chunkFor
      ? Math.max(1, Math.round(chunkFor(state.combo, { remaining, laneLabel: runner.label, ratePerMin, qualifying, target, laneCount: runners.length })))
      : null;
    const claimed = chunkAttempts == null ? 0 : Math.min(chunkAttempts, Math.max(1, remaining));

    state.spawned += 1;
    state.inFlight += 1;
    state.reserved += claimed;
    inFlightTotal += 1;
    return { state, sequence, qualifying, target, chunkAttempts: claimed || chunkAttempts, claimed };
  }

  const startedAt = Date.now();
  // Attempts per millisecond, per lane label. Seeded from the caller and
  // updated by EWMA as invocations land, so a long run keeps adapting rather
  // than trusting a stale file.
  const laneRates = new Map(Object.entries(initialLaneRates).map(([k, perMin]) => [k, perMin / 60000]));
  const RATE_ALPHA = 0.4;

  /**
   * This lane's position among all lanes, fastest first (0 = fastest).
   *
   * A lane with no measured rate ranks first on purpose: it needs a
   * calibration invocation, and holding it back would leave it unmeasured for
   * the whole run.
   */
  function laneRankOf(label) {
    const mine = laneRates.get(label);
    if (mine == null) return 0;
    let faster = 0;
    for (const [other, rate] of laneRates) {
      if (other !== label && rate > mine) faster += 1;
    }
    return faster;
  }

  // Set once any lane produces an output file — the evidence that separates
  // "this lane is broken" from "this work is broken". See the lane-health
  // block in `runLane`.
  let anyLaneProduced = false;
  const laneStats = runners.map((runner) => ({ label: runner.label, invocations: 0, busyMs: 0 }));

  /**
   * Time spent with exactly one invocation running while another lane is
   * parked wanting work — the failure the mean idle figure hides.
   *
   * Mean idle cannot distinguish "36% idle spread thinly across the run"
   * from "36% idle because the last cell ran single-threaded for half an
   * hour", and those need completely different fixes. It is also why this
   * went unnoticed for so long: the only symptom is a quiet machine, and
   * on 2026-08-09 the user spotted it before any instrument did.
   *
   * `parkedLanes` is the load-bearing part of the definition. One lane
   * working alone is perfectly fine when there is nothing else to do —
   * lanes only park when they asked for work and were refused, so this
   * counts *refused* capacity, not merely unused capacity.
   */
  let parkedLanes = 0;
  let soleWorkerSince = null;
  const soleWorker = { totalMs: 0, longestMs: 0, episodes: 0 };
  function noteOccupancy() {
    const stalled = inFlightTotal === 1 && parkedLanes > 0;
    if (stalled && soleWorkerSince === null) {
      soleWorkerSince = Date.now();
    } else if (!stalled && soleWorkerSince !== null) {
      const ms = Date.now() - soleWorkerSince;
      soleWorker.totalMs += ms;
      soleWorker.longestMs = Math.max(soleWorker.longestMs, ms);
      soleWorker.episodes += 1;
      soleWorkerSince = null;
    }
  }

  async function runLane(runner, stats) {
    const health = { consecutiveFailures: 0, charged: [] };
    for (;;) {
      const work = claim(runner);
      if (!work) {
        // Nothing claimable. If nothing is running either, no future claim can
        // ever succeed — every combo is satisfied, retired or capped — so the
        // whole run is over. Otherwise park until an invocation lands and
        // changes the picture. No `await` between `claim()` and `nextCompletion()`,
        // so a completion cannot slip past an unregistered waiter.
        if (inFlightTotal === 0) return;
        parkedLanes += 1;
        noteOccupancy();
        try {
          await nextCompletion();
        } finally {
          parkedLanes -= 1;
          noteOccupancy();
        }
        continue;
      }
      noteOccupancy();

      const { state, sequence, qualifying, target, chunkAttempts, claimed } = work;
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
      const env = envFor(state.combo, sequence, outputPath, eventLogPath, { inFlightBefore: state.inFlight - 1, chunkAttempts, reservedAttempts: state.reserved - claimed });
      const prefix = `[${state.key} #${sequence}] `;
      log(`[${state.key}] starting invocation #${sequence} (${qualifying}/${target} qualifying so far) via ${runner.label}`);

      let result;
      try {
        result = await runner.runInvocation({ scriptPath, env, logPath, prefix, watchdogMs, sigtermGraceMs, outputPath, eventLogPath });
      } finally {
        state.inFlight -= 1;
        state.reserved -= claimed;
        inFlightTotal -= 1;
        noteOccupancy();
        // New results on disk: every cached count is now stale. Invalidate
        // before waking anyone, so no lane decides against a pre-completion
        // view of the world.
        scanCache = new Map();
      }
      stats.invocations += 1;
      stats.busyMs += result?.elapsedMs ?? 0;

      // Did this invocation move the combo forward at all?
      //
      // This, not "did it write a file", is what the cap should count. A combo
      // banking attempts three at a time is progressing and must not be cut
      // off — sinatra lost 3 of every 30 runs that way on 2026-08-08, every
      // cell reporting SHORT while still delivering. A combo whose invocations
      // change nothing is the case the cap exists for, and it is detected here
      // regardless of whether the invocation crashed, wrote an empty file, or
      // wrote a file full of runs that do not count.
      scanCache = new Map();
      const after = scanExisting(state.combo).qualifying;
      if (after <= qualifying) state.barren += 1;
      else state.barren = 0;

      let produced = false;
      let delivered = null;
      if (result.killedForTimeout) {
        log(`[${state.key}] invocation #${sequence} KILLED by watchdog after ${formatElapsed(result.elapsedMs)} — retrying`);
      } else if (result.code !== 0) {
        log(
          `[${state.key}] invocation #${sequence} exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""} after ${formatElapsed(result.elapsedMs)}${result.spawnError ? ` — ${result.spawnError}` : ""} — retrying`,
        );
      } else {
        produced = fs.existsSync(outputPath);
        if (produced && measureYield) {
          // An invocation that writes its output file but banks nothing is a
          // failure wearing a success's clothes: it must not count toward the
          // lane's speed, and the lane deserves the same scrutiny as an
          // outright crash.
          try {
            delivered = measureYield(state.combo, sequence, outputPath, eventLogPath);
          } catch {
            delivered = null;
          }
          if (delivered === 0) produced = false;
        }
        const yieldNote = delivered == null ? "" : ` (${delivered} attempt(s) banked)`;
        log(`[${state.key}] invocation #${sequence} finished in ${formatElapsed(result.elapsedMs)}${yieldNote}${produced ? "" : " — banked nothing, treating as failed, retrying"}`);
      }

      // Lane health. A lane that fails everything must not eat the combos'
      // invocation budget.
      //
      // Measured 2026-08-07: an SSH host whose inotify watch limit was
      // exhausted could never start vite, so every invocation died after ~63s
      // — and `bootstrapHost` had reported it "ready". It burned **7 of one
      // combo's 8 invocations**, and that combo then gave up at 15 of 60 runs.
      // The result reads as a balance finding rather than a dead machine,
      // which is the dangerous part.
      //
      // The cap itself stays exactly as it was — it exists to bound a combo
      // the bot genuinely cannot clear, and a *crashing* invocation writes no
      // output, which is precisely why it counts spawns rather than files.
      // The discriminator is **whether any other lane has produced anything**:
      // if some lane works and this one has failed repeatedly, the fault is
      // the lane, so retire it and hand its spent budget back. If nothing
      // anywhere has ever succeeded, the fault may well be the build or the
      // content, every lane keeps its failures, and the cap ends the run as
      // before.
      if (produced) {
        anyLaneProduced = true;
        // Rate is attempts asked for over wall time taken. Only successful
        // invocations count: a crash is fast and would read as blazing speed.
        // Rate from what was DELIVERED where that is known, not from what was
        // requested.
        const counted = delivered ?? chunkAttempts;
        if (counted && result.elapsedMs > 0) {
          const observed = counted / result.elapsedMs;
          const prev = laneRates.get(runner.label);
          // How expensive this combo is per attempt, relative to what this
          // lane manages on average. Computed against the rate as it stood
          // BEFORE this observation, or the two would partly cancel and every
          // combo would drift toward 1. Dimensionless, so lane speed never
          // leaks into a combo property.
          if (prev != null && prev > 0) {
            const relative = prev / observed;
            state.relCost = state.relCost * (1 - RATE_ALPHA) + relative * RATE_ALPHA;
            try {
              onComboCost?.(state.key, Number(state.relCost.toFixed(3)));
            } catch (err) {
              log(`[${state.key}] could not record measured cost: ${err.message}`);
            }
          }
          const next = prev == null ? observed : prev * (1 - RATE_ALPHA) + observed * RATE_ALPHA;
          laneRates.set(runner.label, next);
          // Report immediately rather than at the end of the run. Never let a
          // caller's persistence problem kill a capture that is otherwise fine.
          try {
            onLaneRate?.(runner.label, Number((next * 60000).toFixed(2)));
          } catch (err) {
            log(`[lane ${runner.label}] could not record measured speed: ${err.message}`);
          }
        }
        health.consecutiveFailures = 0;
        health.charged = [];
      } else {
        health.consecutiveFailures += 1;
        health.charged.push(state);
        if (anyLaneProduced && health.consecutiveFailures >= laneFailureLimit) {
          for (const charged of health.charged) charged.spawned = Math.max(0, charged.spawned - 1);
          log(
            `[lane ${runner.label}] DROPPED after ${health.consecutiveFailures} consecutive failures with no output, while other lanes are producing — ` +
              `refunding ${health.charged.length} invocation(s) to their combos. This lane is broken, not the work.`,
          );
          health.charged = [];
          wakeAll();
          return;
        }
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
  const lanes = laneStats.map((s) => ({
    ...s,
    idleMs: Math.max(0, wallMs - s.busyMs),
    // Attempts per minute, so the next run can seed `initialLaneRates` with
    // what this one learned instead of paying to rediscover it.
    attemptsPerMin: laneRates.has(s.label) ? Number((laneRates.get(s.label) * 60000).toFixed(2)) : null,
  }));
  const idleMs = lanes.reduce((sum, l) => sum + l.idleMs, 0);
  const totalMs = wallMs * Math.max(1, lanes.length);
  // `comboCost` is reported for diagnosis — it explains why a lane was given
  // what it was given, which is otherwise invisible.
  const comboCost = Object.fromEntries(states.map((st) => [st.key, Number(st.relCost.toFixed(2))]));
  // Close an episode still open at the end — a run whose final cell went
  // single-threaded right through to the finish is the common case, and
  // dropping it would hide precisely the worst instance.
  parkedLanes = 0;
  noteOccupancy();
  return {
    wallMs,
    lanes,
    idleMs,
    laneTimeMs: totalMs,
    idleFraction: totalMs > 0 ? idleMs / totalMs : 0,
    comboCost,
    soleWorker,
  };
}

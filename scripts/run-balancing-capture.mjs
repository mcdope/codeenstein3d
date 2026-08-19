// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Fixed-denominator, lane-parallel, event-log-first balance capture.
 *
 * **Why this exists alongside `balancing:campaign`.** That orchestrator runs
 * each combo until N runs *qualify*, which is the wrong knob for any rate:
 * it stops early on easy combos and never terminates on impossible ones, so
 * the denominator is whatever the bot happened to need. A death rate needs a
 * denominator you chose in advance. `doc/dev/balancing-telemetry.md` has said
 * so for a while, and its advice was to drive `run-balancing-telemetry.mjs`
 * directly per combo — which works, and costs you every lane host you own.
 * The 2026-08-04 capture took **14.5 hours on one machine** for exactly that
 * reason. This script is that advice plus the lane orchestrator.
 *
 * Three things it does that the campaign orchestrator does not:
 *
 * - **Counts attempts, not qualifying runs.** Progress is distinct `rid`s in
 *   the event logs — the only count that reflects attempts which actually
 *   produced data. Deliberately not the telemetry script's own `attemptsUsed`,
 *   which counts attempts *started*: it read 60 on a 2026-08-04 cell where a
 *   dying browser produced 38.
 * - **Collects event logs, including from remote lanes.** The campaign never
 *   set `CODEENSTEIN_TELEMETRY_EVENT_LOG` at all, and `SshRunner` used to
 *   fetch only the aggregate JSON — so every per-event metric (death rate by
 *   level, damage attribution, hit rate by range, loot economy) was
 *   unavailable from a lane. One event-log directory per invocation, because
 *   `writeEventBatches` names its file from profile+difficulty alone and two
 *   invocations of one combo would otherwise collide on the way back.
 * - **Chunks each cell across invocations.** One browser does not survive a
 *   60-attempt invocation (2026-08-04: it died at ~38 and the remaining 22
 *   failed instantly on `browser.newContext()`), so the per-invocation cap is
 *   the chunk size and the orchestrator's own retry loop supplies the rest.
 *
 * Pooling across lanes is safe: `rid` is `${pid}-${random}-${counter}`, unique
 * per invocation, so NDJSONs from different hosts concatenate without
 * collision. It is only *sound* if every lane ran the same commit —
 * `bootstrapHost` force-checks-out the local HEAD sha, and this script
 * asserts the tree is clean before starting rather than trusting that.
 *
 * ```sh
 * npm run balancing:capture
 * CODEENSTEIN_CAPTURE_ATTEMPTS=60 CODEENSTEIN_CAPTURE_DIFFICULTIES=hard npm run balancing:capture
 * ```
 *
 * Output: `balancing_capture/` (gitignored), with `events/<combo>-<seq>/`
 * holding the NDJSON each invocation produced. Resumable: re-running counts
 * what is already banked and only asks for the shortfall.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { createBankedRunScanner } from "./lib/bankedRuns.mjs";
import {
  concurrencyByRemaining,
  defaultFormatElapsed as formatElapsed,
  LocalRunner,
  runLaneOrchestrator,
} from "./lib/laneOrchestrator.mjs";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { buildSshRunners, readHostList } from "./lib/sshRunner.mjs";
import { envNumber } from "./lib/envNumber.mjs";

const execFileAsync = promisify(execFile);

const OUT_DIR = path.join(REPO_ROOT, process.env.CODEENSTEIN_CAPTURE_OUT ?? "balancing_capture");
/**
 * Paired gameplay seeds across arms — **on by default**, and the default value
 * is deliberately constant rather than random.
 *
 * Two arms of an A/B are only comparable if they played the same maps and loot
 * rolls. Unpinned, they do not: the 2026-08-19 step-granularity capture's two
 * *identical-code* control arms differed by **21-24pp** on per-level clear
 * rate, a noise floor twice the effect the experiment was sized to detect,
 * produced entirely by independently random rolls of a fixed campaign.
 *
 * Every invocation is handed `SEED_BASE + <attempts already accounted for this
 * combo>`, so an arm covers a contiguous range per combo even though its chunk
 * boundaries differ from the other arm's. Both arms therefore draw the same
 * *set* of seeds, which is what removes the variance; exact per-attempt
 * pairing is not needed and is not achievable when lanes differ in speed.
 *
 * Set `CODEENSTEIN_CAPTURE_SEED_BASE=random` for an unpinned capture (the old
 * behaviour) — appropriate when measuring the *spread itself* rather than
 * comparing arms.
 */
const SEED_BASE_RAW = process.env.CODEENSTEIN_CAPTURE_SEED_BASE ?? "1000000";
const SEED_BASE = SEED_BASE_RAW === "random" ? null : Number(SEED_BASE_RAW);
if (SEED_BASE !== null && !Number.isInteger(SEED_BASE)) {
  console.error(`CODEENSTEIN_CAPTURE_SEED_BASE must be an integer or "random", got ${SEED_BASE_RAW}`);
  process.exit(1);
}
/**
 * Skip the renderer work no capture ever looks at — **on by default**.
 *
 * `advance()` is unconditionally `simulate(dt)` + `render()`, so every bot
 * decision pays a full raycast frame into a canvas nobody reads, ~30k times per
 * attempt. Ablating the draw-pass groups that do not feed gameplay measured
 * **11.5% faster end to end** (196.7s -> 174.0s over three interleaved
 * seed-pinned reps) and **byte-identical telemetry** — 81,080 bytes over 8
 * levels x 12 attempts. See `doc/dev/balancing-telemetry.md`.
 *
 * **`sprites`, `walls` and `shade` are deliberately absent and must stay so**:
 * the `sprites` branch is what sets `this.target` from
 * `findTargetUnderCrosshair` (its `else` sets `this.target = null`), and
 * `walls` fills the z-buffer targeting reads — ablating either stops the bot
 * being able to shoot at all.
 *
 * Set `CODEENSTEIN_CAPTURE_ABLATE=` (empty) to render normally, e.g. when
 * capturing screenshots or diagnosing something visual.
 */
const ABLATE = process.env.CODEENSTEIN_CAPTURE_ABLATE ?? "floor,effects,viewmodel,hud";
const EVENTS_DIR = path.join(OUT_DIR, "events");
const LOGS_DIR = path.join(OUT_DIR, "logs");
const TELEMETRY_SCRIPT = path.join(REPO_ROOT, "scripts", "run-balancing-telemetry.mjs");

const PROFILES = (process.env.CODEENSTEIN_CAPTURE_PROFILES ?? "Casual,Gamer,Pro").split(",").map((s) => s.trim()).filter(Boolean);
const DIFFICULTIES = (process.env.CODEENSTEIN_CAPTURE_DIFFICULTIES ?? "normal,hard").split(",").map((s) => s.trim()).filter(Boolean);
/** The denominator. Every rate this capture produces is out of this. */
const TARGET_ATTEMPTS = envNumber("CODEENSTEIN_CAPTURE_ATTEMPTS", 60, { integer: true, min: 1 });
/** Attempts per invocation — one fresh browser each. 20 is comfortably inside
 * the ~38 where a browser was observed to die, and at the measured ~0.4
 * attempts/min is roughly a 50-minute invocation. */
const CHUNK = envNumber("CODEENSTEIN_CAPTURE_CHUNK", 20, { integer: true, min: 1 });
const CONCURRENCY_PER_LANE = envNumber("CODEENSTEIN_CAPTURE_CONCURRENCY", 10, { integer: true, min: 1 });
/** Sized against a chunk's real cost with headroom, not guessed: 20 attempts
 * at the measured rate is ~50 min, and the 2026-08-04 run showed a watchdog
 * cutting a *working* invocation is far more expensive than one that runs
 * long, because the whole chunk is lost. */
const WATCHDOG_MS = envNumber("CODEENSTEIN_CAPTURE_WATCHDOG_MS", 130 * 60 * 1000, { integer: true, min: 1 });
// Unset = full campaign, which is what a capture is normally for. See `envFor`.
const LEVEL_LIMIT = envNumber("CODEENSTEIN_CAPTURE_LEVEL_LIMIT", null, { integer: true, min: 1 });
/** Per-combo spawn ceiling. A cell needing more invocations than this to reach
 * its target is failing in a way more attempts will not fix. */
const MAX_INVOCATIONS = envNumber("CODEENSTEIN_CAPTURE_MAX_INVOCATIONS", 8, { integer: true, min: 1 });
/**
 * The cap, adjusted for how many invocations the work actually needs.
 *
 * Per-lane chunk sizing means a slow lane is deliberately asked for a *small*
 * chunk, which takes more invocations to reach the same target — so a fixed
 * ceiling that was generous under one-size-fits-all chunks can now bite before
 * the target is met. Measured: a cell asking for 30 attempts in chunks of 3
 * stopped at 24/30 having spent all 8, and reported SHORT. A cell that is short
 * because of an accounting ceiling looks exactly like a cell that is short
 * because the bot could not clear it, which is the one confusion this whole
 * capture exists to avoid.
 *
 * The floor stays whatever the operator asked for; this only raises it to what
 * the smallest legitimate chunk implies, plus slack for retries.
 */
function invocationCapFor(target) {
  // The smallest chunk actually issuable is the floor bounded by the ceiling:
  // `chunkFor` clamps to CHUNK from above and MIN_CHUNK from below, so when
  // CHUNK < MIN_CHUNK the real minimum is CHUNK. Using MIN_CHUNK alone left a
  // cell short at 27/30 for exactly that reason.
  const smallestChunk = Math.max(1, Math.min(MIN_CHUNK, CHUNK));
  return Math.max(MAX_INVOCATIONS, Math.ceil(target / smallestChunk) + 3);
}
/** How long one invocation should take, whichever lane runs it. Chunk size is
 * derived from this and the lane's measured rate, so a slow host gets fewer
 * attempts rather than holding a full-size chunk while every other lane idles.
 * 45 min keeps a comfortable margin under the 130-minute watchdog even if a
 * lane turns out slower than its stored rate. */
const TARGET_CHUNK_MIN = envNumber("CODEENSTEIN_CAPTURE_TARGET_CHUNK_MIN", 45, { integer: true, min: 1 });
/** Never below this: a chunk pays a fixed browser+vite startup cost, so tiny
 * chunks spend most of their time on overhead. */
const MIN_CHUNK = envNumber("CODEENSTEIN_CAPTURE_MIN_CHUNK", 5, { integer: true, min: 1 });
/** Fraction of the watchdog a chunk may be sized to fill. Well under 1 because
 * a lane's recorded rate is an average, and the chunk that overruns is by
 * definition a slower-than-average one. */
const WATCHDOG_CHUNK_MARGIN = 0.7;
/** Learned lane speeds, carried between runs. Gitignored scratch — losing it
 * only costs one round of recalibration. */
const RATES_FILE = path.join(REPO_ROOT, "lane-speed.json");

/**
 * Identity of the campaign currently staged in `demo-campaign/`.
 *
 * Per-combo cost is a property of the *levels*, not of the machine or the
 * repository name — a repo re-staged with different slots is a different
 * campaign and its old costs are wrong. Hashing the staged filenames and sizes
 * is what actually identifies it, and it fails safe: change the staging and the
 * key changes, so the costs are simply relearned rather than silently misapplied.
 */
function campaignKey() {
  const dir = path.join(REPO_ROOT, "demo-campaign");
  const entries = fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`);
  return createHash("sha1").update(entries.join("\n")).digest("hex").slice(0, 12);
}

/**
 * `{ lanes: {label: attemptsPerMin}, campaigns: {key: {combo: relCost}} }`.
 *
 * Accepts the older flat shape (lane rates at the top level) so an existing
 * file is not thrown away on upgrade.
 */
function loadRatesFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(RATES_FILE, "utf8"));
    if (raw && typeof raw === "object" && (raw.lanes || raw.campaigns)) {
      return { lanes: raw.lanes ?? {}, campaigns: raw.campaigns ?? {} };
    }
    return { lanes: raw ?? {}, campaigns: {} };
  } catch {
    // Missing or corrupt both mean the same thing: measure it again. A
    // half-written file must never be able to stop a capture starting.
    return { lanes: {}, campaigns: {} };
  }
}

/**
 * Lane rates for THIS campaign.
 *
 * Rates are attempts per minute, and an attempt's cost depends entirely on the
 * levels being played — so a rate learned on one campaign is meaningless on
 * another. Measured the hard way on 2026-08-07: rates learned from a smoke run
 * capped at 2 levels were carried into a full ripgrep capture, every lane was
 * handed a full 20-attempt chunk on the strength of them, and the "45 minute"
 * invocation was still running after three hours.
 *
 * Keyed like the combo costs, and for the same reason. A machine's *ratio* to
 * its peers is stable across campaigns, but the absolute number that chunk
 * sizing needs is not.
 */
function loadLaneRates(key) {
  return loadRatesFile().campaigns[key]?.lanes ?? {};
}

function loadComboCost(key) {
  return loadRatesFile().campaigns[key]?.combos ?? {};
}

function writeRatesFile(next) {
  const tmp = `${RATES_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, RATES_FILE);
}

/**
 * Record one lane's measured speed, immediately.
 *
 * Written after every invocation rather than at the end of the run, because a
 * capture that is interrupted — killed, watchdogged, cancelled mid-sweep —
 * would otherwise discard everything it had learned and make the next run pay
 * the calibration round again.
 *
 * Write-then-rename so a kill mid-write cannot leave a truncated file behind:
 * `rename` is atomic within a filesystem, so a reader sees either the old
 * contents or the new ones.
 */
function recordLaneRate(label, attemptsPerMin) {
  const file = loadRatesFile();
  const entry = file.campaigns[CAMPAIGN_KEY] ?? {};
  entry.lanes = { ...(entry.lanes ?? {}), [label]: attemptsPerMin };
  file.campaigns[CAMPAIGN_KEY] = entry;
  // Kept for a human reading the file — never used for sizing.
  file.lanes[label] = attemptsPerMin;
  writeRatesFile(file);
}

/** Per-campaign, for the reason `campaignKey` gives. */
function recordComboCost(key, combo, relCost) {
  const file = loadRatesFile();
  const entry = file.campaigns[key] ?? {};
  entry.combos = { ...(entry.combos ?? {}), [combo]: relCost };
  file.campaigns[key] = entry;
  writeRatesFile(file);
}

/**
 * Attempts to ask this lane for.
 *
 * Without a measured rate, fall back to the fixed CHUNK — the first invocation
 * on an unknown host is the calibration run, and guessing low would make a fast
 * host look slow for the rest of the capture.
 */
function chunkFor(_combo, { remaining, ratePerMin, laneCount = 1 }) {
  // Never take more of what is left than an even share across the lanes.
  //
  // The tail is where idle time actually accrues: with long chunks, whoever
  // grabs the last one runs alone while every other lane sits finished. On the
  // ripgrep capture that was 442 idle lane-minutes of 2,064 (21%), and the two
  // least-busy lanes were at 61% and 69%. Splitting the remainder lets them
  // finish together instead.
  const evenShare = Math.max(1, Math.ceil(remaining / Math.max(1, laneCount)));
  // Unknown lane on this campaign: ask for a CALIBRATION chunk, not a full one.
  //
  // The old fallback was the full CHUNK, on the reasoning that guessing low
  // would make a fast host look slow. That is backwards when the campaign's
  // cost is also unknown: on ripgrep a full 20-attempt chunk was still running
  // after three hours, so nothing was learned and nothing could be resized
  // until it finished. A small first chunk costs a little throughput once and
  // buys a real measurement within minutes.
  if (!ratePerMin || ratePerMin <= 0) return Math.min(MIN_CHUNK, CHUNK, evenShare, Math.max(1, remaining));
  const sized = Math.round(ratePerMin * TARGET_CHUNK_MIN);
  // `MIN_CHUNK` is a floor against startup overhead, not a promise the lane can
  // deliver it — and the two knobs never used to check each other. A lane
  // slower than `MIN_CHUNK / watchdogMinutes` cannot finish its smallest legal
  // chunk before the watchdog fires, and because a *killed* invocation records
  // no rate, its stale rate is never revised: it asks for the same chunk and
  // times out again, forever. Measured 2026-08-19: two lanes burned 130 minutes
  // each, three times, and banked nothing.
  //
  // So cap the chunk at what actually fits, with a margin — a lane's rate is an
  // average and a slow chunk is exactly when it matters. `laneFitsWatchdog`
  // handles the case where even one attempt will not fit.
  const fitsInWatchdog = Math.floor(ratePerMin * watchdogMinutes() * WATCHDOG_CHUNK_MARGIN);
  return Math.min(Math.max(MIN_CHUNK, sized), CHUNK, evenShare, Math.max(1, remaining), Math.max(1, fitsInWatchdog));
}

/** The watchdog in minutes — the same budget `runInvocation` enforces. */
function watchdogMinutes() {
  return WATCHDOG_MS / 60_000;
}

/**
 * Can this lane finish even a single attempt inside the watchdog?
 *
 * A lane that cannot is not slow, it is broken for this campaign: every
 * invocation it takes is 130 minutes of nothing, and it never learns better
 * because rates come only from invocations that *finish*. Excluding it loudly
 * is strictly better than discovering it in the log hours later.
 */
export function laneFitsWatchdog(ratePerMin, watchdogMin = watchdogMinutes(), margin = WATCHDOG_CHUNK_MARGIN) {
  if (!ratePerMin || ratePerMin <= 0) return true; // unmeasured: let calibration decide
  return ratePerMin * watchdogMin * margin >= 1;
}
const SIGTERM_GRACE_MS = 5000;
/** Computed once at startup: the staged campaign never changes mid-capture —
 * the clean-tree guard and the plan/engine gate both depend on that. */
const CAMPAIGN_KEY = campaignKey();

const comboKey = (combo) => `${combo.profile}-${combo.difficulty}`;
const eventsDirFor = (combo, sequence) => path.join(EVENTS_DIR, `${comboKey(combo)}-${String(sequence).padStart(3, "0")}`);
const outputPathFor = (combo, sequence) => path.join(OUT_DIR, `${comboKey(combo)}-${String(sequence).padStart(3, "0")}.json`);
const logPathFor = (combo, sequence) => path.join(LOGS_DIR, `${comboKey(combo)}-${String(sequence).padStart(3, "0")}.log`);

/**
 * Distinct `rid`s banked for one combo, across every invocation directory.
 *
 * This number is the denominator of every rate the capture exists to produce,
 * and the scheduler reads it for *every* combo each time a lane frees up. The
 * counting itself lives in `bankedRuns.mjs`, which caches per invocation
 * directory — a finished invocation's log never changes again, so only the
 * directories still being written are re-parsed. See that module for why the
 * cache cannot go stale.
 */
const scanBanked = createBankedRunScanner(EVENTS_DIR);
function scanExisting(combo) {
  return scanBanked(`${comboKey(combo)}-`);
}

function envFor(combo, sequence, outputPath, eventLogPath, { inFlightBefore = 0, chunkAttempts = null, reservedAttempts = inFlightBefore * CHUNK } = {}) {
  // Called immediately before each invocation, which makes it the one place
  // that reliably runs on *every* attempt including retries — and a retry can
  // land on this same directory, because the orchestrator's sequence number
  // skips whatever is already on disk and a watchdog-killed invocation
  // produces nothing. `writeEventBatches` appends, so a stale partial log here would be
  // pooled with the retry's runs and inflate the denominator with truncated
  // data. `SshRunner` does the same on the remote side, where the writing
  // actually happens for a remote lane.
  fs.rmSync(eventLogPath, { recursive: true, force: true });
  fs.mkdirSync(eventLogPath, { recursive: true });

  // Ask for the shortfall, not a full chunk. A chunk rarely yields exactly
  // CHUNK runs — an attempt whose browser dies produces no `rid` at all — so
  // the loop comes back for more, and a fixed CHUNK on that final pass
  // overshoots: a cell at 5 of 6 ran three more attempts and finished at 8.
  // Harmless to the data (those are complete runs, unlike the retry-append
  // case) but not free: at CHUNK=20 the worst case is 19 wasted attempts,
  // about 50 minutes on a real cell. Clamping also makes the denominator
  // land exactly on target instead of "at least".
  //
  // With chunk stealing, other lanes may already be working this same combo.
  // Their attempts are not on disk yet, so `qualifying` does not see them —
  // subtract what they were already asked to produce, or every extra lane
  // re-runs the same shortfall and the overshoot scales with lane count.
  //
  // `reservedAttempts` comes from the orchestrator and is the real sum of what
  // in-flight invocations were asked for. This used to be `inFlightBefore *
  // CHUNK`, which is only correct while every lane gets an identical chunk —
  // and lanes no longer do, because chunk size is now proportional to each
  // lane's measured speed.
  const remaining = Math.max(1, TARGET_ATTEMPTS - scanExisting(combo).qualifying - reservedAttempts);
  const cap = Math.min(chunkAttempts ?? CHUNK, remaining);

  const env = {
    ...process.env,
    CODEENSTEIN_TELEMETRY_PROFILE: combo.profile,
    CODEENSTEIN_TELEMETRY_DIFFICULTY: combo.difficulty,
    // The cap is what this invocation should contribute, not a safety net:
    // this script wants a known number of attempts, not "however many it took
    // to qualify".
    CODEENSTEIN_TELEMETRY_ATTEMPT_CAP: String(cap),
    // Never stop early. Qualification is a campaign concept and would
    // truncate a chunk the moment enough runs cleared level 4.
    CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET: "999",
    CODEENSTEIN_TELEMETRY_CONCURRENCY: String(CONCURRENCY_PER_LANE),
    CODEENSTEIN_TELEMETRY_ANOMALY_SCAN: "1",
    CODEENSTEIN_TELEMETRY_EVENT_LOG: eventLogPath,
    CODEENSTEIN_TELEMETRY_OUTPUT_FILE: outputPath,
  };
  if (SEED_BASE !== null) {
    env.CODEENSTEIN_TELEMETRY_SEED_BASE = String(SEED_BASE);
    // Offset by what this combo has already accounted for, so concurrent and
    // successive chunks do not all replay the same seeds. A retried chunk
    // deliberately reuses its range — repeating a seed is the correct response
    // to losing its result.
    env.CODEENSTEIN_TELEMETRY_SEED_START = String(scanExisting(combo).qualifying + reservedAttempts);
  }
  if (ABLATE) env.CODEENSTEIN_TELEMETRY_EXTRA_QUERY = `&ablate=${ABLATE}`;
  // Full campaign by default: a capture exists to measure a whole progression,
  // and a stray `CODEENSTEIN_TELEMETRY_LEVEL_LIMIT` in the caller's shell would
  // otherwise silently truncate every cell and produce a denominator that looks
  // fine and means nothing.
  //
  // `CODEENSTEIN_CAPTURE_LEVEL_LIMIT` is the deliberate opt-in, for a targeted
  // A/B on one encounter rather than a campaign measurement. It exists because
  // the standoff arm only asks about wolf3d slot 8: the baseline never got past
  // level 8 anyway, so capping the treatment at 9 keeps the two arms comparable
  // *and* stops a successful run wandering through the remaining six levels at
  // several minutes each.
  //
  // Recorded in the output so an analysis cannot mistake a bounded capture for
  // a full one — the whole point of the default.
  delete env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT;
  if (LEVEL_LIMIT) env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT = String(LEVEL_LIMIT);
  return env;
}

/** Lanes may run on different machines, so they must run the same code.
 * `bootstrapHost` checks out this repo's HEAD sha remotely — which is only
 * meaningful if HEAD actually describes the working tree. */
async function assertCleanTree() {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: REPO_ROOT });
  if (stdout.trim().length === 0) return;
  console.error(
    "Refusing to start: the working tree is dirty.\n" +
      "Remote lanes check out HEAD, so uncommitted changes would run locally and not remotely —\n" +
      "the pooled event logs would silently mix two different builds. Commit or stash first.\n\n" +
      stdout,
  );
  process.exit(1);
}

async function main() {
  await assertCleanTree();
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const combos = PROFILES.flatMap((profile) => DIFFICULTIES.map((difficulty) => ({ profile, difficulty })));
  const sshRunners = await buildSshRunners();
  const configuredHosts = readHostList().length;

  // Losing every lane turns a 5-hour sweep back into a 14-hour one, and the
  // only evidence of it is one word on the `Lanes:` line. Refuse rather than
  // let that happen unnoticed — a capture is a long, unattended commitment
  // and this is the last cheap moment to notice.
  if (configuredHosts > 0 && sshRunners.length === 0 && process.env.CODEENSTEIN_CAPTURE_LOCAL_ONLY !== "1") {
    console.error(
      `\nRefusing to start: ${configuredHosts} lane host(s) are configured but none is usable (see the [ssh] lines above).\n` +
        `Running on the local lane alone would take roughly ${configuredHosts + 1}x as long as you are expecting.\n` +
        `Fix the hosts, or set CODEENSTEIN_CAPTURE_LOCAL_ONLY=1 to accept local-only deliberately.`,
    );
    process.exit(1);
  }

  let runners = [new LocalRunner({ cwd: REPO_ROOT }), ...sshRunners];

  // Drop lanes that cannot finish a single attempt inside the watchdog on this
  // campaign. Such a lane does not merely run slowly — it times out, banks
  // nothing, records no rate (rates come only from invocations that finish),
  // and therefore asks for the same impossible chunk on every retry. Measured
  // 2026-08-19: two lanes did this three times over, 130 minutes each.
  //
  // Only ever excludes a lane with a *stored* rate for this exact campaign; an
  // unmeasured lane still gets its calibration chunk and its chance.
  {
    const storedRates = loadLaneRates(CAMPAIGN_KEY);
    const unfit = runners.filter((r) => !laneFitsWatchdog(storedRates[r.label]));
    if (unfit.length > 0) {
      for (const r of unfit) {
        const rate = storedRates[r.label];
        console.log(
          `Excluding lane ${r.label}: ${rate}/min cannot finish one attempt within the ` +
            `${Math.round(watchdogMinutes())}m watchdog on this campaign (needs >= ${(1 / (watchdogMinutes() * WATCHDOG_CHUNK_MARGIN)).toFixed(3)}/min).`,
        );
      }
      runners = runners.filter((r) => !unfit.includes(r));
    }
    if (runners.length === 0) {
      console.error("No lane can finish an attempt within the watchdog — raise CODEENSTEIN_CAPTURE_WATCHDOG_MS or use a cheaper campaign.");
      process.exit(1);
    }
  }

  const banked = combos.reduce((sum, combo) => sum + scanExisting(combo).qualifying, 0);
  const wanted = combos.length * TARGET_ATTEMPTS;
  console.log(`Capture: ${combos.length} combos x ${TARGET_ATTEMPTS} attempts = ${wanted} (${banked} already banked)`);
  console.log(`Lanes: ${runners.map((r) => r.label).join(", ")}`);
  console.log(`Chunk ${CHUNK}/invocation, concurrency ${CONCURRENCY_PER_LANE}, watchdog ${Math.round(WATCHDOG_MS / 60000)}m`);
  // Loud, because a bounded capture that is later read as a full one is the
  // exact mistake this flag makes possible.
  if (LEVEL_LIMIT) console.log(`LEVEL LIMIT ${LEVEL_LIMIT} — bounded capture, NOT a full campaign`);
  console.log(`Output: ${OUT_DIR}\n`);

  const utilisation = await runLaneOrchestrator({
    combos,
    comboKey,
    scanExisting,
    targetQualifying: TARGET_ATTEMPTS,
    outputPathFor,
    logPathFor,
    eventLogPathFor: eventsDirFor,
    envFor,
    scriptPath: TELEMETRY_SCRIPT,
    runners,
    watchdogMs: WATCHDOG_MS,
    maxInvocations: MAX_INVOCATIONS > 0 ? invocationCapFor(TARGET_ATTEMPTS) : null,
    sigtermGraceMs: SIGTERM_GRACE_MS,
    // Let a free lane steal a chunk of a combo another lane is already
    // working, but never start more chunks than there is work left. This used
    // to divide by CHUNK, which silently pinned the end of every cell to a
    // single lane — see `concurrencyByRemaining` for the measurements.
    maxConcurrentPerCombo: (_combo, { qualifying, target }) =>
      concurrencyByRemaining(target - qualifying, { laneCount: runners.length }),
    chunkFor,
    initialLaneRates: loadLaneRates(CAMPAIGN_KEY),
    onLaneRate: recordLaneRate,
    initialComboCost: loadComboCost(CAMPAIGN_KEY),
    onComboCost: (combo, relCost) => recordComboCost(CAMPAIGN_KEY, combo, relCost),
    // What this invocation actually banked — its own event directory, so it is
    // unaffected by whatever other lanes are doing to the same combo.
    measureYield: (_combo, _sequence, _outputPath, eventLogPath) => {
      if (!eventLogPath || !fs.existsSync(eventLogPath)) return 0;
      const rids = new Set();
      for (const file of fs.readdirSync(eventLogPath)) {
        if (!file.endsWith(".ndjson")) continue;
        let text;
        try {
          text = fs.readFileSync(path.join(eventLogPath, file), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const rid = JSON.parse(line).rid;
            if (rid) rids.add(rid);
          } catch {
            // truncated final line — same tolerance as `scanExisting`
          }
        }
      }
      return rids.size;
    },
  });

  console.log("\n=== Capture complete ===");
  let short = false;
  for (const combo of combos) {
    const { qualifying } = scanExisting(combo);
    const flag = qualifying >= TARGET_ATTEMPTS ? "" : "  <-- SHORT";
    if (qualifying < TARGET_ATTEMPTS) short = true;
    console.log(`  ${comboKey(combo).padEnd(16)} ${qualifying}/${TARGET_ATTEMPTS}${flag}`);
  }
  // Idle lane-time used to be invisible, which is how half a capture's
  // capacity went unused for several runs without anyone noticing — the only
  // symptom is a quiet machine. Printed after the cell table so the numbers
  // the capture exists to produce stay first.
  const pct = (ms) => `${Math.round((100 * ms) / Math.max(1, utilisation.wallMs))}%`;
  console.log(
    `\nLanes over ${formatElapsed(utilisation.wallMs)}: ` +
      utilisation.lanes.map((l) => `${l.label} ${pct(l.busyMs)} busy (${l.invocations} inv)`).join(", "),
  );
  console.log(`  idle lane-time: ${formatElapsed(utilisation.idleMs)} of ${formatElapsed(utilisation.laneTimeMs)} (${Math.round(100 * utilisation.idleFraction)}%)`);
  // The shape the percentage above cannot show. 36% idle spread thinly across
  // a run and 36% idle because one cell ran single-threaded for half an hour
  // are different problems with different fixes, and only the second is worth
  // acting on. Printed whenever it happened at all, flagged when it is the
  // dominant story.
  if (utilisation.soleWorker?.episodes > 0) {
    const { totalMs, longestMs, episodes } = utilisation.soleWorker;
    console.log(
      `  one lane working while others waited: ${formatElapsed(totalMs)} across ${episodes} spell(s), longest ${formatElapsed(longestMs)}`,
    );
    if (longestMs > 10 * 60 * 1000) {
      console.log("    ^ over 10 minutes in a single spell — capacity was refused, not merely unused. See `concurrencyByRemaining`.");
    }
  }
  const rates = utilisation.lanes.filter((l) => l.attemptsPerMin != null);
  if (rates.length > 0) {
    // Already persisted per invocation by `recordLaneRate`; this only reports.
    console.log(`  measured speed: ${rates.map((l) => `${l.label} ${l.attemptsPerMin}/min`).join(", ")}`);
  }
  if (utilisation.comboCost) {
    // Relative per-attempt cost, so a surprising assignment can be explained
    // after the fact instead of looking arbitrary.
    console.log(`  relative combo cost: ${Object.entries(utilisation.comboCost).map(([k, v]) => `${k} ${v}x`).join(", ")}`);
  }

  console.log(`\nVerify before using: npm run verify:event-log -- ${path.relative(REPO_ROOT, EVENTS_DIR)}`);
  // A short cell is not a crash, but pooling it with full ones as though the
  // denominators matched is exactly the error this script exists to prevent.
  if (short) console.log("At least one cell is short of target — state its real denominator rather than pooling it as if it were full.");
}

main().catch((err) => {
  console.error("run-balancing-capture failed:", err.message);
  process.exit(1);
});

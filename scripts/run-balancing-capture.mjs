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

import { defaultFormatElapsed as formatElapsed, LocalRunner, runLaneOrchestrator } from "./lib/laneOrchestrator.mjs";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { buildSshRunners, readHostList } from "./lib/sshRunner.mjs";

const execFileAsync = promisify(execFile);

const OUT_DIR = path.join(REPO_ROOT, process.env.CODEENSTEIN_CAPTURE_OUT ?? "balancing_capture");
const EVENTS_DIR = path.join(OUT_DIR, "events");
const LOGS_DIR = path.join(OUT_DIR, "logs");
const TELEMETRY_SCRIPT = path.join(REPO_ROOT, "scripts", "run-balancing-telemetry.mjs");

const PROFILES = (process.env.CODEENSTEIN_CAPTURE_PROFILES ?? "Casual,Gamer,Pro").split(",").map((s) => s.trim()).filter(Boolean);
const DIFFICULTIES = (process.env.CODEENSTEIN_CAPTURE_DIFFICULTIES ?? "normal,hard").split(",").map((s) => s.trim()).filter(Boolean);
/** The denominator. Every rate this capture produces is out of this. */
const TARGET_ATTEMPTS = Number(process.env.CODEENSTEIN_CAPTURE_ATTEMPTS ?? 60);
/** Attempts per invocation — one fresh browser each. 20 is comfortably inside
 * the ~38 where a browser was observed to die, and at the measured ~0.4
 * attempts/min is roughly a 50-minute invocation. */
const CHUNK = Number(process.env.CODEENSTEIN_CAPTURE_CHUNK ?? 20);
const CONCURRENCY_PER_LANE = Number(process.env.CODEENSTEIN_CAPTURE_CONCURRENCY ?? 10);
/** Sized against a chunk's real cost with headroom, not guessed: 20 attempts
 * at the measured rate is ~50 min, and the 2026-08-04 run showed a watchdog
 * cutting a *working* invocation is far more expensive than one that runs
 * long, because the whole chunk is lost. */
const WATCHDOG_MS = Number(process.env.CODEENSTEIN_CAPTURE_WATCHDOG_MS ?? 130 * 60 * 1000);
// Unset = full campaign, which is what a capture is normally for. See `envFor`.
const LEVEL_LIMIT = process.env.CODEENSTEIN_CAPTURE_LEVEL_LIMIT
  ? Number(process.env.CODEENSTEIN_CAPTURE_LEVEL_LIMIT)
  : null;
/** Per-combo spawn ceiling. A cell needing more invocations than this to reach
 * its target is failing in a way more attempts will not fix. */
const MAX_INVOCATIONS = Number(process.env.CODEENSTEIN_CAPTURE_MAX_INVOCATIONS ?? 8);
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
  return Math.max(MAX_INVOCATIONS, Math.ceil(target / Math.max(1, MIN_CHUNK)) + 3);
}
/** How long one invocation should take, whichever lane runs it. Chunk size is
 * derived from this and the lane's measured rate, so a slow host gets fewer
 * attempts rather than holding a full-size chunk while every other lane idles.
 * 45 min keeps a comfortable margin under the 130-minute watchdog even if a
 * lane turns out slower than its stored rate. */
const TARGET_CHUNK_MIN = Number(process.env.CODEENSTEIN_CAPTURE_TARGET_CHUNK_MIN ?? 45);
/** Never below this: a chunk pays a fixed browser+vite startup cost, so tiny
 * chunks spend most of their time on overhead. */
const MIN_CHUNK = Number(process.env.CODEENSTEIN_CAPTURE_MIN_CHUNK ?? 5);
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

function loadLaneRates() {
  return loadRatesFile().lanes;
}

function loadComboCost(key) {
  return loadRatesFile().campaigns[key] ?? {};
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
  file.lanes[label] = attemptsPerMin;
  writeRatesFile(file);
}

/** Per-campaign, for the reason `campaignKey` gives. */
function recordComboCost(key, combo, relCost) {
  const file = loadRatesFile();
  file.campaigns[key] = { ...(file.campaigns[key] ?? {}), [combo]: relCost };
  writeRatesFile(file);
}

/**
 * Attempts to ask this lane for.
 *
 * Without a measured rate, fall back to the fixed CHUNK — the first invocation
 * on an unknown host is the calibration run, and guessing low would make a fast
 * host look slow for the rest of the capture.
 */
function chunkFor(_combo, { remaining, ratePerMin }) {
  if (!ratePerMin || ratePerMin <= 0) return Math.min(CHUNK, Math.max(1, remaining));
  const sized = Math.round(ratePerMin * TARGET_CHUNK_MIN);
  return Math.min(Math.max(MIN_CHUNK, sized), CHUNK, Math.max(1, remaining));
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
 * Streaming line-by-line rather than `JSON.parse` per file would be nicer;
 * this is deliberately the simple version, because it runs once per lane
 * iteration (seconds apart at most) against files that are tens of MB, and
 * being obviously correct matters more here than being fast — this number is
 * the denominator of every rate the capture exists to produce.
 */
function scanExisting(combo) {
  const prefix = `${comboKey(combo)}-`;
  const rids = new Set();
  let fileCount = 0;
  if (!fs.existsSync(EVENTS_DIR)) return { qualifying: 0, fileCount: 0 };
  for (const entry of fs.readdirSync(EVENTS_DIR)) {
    if (!entry.startsWith(prefix)) continue;
    fileCount += 1;
    const dir = path.join(EVENTS_DIR, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ndjson")) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(dir, file), "utf8");
      } catch {
        continue; // a half-fetched log counts as nothing, and gets re-run
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const rid = JSON.parse(line).rid;
          if (rid) rids.add(rid);
        } catch {
          // A truncated final line is the SIGKILL-mid-write case NDJSON
          // exists for — skip it, keep everything before it.
        }
      }
    }
  }
  return { qualifying: rids.size, fileCount };
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

  const runners = [new LocalRunner({ cwd: REPO_ROOT }), ...sshRunners];

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
    // working, but never start more chunks than there is work left: at
    // CHUNK=20 a combo 45 attempts short can absorb three lanes, one 5 short
    // can absorb one. Without this a run whose combo count equals its lane
    // count leaves every finished lane idle for the rest of the capture —
    // measured at 115 of 132 minutes on one ripgrep lane.
    maxConcurrentPerCombo: (_combo, { qualifying, target }) => Math.ceil(Math.max(0, target - qualifying) / CHUNK),
    chunkFor,
    initialLaneRates: loadLaneRates(),
    onLaneRate: recordLaneRate,
    initialComboCost: loadComboCost(CAMPAIGN_KEY),
    onComboCost: (combo, relCost) => recordComboCost(CAMPAIGN_KEY, combo, relCost),
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot dev tool: plays the bundled `demo-campaign/` with three distinct
 * bot profiles (Casual/Gamer/Pro) across all three difficulties, and writes
 * aggregated balancing telemetry to `balancing_telemetry.json` — consumed by
 * hand (or by an LLM balance-review pass) to spot HP-curve/drop-rate/pacing
 * problems without a human replaying the whole campaign nine times.
 *
 * Modeled on `scripts/generate-default-highscore.mjs`'s proven headless-
 * Chromium harness (virtual clock, `window.__codeensteinTestHooks` polling,
 * BFS route planning done entirely in Node before any browser launches) —
 * see that file's doc comment for the low-level rationale (why firing is
 * `Backquote`-only, why routes are precomputed, etc.). This script adds:
 * per-profile combat/navigation parameters, a qualifying-runs-per-
 * profile×difficulty retry loop (`REQUIRED_QUALIFYING_RUNS`, 3 by default —
 * see `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` to override), and
 * `window.__codeensteinTestHooks`'s balancing-telemetry surface
 * (`getTelemetrySnapshot()`/`getMines()`).
 *
 * A run only "counts" once it clears level 4 (proves it survived the
 * unarmed/unupgraded early game) — a run that dies on level 1-3 is
 * discarded outright, but once qualified, ALL of its levels' data (including
 * 1–3) is kept. Not CI-wired, not fast (up to 9 combos × 10 attempts × up to
 * 17 levels each) — run manually (`npm run balancing:telemetry`) against a
 * locally running dev server.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { planRoute, planCoverageRoute } from "./lib/routePlanner.mjs";
import { bfsPath, pathToWaypoints } from "./lib/pathfind.mjs";
import { analyzeStaticLevel } from "./lib/staticLevelAnalysis.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const CAMPAIGN_NAME = "demo-campaign";
export const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
// Overridable so multiple concurrent invocations (e.g. a multi-lane campaign
// orchestrator spawning several of these as separate processes) can each
// write to their own unique path instead of racing to overwrite the same
// fixed file — see scripts/run-balancing-campaign.mjs.
const OUTPUT_FILE = process.env.CODEENSTEIN_TELEMETRY_OUTPUT_FILE
  ? path.resolve(process.env.CODEENSTEIN_TELEMETRY_OUTPUT_FILE)
  : path.join(REPO_ROOT, "balancing_telemetry.json");

// --- Scoped-run env vars (permanent — useful for future debugging, not just
// this file's own smoke test) -----------------------------------------------
const LEVEL_LIMIT = process.env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT ? Number(process.env.CODEENSTEIN_TELEMETRY_LEVEL_LIMIT) : Infinity;
// Unbounded by default — "run until 3 qualifying runs, however long that
// takes." Only set for scoped smoke-testing, where a small explicit value
// keeps the run fast and bounded.
const ATTEMPT_CAP = process.env.CODEENSTEIN_TELEMETRY_ATTEMPT_CAP ? Number(process.env.CODEENSTEIN_TELEMETRY_ATTEMPT_CAP) : Infinity;
const PROFILE_FILTER = process.env.CODEENSTEIN_TELEMETRY_PROFILE || null;
const DIFFICULTY_FILTER = process.env.CODEENSTEIN_TELEMETRY_DIFFICULTY || null;
const PROGRESS_LOG_INTERVAL = 5; // attempts between "still working" heartbeats on an uncapped run
// How many campaign attempts to run concurrently within one combo (separate
// browser contexts/pages sharing one Chromium process). Each attempt is
// mostly I/O-bound — Node↔page.evaluate() round-trips against a virtual
// clock, not real rendering at real speed — so this scales well with CPU
// cores without needing true multi-process parallelism. Default chosen to
// be a meaningful speedup without assuming a huge machine; raise it freely
// on a beefier box.
const ATTEMPT_CONCURRENCY = process.env.CODEENSTEIN_TELEMETRY_CONCURRENCY ? Number(process.env.CODEENSTEIN_TELEMETRY_CONCURRENCY) : 12;
// Off by default (keeps normal output to just heartbeats + "Telemetry saved")
// — set to debug a combo that's burning through attempts without qualifying.
const VERBOSE = process.env.CODEENSTEIN_TELEMETRY_VERBOSE === "1";
// Permanent (not a one-off debug flag removed once some bug is root-caused —
// per-tick navigation/combat decisions are useful to inspect on demand for
// whatever the next "why is the bot doing that" question turns out to be).
// Off by default, same reasoning as VERBOSE above.
const DEBUG_NAV = process.env.CODEENSTEIN_TELEMETRY_DEBUG_NAV === "1";
// Permanent, like DEBUG_NAV — an automated, repeatable substitute for "watch
// the bot play and eyeball whether anything looks erratic" (which previously
// required a human screen recording + manual ffmpeg contact-sheet review
// every single time a fix needed re-verifying). When on, `tick()` appends a
// lightweight per-decision record to `mineMemory.trace` (reusing the
// already-per-level-scoped `mineMemory` object as the carrier, rather than
// threading a new parameter through every call site) and `playRun` runs
// `detectAnomalies` against it after each level, logging any findings. See
// `detectAnomalies`'s doc comment for exactly what it catches.
const ANOMALY_SCAN = process.env.CODEENSTEIN_TELEMETRY_ANOMALY_SCAN === "1";
// Implies ANOMALY_SCAN (the trace has to exist to analyze it). Runs a much
// more precise, tick-by-tick pass over the same per-decision trace, looking
// specifically for "a movement key (W/A/D) was held this tick, but position
// didn't actually change since the last one" — directly correlating intent
// (keys held) with outcome (real displacement), rather than the coarser
// anchor-over-a-window `stall` detector above. Added per explicit user
// request (2026-07-14) after a session of manually grepping raw `DEBUG_NAV`
// output tick-by-tick to find exactly this signature by hand, chasing
// several real full-freeze bugs — this makes that specific, recurring
// manual step automatic. See `detectHeldKeyNoMovement`'s doc comment.
const NAV_DIAG = process.env.CODEENSTEIN_TELEMETRY_NAV_DIAG === "1";
// Opens a real, visible browser window and runs at a watchable real-time
// pace instead of the virtual-clock fast-forward, so a human can actually
// see what the bot is doing tick-by-tick — "a param to view the actual
// botplay, to identify stupidness" (user request). Combine with
// CODEENSTEIN_TELEMETRY_PROFILE/_DIFFICULTY/_LEVEL_LIMIT/_ATTEMPT_CAP to
// focus on one specific combo instead of watching the whole campaign.
const HEADED = process.env.CODEENSTEIN_TELEMETRY_HEADED === "1";
// Real ms waited per tick in headed mode — slow enough to actually follow
// (~7 decisions/sec), fast enough not to be painful to sit through.
const WATCH_STEP_MS = 130;

// Overridable so a large-scale data-collection campaign can raise the target
// (e.g. 50) per invocation without touching this default — every existing
// caller (balancing:scan, ad-hoc smoke tests) is unaffected when unset.
const REQUIRED_QUALIFYING_RUNS = process.env.CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET
  ? Number(process.env.CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET)
  : 3;
const QUALIFY_LEVEL_INDEX = 3; // 0-based — "level 4" in 1-based campaign numbering

const VIRTUAL_STEP_MS = 50;
const MAX_TICKS_PER_WAYPOINT = 600;
const FINAL_APPROACH_TICKS = 80;
const TURN_MOVE_EPS = 0.2;
const ARRIVE_EPS = 0.15;
// Any single-tick position jump larger than this is physically impossible
// via normal movement (max sprint is ~0.32 tiles/tick at `VIRTUAL_STEP_MS`)
// and can only mean a teleporter pad fired — see `driveToward`'s doc
// comment on the jump-detection check that uses this.
const TELEPORT_JUMP_DETECT_TILES = 1.0;
// See `maybeDetourForLoot`'s doc comment — caps how far (straight-line) the
// bot will detour for a single uncollected pickup.
const MAX_LOOT_DETOUR_TILES = 20;
// How far (in tiles) the bot's actual position may be from an upcoming
// waypoint before it's considered "displaced" and worth a fresh BFS re-plan
// (see `driveTowardWithReplan`'s doc comment). Consecutive planned
// waypoints are exactly 1 tile apart (4-directional BFS) — a threshold at
// or near 1.0 fires on essentially every normal waypoint transition, not
// just real displacement (found via the [driftdebug] diagnostic: constant
// spurious "drift" reports for ordinary step-to-step movement). Comfortably
// above that spacing so it only fires on a genuine detour/retreat/knockback.
const LEG_REPLAN_DRIFT_TILES = 2.5;
// Mirrors src/engine/engine.ts's ROT_SPEED (rad/sec) — needed here to compute
// how long a turn-only key-hold should last (see `turnBurstMs`'s doc comment).
const ENGINE_ROT_SPEED = 2.6;

/**
 * How long to hold a turn key for a *pure* turn (no simultaneous movement/
 * fire) so it lands as close as possible to `deltaAngle` without overshooting
 * past it. Every full decision tick previously held the key for a fixed
 * `VIRTUAL_STEP_MS`/`WATCH_STEP_MS`, covering a *fixed* angle
 * (`ENGINE_ROT_SPEED * rotSpeedMultiplier * stepSec`) regardless of how much
 * turn was actually still needed. That's fine while far from aligned (more
 * turn is always progress), but once `deltaAngle` shrinks below one fixed
 * step's worth, committing to the full step blows straight past the target —
 * and since the very next tick sees the opposite-signed delta and again
 * commits to a full step, it overshoots back the other way, forever (found
 * via trace: `dir` oscillating between two fixed values every tick, never
 * converging, for 50+ consecutive ticks against a stationary mine). Bumping
 * `rotSpeedMultiplier` (realistic mouse-speed approximation — see
 * `PROFILES`) made each fixed step bigger and this far more likely to trigger
 * than at the original real keyboard rate. Capping the hold duration at
 * exactly what's needed for the remaining angle (still capped at the normal
 * step for large deltas, so far-off turns are just as fast as before) fixes
 * it for both headless (shorter virtual-clock pump) and headed (shorter real
 * wait — the key stays *held* across ticks either way, so a shorter wait just
 * means the very next re-check happens sooner, before it's had a chance to
 * sail past the target).
 *
 * `mineMemory`/`player`/`currentAngle`, if passed, record what this decision
 * *expects* to happen (`checkRotationAnomaly` compares against it on the
 * very next `tick()` call) — see that function's doc comment for why this
 * exists. Optional so callers that don't care about the anomaly check
 * (there are none left, but keeps this function usable standalone) aren't
 * forced to thread them through.
 */
function turnBurstMs(deltaAngle, rotSpeedMultiplier, mineMemory, player, currentAngle) {
  const standardStepMs = HEADED ? WATCH_STEP_MS : VIRTUAL_STEP_MS;
  const rate = ENGINE_ROT_SPEED * rotSpeedMultiplier; // rad/sec
  const neededMs = (Math.abs(deltaAngle) / rate) * 1000;
  if (mineMemory) mineMemory.pendingTurnCheck = { beforeDir: currentAngle, turnBurstMs: Math.min(standardStepMs, neededMs), rotSpeedMultiplier };
  return Math.max(1, Math.min(standardStepMs, neededMs));
}

// Mirrors src/engine/engine.ts's MOVE_SPEED/SPRINT_MULTIPLIER — needed here
// for `moveBurstMs`, the linear-movement counterpart to `turnBurstMs`.
const ENGINE_MOVE_SPEED = 3.2;
const ENGINE_SPRINT_MULTIPLIER = 2.0;

/**
 * Same idea as `turnBurstMs`, for straight-line movement toward a known
 * distance: cap how long a movement key is held so it doesn't overshoot past
 * a small arrival tolerance. Found via trace: the hazard-crossing branch
 * sprints (2x `MOVE_SPEED`, ~0.32 tiles per normal 50ms step) toward
 * `navTarget` — but `driveToward`'s own arrival check uses a much smaller
 * `ARRIVE_EPS` (0.15 tiles). When a route waypoint's coordinates land at or
 * near the hazard tile itself (common — route planning has no reason to
 * avoid hazard tiles), a full sprint step blows straight past that 0.15-tile
 * circle every tick, so `dist < eps` is never satisfied — the player just
 * oscillates back and forth around the target, standing on the hazard tile
 * the entire time. Confirmed via trace: `driveToward`'s per-tick distance
 * hovering at 0.15-0.17 (just outside `ARRIVE_EPS`) for 100+ consecutive
 * ticks while `hpFrac` drained from ~0.5 to 0 (93.6 total hazard damage,
 * fatal) — the position visibly bounces between two or three nearby points
 * rather than converging. Only applied where movement is *toward a specific
 * point* with a real arrival tolerance (hazard-crossing, plain nav-target
 * walking) — not the "run away from a threat"/mine-retreat branches, which
 * have no target point to overshoot past in the first place.
 */
function moveBurstMs(dist, sprinting) {
  const standardStepMs = HEADED ? WATCH_STEP_MS : VIRTUAL_STEP_MS;
  const speed = ENGINE_MOVE_SPEED * (sprinting ? ENGINE_SPRINT_MULTIPLIER : 1); // tiles/sec
  const neededMs = (dist / speed) * 1000;
  return Math.max(1, Math.min(standardStepMs, neededMs));
}

// How much more rotation than `turnBurstMs`'s own math predicts still counts
// as "plausible" before `checkRotationAnomaly` flags it — generous on
// purpose (real headed-mode frame-rate variance is real and expected; this
// is only meant to catch genuinely implausible jumps, not every bit of
// jitter). See `checkRotationAnomaly`'s doc comment for why this exists at
// all instead of a real fix.
const ROTATION_ANOMALY_SLACK = 4;

/**
 * Defensive net for an intermittent, not-fully-root-caused report: a user
 * watching `balancing:watch` saw the bot occasionally spin far more than one
 * decision's worth of turning should ever produce (near/exceeding a full
 * rotation) at a corner, then visibly correct back over the next several
 * ticks. Traced extensively (a temporary per-frame engine counter confirmed
 * every *individual* frame's own rotation stays normal-sized, and the
 * headless virtual-clock pump was verified to advance exactly one frame per
 * call) without finding a definitive single mechanism — plausibly explained
 * by more real engine frames elapsing during a wait than expected under
 * system/IPC load (real time, not virtual, so no `MAX_DT`-style clamp fully
 * protects against a *burst* of otherwise-individually-normal frames), but
 * not confirmed. Since `tick()` already recomputes its target fresh from
 * *actual* current state every call (nothing here depends on remembering
 * how the player got to its current facing), a surprise jump doesn't leave
 * the bot stuck — it just wastes visible time before self-correcting. This
 * doesn't try to prevent the underlying cause (unknown); it only (a) makes
 * any recurrence immediately visible in the log instead of requiring
 * re-instrumentation, and (b) the `ROTATION_ANOMALY_SLACK`-scaled bound
 * gives a concrete number to tighten if/when the real mechanism is found.
 */
function checkRotationAnomaly(mineMemory, player, currentAngle) {
  const pending = mineMemory?.pendingTurnCheck;
  if (!pending) return;
  mineMemory.pendingTurnCheck = null;
  const actual = Math.abs(angleDelta(pending.beforeDir, currentAngle));
  const expectedMax = ENGINE_ROT_SPEED * pending.rotSpeedMultiplier * (pending.turnBurstMs / 1000) * ROTATION_ANOMALY_SLACK;
  if (actual > Math.max(expectedMax, 0.3)) {
    console.log(
      `[nav-warn] implausible rotation: turned ${actual.toFixed(2)}rad in one decision ` +
        `(requested turnBurst=${pending.turnBurstMs.toFixed(0)}ms, expected <=${expectedMax.toFixed(2)}rad) ` +
        `at (${player.x.toFixed(2)},${player.y.toFixed(2)}) — not a stuck state, self-corrects next tick, logged for diagnosis.`,
    );
  }
}
/** No-op unless `ANOMALY_SCAN` is on. Appends one lightweight per-decision
 * record to `mineMemory.trace` — reusing the already-per-level-scoped
 * `mineMemory` object as the carrier (it's threaded through every call site
 * that reaches `tick()` already) rather than adding a new parameter
 * everywhere. `playRun` resets `.trace = []` per level and runs
 * `detectAnomalies` against it once the level's legs finish. */
function recordTrace(mineMemory, entry) {
  if ((!ANOMALY_SCAN && !NAV_DIAG) || !mineMemory?.trace) return;
  mineMemory.trace.push(entry);
}

// Position-unchanged-for-this-many-consecutive-ticks threshold before
// `detectAnomalies` calls it a "stall" rather than just an unlucky couple of
// ticks — roughly matches the shortest genuinely-reproduced freeze found by
// hand this session (34 ticks, legitimate spike-cycle wait) minus margin, so
// real bugs (which ran 95-155 ticks) trip it clearly while a normal brief
// pause doesn't.
const STALL_TICKS_THRESHOLD = 20;
// Any run of >=2 consecutive same-position ticks where health is also
// dropping is worth flagging immediately, regardless of the stall
// threshold above — health draining while stationary is never expected
// behavior (see milestone 14's hazard-escape-freeze bug), so this stays far
// more sensitive than the generic stall detector.
const HP_DRAIN_FROZEN_TICKS_THRESHOLD = 2;
const TRACE_POS_EPS = 0.05;
// Lower than STALL_TICKS_THRESHOLD (20) on purpose — `detectHeldKeyNoMovement`
// is a much more precise signal (real tick-to-tick displacement vs. a held
// movement key, not just "anchored within a window"), so it doesn't need as
// long a run to be confident it's a real freeze rather than incidental noise.
const HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD = 10;

/**
 * Scans one level's worth of per-decision trace records (see `recordTrace`)
 * for the two "erratic-looking" patterns actually found and fixed this
 * session, so future regressions (or new instances of the same underlying
 * class of bug) surface automatically from a script run instead of requiring
 * a human to watch/screen-record gameplay and notice something looks wrong:
 *
 * - `stall`: position hasn't moved for `STALL_TICKS_THRESHOLD`+ consecutive
 *   ticks. Excludes ticks explicitly marked `waitingOnSpike` (legitimately
 *   waiting out an active spike-trap's safe/active cycle — confirmed benign
 *   via milestone 13's re-verification) — everything else stationary this
 *   long, threat or no threat, is exactly the shape of every "endless
 *   useless turning/freeze" bug found so far.
 * - `healthDrainFrozen`: position unchanged while health is *also* dropping,
 *   for as few as 2 consecutive ticks — the hazard-escape-freeze bug
 *   (milestone 14) specifically.
 *
 * Both also exclude a run where a majority of its ticks have `fire: true` —
 * a bot holding ground and firing continuously while a threat closes distance
 * is a correct, intentional ranged standoff, not a freeze. Found via the
 * diagonal-movement dig: several "stall"/"healthDrainFrozen" reports at
 * threatDist~5-8 turned out to be exactly this shape (fire=true nearly every
 * tick, ending in a clean melee kill once the enemy closed in) — false
 * positives from this detector being otherwise purely position-based.
 *
 * Returns `{type, startTick, endTick, ticks, detail}[]`.
 */
function detectAnomalies(trace) {
  const findings = [];
  if (!trace || trace.length === 0) return findings;
  let runStart = 0;
  // Compared against the *anchor* (the run's own starting position), not the
  // immediately preceding tick — comparing only to the previous tick let a
  // slow but genuine crawl (each individual step under `TRACE_POS_EPS`, e.g.
  // a heavily-capped `turnBurst` producing tiny per-tick displacement) get
  // misreported as one giant frozen stall, since every adjacent pair looked
  // "unchanged" even though the position drifted substantially over the
  // whole run. Anchoring to the run's start correctly lets that drift
  // eventually exceed the threshold and close the run out as real movement.
  let anchor = trace[0];
  for (let i = 1; i <= trace.length; i++) {
    const cur = i < trace.length ? trace[i] : null;
    const samePos = cur && Math.abs(cur.x - anchor.x) < TRACE_POS_EPS && Math.abs(cur.y - anchor.y) < TRACE_POS_EPS;
    if (!samePos) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= 2) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const runSlice = trace.slice(runStart, runEnd);
        const allWaitingOnSpike = runSlice.every((r) => r.waitingOnSpike);
        // A ranged standoff — holding ground and firing while a threat closes
        // distance — is correct, intentional behavior, not a freeze: there's
        // no reason to walk toward an enemy already being damaged from range.
        // Found via automated dig: 3 independently-reproduced "stall"/
        // "healthDrainFrozen" reports at threatDist~5-8 were all this exact
        // shape (fire=true nearly every tick, ending in a clean melee kill),
        // false-flagged because this detector is otherwise purely position-
        // based. Mirrors `combatStallTicks`'s own `!fire` requirement (see its
        // doc comment) — a majority (not literally 100%, since brief re-aim
        // ticks between shots are expected and harmless) of the run actually
        // firing is enough to call this real combat, not a stuck bot.
        const firingTicks = runSlice.filter((r) => r.fire).length;
        const mostlyFiring = firingTicks / runLen > 0.5;
        if (runLen >= STALL_TICKS_THRESHOLD && !allWaitingOnSpike && !mostlyFiring) {
          findings.push({
            type: "stall",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)} threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"}`,
          });
        }
        if (runLen >= HP_DRAIN_FROZEN_TICKS_THRESHOLD && last.hpFrac < first.hpFrac - 0.001 && !mostlyFiring) {
          findings.push({
            type: "healthDrainFrozen",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
          });
        }
      }
      runStart = i;
      anchor = cur;
    }
  }
  return findings;
}

// Movement keys that actually translate the player — KeyQ/KeyE only rotate,
// so holding just those (e.g. a pure re-aim) is never expected to move the
// player and isn't part of this check.
const TRANSLATING_KEYS = new Set(["KeyW", "KeyA", "KeyD"]);

/**
 * Gated behind `NAV_DIAG` (see its doc comment): a tick-by-tick pass over
 * the same trace `detectAnomalies` uses, but checking each tick against the
 * *immediately preceding* one (not an anchor) and correlating it directly
 * with which keys were actually held. Flags a run where a translating key
 * (`TRANSLATING_KEYS`) was held yet real displacement since the previous
 * tick was under `TRACE_POS_EPS` — i.e. the engine's own per-axis collision
 * resolution (`player.ts`'s `move()`) rejected the translation outright,
 * every single tick, for the whole run. This is the exact signature several
 * real full-freeze bugs shared this session (correctly aimed, a movement
 * key genuinely held every tick, zero net progress) — before this, finding
 * it meant manually grepping raw `DEBUG_NAV` tick dumps for the pattern by
 * eye, repeatedly, across a whole session of chasing hard-to-reproduce
 * freezes. Reports which keys were actually held throughout the run and the
 * branch/threat context, since that's normally the first thing worth
 * checking once one of these is found.
 */
function detectHeldKeyNoMovement(trace) {
  const findings = [];
  if (!trace || trace.length < 2) return findings;
  let runStart = null;
  for (let i = 1; i <= trace.length; i++) {
    const prev = trace[i - 1];
    const cur = i < trace.length ? trace[i] : null;
    const heldTranslatingKey = prev.moveKeys?.some((k) => TRANSLATING_KEYS.has(k));
    const noRealMovement = cur && Math.abs(cur.x - prev.x) < TRACE_POS_EPS && Math.abs(cur.y - prev.y) < TRACE_POS_EPS;
    if (heldTranslatingKey && noRealMovement) {
      if (runStart === null) runStart = i - 1;
      continue;
    }
    if (runStart !== null) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const heldKeys = new Set(trace.slice(runStart, runEnd).flatMap((r) => r.moveKeys ?? []));
        findings.push({
          type: "heldKeyNoMovement",
          startTick: runStart,
          endTick: runEnd - 1,
          ticks: runLen,
          detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} heldKeys=[${[...heldKeys].join(",")}] threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
        });
      }
      runStart = null;
    }
  }
  return findings;
}

/** No-op unless `ANOMALY_SCAN` is on. Runs `detectAnomalies` (and, if
 * `NAV_DIAG` is also on, `detectHeldKeyNoMovement`) against this level's
 * accumulated trace and logs any findings, tagged with `label` (typically
 * `${profileName}/${difficulty}`) and the 1-based level number. */
function reportAnomalies(mineMemory, label, levelIndex) {
  if ((!ANOMALY_SCAN && !NAV_DIAG) || !mineMemory?.trace) return;
  if (NAV_DIAG) {
    for (const f of detectHeldKeyNoMovement(mineMemory.trace)) {
      console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
    }
  }
  for (const f of detectAnomalies(mineMemory.trace)) {
    console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
  }
}

const TIGHT_ARRIVE_EPS = 0.05;
const DOOR_OPEN_TICKS = 10;
// Same total push duration as `DOOR_OPEN_TICKS * VIRTUAL_STEP_MS` (500ms),
// just in much finer steps — see `holdForwardFine`'s doc comment.
const DOOR_OPEN_FINE_STEP_MS = 5;

// Mirrors src/engine/enemyAi.ts / src/engine/traps.ts / src/engine/weapons.ts
// — plain literals rather than importing those TS modules (this is a plain
// Node script, not bundled like the map/parser layer in loadEngineModules.mjs).
const AGGRO_RADIUS = 7.5;
const ENGAGE_RADIUS = AGGRO_RADIUS + 2; // combat always preempts navigation within this — same for every profile, non-negotiable, see module doc comment
const MINE_BLAST_RADIUS = 2.4;
// Proactive-disarm search radius. Must exceed MINE_BLAST_RADIUS to stay a
// "safe" shot; kept close to the engine's own MINE_SIGHT_RADIUS (4.5, when a
// mine first becomes visible) rather than just above the blast radius (was
// 3) — at 3, the safe window was only 0.6 tiles wide, crossed in ~4 ticks at
// normal walking speed, too tight to reliably notice+aim+fire before
// entering blast range. Mines were the #1 killer even with disarm logic on.
const MINE_DISARM_RANGE = 4.2;
// Give up on a proactive mine-disarm shot after this many consecutive ticks
// targeting the *same* mine with no hit — a wider MINE_DISARM_RANGE means a
// "visible" mine can be targeted from far enough away that a clean shot
// isn't actually guaranteed (a wall in the way, geometry the fire raycast
// doesn't connect with, etc.); without a give-up, `tick()`'s combat-always-
// preempts-navigation rule means a mine that can never actually be hit locks
// the bot in place forever (confirmed: 595/600 ticks spent motionlessly
// re-targeting the same unreachable mine, own waypoint left unreached 0.29
// tiles away). Ranged/melee enemy combat doesn't need this — an enemy
// that's alive and aggroed is always eventually hittable (it's actively
// approaching), only a *stationary* target like a mine can be permanently
// out of reach yet still pass the aim/distance filters every tick.
const MINE_TARGET_GIVEUP_TICKS = 40;
// `MINE_REALIGN_EPS` (0.01 rad) assumes `turnBurstMs` can produce an
// arbitrarily small, precise rotation by holding a turn key for an
// arbitrarily short duration — exactly true in headless mode (virtual-time
// pumping advances by precisely the requested duration in one frame), but
// NOT in headed/watch mode: the engine only actually rotates once per real
// rendered frame, so a wait shorter than roughly one real frame doesn't
// reliably produce a proportionally small rotation. Once the remaining angle
// is smaller than what one real frame's rotation covers, the bot can never
// converge to 0.01 rad at all — found via `npm run balancing:watch`'s trace
// log as `dir` bouncing between two fixed values forever, position frozen,
// chasing an unreachable precision target. A first fix attempt widened the
// realignment epsilon itself (accept "close enough"), but that backfired
// worse: once "close enough" per the widened epsilon, the mine branch adds
// no turn key AND no movement key (mine-targeting deliberately never adds
// forward/strafe movement, to avoid walking into blast range), so the bot
// did *nothing* every tick until `MINE_TARGET_GIVEUP_TICKS` — guaranteeing
// it always gave up rather than sometimes getting lucky via the oscillation,
// which in turn left more live, un-avoided mines for the bot to walk over
// later (user report after the first fix: "walked over multiple mines").
// This threshold instead leaves the fine realignment epsilon untouched (so
// headless/telemetry behavior, which converges in 1-2 ticks anyway, is
// completely unaffected) and just forces a shot at the *current* best-effort
// alignment once stuck on the same mine this many ticks — bounded well under
// `MINE_TARGET_GIVEUP_TICKS` so the jitter window shortens dramatically and
// a shot is always attempted before giving up, instead of guaranteeing
// neither.
const MINE_REALIGN_STALL_TICKS = 15;
// Below this health fraction, break contact with the nearest threat instead
// of trading hits — the base bot previously had zero self-preservation
// instinct (fight to the death against literally any odds, even at 1 HP
// with no healing available), which is unrealistic even for a genuinely
// unskilled human player and was producing implausibly low survival rates
// (a "casual" profile needing 100+ attempts to clear the first 3 levels of
// a campaign real players clear easily). Retreating is a tactical response
// to imminent death, not the "avoid combat" the hard engagement-radius rule
// forbids — the bot still fights everything down to this threshold first.
const CRITICAL_HEALTH_FRACTION = 0.2;
const MELEE_RANGE = 1.5;
// Combat can genuinely deadlock against wall geometry: an aggroed threat
// close enough to attempt melee/ranged combat on, but positioned diagonally
// across a solid wall corner from the player — turning further doesn't help
// (the angle is already essentially correct) and walking forward doesn't
// either (the player is already pressed against the wall), so
// `meleeWouldHit`/a clear ranged shot never resolves and the bot stands
// there indefinitely. Found via the automated anomaly scan (`npm run
// balancing:scan`): 591 consecutive frozen ticks (position, angle, and
// health all unchanged) fighting a threat at dist=0.7 always occluded from
// the exact crosshair column. Once a threat engagement has produced no
// actual attack (`fire`) for this many consecutive ticks with position
// frozen, nudge sideways (strafe) instead of just re-aiming in place —
// still actively fighting (not falling back to navigation, which the
// module doc comment's "combat always preempts navigation" rule forbids),
// just trying a different position along the wall to clear the occlusion.
const COMBAT_STALL_TICKS_THRESHOLD = 40;
// How often to flip strafe direction while still stalled — guards against
// picking the one direction that happens to lead further into a dead end.
const COMBAT_STALL_STRAFE_FLIP_TICKS = 20;
// The critical-health retreat branch's unconditional sprint-away (see its
// doc comment) can still freeze completely if "directly away from the
// threat" happens to point straight into a wall (a cornered retreat) —
// found via the automated anomaly scan: 30-70 tick complete freezes with
// hpFrac draining toward 0 while pinned in place. Lower threshold than
// combat's (near-death urgency, and there's no narrow hit-window to protect
// by waiting longer before reacting).
const CRITICAL_STALL_TICKS_THRESHOLD = 15;
const CRITICAL_STALL_STRAFE_FLIP_TICKS = 10;
// The engine's own enemy AI only holds an enemy still to bite once within its
// (much smaller) ATTACK_RADIUS=0.5 — between that and MELEE_RANGE, an aggroed
// enemy is still actively homing in (path-waypoint chase, which rounds
// corners), so its position keeps drifting. Below this floor, stop trying to
// close the last bit of distance during an in-progress melee engagement — any
// closer risks pushing into the enemy's own collision footprint/oscillating
// against it — and just keep re-aiming in place, since the enemy is close
// enough to plausibly settle into ATTACK_RADIUS and hold still on its own.
const MELEE_CLOSE_MIN_DISTANCE = 0.4;
// Below this distance, stop advancing while turning to line up a ranged shot
// — otherwise "keep approaching while aiming" (see the `aimTarget` branch in
// `tick()`) could walk the bot straight into melee range mid-turn, which
// defeats the point of choosing a ranged weapon in the first place.
const MIN_RANGED_APPROACH_DISTANCE = 3;
// Above this angular error, walking forward while still turning toward a
// route waypoint would move the bot away from (or perpendicular to) where
// it actually needs to go — e.g. a near-180° corridor doubling-back. Below
// it, walking while turning is still net progress. Plain navigation
// previously never moved at all until fully aligned (`TURN_MOVE_EPS`),
// which — combined with how often BFS route waypoints require *some*
// heading correction — made routine walking look stop-start/slow even
// though `MOVE_SPEED` itself was untouched (user report: "movement seems a
// bit slow, even on casual").
//
// Originally 1.0 (~57°) — too permissive: watching gameplay, the bot
// visibly swept its heading back and forth by up to ~180° repeatedly on
// otherwise straight corridors (user report: "rotates often"). Root cause,
// confirmed via DEBUG_NAV trace: right after a threat clears (switching
// from combat-aiming back to plain nav), the heading can still be
// wildly off from the nav bearing. Walking forward that far off-bearing
// (up to 57°) drifts the bot meaningfully sideways relative to the true
// line to a waypoint only ~1 tile away, which can overshoot the waypoint
// along one axis while the other axis hasn't caught up — flipping the
// target's bearing to *behind* the bot, forcing a near-full reversal, which
// then overshoots the other way, repeating. Tightened so only genuinely
// minor corrections keep walking; anything bigger stops to turn first,
// same as the original "movement seems slow" fix intended for *routine*
// waypoint-to-waypoint heading changes (typically small on a mostly-
// straight route), not a fresh 90°+ reorientation.
const MAX_WALK_WHILE_TURNING_RAD = 0.35;
const HAZARD_TILE = 2; // src/map/types.ts's Tile enum
const KNIFE_WEAPON_INDEX = 2;
const GDB_WEAPON_INDEX = 3;
const GHIDRA_WEAPON_INDEX = 4;
const FRIDAY_HOTFIX_WEAPON_INDEX = 5;
const TOOLCHAIN_WEAPON_INDEX = 6;
const STARTING_WEAPONS = [0, 1, 2];

export const DIFFICULTIES = ["easy", "normal", "hard"];

/**
 * Bot behavior profiles. `engageRadius` is deliberately identical across all
 * three (see `ENGAGE_RADIUS`) — "low aggression" (Casual) never means
 * skipping a fight, only a looser `fireAngleEps` (worse aim) and a lower
 * `healthDetourThreshold` urgency inversion (higher = detours for health
 * sooner). `weaponPriority` lists ranged `WEAPONS` indices in preference
 * order (melee indices are excluded — melee-in-range is handled separately,
 * universally, for every profile: see the `MELEE_RANGE` check in `tick()`).
 * Every profile's list ends in a complete fallback chain (pistol, shotgun,
 * Friday Hotfix) so a profile never ends up with *no* valid ranged option
 * just because its preferred unlockable weapon isn't owned yet or is out of
 * ammo — Pro's list originally omitted the shotgun/Friday Hotfix entirely,
 * meaning it had nothing to fall back on beyond the bare pistol whenever
 * ghidra/gdb weren't available, found while investigating why Pro/normal
 * was taking dramatically longer to qualify than the "less skilled" Casual
 * and Gamer profiles despite Pro's much tighter aim.
 *
 * `proactiveMineDisarm` is `true` for every profile — mines were the #1
 * killer in early testing even for profiles that didn't proactively shoot
 * them (a proximity-fuse detonation is exactly the kind of "gotcha" damage
 * no reasonable player would just walk into if they'd spotted the mine at
 * all — see `MINE_DISARM_RANGE`), kept as a per-profile field only so it
 * still shows up explicitly in the output's `meta.profiles` dump.
 *
 * `coverageMode` is `false` for every profile — navigation is always
 * shortest-route-to-exit (`planRoute`, not `planCoverageRoute`), regardless
 * of skill level. This was originally Casual-only "maximize map coverage"
 * (visit every room), which turned out to be the single biggest driver of
 * Casual's implausibly low survival rate: forcing a bot through every
 * dangerous room in a level, on top of already-worse aim, produced
 * survival odds far below even an unskilled real player's, since a real
 * "casual" player still generally beelines for progress rather than
 * deliberately courting every fight on the map. Skill differences now come
 * entirely from combat/aim/tactics, not from how much of the map gets
 * walked — `planCoverageRoute` itself is kept (tested, working) in case a
 * future profile wants it, just unused today. Loot is collected
 * opportunistically along the shortest route regardless of profile (see
 * `maybeDetourForLoot`) — "embrace combat, collect what's there" rather
 * than "route around danger to see the whole map".
 *
 * There is deliberately no `meleeRush` field (an earlier version had one,
 * `true` for Pro only) — it was never actually read anywhere in the tick
 * logic, and on reflection the underlying idea doesn't hold up: a genuinely
 * high-accuracy player has no reason to proactively close distance *from
 * range* into melee at all (that's *more* exposure to incoming fire, not
 * less) — the correct "skilled" behavior is exactly what every profile
 * already does, universally: snipe efficiently from range, and only melee
 * opportunistically once something's already adjacent (free, ammo-less,
 * lifesteal). This is distinct from finishing an *already-committed* melee
 * engagement (`threat.dist <= MELEE_RANGE`, see `MELEE_CLOSE_MIN_DISTANCE`),
 * where a small amount of closing movement is needed purely to resolve
 * `meleeWouldHit`'s narrow hit window against a still-approaching enemy —
 * that's tightening an opportunity already taken, not manufacturing one.
 *
 * `fireAngleEps` calibration note: earlier values (Casual 0.17-0.22, Gamer
 * 0.15, Pro 0.08) were all *far* too loose, discovered via a `DEBUG_RANGE=1`
 * trace + a controlled experiment. The working assumption had been that
 * remaining low pistol accuracy (~5-7% even after fixing the mine-LOS bug —
 * see `findDisarmableMine`'s doc comment) was the engine's own Cone-of-Fire
 * deviation, an unavoidable range-scaled property — but the actual observed
 * firing distances (median ~3.8 tiles, max ~7.4, against `FOG_FAR=14`) put
 * real Cone-of-Fire deviation at only ~1-5px, nowhere near enough to cause
 * that much of a miss rate. Directly testing a much tighter Casual value
 * (0.03) confirmed it: hit rates jumped to 70-90%+ in most fights. The
 * *tolerance itself* was the bug — at typical engagement range an enemy's
 * on-screen angular width is only a few degrees, so a ~10-13° "close enough
 * to fire" tolerance let the bot fire while aimed at empty space next to
 * the target far more often than not. Retuned to a much tighter ladder that
 * still preserves real skill differentiation (Pro tightest, Casual
 * loosest) without any tier being catastrophically bad.
 */
export const PROFILES = {
  Casual: {
    fireAngleEps: 0.08,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Simple/reliable weapons first; ghidra last (a "casual" player is more
    // hesitant with a self-splash-capable rocket launcher) — but still in
    // the list, since every profile should be able to use whatever it has.
    weaponPriority: [0, 1, GDB_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.75,
    proactiveMineDisarm: true,
    // Same "more hesitant with a self-splash launcher" reasoning as the
    // weaponPriority ordering above, applied to situational cluster-
    // targeting too (see `pickRangedWeapon`) — sticks to the shotgun for a
    // distant cluster instead of reaching for rockets.
    rocketForDistantClusters: false,
    // See `botRotSpeedMul`'s doc comment (engine.ts's `rotSpeedMultiplier`)
    // — approximates a realistic *mouse* turn speed for this skill tier
    // rather than the real Q/E keyboard rate, since mouse-look itself isn't
    // available to a Playwright-automated browser. ~2x keyboard (~5.2
    // rad/sec, ~300°/sec) — an unhurried, average mouse sensitivity.
    rotSpeedMultiplier: 2,
  },
  Gamer: {
    fireAngleEps: 0.05,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Ammo-efficient auto weapon first, heavy hitter last, everything else
    // in between.
    weaponPriority: [GDB_WEAPON_INDEX, 0, 1, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.5,
    proactiveMineDisarm: true,
    rocketForDistantClusters: true,
    // ~3.5x keyboard (~9.1 rad/sec, ~520°/sec) — a comfortable, practiced
    // enthusiast's mouse turn speed.
    rotSpeedMultiplier: 3.5,
  },
  Pro: {
    fireAngleEps: 0.03,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Heavy hitters first, complete fallback chain through everything else —
    // was missing 1/FRIDAY_HOTFIX_WEAPON_INDEX entirely before, the direct
    // cause of Pro/normal needing far more attempts to qualify than the
    // "less skilled" profiles.
    weaponPriority: [GHIDRA_WEAPON_INDEX, GDB_WEAPON_INDEX, 0, 1, FRIDAY_HOTFIX_WEAPON_INDEX],
    healthDetourThreshold: 0.25,
    proactiveMineDisarm: true,
    rocketForDistantClusters: true,
    // ~5x keyboard (~13 rad/sec, ~745°/sec) — a fast, high-sensitivity
    // competitive flick-turn, still within real human mouse-aim territory.
    rotSpeedMultiplier: 5,
  },
};

const DAMAGE_SOURCES = ["enemyMelee", "enemyRanged", "trapSpike", "trapMine", "hazard", "selfRocket"];
const HEAL_SOURCES = ["pickupHealth", "pickupSwap", "lifesteal"];
const LOOT_KINDS = ["bullets", "rockets", "smg", "gas", "health", "swap", "weapon"];

// Deterministic outlier-flag thresholds — tunable, arithmetic only, no RNG.
const DENSITY_OUTLIER_MULTIPLIER = 1.5;
const NORMAL_TTK_HIGH_SEC = 8;
const CROSS_DIFFICULTY_FLAT_THRESHOLD = 0.15; // relative change below this = "barely scales"

function angleDelta(current, target) {
  const d = target - current;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * The strafe key ("KeyD"/right or "KeyA"/left) that moves the player toward
 * a target requiring `delta` radians of turn to face — same-sign
 * correlation as the engine's own `rotate()`/`strafe()` conventions
 * (`player.ts`: positive `rotate` = turn right, positive `strafe` = move
 * right, "the right vector is the facing vector rotated +90°, matching
 * rotate's positive-angle convention"). A positive `delta` means the target
 * is to the right (needs `KeyE` to turn toward), so `KeyD` also moves
 * bodily toward it.
 *
 * Lets the bot move diagonally (forward + sideways) instead of
 * straight-ahead-only while turning. Two independent motivations (user
 * directive, 2026-07-14): (1) less wasted-looking pure rotation — a diagonal
 * step makes real progress toward the target with less turning needed
 * first, rather than "stop, spin to face it, then walk straight"; (2) the
 * engine's own `move()` (`player.ts`) resolves the X and Y axes of a
 * translation *independently* ("resolving each axis independently for
 * sliding") — a diagonal (forward+strafe) vector is a genuinely different
 * move than forward-only, so it can find an unblocked partial slide in
 * cases where a wall-aligned pure-forward vector can't move at all.
 *
 * CONFIRMED REGRESSION, only used in the plain-navigation branch now: an A/B
 * test against the pre-diagonal-movement baseline (same map seed, same
 * concurrency/scale) found Casual/normal's level-2 death rate jumped from
 * 0% to 72% once diagonal movement was added to every turn-and-move branch.
 * Part of the cause was a genuine, separately-fixed engine bug (unnormalized
 * diagonal speed — `handleMovement` in `engine.ts` applied a full,
 * un-scaled `step` to both axes independently, so moving diagonally covered
 * ~41%/sqrt(2) more ground per frame than straight movement), but fixing
 * that alone wasn't sufficient: a second A/B test with the engine fix in
 * place still showed the same 72%-vs-0% gap, isolated via bisection to
 * diagonal movement's *direction* itself (not just its speed) — most likely
 * subtle trajectory/positioning shifts during hazard/critical-health/
 * mine-retreat/ranged-aim that a low-aim-tolerance profile like Casual can
 * least absorb. Reverted from those four branches; kept only in plain
 * navigation (open hallway travel, lowest combat-proximity risk), where the
 * same A/B methodology found no comparable survival cost.
 */
function diagonalStrafeKey(delta) {
  return delta > 0 ? "KeyD" : "KeyA";
}

/** Phase 0: parse + generate + route-plan every campaign level in Node,
 * before any browser launches. Exported so other scripts (e.g. the headed
 * watch-session driver) can reuse the exact same level plans instead of
 * duplicating this. */
export async function planLevels() {
  console.log("Loading engine modules + planning routes in Node...");
  const { parseFile, extensionOf, MapGenerator } = await loadEngineModules();
  const generator = new MapGenerator();

  const filenames = fs
    .readdirSync(CAMPAIGN_DIR)
    .filter((f) => fs.statSync(path.join(CAMPAIGN_DIR, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const limitedFilenames = Number.isFinite(LEVEL_LIMIT) ? filenames.slice(0, LEVEL_LIMIT) : filenames;

  const levelPlans = [];
  for (const filename of limitedFilenames) {
    const text = fs.readFileSync(path.join(CAMPAIGN_DIR, filename), "utf8");
    const parsed = await parseFile(filename, text);
    if (!parsed) {
      console.log(`[${filename}] PARSE FAIL — skipping`);
      continue;
    }
    const bonusLevel = extensionOf(filename) === "h";
    const map = generator.generate(parsed, bonusLevel, false, [3, 4, 5]);
    const routePlain = planRoute(map);
    const routeCoverage = planCoverageRoute(map);
    const staticAnalysis = analyzeStaticLevel(map, routePlain);
    levelPlans.push({ filename, filePath: `${CAMPAIGN_NAME}/${filename}`, map, routePlain, routeCoverage, staticAnalysis });
  }
  console.log(`${levelPlans.length} levels planned.\n`);
  return levelPlans;
}

async function main() {
  const levelPlans = await planLevels();
  const profileNames = PROFILE_FILTER ? [PROFILE_FILTER] : Object.keys(PROFILES);
  const difficulties = DIFFICULTY_FILTER ? [DIFFICULTY_FILTER] : DIFFICULTIES;

  const browser = await chromium.launch({ headless: !HEADED });
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      campaign: CAMPAIGN_NAME,
      levelCount: levelPlans.length,
      difficulties: DIFFICULTIES,
      profiles: PROFILES,
    },
    profiles: {},
  };

  for (const profileName of profileNames) {
    const profile = PROFILES[profileName];
    output.profiles[profileName] = {};
    for (const difficulty of difficulties) {
      console.log(`=== ${profileName} / ${difficulty} ===`);
      const combo = await runCombo(browser, profileName, profile, difficulty, levelPlans);
      output.profiles[profileName][difficulty] = buildComboOutput(levelPlans, combo);
      console.log(
        `  qualifying runs: ${combo.qualifyingRuns.length}/${REQUIRED_QUALIFYING_RUNS} (attempts used: ${combo.attemptsUsed})`,
      );
    }
    output.profiles[profileName].crossDifficultyFlags = computeCrossDifficultyFlags(output.profiles[profileName]);
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log("Telemetry saved");
}

// ---------------------------------------------------------------------------
// Retry/qualify loop
// ---------------------------------------------------------------------------

/** One full campaign attempt: fresh isolated context/page, drive it to
 * completion (win/death/stuck), close the context. Extracted from
 * `runCombo` so batches of these can run concurrently — each attempt is
 * mostly I/O-bound (`page.evaluate()` round-trips against a virtual clock,
 * no real rendering work at real speed), so running several at once scales
 * well without needing real parallel CPU work. */
async function runOneAttempt(browser, profileName, profile, difficulty, levelPlans) {
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
    if (process.env.CODEENSTEIN_CONSOLE_FORWARD) page.on("console", (msg) => console.log(`  [console] ${msg.text()}`));

    if (!HEADED) await installVirtualClock(page); // headed mode runs on the real clock so a human can follow along
    await installDifficulty(page, difficulty);
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1&botRotSpeedMul=${profile.rotSpeedMultiplier}`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    const run = await playRun(page, profile, levelPlans, `${profileName}/${difficulty}`);
    await context.close();
    return run;
  } catch (err) {
    // A single flaky Chromium context/page (crash, closed target mid-eval)
    // must not take down the whole concurrent batch — surface it as a
    // discarded, non-qualifying attempt instead of an uncaught rejection.
    console.log(`  [attempt crashed] ${err.message}`);
    if (context) {
      await context.close().catch(() => {});
    }
    return {
      reachedExitForLevel: [],
      levelSnapshots: [],
      weaponFirstOwnedAtLevel: {},
      diedAtLevelIndex: null,
      reason: `attemptCrashed: ${err.message}`,
    };
  }
}

async function runCombo(browser, profileName, profile, difficulty, levelPlans) {
  const qualifyingRuns = [];
  const failureReasons = [];
  let attempts = 0;
  let consecutiveCrashedBatches = 0;
  // Headed mode is for a human watching one attempt at a time — concurrency
  // there would just open several simultaneous windows, defeating the point.
  const concurrency = HEADED ? 1 : ATTEMPT_CONCURRENCY;

  while (qualifyingRuns.length < REQUIRED_QUALIFYING_RUNS && attempts < ATTEMPT_CAP) {
    const batchSize = Math.min(concurrency, ATTEMPT_CAP - attempts);
    const batch = await Promise.all(
      Array.from({ length: batchSize }, () => runOneAttempt(browser, profileName, profile, difficulty, levelPlans)),
    );
    const crashedInBatch = batch.filter((run) => run.reason?.startsWith("attemptCrashed")).length;
    // If literally every attempt in a batch crashed, the shared browser
    // instance itself is almost certainly dead, not just one flaky context —
    // don't spin forever re-crashing instantly; surface it as a hard failure.
    consecutiveCrashedBatches = crashedInBatch === batch.length ? consecutiveCrashedBatches + 1 : 0;
    if (consecutiveCrashedBatches >= 3) {
      throw new Error(
        `[${profileName}/${difficulty}] browser appears dead: ${consecutiveCrashedBatches} consecutive fully-crashed batches`,
      );
    }
    for (const run of batch) {
      attempts += 1;
      if (run.reachedExitForLevel[QUALIFY_LEVEL_INDEX]) {
        qualifyingRuns.push(run);
      } else {
        failureReasons.push({ attempt: attempts, reason: run.reason, diedAtLevelIndex: run.diedAtLevelIndex });
        if (VERBOSE) {
          const where = run.diedAtLevelIndex !== null ? ` at level ${run.diedAtLevelIndex + 1}` : "";
          console.log(`  [${profileName}/${difficulty}] attempt ${attempts} failed: ${run.reason}${where}`);
        }
      }
    }
    if (attempts >= PROGRESS_LOG_INTERVAL) {
      console.log(`  [${profileName}/${difficulty}] still working — attempt ${attempts}, qualifying ${Math.min(qualifyingRuns.length, REQUIRED_QUALIFYING_RUNS)}/${REQUIRED_QUALIFYING_RUNS}`);
    }
  }
  // A batch can overshoot (e.g. all 4 concurrent attempts qualify at once) —
  // trim to exactly 3 samples so aggregation stays consistent with a
  // sequential run. IMPORTANT: capture the untrimmed count first. When
  // ATTEMPT_CONCURRENCY > REQUIRED_QUALIFYING_RUNS (the campaign orchestrator's
  // default: concurrency 8, target 5), the loop almost always exits after a
  // single batch once true per-attempt success is reasonably high — every one
  // of the overnight campaign's 90 files landed at exactly 8 attempts/5
  // qualifying as a result, which mechanically floors qualifyingRuns.length/
  // attemptsUsed at REQUIRED_QUALIFYING_RUNS/ATTEMPT_CONCURRENCY (5/8=62.5%)
  // regardless of the real underlying rate. trueQualifyingCount preserves the
  // real number of successes in the final batch so downstream rate
  // calculations aren't silently censored by the sample-size trim.
  const trueQualifyingCount = qualifyingRuns.length;
  qualifyingRuns.length = Math.min(qualifyingRuns.length, REQUIRED_QUALIFYING_RUNS);

  return { qualifyingRuns, attemptsUsed: attempts, failureReasons, trueQualifyingCount };
}

/**
 * Plays one full campaign attempt for `profile`. Returns `{
 * reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel,
 * diedAtLevelIndex, reason }` — `levelSnapshots` is `{levelIndex, snapshot,
 * player, incomplete}[]`, one entry per level the run actually reached the
 * end of (won or died on); `incomplete: true` marks the death-level entry.
 */
export async function playRun(page, profile, levelPlans, label = "") {
  const reachedExitForLevel = new Array(levelPlans.length).fill(false);
  const levelSnapshots = [];
  const weaponFirstOwnedAtLevel = {};
  const knownOwned = new Set(STARTING_WEAPONS);
  const visitedPickups = new Set();

  for (let i = 0; i < levelPlans.length; i++) {
    visitedPickups.clear(); // static AmmoPickup positions are per-map; a fresh engine per level makes prior "visited" state meaningless here
    // Scoped per level (not per waypoint/leg — see `tick()`'s mine-handling
    // doc comment): `driveToward` is called freshly for every single
    // waypoint, often only 15-25 ticks apart, so a give-up counter created
    // inside it would keep resetting to 0 before ever reaching
    // `MINE_TARGET_GIVEUP_TICKS` and never actually give up (confirmed via
    // trace: ticks resetting to 1 every ~15-25 ticks, 188 total retreat
    // attempts against the same unreachable mine, permanently stuck).
    // Retreat and shoot tracking are kept in separate slots (not one shared
    // `{key,ticks}` pair) — sharing one caused a second, nastier bug: giving
    // up on a retreat fell through into the *shoot*-tracking code below it,
    // which (seeing no shoot target) reset the shared memory to zero, so the
    // very next tick re-entered retreat mode completely fresh and gave up
    // again 40 ticks later, forever (confirmed via trace: this cycled the
    // full 600-tick budget without ever truly escaping). `abandoned` is the
    // real fix for "stop trying" — once give-up fires for a mine in either
    // mode, it's blacklisted from both for the rest of the level, so this
    // can't cycle no matter how the two modes interleave.
    const mineMemory = { retreatKey: null, retreatTicks: 0, shootKey: null, shootTicks: 0, abandoned: new Set(), trace: ANOMALY_SCAN || NAV_DIAG ? [] : undefined };
    const { map, routePlain, routeCoverage } = levelPlans[i];
    const route = profile.coverageMode ? routeCoverage : routePlain;

    const player0 = await readState(page);
    if (player0.state !== "playing") {
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: player0.state === "over" ? "died" : "stuck" };
    }
    const prevExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());

    const legOutcome = route.ok ? await driveLegs(page, route.legs, profile, map, visitedPickups, mineMemory) : { state: "stuck" };

    if (legOutcome.state === "over") {
      const deathResult = await pullLevelResult(page);
      levelSnapshots.push({ levelIndex: i, ...deathResult, incomplete: true });
      if (VERBOSE) logDeathDetail(i, deathResult);
      reportAnomalies(mineMemory, label, i);
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
    }
    if (legOutcome.state === "stuck") {
      reportAnomalies(mineMemory, label, i);
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
    }
    if (legOutcome.state === "playing") {
      const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
      const pushed = await driveToward(page, exitCenter, TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS, profile, map, mineMemory);
      if (pushed.state === "over") {
        const deathResult = await pullLevelResult(page);
        levelSnapshots.push({ levelIndex: i, ...deathResult, incomplete: true });
        if (VERBOSE) logDeathDetail(i, deathResult);
        reportAnomalies(mineMemory, label, i);
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
      }
      if (pushed.state !== "won") {
        reportAnomalies(mineMemory, label, i);
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
      }
    }
    // else legOutcome.state === "won" already — fall through.
    reportAnomalies(mineMemory, label, i);

    const result = await pullLevelResult(page);
    levelSnapshots.push({ levelIndex: i, ...result, incomplete: false });
    reachedExitForLevel[i] = true;
    for (const w of result.player.ownedWeapons) {
      if (!knownOwned.has(w)) {
        knownOwned.add(w);
        weaponFirstOwnedAtLevel[w] = i + 1; // 1-based level index, matching campaignLevelIndex convention
      }
    }

    await dismissOverlay(page); // Commit Summary overlay
    const advance = await page
      .waitForFunction(
        (prevExit) => {
          const hooks = window.__codeensteinTestHooks;
          if (!hooks) return null;
          const exit = hooks.getExit();
          if (exit.x !== prevExit.x || exit.y !== prevExit.y) return "advanced";
          if (localStorage.getItem("codeenstein-highscores")) return "campaign-complete";
          return false;
        },
        prevExit,
        { timeout: 20000, polling: 100 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => "timeout");

    if (advance === "campaign-complete") {
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: null, reason: "campaign-complete" };
    }
    if (advance !== "advanced") {
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: null, reason: "stuck" };
    }
    await dismissOverlay(page); // next level's briefing
  }
  return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: null, reason: "campaign-complete" };
}

async function pullLevelResult(page) {
  return page.evaluate(() => {
    const hooks = window.__codeensteinTestHooks;
    return { snapshot: hooks.getTelemetrySnapshot(), player: hooks.getPlayerState() };
  });
}

/** VERBOSE-only diagnostic for a death — see `CODEENSTEIN_TELEMETRY_VERBOSE`. */
function logDeathDetail(levelIndex, { snapshot }) {
  console.log(
    `    -> died on level ${levelIndex + 1}: fatal=${snapshot.fatalDamageSource}, kills=${snapshot.kills}, ` +
      `minHealth=${Math.round(snapshot.minHealthReached)}, dmgBySource=${JSON.stringify(snapshot.damageBySource)}, ` +
      `combatTimeSec=${snapshot.combatTimeSec.toFixed(1)}, levelTimeSec=${snapshot.levelTimeSec.toFixed(1)}, peakAggroed=${snapshot.peakAggroedCount}`,
  );
  if (snapshot.ttkRecords?.length) {
    const summary = snapshot.ttkRecords
      .map((r) => `${r.category}${r.deathAtLevelTime === null ? "(alive)" : `(ttk=${(r.deathAtLevelTime - r.aggroAtLevelTime).toFixed(1)}s)`}`)
      .join(", ");
    console.log(`       engaged enemies: ${summary}`);
  }
  if (snapshot.weaponTallies && Object.keys(snapshot.weaponTallies).length) {
    const summary = Object.entries(snapshot.weaponTallies)
      .map(([idx, t]) => `${idx}:${t.shotsFired}shots/${t.hits}hits/${t.kills}kills`)
      .join(", ");
    console.log(`       weapons: ${summary}`);
  }
}

// ---------------------------------------------------------------------------
// Navigation / combat driving — adapted from generate-default-highscore.mjs,
// parameterized per profile (fireAngleEps/engageRadius/weaponPriority/
// proactiveMineDisarm) plus a health-pickup detour layer.
// ---------------------------------------------------------------------------

/**
 * Detour to collect an uncollected static `AmmoPickup` — any kind, not just
 * health. "The bot should collect all available loot" (user directive):
 * below `healthDetourThreshold`, prioritize the nearest *health* pickup
 * specifically even if it's farther away than other loot (the original,
 * survival-motivated behavior); otherwise, just grab whichever uncollected
 * pickup is nearest, of any kind, since a shortest-route bot walking past
 * free ammo/weapons without detouring for it isn't realistic "collect
 * everything" play. Falls back to "nearest of any kind" even while urgent
 * if no health pickup exists on this map, rather than doing nothing.
 *
 * Capped at `MAX_LOOT_DETOUR_TILES` (straight-line): once this started
 * getting checked before every waypoint instead of once per leg (see
 * `driveLegs`'s doc comment), the *global* nearest-uncollected-pickup
 * search could — and did — pick something from a completely different,
 * already-passed part of the level, sending the bot on a 50+ tile round
 * trip for a single ammo pickup (user report, watching gameplay: "bot
 * still sometimes walk back to where he came from"). A pickup beyond the
 * cap is left for later — it stays in `map.ammoPickups`/`getDrops()`
 * uncollected, so a *later* check (once the route naturally passes closer
 * to it) can still pick it up; it's just never worth an immediate detour
 * this far.
 */
async function maybeDetourForLoot(page, map, visitedPickups, profile, mineMemory, openedDoors) {
  const player = await readState(page);
  if (player.state !== "playing") return { state: player.state };

  // Static, pre-placed pickups (known from Node-side map generation) need
  // our own "already visited" bookkeeping — `map.ammoPickups` never shrinks.
  // Dynamic kill-drop loot (an enemy's death drop) doesn't exist until
  // runtime and isn't in `map.ammoPickups` at all — without querying it
  // separately, the bot has no way to know a drop is there and will walk
  // right past it (user report: "bot should also collect all loot in his
  // viewable area, sometimes skips drops"). Queried live and re-checked
  // every call rather than tracked in `visitedPickups`, since the engine's
  // own `getDrops()` already naturally stops listing one once collected.
  const staticUncollected = map.ammoPickups.filter((p) => !visitedPickups.has(`${p.x},${p.y}`));
  const dynamicDrops = await page.evaluate(() => window.__codeensteinTestHooks.getDrops());
  // Dependency keys — same "unknown at map-generation time from the bot's
  // perspective, needs a live query" reasoning as `dynamicDrops` above, but
  // for a different reason: keys are placed statically, but the *route
  // planner* only ever detours for one when it's already blocking a specific
  // planned door leg (see `scripts/lib/routePlanner.mjs`), so a key sitting
  // near the bot's path but not currently required is otherwise never
  // targeted (user report, watching gameplay: "bots don't always collect
  // keys, even if they are next to their path"). Folded into the same
  // nearest-by-real-path pool as every other pickup kind below, rather than
  // given its own unconditional detour, so it's still subject to the same
  // sane distance cap as everything else — a key that's actually adjacent to
  // the path wins the nearest-path comparison for free.
  const dynamicKeys = (await page.evaluate(() => window.__codeensteinTestHooks.getKeys())).map((k) => ({ ...k, kind: "key" }));
  const uncollected = [...staticUncollected, ...dynamicDrops, ...dynamicKeys];
  if (uncollected.length === 0) return { state: "playing" };

  const urgent = player.healthFraction < profile.healthDetourThreshold;
  const healthOnly = uncollected.filter((p) => p.kind === "health");
  const pool = urgent && healthOnly.length > 0 ? healthOnly : uncollected;

  // Rank by actual walking distance (a real BFS path), not straight-line —
  // a pickup that looks close as the crow flies can require a much longer
  // detour (or be behind a wall entirely) if it's not directly reachable,
  // same class of issue as `driveTowardWithReplan`'s line-of-sight fix.
  // Straight-line distance is only used as a cheap pre-filter (a real path
  // is never shorter) to skip a wasted BFS call for obviously-too-far
  // candidates before paying for the real one.
  let best = null;
  let bestPath = null;
  for (const p of pool) {
    if (Math.hypot(p.x - player.x, p.y - player.y) > MAX_LOOT_DETOUR_TILES) continue;
    const path = bfsPath(
      map,
      { x: Math.floor(player.x), y: Math.floor(player.y) },
      { x: Math.floor(p.x), y: Math.floor(p.y) },
      new Set(),
      openedDoors,
    );
    if (!path || path.length - 1 > MAX_LOOT_DETOUR_TILES) continue;
    if (!bestPath || path.length < bestPath.length) {
      best = p;
      bestPath = path;
    }
  }
  // Leave it uncollected rather than mark it visited — a later check, once
  // the route naturally passes closer, can still pick it up.
  if (!best) return { state: "playing" };
  if (staticUncollected.includes(best)) visitedPickups.add(`${best.x},${best.y}`);

  const path = bestPath;
  if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug] loot-detour from (${player.x.toFixed(1)},${player.y.toFixed(1)}) to best=(${best.x},${best.y}) kind=${best.kind} pathLen=${path.length}`);
  for (const wp of pathToWaypoints(path)) {
    if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug]   loot wp=(${wp.x},${wp.y})`);
    const result = await driveToward(page, wp, ARRIVE_EPS, MAX_TICKS_PER_WAYPOINT, profile, map, mineMemory);
    if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug]   -> result=${JSON.stringify(result)}`);
    if (result.state !== "playing") return result;
  }
  return { state: "playing" };
}

/**
 * Drive toward a single planned waypoint, but re-BFS a detour-safe path to
 * it first if the bot has drifted `LEG_REPLAN_DRIFT_TILES` or more away from
 * where it's expected to be — *or* the straight line to it is blocked by a
 * wall regardless of distance. `driveToward` itself is straight-line-only
 * (no wall awareness) — that's fine between two BFS-adjacent waypoints a
 * route leg planned together, but not once something (a loot detour, a
 * critical-health retreat, a mine-avoidance backoff, an in-progress fight
 * pushing the bot around) has displaced the bot from the route entirely.
 * Checked before *every* waypoint, not just once per leg: a leg can be
 * dozens of waypoints long, and displacement found via the automated
 * anomaly scan (`npm run balancing:scan`) happened mid-leg just as often as
 * at a leg's start (real combat/retreat mechanics only exist once enemies
 * are actually in play, unlike the first, doors-and-detour-only repro of
 * this bug class). See `bfsPath`'s `openDoors` doc comment for why
 * `openedDoors` must be threaded through here too.
 *
 * The distance-only version of this check had its own bug: a *short*
 * (under `LEG_REPLAN_DRIFT_TILES`) straight-line gap can still have a wall
 * directly in it if the true walkable path bends around a corner — found
 * via the automated anomaly scan as a 596-tick complete freeze (`main.c`,
 * an L-shaped wall segment), correctly aimed and holding forward every
 * tick, genuinely unable to move because the straight line to the target
 * crossed solid wall the whole time and the drift check never fired since
 * 1.78 tiles was comfortably under the 2.5-tile distance threshold. Added
 * a `hasLineOfSight` check (already used elsewhere for ranged/mine
 * targeting) so a blocked line always triggers the wall-aware BFS re-plan
 * regardless of how short the straight-line distance looks. */
async function driveTowardWithReplan(page, wp, map, profile, mineMemory, openedDoors, eps = ARRIVE_EPS) {
  const player = await readState(page);
  const displaced =
    Math.hypot(player.x - wp.x, player.y - wp.y) > LEG_REPLAN_DRIFT_TILES ||
    (map && !hasLineOfSight(map, player.x, player.y, wp.x, wp.y));
  if (displaced) {
    const path = bfsPath(
      map,
      { x: Math.floor(player.x), y: Math.floor(player.y) },
      { x: Math.floor(wp.x), y: Math.floor(wp.y) },
      new Set(),
      openedDoors,
    );
    if (process.env.CODEENSTEIN_DRIFTDEBUG) {
      console.log(
        `[driftdebug] drift from (${player.x.toFixed(2)},${player.y.toFixed(2)}) wp=(${wp.x},${wp.y}) openedDoors=${JSON.stringify([...openedDoors])} path=${path ? `${path.length} tiles` : "NULL"}`,
      );
    }
    if (path) {
      for (const rwp of pathToWaypoints(path)) {
        if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug] replan-walk wp=(${rwp.x},${rwp.y})`);
        const result = await driveToward(page, rwp, ARRIVE_EPS, MAX_TICKS_PER_WAYPOINT, profile, map, mineMemory);
        if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug]   -> result=${JSON.stringify(result)}`);
        if (result.state !== "playing" || result.reason === "stuck") return result;
      }
      return { state: "playing", reason: "arrived" };
    }
  }
  return driveToward(page, wp, eps, MAX_TICKS_PER_WAYPOINT, profile, map, mineMemory);
}

async function driveLegs(page, legs, profile, map, visitedPickups, mineMemory) {
  // `map.grid` is static and never reflects a door's live opened/closed
  // state — any BFS re-plan mid-run (drift below, or a loot detour) needs
  // to know which doors *this run* has already opened, or it'll wrongly
  // treat them as permanently blocked and fail to find a path that in
  // reality is walkable. See `bfsPath`'s `openDoors` doc comment.
  const openedDoors = new Set();

  for (const leg of legs) {
    const detour = await maybeDetourForLoot(page, map, visitedPickups, profile, mineMemory, openedDoors);
    if (detour.state !== "playing") return detour;

    if (leg.kind === "walk") {
      // A loot detour only ran once, right here, before this leg's *entire*
      // waypoint list — but most levels route through as a single giant
      // leg (dozens to 100+ waypoints), so any pickup that wasn't the
      // single nearest-to-leg-start one was silently skipped for the rest
      // of the leg, however close the bot's route later passed by it (user
      // report, watching gameplay: "doesn't collect all loot, even when
      // right next to his path"). Re-check before every waypoint instead —
      // matches the "collect everything" design intent this function's own
      // doc comment already describes.
      for (const wp of leg.waypoints) {
        const wpDetour = await maybeDetourForLoot(page, map, visitedPickups, profile, mineMemory, openedDoors);
        if (wpDetour.state !== "playing") return wpDetour;
        if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug] leg-walk wp=(${wp.x},${wp.y})`);
        const result = await driveTowardWithReplan(page, wp, map, profile, mineMemory, openedDoors);
        if (process.env.CODEENSTEIN_WPDEBUG) console.log(`[wpdebug]   -> result=${JSON.stringify(result)}`);
        if (result.state !== "playing") return result;
        if (result.reason === "stuck") return { state: "stuck" };
      }
    } else if (leg.kind === "openDoor") {
      // `openDoorAhead()` (engine.ts) only detects the door tile within a
      // short `player.radius + 0.15` (0.35 tile) reach straight ahead of
      // the player's *exact* position — it never fires if the player
      // isn't laterally centered on the door's axis first. The preceding
      // walk leg's last waypoint only guarantees being within `ARRIVE_EPS`
      // (0.15 tiles) of *a* point near the door, not centered on it, so
      // AABB wall-collision with the door frame's corner can stop the
      // player just short of that 0.35 reach whenever it approaches even
      // slightly off-axis — leaving the door forever locked and the
      // bot pushing uselessly against it. Found via the automated anomaly
      // scan: a rare (~1-in-20) 600-tick freeze, correctly aimed
      // (`dir` matching the door's approach angle) with `moveKeys=[KeyW]`
      // held every tick, zero net movement — confirmed via forwarded
      // engine console output that every key on the level had already
      // been collected but the corresponding "door unlocked" message never
      // fired. Fixed by explicitly walking to a staging point centered on
      // the door tile's cross-axis, one tile back along the approach
      // direction, before facing/pushing.
      //
      // First attempt at this fix reused the default `ARRIVE_EPS` (0.15) —
      // but the staging point is mathematically identical to the preceding
      // walk leg's own last waypoint (both derived the same way from the
      // door's coordinates), so arriving there with the *same* loose
      // tolerance gave no additional centering guarantee at all and the
      // freeze recurred (once more, same exact spot, next scan). Passing
      // `TIGHT_ARRIVE_EPS` (0.05, already used for the final exit approach)
      // is what actually guarantees `openDoorAhead`'s reach check succeeds.
      const stagingPoint = {
        x: leg.doorTile.x + 0.5 - leg.approachDir.dx,
        y: leg.doorTile.y + 0.5 - leg.approachDir.dy,
      };
      const staged = await driveTowardWithReplan(page, stagingPoint, map, profile, mineMemory, openedDoors, TIGHT_ARRIVE_EPS);
      if (staged.state !== "playing") return staged;
      const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
      const faced = await faceAngle(page, targetAngle, MAX_TICKS_PER_WAYPOINT, profile, mineMemory, map);
      if (faced.state !== "playing") return faced;
      const held = await holdForwardFine(page, DOOR_OPEN_TICKS * VIRTUAL_STEP_MS, DOOR_OPEN_FINE_STEP_MS);
      if (held.state !== "playing") return held;
      openedDoors.add(`${leg.doorTile.x},${leg.doorTile.y}`);
    }
  }
  return { state: "playing" };
}

function isHazardAt(map, x, y) {
  return map.grid[Math.floor(y)]?.[Math.floor(x)] === HAZARD_TILE;
}

/** Mirrors `src/engine/traps.ts`'s `isSpikeActive` — whether the spike trap
 * (if any) at (x,y) is in its damaging half of the cycle at `levelTime`. */
function activeSpikeAt(map, x, y, levelTime) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const trap = map.spikeTraps.find((t) => t.x === cx && t.y === cy);
  if (!trap) return false;
  const cyclePos = (levelTime + trap.phase) % trap.period;
  return cyclePos >= trap.period / 2;
}

/**
 * Aggressive targeting: prioritize whichever aggroed enemy can be finished
 * off fastest (already in melee range, or an Edge Case — low HP/fast by
 * design, see `Enemy.edgeCase`) over strictly whoever's nearest. Fixes a
 * real death pattern found via `logDeathDetail`'s per-enemy TTK trace: a
 * swarm of several Edge Cases plus 1-2 tankier "normal" enemies, where
 * pure-nearest-first targeting could spend 3-6s locked onto one normal
 * enemy while multiple fast, simultaneously-aggroed Edge Cases kept landing
 * free chip damage in the meantime. Thinning the *numerous, individually
 * weak* attackers first reduces how many are landing hits at once, which
 * matters more for total damage taken than which target happens to be
 * literally closest. Falls back to nearest-first among equally "quick"
 * (or equally "not quick") candidates. This also synergizes with the
 * shotgun-for-clusters logic in `pickRangedWeapon` — the target it now
 * locks onto is more often the swarm itself, not an unrelated single enemy
 * standing apart from it.
 */
// `map` is optional (some callers don't have one on hand) — when omitted,
// every candidate is treated as visible, i.e. the original distance/quick-
// kill-only ranking, unchanged.
function pickThreat(enemies, player, profile, map) {
  // `i` is the enemy's index in the engine's own `this.enemies` array
  // (stable for a whole level — engine.ts only assigns it once at map load
  // and never splices/reorders it, only flips `alive`), captured before any
  // filtering so it still matches the live array. Used by `tick()` to
  // recognize "same enemy as last tick" for the last-visible-position
  // freeze — see its doc comment.
  const candidates = enemies
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.alive && e.aggroed)
    .map((e) => ({
      ...e,
      dist: Math.hypot(e.x - player.x, e.y - player.y),
      visible: !map || hasLineOfSight(map, player.x, player.y, e.x, e.y),
    }))
    .filter((e) => e.dist < profile.engageRadius);
  candidates.sort((a, b) => {
    const aQuick = a.dist <= MELEE_RANGE || a.edgeCase;
    const bQuick = b.dist <= MELEE_RANGE || b.edgeCase;
    if (aQuick !== bQuick) return aQuick ? -1 : 1;
    // Among otherwise-equal-priority candidates, a visible enemy can be
    // engaged (fired on, or approached with intent) immediately; an
    // occluded one first needs the bot to round a corner regardless of how
    // "close" it is. Locking onto the occluded one when a visible
    // alternative exists just delays real engagement — see
    // `driveTowardWithReplan`'s doc comment for the analogous navigation
    // bug this mirrors (short-distance != actually reachable/usable).
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.dist - b.dist;
  });
  return candidates[0];
}

/**
 * Mirrors the engine's own `hasLineOfSight` (`src/engine/enemyAi.ts`):
 * samples every ~0.1 tiles along the line and fails if any sample lands on
 * a wall/unopened-secret/lore tile.
 */
function hasLineOfSight(map, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.1);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallTile(map, x0 + dx * t, y0 + dy * t)) return false;
  }
  return true;
}

function isWallTile(map, x, y) {
  const tile = map.grid[Math.floor(y)]?.[Math.floor(x)];
  return tile === undefined || tile === 1 || tile === 6 || tile === 7;
}

// How far off `navTarget`'s direction a mine can be and still be worth a
// proactive detour-and-shoot — see `findDisarmableMine`'s doc comment for
// why this exists. `Math.PI/2` = a mine has to be somewhere in the forward
// hemisphere (90° either side of the intended heading), not behind the
// player.
const MINE_DISARM_MAX_ANGLE_FROM_PATH = Math.PI / 2;
// How tight to keep refining aim on a mine while `player.wouldMineHit` is
// still false — much tighter than any profile's `fireAngleEps`, since a
// mine's on-screen hit window is narrower than that at typical disarm
// range (see `wouldMineHit`'s doc comment in engine.ts). Small enough that
// further turning stops mattering once reached; `wouldMineHit` itself (not
// this) is what actually gates firing.
const MINE_REALIGN_EPS = 0.01;

/**
 * A mine only counts as "disarmable from here" if there's a clear shot —
 * `visible` only means the mine has been *spotted* (within the engine's
 * MINE_SIGHT_RADIUS), not that it's actually hittable from the player's
 * current position. Without this check, a mine behind a wall corner (still
 * "visible" and within `MINE_DISARM_RANGE`) got targeted and fired at
 * anyway — every shot hit the wall instead, never the mine, burning up to
 * `MINE_TARGET_GIVEUP_TICKS` uselessly each time it (or another run on the
 * same deterministic map) encountered it. Found via a `DEBUG_FIRE=1` trace:
 * a single mine position was fired at 60-74 times total across a couple of
 * attempts, all at an identical "aligned" angle that should have connected.
 *
 * Also excludes mines well off to the side of or behind `navTarget`'s
 * direction (see `MINE_DISARM_MAX_ANGLE_FROM_PATH`): without this, *any*
 * visible mine within disarm range got targeted regardless of angle,
 * including ones almost directly behind the player relative to where it
 * was actually headed — confirmed via trace: the bot would swing ~150-180°
 * around to shoot a mine, then swing another ~150-180° back to resume its
 * original heading, for a mine that was never actually going to be walked
 * over. A mine this far off-path isn't a real threat to the route; it's
 * cheaper to just leave it (the reactive "back away if it becomes
 * dangerous" retreat logic in `tick()` still applies regardless of angle,
 * so this doesn't affect actual safety).
 */
function findDisarmableMine(mines, player, abandoned, map, navTarget) {
  const navAngle = navTarget ? Math.atan2(navTarget.y - player.y, navTarget.x - player.x) : null;
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist > MINE_BLAST_RADIUS && m.dist <= MINE_DISARM_RANGE)
    .filter((m) => hasLineOfSight(map, player.x, player.y, m.x, m.y))
    .filter((m) => {
      if (navAngle === null) return true;
      const mineAngle = Math.atan2(m.y - player.y, m.x - player.x);
      return Math.abs(angleDelta(navAngle, mineAngle)) <= MINE_DISARM_MAX_ANGLE_FROM_PATH;
    })
    .sort((a, b) => a.dist - b.dist)[0];
}

/** A visible mine close enough to be actively dangerous (inside its own
 * blast radius) rather than just a target to line up a shot on — "stop, back
 * up" comes before "shoot" (see `tick()`'s mine-handling doc comment). */
function findDangerousMine(mines, player, abandoned) {
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist <= MINE_BLAST_RADIUS)
    .sort((a, b) => a.dist - b.dist)[0];
}

function hasAmmoFor(player, weaponIndex) {
  if (weaponIndex === 0 || weaponIndex === 1) return player.ammo.bullets > 0;
  if (weaponIndex === GDB_WEAPON_INDEX) return player.ammo.smg > 0;
  if (weaponIndex === GHIDRA_WEAPON_INDEX) return player.ammo.rockets > 0;
  if (weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX) return player.ammo.gas > 0;
  return true;
}

// How close two aggroed enemies have to be to each other to count as
// "clustered" — worth switching to a spread weapon for (see `pickRangedWeapon`).
const CLUSTER_RADIUS = 3;
// Rockets splash the shooter too (see engine.ts's ROCKET_BLAST_RADIUS=2.6) —
// never select ghidra as the situational/priority pick against a target this
// close, regardless of profile. Directly fixes an observed death: a run
// fired a rocket at a target barely out of the spawn room and killed itself
// with the splash 0.3s into the level (45 self-rocket damage, 0 other damage).
const ROCKET_SAFE_DISTANCE = 4;
// Mirrors src/engine/rockets.ts's ROCKET_ENEMY_TRIGGER_RADIUS — how close a
// rocket's flight path has to pass an enemy to detonate on it early. Needed
// here (not just aimDist) because a rocket detonates on the FIRST living
// enemy its path comes this close to, not necessarily the intended target —
// see `nearestRocketDetonationDistance`'s doc comment.
const ROCKET_ENEMY_TRIGGER_RADIUS = 0.4;

/**
 * Distance along the player's current firing ray to the nearest point where
 * an in-flight rocket would actually detonate against a living enemy — not
 * just the intended target's own distance. `updateRockets` (engine) explodes
 * a rocket on the FIRST living enemy it comes within `ROCKET_ENEMY_TRIGGER_
 * RADIUS` of, tracked or not; checking only the intended target's distance
 * (the original, insufficient fix) misses an untracked enemy sitting between
 * the player and the target, or just off to the side of the flight path,
 * which can trigger a much closer detonation than the bot accounted for.
 * Confirmed via balance telemetry: after the target-distance-only fix
 * shipped, Pro/Normal's self-rocket death share got *worse* (20%→29%) across
 * a full re-collection, while three other affected combos improved — this
 * path-blind gap is the leading suspect.
 *
 * Deliberately doesn't account for walls between the player and an in-path
 * enemy (would need a real raycast sweep, not just this straight-line
 * projection) — a rare enough edge case not worth the added complexity here.
 */
function nearestRocketDetonationDistance(player, enemies) {
  let nearest = Infinity;
  const dirX = player.dirX;
  const dirY = player.dirY;
  const triggerSq = ROCKET_ENEMY_TRIGGER_RADIUS * ROCKET_ENEMY_TRIGGER_RADIUS;
  for (const e of enemies) {
    if (!e.alive) continue;
    const ex = e.x - player.x;
    const ey = e.y - player.y;
    const t = ex * dirX + ey * dirY; // distance along the firing ray to closest approach
    if (t < 0 || t >= nearest) continue; // behind the player, or already not the closest
    const perpSq = ex * ex + ey * ey - t * t;
    if (perpSq <= triggerSq) nearest = t;
  }
  return nearest;
}

/**
 * True if firing a rocket right now is unsafe. Two independent reasons:
 *
 * 1. `isMineTarget` — a rocket has ZERO interaction with mines. Unlike every
 *    hitscan weapon (which explicitly checks `findMineInProjections` and
 *    calls `destroyMine`, per `RaycasterEngine`'s fire handler), a rocket
 *    goes through `spawnRocket`/`updateRockets` instead, which only ever
 *    checks `nearLivingEnemy`/`isWall` — confirmed by reading both call
 *    sites, not assumed. A rocket "aimed at" a mine flies straight through
 *    it, doing nothing, and keeps travelling until it hits a wall or a
 *    living enemy — at a distance the mine's own `dist` says nothing about.
 *    The bot has no map-aware wall-distance estimate to fall back on, so the
 *    only correct answer is: never fire a rocket at a mine, at any distance.
 *    Confirmed via a concurrency=1 diagnostic trace: the previous
 *    (target-distance-only) mine-targeting check let the bot fire Ghidra
 *    repeatedly at the same never-actually-threatened mine, each shot flying
 *    off to an unaccounted-for wall.
 * 2. The intended target (an actual enemy) or some other untracked living
 *    enemy sits close enough to the flight path to trigger an earlier,
 *    closer detonation than expected. See `nearestRocketDetonationDistance`.
 */
function rocketAimUnsafe(player, enemies, aimDist, isMineTarget) {
  if (isMineTarget) return true;
  if (aimDist !== null && aimDist < ROCKET_SAFE_DISTANCE) return true;
  return nearestRocketDetonationDistance(player, enemies) < ROCKET_SAFE_DISTANCE;
}

// Matches Friday Hotfix's real `maxRange` (weapons.ts) — beyond this its
// pellets can't even reach the target, so there's no point selecting it.
const FRIDAY_HOTFIX_MAX_RANGE = 3.5;
// How far a clustered threat needs to be before rocket splash is worth
// preferring over the flamethrower/shotgun, for skill tiers confident enough
// to use it that way (see `rocketForDistantClusters`). Set comfortably past
// `ROCKET_SAFE_DISTANCE` (4) rather than right at it, so this doesn't flip-
// flop with the safety check at the boundary — a cluster only counts as
// "distant" once it's unambiguously past the point rockets are even
// considered safe.
const ROCKET_CLUSTER_MIN_DIST = ROCKET_SAFE_DISTANCE + 1;

/**
 * Best ranged weapon for the current situation — not just a fixed per-
 * profile preference order. "Ranged weapons according to situation" (user
 * directive): once 2+ aggroed enemies are clustered near the current threat,
 * picks a weapon suited to the cluster's distance rather than always
 * reaching for the same spread weapon —
 * - **Close** (within Friday Hotfix's real range): the flamethrower first —
 *   a sustained cone directly in front does more against a tight, close
 *   group than one shotgun blast — falling back to Regex Shotgun if Friday
 *   Hotfix isn't owned/ammo'd.
 * - **Distant**, and only for skill tiers confident enough to use rockets
 *   this way (`profile.rocketForDistantClusters` — Casual is more hesitant
 *   with a self-splash-capable launcher, same reasoning as its
 *   `weaponPriority` ordering): Ghidra, splashing the whole distant group at
 *   once instead of one target at a time — still gated by `rocketAimUnsafe`,
 *   so this never overrides the self-splash safety check.
 * - **Everything else** (mid-range, or a distant cluster on a profile that
 *   doesn't trust rockets for this): Regex Shotgun, broad enough to be a
 *   reasonable default regardless of exact range.
 *
 * Falls back to `profile.weaponPriority` for a single, isolated target (not
 * clustered) or once none of the above apply. Never selects ghidra within
 * `ROCKET_SAFE_DISTANCE` regardless of source, at any priority — self-splash
 * damage isn't worth it that close. Never returns a melee index — melee
 * always goes through quick-melee (Space), never the equipped ranged slot
 * (mirrors `currentMeleeWeapon` in `src/engine/weapons.ts`).
 */
function pickRangedWeapon(player, profile, enemies, threat, mineTarget) {
  if (threat) {
    const clusterCount = enemies.filter(
      (e) => e.alive && e.aggroed && Math.hypot(e.x - threat.x, e.y - threat.y) <= CLUSTER_RADIUS,
    ).length;
    if (clusterCount >= 2) {
      if (threat.dist <= FRIDAY_HOTFIX_MAX_RANGE) {
        if (player.ownedWeapons.includes(FRIDAY_HOTFIX_WEAPON_INDEX) && hasAmmoFor(player, FRIDAY_HOTFIX_WEAPON_INDEX)) {
          return player.weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX ? null : FRIDAY_HOTFIX_WEAPON_INDEX;
        }
      } else if (
        threat.dist >= ROCKET_CLUSTER_MIN_DIST &&
        profile.rocketForDistantClusters &&
        player.ownedWeapons.includes(GHIDRA_WEAPON_INDEX) &&
        hasAmmoFor(player, GHIDRA_WEAPON_INDEX) &&
        !rocketAimUnsafe(player, enemies, threat.dist, false)
      ) {
        return player.weaponIndex === GHIDRA_WEAPON_INDEX ? null : GHIDRA_WEAPON_INDEX;
      }
      if (player.ownedWeapons.includes(1) && hasAmmoFor(player, 1)) {
        return player.weaponIndex === 1 ? null : 1; // Regex Shotgun
      }
    }
  }
  // The doc comment above already claimed "never selects ghidra within
  // ROCKET_SAFE_DISTANCE regardless of source" — but the code only ever
  // checked `threat.dist`, so a mine target (aimed at with `threat` null)
  // never went through this exclusion at all. Fixed once already (checking
  // `mineTarget.dist` too via `aimDist`), then fixed again: `mineTarget.dist`
  // was never the right thing to check in the first place, since a rocket
  // has no interaction with mines at all and flies through to an
  // unaccounted-for wall — see `rocketAimUnsafe`'s doc comment. Ghidra is
  // now excluded outright whenever the aim source is a mine, not just when
  // it's judged "too close".
  const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
  for (const idx of profile.weaponPriority) {
    if (idx === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget))) continue;
    if (!player.ownedWeapons.includes(idx)) continue;
    if (!hasAmmoFor(player, idx)) continue;
    return player.weaponIndex === idx ? null : idx;
  }
  return null;
}

/** One tick: combat (or proactive mine-disarm) always preempts navigation,
 * same as the base bot — see module doc comment on why `engageRadius` is
 * uniform across profiles. Hazard-crossing suppresses combat entirely (see
 * below) rather than detouring to a "safe tile", which made things worse —
 * the nearest safe edge tile is often not on the way to the real
 * destination, so the bot would reach it and immediately walk back into the
 * same hazard pursuing its actual target, each round trip costing HP for no
 * progress (confirmed by tracing real runs).
 *
 * `mineMemory` (`{key, ticks}`, created once per level in `playRun` and
 * threaded down through every `driveToward`/`faceAngle`/`maybeDetourFor*`
 * call so it accumulates across waypoint/leg boundaries — see `playRun`'s
 * doc comment for why a shorter-lived scope doesn't work) caps how long the
 * bot will keep re-targeting the *same* mine or retreating from the *same*
 * one — see `MINE_TARGET_GIVEUP_TICKS`'s doc comment for why this is needed
 * once `MINE_DISARM_RANGE` is wide enough that a "visible" mine isn't
 * guaranteed to be a clean shot.
 */
async function tick(page, player, enemies, mines, navTarget, profile, map, mineMemory) {
  checkRotationAnomaly(mineMemory, player, Math.atan2(player.dirY, player.dirX));
  // Currently standing on a damaging ground tile (hazard, or a spike trap
  // that flipped active): don't stop to fight (or proactively disarm a
  // mine) — just keep marching toward wherever the bot was already headed,
  // crossing/leaving it as fast as possible instead of trading shots while
  // parked in it. This has to be checked *before* combat/mine-targeting
  // priority, not just inside the navTarget-only branch below (which is
  // skipped entirely whenever a threat/mine is being aimed at) — the
  // preventive "don't step onto an active spike tile" check further down
  // only helps while peacefully navigating; if an enemy aggroes *while* the
  // bot happens to be standing on hazard or an active spike, that branch
  // never runs at all and the bot just stands there taking damage for the
  // whole fight (confirmed both for hazard originally, and for spikes via
  // the same bug: traced 7-27 spike damage/run where the wait-before-
  // stepping logic in the navTarget branch was correct but unreachable
  // during combat). No effect when there's no `navTarget` to fall back to
  // (e.g. `faceAngle` during a door-open leg) — rare enough not to special-case.
  if (map && navTarget && (isHazardAt(map, player.x, player.y) || activeSpikeAt(map, player.x, player.y, player.levelTime))) {
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const dist = Math.hypot(navTarget.x - player.x, navTarget.y - player.y);
    // Sprint (2x MOVE_SPEED, see engine.ts's SPRINT_MULTIPLIER) unconditionally
    // while standing on hazard/an active spike — *including* while still
    // turning to face `navTarget`, unlike the plain-navigation branch (which
    // caps walk-while-turning to avoid a wrong-direction detour, a tradeoff
    // that only makes sense without any urgency). Arriving here at a large
    // misalignment is routine, not rare: the mine-retreat and critical-health
    // branches back away in whatever direction points away from the danger,
    // with no awareness of what's underfoot, so landing on hazard already
    // facing far from `navTarget` happens often. Freezing to turn in place
    // first (the previous behavior) meant taking full, uninterrupted tick
    // damage for as long as the turn took — confirmed via screen recording:
    // health draining 100%->85% over several seconds with the camera static,
    // only slowly rotating, after a mine-retreat backed the bot onto acid.
    // Any movement reduces total exposure versus none, even imperfectly
    // aimed, since standing still is never free here.
    const moveKeys = new Set(["KeyW", "ShiftLeft"]);
    let turnBurst;
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      // Deliberately no `diagonalStrafeKey` here — see its doc comment's
      // "confirmed regression" note. Reverted from every branch except plain
      // navigation after an A/B test showed diagonal movement (even at the
      // engine's now-normalized speed) still measurably hurt Casual's
      // survival (72% vs 0% level-2 death rate at matched scale), most
      // likely via subtle trajectory/positioning shifts a low-aim-tolerance
      // profile can least absorb — worse during actual danger (hazard,
      // critical health, mine retreat, ranged aiming) than during open
      // hallway travel.
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
    } else {
      // Capped via `moveBurstMs` so a sprint step can't blow past `navTarget`
      // and oscillate forever around it — see that helper's doc comment for
      // the fatal stuck-in-hazard case this fixes.
      turnBurst = moveBurstMs(dist, true);
    }
    recordTrace(mineMemory, { branch: "hazard", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
    return applyAction(page, moveKeys, false, null, false, turnBurst);
  }

  const threat = pickThreat(enemies, player, profile, map);

  // Critical health: break contact instead of trading hits — see
  // `CRITICAL_HEALTH_FRACTION`'s doc comment. Turn to face directly away
  // from the nearest threat and sprint (same reasoning as the hazard-
  // crossing sprint above: distance is what matters, not damage output
  // right now) rather than turning toward it to line up a shot. A losing
  // fight against multiple enemies can still end in death here (an aggroed
  // enemy keeps chasing — this doesn't guarantee escape), but it stops the
  // bot from *choosing* to keep standing and trading hits once survival
  // odds are already this bad.
  if (threat && player.healthFraction < CRITICAL_HEALTH_FRACTION) {
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const awayAngle = Math.atan2(player.y - threat.y, player.x - threat.x);
    const delta = angleDelta(currentAngle, awayAngle);
    // Sprint away unconditionally, *including* while still turning to face
    // directly away — the same "turn-only, no movement" defect as the
    // hazard-escape branch (see its doc comment) was found here too via the
    // automated anomaly scan: multiple runs stood frozen turning in place
    // for 60-100+ consecutive ticks at critical health, taking free hits the
    // whole time, and dying (hpFrac reaching 0.00) without ever actually
    // retreating a single tile. An imperfectly-aimed retreat step is still
    // strictly better than standing still at the edge of death.
    const moveKeys = new Set(["KeyW", "ShiftLeft"]);
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      // Deliberately no `diagonalStrafeKey` here — see its doc comment's
      // "confirmed regression" note; reverted from every danger branch.
    }
    // A blocked "away" vector (cornered retreat) still won't move the
    // player no matter how unconditional the sprint above is. This branch
    // returns before the shared end-of-tick `combatStallTicks` bookkeeping
    // ever runs, so it needs its own same-position tracking — see
    // `CRITICAL_STALL_TICKS_THRESHOLD`'s doc comment.
    if (mineMemory) {
      const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
      if (mineMemory.criticalStallPos === posKey) {
        mineMemory.criticalStallTicks = (mineMemory.criticalStallTicks ?? 0) + 1;
      } else {
        mineMemory.criticalStallPos = posKey;
        mineMemory.criticalStallTicks = 0;
      }
      if (mineMemory.criticalStallTicks >= CRITICAL_STALL_TICKS_THRESHOLD) {
        // Take sole control of the strafe key here — `diagonalStrafeKey`
        // above may have already added the *opposite* direction (it tracks
        // `delta`'s sign, which stays fixed while cornered, not the
        // alternation this stall-breaker needs). Both keys held at once
        // cancel out via the engine's per-axis strafe resolution, silently
        // neutering this alternation and reproducing the exact frozen-
        // critical-health symptom it was added to fix.
        moveKeys.delete("KeyD");
        moveKeys.delete("KeyA");
        moveKeys.add(
          Math.floor(mineMemory.criticalStallTicks / CRITICAL_STALL_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA",
        );
      }
    }
    // Deliberately *not* `turnBurstMs` here, unlike combat-aiming branches —
    // that helper caps duration to protect a narrow hit-window from
    // overshoot, but fleeing has no such window: "roughly away" is exactly
    // as good as "precisely away". Using it anyway meant the same
    // near-zero-duration trap as the hazard-escape/melee-corner bugs: a
    // small residual "face away" angle produced a ~1ms turnBurst, which then
    // also throttled the always-added KeyW/ShiftLeft to an imperceptible
    // fraction of a tile — confirmed via the automated scan still finding
    // 90+ tick critical-health freezes (hpFrac draining toward 0) even after
    // the fix above. A full sprint step every tick, overshooting the exact
    // "away" angle if needed, still converges toward genuinely-away — it
    // just doesn't stall doing it.
    const turnBurst = moveBurstMs(10, true);
    recordTrace(mineMemory, { branch: "criticalHealth", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: threat.dist, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
    return applyAction(page, moveKeys, false, null, false, turnBurst);
  }

  // Proper mine handling: stop, back up out of blast range, shoot it, then
  // continue — not just "shoot any mine that happens to already be at a safe
  // distance" (the previous behavior, which left the bot doing nothing
  // useful whenever a mine was spotted too close to safely target). Backing
  // away takes priority over actually shooting (below) since you can't line
  // up a *safe* shot from inside your own target's blast radius in the
  // first place. Gated behind `!threat` like the rest of mine-handling — an
  // active enemy fight still wins (backing away from a mine with an enemy
  // still shooting at you is its own risk this doesn't try to weigh).
  if (!threat && profile.proactiveMineDisarm) {
    const dangerMine = findDangerousMine(mines, player, mineMemory?.abandoned);
    if (dangerMine) {
      const key = `${dangerMine.x},${dangerMine.y}`;
      let gaveUp = false;
      if (mineMemory) {
        mineMemory.retreatTicks = mineMemory.retreatKey === key ? mineMemory.retreatTicks + 1 : 1;
        mineMemory.retreatKey = key;
        gaveUp = mineMemory.retreatTicks > MINE_TARGET_GIVEUP_TICKS;
        if (gaveUp) mineMemory.abandoned.add(key); // e.g. wedged against a wall — stop trying, in either mode, for the rest of the level
      }
      if (!gaveUp) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const awayAngle = Math.atan2(player.y - dangerMine.y, player.x - dangerMine.x);
        const delta = angleDelta(currentAngle, awayAngle);
        // Always move (diagonally, while still turning if needed) instead of
        // stopping to fully face `awayAngle` first — same "any movement beats
        // freezing to turn in place" reasoning as the hazard/critical-health
        // branches (see their doc comments), applied here too since this
        // branch previously never combined a turn with forward movement at
        // all (turn-only while misaligned, walk-only once aligned).
        const moveKeys = new Set(["KeyW"]);
        let turnBurst;
        if (Math.abs(delta) > TURN_MOVE_EPS) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          // Deliberately no `diagonalStrafeKey` here — see its doc comment's
          // "confirmed regression" note; reverted from every danger branch.
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
        } else {
          turnBurst = moveBurstMs(10, false);
        }
        recordTrace(mineMemory, { branch: "mineRetreat", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: dangerMine.dist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
        return applyAction(page, moveKeys, false, null, false, turnBurst);
      }
      // else: gave up retreating — fall through to normal navigation below
      // rather than freezing here (this mine is now in `abandoned`, so
      // `findDisarmableMine` right below won't just immediately re-target it).
    }
  }

  let mineTarget = !threat && profile.proactiveMineDisarm && map ? findDisarmableMine(mines, player, mineMemory?.abandoned, map, navTarget) : null;
  if (mineTarget && mineMemory) {
    const key = `${mineTarget.x},${mineTarget.y}`;
    mineMemory.shootTicks = mineMemory.shootKey === key ? mineMemory.shootTicks + 1 : 1;
    mineMemory.shootKey = key;
    if (mineMemory.shootTicks > MINE_TARGET_GIVEUP_TICKS) {
      mineMemory.abandoned.add(key); // e.g. a wall blocks line of fire — stop trying, in either mode, for the rest of the level
      mineTarget = null;
    }
  }
  // A threat's aggro is sticky (see the "Don't fire at an aggroed-but-
  // currently-occluded threat" comment below), but `threat.x/y` is the
  // enemy's live, continuously-updated position from the engine, even while
  // it's behind a wall the bot can't see through. Aiming — turning to face,
  // and therefore also walking toward, since movement is relative to facing
  // — exactly at that live position the whole time looks like the bot has
  // X-ray vision, tracking an invisible enemy's every move (user report,
  // watching gameplay: "aims at stuff he cant see because of a wall in the
  // LOS"). Real knowledge is bounded: freeze the aim at wherever the threat
  // was *last actually seen* while occluded, only resuming live tracking
  // once `threat.visible` is true again. Keyed by `threat.i` (the enemy's
  // stable index into the engine's own enemy array — never reordered or
  // spliced, only `alive` flips, see `pickThreat`) so switching to a
  // *different* aggroed enemy doesn't inherit a stale frozen position left
  // over from whichever enemy was tracked before. Firing itself was already
  // correctly gated on a fresh, live `hasLineOfSight` check regardless (see
  // below) — this only changes where the bot visibly looks, never whether
  // it can cheat a shot.
  let threatAim = threat;
  if (threat && mineMemory) {
    if (threat.visible) {
      mineMemory.lastVisibleThreat = { i: threat.i, x: threat.x, y: threat.y };
    } else if (mineMemory.lastVisibleThreat?.i === threat.i) {
      threatAim = mineMemory.lastVisibleThreat;
    }
    // else: aggroed without this specific enemy ever having been seen yet
    // (aggro can trigger through walls, e.g. proximity, so this isn't rare)
    // — no memory to fall back on, so aim at the live position same as
    // before this fix. Only matters for the brief window before the bot
    // first lays eyes on it; every occlusion after that first sighting is
    // covered by the freeze above.
  }
  const aimTarget = threatAim ?? mineTarget;
  // Read the stall counter as last tick left it (updated at the bottom of
  // this function, after `fire` is known) — see `COMBAT_STALL_TICKS_THRESHOLD`'s
  // doc comment.
  const stallStrafeKey =
    threat && mineMemory && (mineMemory.combatStallTicks ?? 0) >= COMBAT_STALL_TICKS_THRESHOLD
      ? Math.floor(mineMemory.combatStallTicks / COMBAT_STALL_STRAFE_FLIP_TICKS) % 2 === 0
        ? "KeyD"
        : "KeyA"
      : null;

  const currentAngle = Math.atan2(player.dirY, player.dirX);
  const moveKeys = new Set();
  let turnBurst;
  let fire = false;
  let weaponSwitch = null;
  if (DEBUG_NAV) {
    console.log(
      `[nav] pos=(${player.x.toFixed(2)},${player.y.toFixed(2)}) dir=${currentAngle.toFixed(2)} hpFrac=${player.healthFraction.toFixed(2)} ` +
        `threat=${threat ? `(${threat.x.toFixed(1)},${threat.y.toFixed(1)},dist=${threat.dist.toFixed(1)})` : "none"} ` +
        `mineTarget=${mineTarget ? `(${mineTarget.x},${mineTarget.y})` : "none"} navTarget=${navTarget ? `(${navTarget.x.toFixed(2)},${navTarget.y.toFixed(2)})` : "none"} ` +
        `weaponIndex=${player.weaponIndex} ammo=${JSON.stringify(player.ammo)} owned=${JSON.stringify(player.ownedWeapons)}`,
    );
  }
  let useMelee = false;
  let waitingOnSpike = false;

  if (aimTarget) {
    const targetAngle = Math.atan2(aimTarget.y - player.y, aimTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    // Melee-in-range is a universal tactical choice for every profile: free
    // (no ammo cost), and the knife/Toolchain's lifesteal is the single
    // biggest survivability lever there is, including for "unskilled"
    // Casual — a struggling bot should still finish off an adjacent enemy
    // by hand rather than keep missing with a wide Cone-of-Fire cone at
    // point-blank range. No profile proactively closes distance to force a
    // melee opportunity (see the module doc comment's note on why
    // `meleeRush` was removed) — enemies close distance on their own via
    // chase AI, so this only ever fires opportunistically. Checked *before*
    // the ranged `fireAngleEps` gate below. Gated on `player.meleeWouldHit`
    // (the engine's own crosshair-column hit test — see its doc comment)
    // rather than a fixed angle tolerance: a melee swing only lands within
    // the target's on-screen width, which shrinks with distance (even
    // inside melee range) and with an Edge Case's smaller sprite scale, so
    // no single static epsilon is ever correct — a fixed 0.6 rad tolerance
    // was found to fire hundreds of whiffed swings against one Edge Case
    // near the far edge of melee range before giving up (confirmed via
    // trace: `aliveAggroed` unchanged and `hp` unchanged across 400+
    // consecutive `useMelee` ticks). `delta`'s sign still picks which way to
    // turn — only the *decision to actually swing* changed.
    if (threat && threat.dist <= MELEE_RANGE) {
      if (!player.meleeWouldHit) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        // `delta` is the exact angle to the target, so turning by no more
        // than `delta` lands as close to perfectly aligned as possible —
        // always within whatever the actual (distance/size-dependent, not
        // known here) hit window turns out to be, without ever overshooting
        // past it. See `turnBurstMs`'s doc comment for why a fixed-duration
        // key-hold isn't safe once turning is fast enough to blow past a
        // narrow window in one step.
        turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
        // Also keep closing the last bit of distance, not just re-aiming in
        // place — `meleeWouldHit`'s on-screen hit window narrows the farther
        // out it's checked, and an enemy this "close" (already inside
        // MELEE_RANGE) isn't guaranteed to actually be closing distance on
        // its own: the engine's chase AI only holds an enemy still to bite
        // once within its own much smaller ATTACK_RADIUS, so between there
        // and MELEE_RANGE it's still walking (and can visibly drift/round a
        // corner) while the bot was previously doing nothing but turn.
        // Confirmed via headless trace: a threat sitting at dist 1.4 with a
        // narrow, drifting hit window produced 95 consecutive stalled ticks
        // (no forward movement, meleeWouldHit never true) before this fix.
        if (map && threat.dist > MELEE_CLOSE_MIN_DISTANCE) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
            moveKeys.add("KeyW");
          }
        }
        // See `COMBAT_STALL_TICKS_THRESHOLD`'s doc comment — turning and
        // walking forward both do nothing once pinned against a wall
        // corner, so nudge sideways instead once that's been going on long
        // enough to be sure it's not just an ordinary in-progress approach.
        if (stallStrafeKey) {
          moveKeys.add(stallStrafeKey);
          // `turnBurst` above was sized for a near-zero residual turn angle
          // (as little as 1ms) — reusing that same tiny duration as the
          // held-key time for the strafe key added here would move the
          // player an imperceptible fraction of a tile, defeating the whole
          // point. Found via the automated anomaly scan: the strafe key was
          // confirmed present in the actual action log every tick, yet
          // position never moved at all, because it was only ever held for
          // ~1-2ms. Force a full step's worth of hold time whenever actually
          // trying to strafe out of a stall — the fine turn precision this
          // tick would normally protect doesn't matter once the bot has
          // already been stuck in place for `COMBAT_STALL_TICKS_THRESHOLD`
          // ticks.
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false));
        }
      } else {
        fire = true;
        useMelee = true;
      }
    } else {
      // Don't fire at an aggroed-but-currently-occluded threat: aggro is
      // sticky (an enemy that was once visible stays aggroed even after
      // ducking behind a corner or being chased around one), so an aligned
      // angle doesn't guarantee a clear shot. Without this, the bot would
      // "fire" straight into the wall corner every tick it happened to be
      // angle-aligned with an occluded enemy, burning ammo for zero effect
      // (the engine's own `fire()` already silently no-ops a shot whose
      // column projects onto a wall before the target — see
      // `findTargetInProjections`'s z-buffer check — so this wasted ammo
      // was never even landing). Mirrors the mine-targeting fix
      // (`findDisarmableMine`'s `hasLineOfSight` requirement) for the same
      // reason.
      const hasLos = !threat || !map || hasLineOfSight(map, player.x, player.y, threat.x, threat.y);
      // A stationary mine's on-screen width at typical disarm range is
      // narrower than any fixed `fireAngleEps` tolerance — same underlying
      // issue as melee's `meleeWouldHit`, but for a *ranged* shot, where
      // Cone-of-Fire deviation is also in play. Without this, the bot could
      // sit "angle-aligned" per `fireAngleEps` and fire dozens of times
      // while only occasionally actually connecting (confirmed via trace: a
      // mine survived ~30 point-blank, perfectly-angle-aligned shots before
      // finally dying). `player.wouldMineHit` is the engine's own
      // conservative (worst-case-deviation) hit test — gate firing on it,
      // and keep refining aim toward exact alignment (not just
      // `fireAngleEps`) while it's not yet true, same as an unaligned angle.
      // `mineMemory.shootTicks` (bumped above, before any of this aim logic
      // runs) already counts consecutive ticks spent on this exact mine —
      // reused here as a stall counter: once realignment has been stuck long
      // enough that it's clearly not going to cleanly converge (see
      // `MINE_REALIGN_STALL_TICKS`'s doc comment), stop insisting on
      // `wouldMineHit` and just take the shot at the current best-effort
      // alignment instead of freezing until the much-later full give-up.
      const mineRealignStalled = Boolean(mineMemory) && mineMemory.shootTicks > MINE_REALIGN_STALL_TICKS;
      const mineNotReady = !threat && !player.wouldMineHit && !mineRealignStalled;
      if (Math.abs(delta) > profile.fireAngleEps || !hasLos || mineNotReady) {
        if (Math.abs(delta) > (mineNotReady ? MINE_REALIGN_EPS : profile.fireAngleEps)) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          // Deliberately no `diagonalStrafeKey` here — see its doc comment's
          // "confirmed regression" note; reverted from every danger/combat
          // branch (not added to the melee branch above either, where the
          // turn is a precision aim adjustment for a swing about to land,
          // not a "get moving" approach).
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
        }
        // Keep closing distance while lining up a ranged shot (or trying to
        // clear a blocked corner) instead of planting both feet the instant
        // a threat is spotted — a real player doesn't freeze completely
        // just because their aim/sightline isn't perfect yet. Threat-only
        // (not while aiming at a mine, where closing distance risks
        // entering the blast radius) and only while still comfortably
        // outside melee range, so this can't walk the bot into melee
        // mid-turn. Also don't step onto a hazard/active-spike tile just to
        // chase a shot — the top-of-function hazard override only reacts
        // *after* already standing on one; this is what stops it from
        // walking onto one in the first place (found via trace: a run died
        // to 108.9 hazard damage after this movement addition, having
        // walked straight into acid while turning toward a distant enemy).
        // The `!hasLos` half of this OR is required even *inside*
        // `MIN_RANGED_APPROACH_DISTANCE` — an aggroed enemy stuck behind a
        // corner at close range (already angle-aligned, so `delta` stays
        // ~0) would otherwise never approach *or* fire, freezing solid until
        // the enemy's own chase AI happened to close the gap on its own
        // (confirmed via headless trace: 155 consecutive stalled ticks,
        // moveKeys=[] and fire=false throughout, against a threat sitting at
        // dist 2.6-3.1 with a constant heading).
        if (threat && (threat.dist > MIN_RANGED_APPROACH_DISTANCE || !hasLos) && map) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
            moveKeys.add("KeyW");
          }
        }
        // See `COMBAT_STALL_TICKS_THRESHOLD`'s doc comment and the matching
        // melee-branch comment above for why `turnBurst` also needs bumping
        // here, not just adding the key. Also takes sole control of the
        // strafe key — see the matching `criticalHealth` branch comment:
        // `diagonalStrafeKey` above may have already added the opposite
        // direction (tied to `delta`'s sign, not this alternation), and
        // both held at once cancel out via the engine's per-axis strafe
        // resolution, silently neutering the stall-breaker.
        if (stallStrafeKey) {
          moveKeys.delete("KeyD");
          moveKeys.delete("KeyA");
          moveKeys.add(stallStrafeKey);
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false));
        }
      } else {
        weaponSwitch = pickRangedWeapon(player, profile, enemies, threat, mineTarget);
        // `pickRangedWeapon`'s own Ghidra exclusion only ever gates which
        // weapon gets *selected* — it has no way to say "don't fire at
        // all". If Ghidra was already equipped (chosen safely on an earlier
        // tick, before the target closed distance) and nothing else has
        // ammo, the loop inside it exhausts and returns `null` —
        // indistinguishable here from "already on the correct, safe
        // weapon" — and firing proceeded anyway with the now-unsafe rocket.
        // Confirmed via balance telemetry: self-rocket splash accounted for
        // 29% of all Pro/Easy deaths and 20% of Gamer/Easy's — a
        // disproportionate share given rockets deal less average damage per
        // level-visit than mines do (not the single leading cause of death
        // anywhere; that's enemy melee everywhere, in both pre- and post-fix
        // data — an earlier version of this comment and the published
        // report both claimed otherwise, incorrectly). Re-check the
        // *effective* weapon (the switch target, or whatever's already
        // equipped if no switch is happening) against the same safety check
        // right before actually firing, not just at selection time — a real
        // player holding an empty-handed rocket launcher at point-blank
        // range wouldn't pull the trigger just because nothing better is in
        // their inventory. Covers both the threat and mine-targeting aim
        // contexts, plus untracked in-path enemies (see `rocketAimUnsafe`'s
        // doc comment) — a target-distance-only version of this check
        // shipped first and improved 3 of 4 affected combos, but made
        // Pro/Normal's self-rocket rate *worse* (20%→29%). Root cause,
        // confirmed by reading `RaycasterEngine`'s fire handler: a rocket has
        // no interaction with mines at all (`spawnRocket` bypasses the
        // hitscan mine-detection path entirely) — mine-targeting's `aimDist`
        // was never a meaningful safety proxy to begin with, since the
        // rocket flies straight through the mine to an unaccounted-for wall.
        // Ghidra is now excluded outright for mine-targeting, not just
        // gated on distance.
        const effectiveWeapon = weaponSwitch ?? player.weaponIndex;
        const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
        const rocketUnsafe = effectiveWeapon === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget));
        fire = !rocketUnsafe;
      }
    }
  } else if (navTarget) {
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const aheadX = player.x + player.dirX * 0.6;
    const aheadY = player.y + player.dirY * 0.6;
    const blockedAhead = map && activeSpikeAt(map, aheadX, aheadY, player.levelTime);
    waitingOnSpike = Boolean(blockedAhead);
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
      // Walk while still correcting heading — don't stop-start at every
      // waypoint transition just because it needs a moderate heading
      // correction first. Capped
      // to angular errors under `MAX_WALK_WHILE_TURNING_RAD` so a sharp
      // corridor doubling-back doesn't send the bot walking the wrong way
      // while it turns around.
      if (Math.abs(delta) < MAX_WALK_WHILE_TURNING_RAD && !blockedAhead) {
        moveKeys.add("KeyW");
        // See `diagonalStrafeKey`'s doc comment — moves toward the target's
        // lateral offset instead of just forward-in-a-not-yet-correct-
        // direction, which both looks less like aimless spinning and
        // biases the resultant movement vector *toward* the true bearing
        // (reducing, not increasing, the overshoot risk this cap already
        // guards against).
        moveKeys.add(diagonalStrafeKey(delta));
      }
      // NOTE: deliberately no strafe-only movement here for large deltas.
      // Adding lateral motion before heading convergence moves the player,
      // which shifts `targetAngle` itself — for a close navTarget this is
      // enough to flip delta's sign every tick, flipping the strafe
      // direction with it, producing a self-sustaining oscillation with
      // zero net progress (reproduced as a "stuck" regression). Pure
      // in-place rotation keeps `targetAngle` fixed and converges cleanly.
    } else if (!blockedAhead) {
      // Don't step onto an active spike trap — wait out its cycle instead
      // (see `activeSpikeAt`). Opposite instinct from hazard-crossing above:
      // spikes cycle safe/active and are harmless in their safe half, so
      // waiting a moment costs nothing, versus hazard which is never safe to
      // linger in and is worth rushing through instead.
      moveKeys.add("KeyW");
      // Capped so a normal-speed step can't overshoot a close waypoint
      // either — see `moveBurstMs`'s doc comment (0.16 tiles/step at
      // MOVE_SPEED is already larger than `ARRIVE_EPS`=0.15).
      turnBurst = moveBurstMs(Math.hypot(navTarget.x - player.x, navTarget.y - player.y), false);
    }
  }

  if (DEBUG_NAV) {
    console.log(`      -> moveKeys=[${[...moveKeys].join(",")}] fire=${fire} useMelee=${useMelee} weaponSwitch=${weaponSwitch} turnBurst=${turnBurst?.toFixed(0)}`);
  }
  // Update the stall counter `stallStrafeKey` read at the top of this
  // function — a real attack attempt (`fire`) counts as progress even if
  // position doesn't change (e.g. repeatedly landing hits on a stationary
  // enemy is fine to stay still for), so only an unchanging position with
  // no attack executed counts toward the stall.
  if (threat && mineMemory) {
    const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
    if (!fire && mineMemory.combatStallPos === posKey) {
      mineMemory.combatStallTicks = (mineMemory.combatStallTicks ?? 0) + 1;
    } else {
      mineMemory.combatStallPos = posKey;
      mineMemory.combatStallTicks = 0;
    }
  } else if (mineMemory) {
    mineMemory.combatStallTicks = 0;
    mineMemory.combatStallPos = null;
  }
  recordTrace(mineMemory, {
    branch: "main",
    x: player.x,
    y: player.y,
    hpFrac: player.healthFraction,
    threatDist: threat?.dist ?? null,
    mineDist: mineTarget?.dist ?? null,
    waitingOnSpike,
    moveKeys: [...moveKeys],
    turnBurst,
    fire: fire || useMelee,
  });
  return applyAction(page, moveKeys, fire, weaponSwitch, useMelee, turnBurst);
}

async function driveToward(page, point, eps, maxTicks, profile, map, mineMemory) {
  let { player, enemies, mines } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") {
      await applyAction(page, new Set(), false, null, false);
      return { state: player.state, reason: player.state };
    }
    if (Math.hypot(point.x - player.x, point.y - player.y) < eps) {
      // Deliberately no `applyAction(page, new Set(), ...)` stop here — this
      // fires at *every* waypoint arrival, and BFS route waypoints are only
      // 1 tile apart, so releasing every held key and burning a full extra
      // step standing still here (real wall-clock time in headed/watch mode,
      // simulated time in headless) turned ordinary corridor walking into a
      // visible "step-wait-step" stutter instead of continuous motion — a
      // real player never has their input zeroed at every tile boundary.
      // The next `driveToward`/`tick()` call recomputes and applies its own
      // fresh key set regardless; `applyAction`'s held-vs-desired diff
      // already issues any needed keyup then, so nothing is left dangling.
      return { state: "playing", reason: "arrived" };
    }
    const prevX = player.x;
    const prevY = player.y;
    ({ player, enemies, mines } = await tick(page, player, enemies, mines, point, profile, map, mineMemory));
    // A BFS-derived waypoint list (see `driveTowardWithReplan`) has no
    // concept of teleporter (goto/label) tiles — `bfsPath` treats them as
    // plain floor — so a replanned path can end up targeting a teleporter
    // pad's exact tile-center as an arrival point. Stepping onto it always
    // warps the player away (`checkTeleporters()` in engine.ts) before this
    // loop's own arrival check can ever be satisfied, so it would otherwise
    // spend the full `maxTicks` budget chasing a target it can structurally
    // never reach (found via the automated anomaly scan: a real teleporter
    // pair on `main.c` newly became reachable as an explicit waypoint once
    // BFS-replanning grew more common — see the loot-detour-per-waypoint
    // and rotation fixes' doc comments). Detect a jump far larger than any
    // legitimate single tick of movement and treat it the same as arriving
    // — the target is moot once the player's been warped elsewhere.
    if (Math.hypot(player.x - prevX, player.y - prevY) > TELEPORT_JUMP_DETECT_TILES) {
      await applyAction(page, new Set(), false, null, false);
      return { state: "playing", reason: "teleported" };
    }
  }
  await applyAction(page, new Set(), false, null, false);
  return { state: "playing", reason: "stuck" };
}

async function faceAngle(page, targetAngle, maxTicks, profile, mineMemory, map) {
  let { player, enemies, mines } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") return { state: player.state };
    const threat = pickThreat(enemies, player, profile, map);
    if (!threat) {
      const currentAngle = Math.atan2(player.dirY, player.dirX);
      const delta = angleDelta(currentAngle, targetAngle);
      if (Math.abs(delta) < TURN_MOVE_EPS) {
        await applyAction(page, new Set(), false, null, false);
        return { state: "playing" };
      }
      // `tick()` only ever turns the player toward a threat, a mine, or
      // `navTarget` — none of which apply here (this is a bare "face this
      // specific angle" request, used only to square up to a door before
      // opening it), so routing this case through `tick()` (as the code
      // used to) left it idling (`navTarget=null`, no threat/mine to aim
      // at) for the full `maxTicks` budget whenever a real turn was needed.
      // Found via the automated anomaly scan: 600-tick complete freezes
      // (`navTarget=none`, empty moveKeys) recurring right after arriving
      // at a walk leg's last waypoint, immediately before its matching
      // openDoor leg — most door approaches happened to already be facing
      // close enough by chance (from the preceding walk's own heading), so
      // this only surfaced when the door's approach direction required an
      // actual turn. Issue the turn directly instead of relying on tick().
      // `angleDelta` is computed fresh from the *live* `player.dirX/dirY`
      // every tick, via `atan2(sin(d), cos(d))` — well-behaved for any
      // single call, but when the needed turn is very close to exactly
      // 180°, tiny floating-point noise in the recomputed `currentAngle`
      // from one tick to the next can land the result on either side of
      // atan2's +-pi branch cut, flipping the *sign* of `delta` (and hence
      // the chosen turn key) tick to tick — each reversal partially undoes
      // the previous tick's turn, so the angle never converges. Found via
      // the automated anomaly scan recurring specifically for the Gamer
      // profile (3.5x rotation speed) at one exact door approach requiring
      // close to a full about-face — a rarer residual of the same 600-tick
      // freeze class as this function's other fix above, surviving it
      // because that fix only addressed *routing* the turn, not this
      // separate direction-instability failure mode. Pin the turn
      // direction once whenever |delta| is this close to pi, instead of
      // trusting its sign, so a near-180 turn always resolves the same way.
      const NEAR_PI_TURN_EPS = 0.05;
      const turnPositive = Math.abs(Math.abs(delta) - Math.PI) < NEAR_PI_TURN_EPS ? true : delta > 0;
      const moveKeys = new Set([turnPositive ? "KeyE" : "KeyQ"]);
      const turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, mineMemory, player, currentAngle);
      ({ player, enemies, mines } = await applyAction(page, moveKeys, false, null, false, turnBurst));
      continue;
    }
    ({ player, enemies, mines } = await tick(page, player, enemies, mines, null, profile, undefined, mineMemory));
  }
  await applyAction(page, new Set(), false, null, false);
  return { state: "playing" };
}

/**
 * Holds `KeyW` in much smaller steps than the bot's normal movement grain —
 * for the final push against a door. `engine.ts`'s `openDoorAhead()` only
 * fires once a forward probe (`player.radius + 0.15` = 0.35 tiles ahead of
 * the *current* position) lands inside the door's tile, but wall collision
 * (`collidesWithWall`) rejects an entire tick's movement outright if its
 * destination would overlap the still-solid door — it doesn't clamp/slide
 * to the closest legal position. At the bot's normal `VIRTUAL_STEP_MS` step
 * size (~0.16 tiles/tick at `MOVE_SPEED`), the player can get rejected while
 * still short of the 0.35 reach threshold and then can never take a smaller
 * partial step to close that last bit of distance, freezing forever a
 * literal hair's-width from the door — found via the automated anomaly
 * scan surviving two earlier fixes aimed at *positioning* before the push
 * (a real player's continuous, much-finer per-frame movement doesn't hit
 * this exact quantization gap in practice, which is why it's bot-specific).
 * Using a much smaller step size here lets the player converge tile-by-tile
 * closer to the true collision boundary before a step gets rejected,
 * reliably landing within the reach threshold instead of short of it.
 */
async function holdForwardFine(page, totalMs, stepMs) {
  const steps = Math.ceil(totalMs / stepMs);
  for (let t = 0; t < steps; t++) {
    const { player } = await applyAction(page, new Set(["KeyW"]), false, null, false, stepMs);
    if (player.state !== "playing") return { state: player.state };
  }
  await applyAction(page, new Set(), false, null, false);
  return { state: "playing" };
}

async function readFull(page) {
  return page.evaluate(() => {
    const hooks = window.__codeensteinTestHooks;
    return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
  });
}

async function readState(page) {
  return page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
}

/** Same Node↔browser bridge as `generate-default-highscore.mjs`'s
 * `applyAction` (see its doc comment for why firing never touches the
 * mouse), extended with an edge-triggered weapon-switch (`Digit{n+1}`) and a
 * melee-vs-ranged fire key choice (`Space` for quick-melee, `Backquote`
 * otherwise — both edge-triggered the same way). In `HEADED` mode, skips the
 * virtual-clock pump (not installed then — see `installVirtualClock`'s call
 * site) and instead waits `WATCH_STEP_MS` of *real* time so a human watching
 * the visible browser window can actually follow the action. */
async function applyAction(page, desiredMoveKeys, fire, weaponSwitchIndex, useMelee, stepMsOverride) {
  const stepMs = stepMsOverride ?? (HEADED ? WATCH_STEP_MS : VIRTUAL_STEP_MS);
  const dispatched = await page.evaluate(
    ({ desiredKeys, fire, weaponSwitchIndex, useMelee, stepMs, headed }) => {
      const canvas = document.querySelector("canvas");
      const hooks = window.__codeensteinTestHooks;
      const desired = new Set(desiredKeys);
      const held = (window.__botHeldKeys ??= new Set());
      for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
      for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
      window.__botHeldKeys = desired;
      if (weaponSwitchIndex !== null && weaponSwitchIndex !== undefined) {
        const code = `Digit${weaponSwitchIndex + 1}`;
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
      }
      // Fire is held for the *whole* tick (pumped virtual time or the real-time
      // wait in headed mode), not pressed-and-released before any frame runs.
      // A semi-auto weapon (`Weapon.auto` unset — pistol/shotgun/ghidra) still
      // fires exactly once per tick either way, since `consumeFire()` is driven
      // by the one keydown *event*, not by how long the key stays down. But an
      // `auto: true` weapon (gdb, Friday Hotfix) checks `isFireHeld()` — whether
      // the key is *currently* down — every frame; releasing it before the pump
      // even starts meant no frame ever observed it held, so gdb/Friday Hotfix
      // fired literally zero shots across the entire 836-attempt balance
      // campaign, confirmed both by `weaponEfficiency` (no "3"/"5" entries
      // anywhere) and a live ammo-pool trace (smg/gas sat permanently capped,
      // never spent). Fixed by moving the keyup to the end of the tick.
      const fireCode = fire ? (useMelee ? "Space" : "Backquote") : null;
      if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keydown", { code: fireCode }));
      if (headed) return { fireCode };
      window.__pumpVirtualTime(stepMs, stepMs);
      if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
    },
    { desiredKeys: [...desiredMoveKeys], fire, weaponSwitchIndex, useMelee, stepMs, headed: HEADED },
  );
  if (!HEADED) return dispatched;
  await page.waitForTimeout(stepMs);
  return page.evaluate((fireCode) => {
    const canvas = document.querySelector("canvas");
    if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
    const hooks = window.__codeensteinTestHooks;
    return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
  }, dispatched.fireCode);
}

export async function waitForTestHooks(page) {
  await page.waitForFunction(() => window.__codeensteinTestHooks !== undefined, undefined, { timeout: 15000, polling: 100 });
}

export async function dismissOverlay(page) {
  if (HEADED) {
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
    await page.waitForTimeout(200);
    return;
  }
  await page.evaluate(() => {
    window.__pumpVirtualTime(1500, 50);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.__pumpVirtualTime(50, 50);
  });
}

export async function installDifficulty(page, difficulty) {
  await page.addInitScript((d) => localStorage.setItem("codeenstein-difficulty", d), difficulty);
}

/** Synchronous virtual clock — identical to `generate-default-highscore.mjs`'s
 * `installVirtualClock` (see its doc comment). */
async function installVirtualClock(page) {
  await page.addInitScript(() => {
    let vNow = 0;
    const epochStart = Date.now();
    let pending = [];
    let rafId = 0;
    window.performance.now = () => vNow;
    Date.now = () => epochStart + vNow;
    window.requestAnimationFrame = (cb) => {
      const id = ++rafId;
      pending.push({ id, cb });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending = pending.filter((p) => p.id !== id);
    };
    window.__pumpVirtualTime = (totalMs, stepMs) => {
      const steps = Math.ceil(totalMs / stepMs);
      for (let i = 0; i < steps; i++) {
        vNow += stepMs;
        const due = pending;
        pending = [];
        for (const { cb } of due) cb(vNow);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

/** `{mean|max|min: value, samples}` — spread-preserving wrapper for
 * judgment-call metrics where run-to-run variance is itself informative (see
 * the plan's rationale: a bare average can hide "this is a coin flip"). */
function spread(nums, kind) {
  const finite = nums.filter((n) => Number.isFinite(n));
  const value = finite.length === 0 ? 0 : kind === "max" ? Math.max(...finite) : kind === "min" ? Math.min(...finite) : mean(finite);
  return { [kind]: value, samples: nums };
}

function sumRecord(records, keys) {
  const out = {};
  for (const k of keys) out[k] = records.reduce((s, r) => s + (r[k] ?? 0), 0);
  return out;
}

function avgRecord(records, keys) {
  const out = {};
  for (const k of keys) out[k] = mean(records.map((r) => r[k] ?? 0));
  return out;
}

function aggregateWeaponTallies(tallyMaps) {
  const out = {};
  for (const tallies of tallyMaps) {
    for (const [idx, t] of Object.entries(tallies)) {
      out[idx] ??= { shotsFired: 0, hits: 0, kills: 0 };
      out[idx].shotsFired += t.shotsFired;
      out[idx].hits += t.hits;
      out[idx].kills += t.kills;
    }
  }
  return out;
}

function fatalDamageSourceCounts(samples) {
  const counts = {};
  for (const s of samples) {
    const src = s.snapshot.fatalDamageSource;
    if (src) counts[src] = (counts[src] ?? 0) + 1;
  }
  return counts;
}

/**
 * Builds the 7-category runtime breakdown from a level's qualifying-run
 * samples (`{levelIndex, snapshot, player, incomplete}[]`). `shortestPathTiles`
 * is the level's static BFS-shortest distance (`null` for the campaign-wide
 * rollup, whose route-efficiency figure is computed separately across whole
 * runs instead — see `buildCampaignAggregate`).
 */
function aggregateLevelRuntime(samples, shortestPathTiles) {
  const sampleCount = samples.length;
  const incompleteSampleCount = samples.filter((s) => s.incomplete).length;
  if (sampleCount === 0) {
    return { sampleCount: 0, incompleteSampleCount: 0 };
  }
  const snaps = samples.map((s) => s.snapshot);

  const ttkByCategory = { normal: [], elite: [], edgeCase: [] };
  for (const snap of snaps) {
    for (const rec of snap.ttkRecords) {
      if (rec.deathAtLevelTime === null) continue;
      ttkByCategory[rec.category].push(rec.deathAtLevelTime - rec.aggroAtLevelTime);
    }
  }

  const lootRolled = sumRecord(
    snaps.map((s) => s.lootRolled),
    LOOT_KINDS,
  );
  const lootCollectedDynamic = sumRecord(
    snaps.map((s) => s.lootCollectedDynamic),
    LOOT_KINDS,
  );
  const lootCollectedStatic = sumRecord(
    snaps.map((s) => s.lootCollectedStatic),
    LOOT_KINDS,
  );
  const consumedTotal = {};
  for (const k of LOOT_KINDS) consumedTotal[k] = (lootCollectedDynamic[k] ?? 0) + (lootCollectedStatic[k] ?? 0);

  const routeEfficiencyScore =
    shortestPathTiles === null
      ? spread(
          snaps.map(() => 0),
          "mean",
        ) // overwritten by buildCampaignAggregate
      : spread(
          snaps.map((s) => (s.distanceTraveled > 0 ? Math.min(1, shortestPathTiles / s.distanceTraveled) : 0)),
          "mean",
        );

  return {
    sampleCount,
    incompleteSampleCount,
    mapDensityEnemyDemographics: {
      killsObserved: spread(
        snaps.map((s) => s.kills),
        "mean",
      ),
    },
    combatPacing: {
      avgTtkByCategory: {
        normal: spread(ttkByCategory.normal, "mean"),
        elite: spread(ttkByCategory.elite, "mean"),
        edgeCase: spread(ttkByCategory.edgeCase, "mean"),
      },
      combatVsExplorationRatio: spread(
        snaps.map((s) => (s.levelTimeSec > 0 ? s.combatTimeSec / s.levelTimeSec : 0)),
        "mean",
      ),
      peakSimultaneousAggroed: spread(
        snaps.map((s) => s.peakAggroedCount),
        "max",
      ),
    },
    aiEffectivenessDanger: {
      enemyAccuracy: spread(
        snaps.map((s) => (s.enemyBoltsFired > 0 ? s.enemyBoltsHit / s.enemyBoltsFired : 0)),
        "mean",
      ),
      meleeVsRangedAttackRatio: spread(
        snaps.map((s) => {
          const total = s.enemyMeleeAttacks + s.enemyBoltsFired;
          return total > 0 ? s.enemyMeleeAttacks / total : 0;
        }),
        "mean",
      ),
      minHealthReached: spread(
        snaps.map((s) => s.minHealthReached),
        "min",
      ),
      timeBelow25PctHealthSec: spread(
        snaps.map((s) => s.timeBelow25PctHealthSec),
        "mean",
      ),
    },
    damageHealingBreakdown: {
      damageBySource: avgRecord(
        snaps.map((s) => s.damageBySource),
        DAMAGE_SOURCES,
      ),
      healingBySource: avgRecord(
        snaps.map((s) => s.healingBySource),
        HEAL_SOURCES,
      ),
      fatalDamageSourceCounts: fatalDamageSourceCounts(samples),
    },
    weaponEfficiency: aggregateWeaponTallies(snaps.map((s) => s.weaponTallies)),
    economyLootStarvation: {
      lootRolled,
      consumed: { dynamic: lootCollectedDynamic, static: lootCollectedStatic, total: consumedTotal },
      // Not a "desperation" signal (a miss doesn't necessarily hurt — health
      // is unconditional now, see engine.ts's kill handler) — a mechanic-
      // verification stat, letting real telemetry confirm
      // REGULAR_KILL_NO_DROP_CHANCE's ~20% design rate empirically instead
      // of trusting the constant alone.
      pctRegularKillLootMisses: spread(
        snaps.map((s) => (s.regularKillLootRolls > 0 ? s.regularKillLootMisses / s.regularKillLootRolls : 0)),
        "mean",
      ),
      desperation: {
        timeAtZeroRangedAmmoSec: spread(
          snaps.map((s) => s.timeAtZeroRangedAmmoSec),
          "mean",
        ),
        pctKillsForcedMelee: spread(
          snaps.map((s) => (s.kills > 0 ? s.killsForcedByMelee / s.kills : 0)),
          "mean",
        ),
      },
    },
    navigationMapFlow: {
      routeEfficiencyScore,
      mapCoveragePct: spread(
        snaps.map((s) => s.mapCompletionFrac),
        "mean",
      ),
      secretRoomsOpened: spread(
        snaps.map((s) => s.secretRoomsOpened),
        "mean",
      ),
      minesTriggered: spread(
        snaps.map((s) => s.minesTriggered),
        "mean",
      ),
      minesDisarmed: spread(
        snaps.map((s) => s.minesDisarmed),
        "mean",
      ),
    },
    score: spread(
      snaps.map((s) => s.score),
      "mean",
    ),
  };
}

function computeLevelFlags(level, campaignAvgDensity) {
  const flags = [];
  if (campaignAvgDensity > 0 && level.static.enemyDensity > campaignAvgDensity * DENSITY_OUTLIER_MULTIPLIER) {
    flags.push("density_outlier");
  }
  const normalTtk = level.runtime.combatPacing?.avgTtkByCategory?.normal?.mean;
  if (normalTtk !== undefined && normalTtk > NORMAL_TTK_HIGH_SEC) flags.push("normal_ttk_high");
  // No ammo_starvation_* flag here (deliberately removed, not just unimplemented):
  // static per-visit prePlacedAmmo can't be compared against `consumed.total` without
  // guaranteeing near-universal false positives, since `consumed.total` also includes
  // dynamic (kill-drop) consumption that's nonzero on almost every level. Restricting
  // the comparison to `consumed.static` avoids that, but is then close to a tautology
  // (players structurally can't consume more static ammo than was placed) and carries
  // no real signal. A trustworthy version needs real per-roll dynamic-drop amounts,
  // which `lootRolled` doesn't record for most drops (see pushLootDrop in engine.ts) —
  // an engine-side change, out of scope here. Real resource-scarcity signal already
  // exists and is reliable: economyLootStarvation.desperation's
  // timeAtZeroRangedAmmoSec/pctKillsForcedMelee.
  return flags;
}

function buildComboOutput(levelPlans, combo) {
  const { qualifyingRuns, attemptsUsed, failureReasons, trueQualifyingCount } = combo;

  const levels = levelPlans.map((lp, i) => {
    const samples = qualifyingRuns.map((run) => run.levelSnapshots.find((s) => s.levelIndex === i)).filter(Boolean);
    const runtime = aggregateLevelRuntime(samples, lp.staticAnalysis.shortestPathTiles);
    return { levelIndex: i, filename: lp.filename, static: lp.staticAnalysis, runtime };
  });

  const campaignAvgDensity = mean(levels.map((l) => l.static.enemyDensity));
  for (const level of levels) {
    level.runtime.flags = level.runtime.sampleCount > 0 ? computeLevelFlags(level, campaignAvgDensity) : [];
  }

  const campaignAggregate = buildCampaignAggregate(levelPlans, qualifyingRuns);
  campaignAggregate.flags = computeLevelFlags({ static: { enemyDensity: campaignAvgDensity }, runtime: campaignAggregate }, campaignAvgDensity);

  const weaponFirstOwnedAtLevel = mergeWeaponFirstOwned(qualifyingRuns);
  const weaponAcquisitionRate = computeWeaponAcquisitionRate(qualifyingRuns);

  return {
    attemptsUsed,
    qualifyingRunCount: qualifyingRuns.length,
    // Real success count before the REQUIRED_QUALIFYING_RUNS sample-size trim
    // above — use this (not qualifyingRunCount) for a true qualifying-rate
    // stat. See the trim's doc comment for why the two diverge.
    trueQualifyingCount,
    failureReasons,
    weaponFirstOwnedAtLevel,
    weaponAcquisitionRate,
    levels,
    campaignAggregate,
  };
}

/** Earliest level each weapon index was first owned, across qualifying runs
 * (min across runs — "how soon could this profile realistically get it"). */
function mergeWeaponFirstOwned(qualifyingRuns) {
  const out = {};
  for (const run of qualifyingRuns) {
    for (const [idx, level] of Object.entries(run.weaponFirstOwnedAtLevel)) {
      out[idx] = out[idx] === undefined ? level : Math.min(out[idx], level);
    }
  }
  return out;
}

/** Fraction of qualifying runs that acquired each weapon index *at all* —
 * distinct from `mergeWeaponFirstOwned`'s min-level, which only answers "how
 * soon" for whichever runs got it, not "how often" any run got it at all.
 * Covers every unlockable weapon uniformly (gdb/ghidra/Friday Hotfix/
 * Toolchain), not just Toolchain — added specifically to verify the new
 * miss-chance Toolchain drop and the reworked loot economy actually move
 * these numbers, rather than trusting the balance constants alone. */
function computeWeaponAcquisitionRate(qualifyingRuns) {
  const counts = {};
  for (const run of qualifyingRuns) {
    for (const idx of Object.keys(run.weaponFirstOwnedAtLevel)) {
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }
  const total = qualifyingRuns.length;
  const out = {};
  for (const [idx, count] of Object.entries(counts)) {
    out[idx] = { count, rate: total > 0 ? count / total : 0 };
  }
  return out;
}

/** Campaign-wide rollup: flattens every qualifying run's level snapshots into
 * one sample set (so a metric like `damageBySource` sums correctly across
 * the whole campaign, not just per-level), except route efficiency, which is
 * computed per-run (total distance vs. total shortest-path across whatever
 * levels that run reached) since a single level's `shortestPathTiles`
 * wouldn't mean anything campaign-wide. */
function buildCampaignAggregate(levelPlans, qualifyingRuns) {
  const allSamples = qualifyingRuns.flatMap((run) => run.levelSnapshots);
  const runtime = aggregateLevelRuntime(allSamples, null);

  const perRunRouteEff = qualifyingRuns.map((run) => {
    let dist = 0;
    let shortest = 0;
    for (const s of run.levelSnapshots) {
      dist += s.snapshot.distanceTraveled;
      shortest += levelPlans[s.levelIndex].staticAnalysis.shortestPathTiles;
    }
    return dist > 0 ? Math.min(1, shortest / dist) : 0;
  });
  if (runtime.navigationMapFlow) runtime.navigationMapFlow.routeEfficiencyScore = spread(perRunRouteEff, "mean");
  return runtime;
}

function computeCrossDifficultyFlags(profileResult) {
  const flags = [];
  const easyTtk = profileResult.easy?.campaignAggregate?.combatPacing?.avgTtkByCategory?.normal?.mean;
  const hardTtk = profileResult.hard?.campaignAggregate?.combatPacing?.avgTtkByCategory?.normal?.mean;
  if (easyTtk !== undefined && hardTtk !== undefined && easyTtk > 0) {
    const relChange = Math.abs(hardTtk - easyTtk) / easyTtk;
    if (relChange < CROSS_DIFFICULTY_FLAT_THRESHOLD) flags.push("normal_ttk_barely_scales_with_difficulty");
  }
  const easyDmg = profileResult.easy?.campaignAggregate?.damageHealingBreakdown?.damageBySource?.enemyMelee;
  const hardDmg = profileResult.hard?.campaignAggregate?.damageHealingBreakdown?.damageBySource?.enemyMelee;
  if (easyDmg !== undefined && hardDmg !== undefined && easyDmg > 0) {
    const relChange = Math.abs(hardDmg - easyDmg) / easyDmg;
    if (relChange < CROSS_DIFFICULTY_FLAT_THRESHOLD) flags.push("enemy_melee_damage_barely_scales_with_difficulty");
  }
  const toolchainAcquired = ["easy", "normal", "hard"].some((d) => profileResult[d]?.weaponFirstOwnedAtLevel?.[TOOLCHAIN_WEAPON_INDEX] !== undefined);
  if (!toolchainAcquired) flags.push("toolchain_never_acquired_at_any_difficulty");
  return flags;
}

// Guarded so other scripts (e.g. watch-bot-sessions.mjs) can import this
// module's exports (PROFILES, playRun, planLevels, ...) without triggering
// the full 9-combo run as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("run-balancing-telemetry crashed:", err);
    process.exit(1);
  });
}

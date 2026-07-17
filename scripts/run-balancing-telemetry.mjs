// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot dev tool: plays the bundled `demo-campaign/` with three distinct
 * bot profiles (Casual/Gamer/Pro) across all three difficulties, and writes
 * aggregated balancing telemetry to `balancing_telemetry.json` — consumed by
 * hand (or by an LLM balance-review pass) to spot HP-curve/drop-rate/pacing
 * problems without a human replaying the whole campaign nine times.
 *
 * The actual navigation/combat/loot decision-making lives in
 * `scripts/lib/bot.mjs`'s `Bot` class (shared with
 * `scripts/generate-default-highscore.mjs`) — this file owns the
 * telemetry-specific orchestration on top of it: per-profile combat/
 * navigation parameters (`PROFILES`), a qualifying-runs-per-profile×difficulty
 * retry loop (`REQUIRED_QUALIFYING_RUNS`, 3 by default — see
 * `CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET` to override, built on
 * `scripts/lib/qualifyLoop.mjs`'s generic retry-until-N-qualifying machinery),
 * and `window.__codeensteinTestHooks`'s balancing-telemetry surface
 * (`getTelemetrySnapshot()`/`getMines()`) plus the aggregation/report-shape
 * building below.
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
import { analyzeStaticLevel } from "./lib/staticLevelAnalysis.mjs";
import {
  Bot,
  PISTOL_WEAPON_INDEX,
  SHOTGUN_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  TOOLCHAIN_WEAPON_INDEX,
  STARTING_WEAPONS,
} from "./lib/bot.mjs";
import { runQualifyLoop } from "./lib/qualifyLoop.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";

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
// the bot play and eyeball whether anything looks erratic". When on, the
// `Bot` appends a lightweight per-decision record to its trace and `playRun`
// runs anomaly detection against it after each level, logging any findings.
const ANOMALY_SCAN = process.env.CODEENSTEIN_TELEMETRY_ANOMALY_SCAN === "1";
// Implies ANOMALY_SCAN (the trace has to exist to analyze it). Runs a much
// more precise, tick-by-tick pass over the same per-decision trace, looking
// specifically for "a movement key (W/A/D) was held this tick, but position
// didn't actually change since the last one".
const NAV_DIAG = process.env.CODEENSTEIN_TELEMETRY_NAV_DIAG === "1";
// Opens a real, visible browser window and runs at a watchable real-time
// pace instead of the virtual-clock fast-forward, so a human can actually
// see what the bot is doing tick-by-tick. Combine with
// CODEENSTEIN_TELEMETRY_PROFILE/_DIFFICULTY/_LEVEL_LIMIT/_ATTEMPT_CAP to
// focus on one specific combo instead of watching the whole campaign.
const HEADED = process.env.CODEENSTEIN_TELEMETRY_HEADED === "1";

// Overridable so a large-scale data-collection campaign can raise the target
// (e.g. 50) per invocation without touching this default — every existing
// caller (balancing:scan, ad-hoc smoke tests) is unaffected when unset.
const REQUIRED_QUALIFYING_RUNS = process.env.CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET
  ? Number(process.env.CODEENSTEIN_TELEMETRY_QUALIFYING_TARGET)
  : 3;
const QUALIFY_LEVEL_INDEX = 3; // 0-based — "level 4" in 1-based campaign numbering

// How many ticks the final push toward the exit tile gets, once the route's
// own legs are exhausted — see `playRun`'s final `driveToward` call.
const FINAL_APPROACH_TICKS = 80;

// Mirrors src/engine/enemyAi.ts — plain literal rather than importing that TS
// module (this is a plain Node script, not bundled like the map/parser layer
// in loadEngineModules.mjs). Only referenced here (via `ENGAGE_RADIUS`) for
// `PROFILES.*.engageRadius` — every other movement/combat tuning constant
// lives in `scripts/lib/bot.mjs`'s `DEFAULT_TUNING`.
const AGGRO_RADIUS = 7.5;
const ENGAGE_RADIUS = AGGRO_RADIUS + 2; // combat always preempts navigation within this — same for every profile, non-negotiable, see PROFILES's doc comment

export const DIFFICULTIES = ["easy", "normal", "hard"];

/**
 * Bot behavior profiles. `engageRadius` is deliberately identical across all
 * three (see `ENGAGE_RADIUS`) — "low aggression" (Casual) never means
 * skipping a fight, only a looser `fireAngleEps` (worse aim) and a lower
 * `healthDetourThreshold` urgency inversion (higher = detours for health
 * sooner). `weaponPriority` lists ranged `WEAPONS` indices in preference
 * order (melee indices are excluded — melee-in-range is handled separately,
 * universally, for every profile: see the `MELEE_RANGE` check in
 * `Bot#tick`). Every profile's list ends in a complete fallback chain
 * (pistol, shotgun, Friday Hotfix) so a profile never ends up with *no*
 * valid ranged option just because its preferred unlockable weapon isn't
 * owned yet or is out of ammo — Pro's list originally omitted the
 * shotgun/Friday Hotfix entirely, meaning it had nothing to fall back on
 * beyond the bare pistol whenever ghidra/gdb weren't available, found while
 * investigating why Pro/normal was taking dramatically longer to qualify
 * than the "less skilled" Casual and Gamer profiles despite Pro's much
 * tighter aim.
 *
 * `proactiveMineDisarm` is `true` for every profile — mines were the #1
 * killer in early testing even for profiles that didn't proactively shoot
 * them, kept as a per-profile field only so it still shows up explicitly in
 * the output's `meta.profiles` dump.
 *
 * `coverageMode` is `false` for every profile — navigation is always
 * shortest-route-to-exit (`planRoute`, not `planCoverageRoute`), regardless
 * of skill level. This was originally Casual-only "maximize map coverage"
 * (visit every room), which turned out to be the single biggest driver of
 * Casual's implausibly low survival rate — see the git history for the full
 * rationale. Skill differences now come entirely from combat/aim/tactics,
 * not from how much of the map gets walked.
 *
 * `fireAngleEps` calibration note: earlier values (Casual 0.17-0.22, Gamer
 * 0.15, Pro 0.08) were all *far* too loose — see git history for the
 * controlled-experiment writeup. Retuned to a much tighter ladder that still
 * preserves real skill differentiation (Pro tightest, Casual loosest)
 * without any tier being catastrophically bad.
 *
 * `fireCooldownMs`: the minimum simulated time (`Bot#simTimeMs`, see
 * `bot.mjs`) between two dispatched shots of a *semi-auto* ranged weapon
 * (pistol/shotgun/ghidra) — those have no engine-side fire-rate cap (see
 * `updateFiring`'s doc comment in `engine.ts`) and fire exactly once per
 * `Backquote` keydown, so a bot re-dispatching that key every single
 * decision tick fired far faster than any human trigger-pull (~20/sec at
 * the headless 50ms tick rate — "the pistol becomes an smg"). Auto weapons
 * (gdb/Friday Hotfix) are unaffected by this field, since their own
 * `fireIntervalSec` cooldown already caps them realistically while held.
 * Values are plausible real semi-auto trigger-pull rates, tightest→loosest
 * matching the `fireAngleEps`/`rotSpeedMultiplier` skill ladder: Pro 120ms
 * (~8.3/sec, a fast competitive rate), Gamer 160ms (~6.25/sec), Casual
 * 220ms (~4.5/sec, an unhurried rate).
 */
export const PROFILES = {
  Casual: {
    fireAngleEps: 0.08,
    fireCooldownMs: 220,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Simple/reliable weapons first; ghidra last (a "casual" player is more
    // hesitant with a self-splash-capable rocket launcher) — but still in
    // the list, since every profile should be able to use whatever it has.
    weaponPriority: [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, GDB_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.75,
    proactiveMineDisarm: true,
    // Same "more hesitant with a self-splash launcher" reasoning as the
    // weaponPriority ordering above, applied to situational cluster-
    // targeting too (see `pickRangedWeapon` in bot.mjs) — sticks to the
    // shotgun for a distant cluster instead of reaching for rockets.
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
    fireCooldownMs: 160,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Ammo-efficient auto weapon first, heavy hitter last, everything else
    // in between.
    weaponPriority: [GDB_WEAPON_INDEX, PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX, GHIDRA_WEAPON_INDEX],
    healthDetourThreshold: 0.5,
    proactiveMineDisarm: true,
    rocketForDistantClusters: true,
    // ~3.5x keyboard (~9.1 rad/sec, ~520°/sec) — a comfortable, practiced
    // enthusiast's mouse turn speed.
    rotSpeedMultiplier: 3.5,
  },
  Pro: {
    fireAngleEps: 0.03,
    fireCooldownMs: 120,
    engageRadius: ENGAGE_RADIUS,
    coverageMode: false,
    // Heavy hitters first, complete fallback chain through everything else —
    // was missing 1/FRIDAY_HOTFIX_WEAPON_INDEX entirely before, the direct
    // cause of Pro/normal needing far more attempts to qualify than the
    // "less skilled" profiles.
    weaponPriority: [GHIDRA_WEAPON_INDEX, GDB_WEAPON_INDEX, PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX],
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

/** Thin wrapper around `scripts/lib/qualifyLoop.mjs`'s generic retry-until-N
 * machinery — "qualifying" here means clearing through `QUALIFY_LEVEL_INDEX`
 * (fixed for every profile/difficulty combo, unlike the per-profile target
 * levels `generate-default-highscore.mjs` uses). Re-adds this combo's
 * `[profileName/difficulty]` prefix to a hard "browser appears dead" failure
 * so that diagnostic stays exactly as identifiable as before the extraction. */
async function runCombo(browser, profileName, profile, difficulty, levelPlans) {
  // Headed mode is for a human watching one attempt at a time — concurrency
  // there would just open several simultaneous windows, defeating the point.
  const concurrency = HEADED ? 1 : ATTEMPT_CONCURRENCY;
  try {
    return await runQualifyLoop({
      runAttempt: () => runOneAttempt(browser, profileName, profile, difficulty, levelPlans),
      isQualifying: (run) => run.reachedExitForLevel[QUALIFY_LEVEL_INDEX],
      requiredQualifyingRuns: REQUIRED_QUALIFYING_RUNS,
      attemptCap: ATTEMPT_CAP,
      concurrency,
      onProgress: (attempts, qualifying) => {
        if (attempts >= PROGRESS_LOG_INTERVAL) {
          console.log(`  [${profileName}/${difficulty}] still working — attempt ${attempts}, qualifying ${qualifying}/${REQUIRED_QUALIFYING_RUNS}`);
        }
      },
      onAttemptResult: (run, attempts) => {
        if (!run.reachedExitForLevel[QUALIFY_LEVEL_INDEX] && VERBOSE) {
          const where = run.diedAtLevelIndex !== null ? ` at level ${run.diedAtLevelIndex + 1}` : "";
          console.log(`  [${profileName}/${difficulty}] attempt ${attempts} failed: ${run.reason}${where}`);
        }
      },
    });
  } catch (err) {
    throw new Error(`[${profileName}/${difficulty}] ${err.message}`);
  }
}

/**
 * Plays one full campaign attempt for `profile`, driving a single `Bot`
 * instance through every level. Returns `{ reachedExitForLevel,
 * levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex, reason }` —
 * `levelSnapshots` is `{levelIndex, snapshot, player, incomplete}[]`, one
 * entry per level the run actually reached the end of (won or died on);
 * `incomplete: true` marks the death-level entry.
 */
export async function playRun(page, profile, levelPlans, label = "") {
  const reachedExitForLevel = new Array(levelPlans.length).fill(false);
  const levelSnapshots = [];
  const weaponFirstOwnedAtLevel = {};
  const knownOwned = new Set(STARTING_WEAPONS);

  const bot = new Bot(page, profile, {
    realtime: HEADED,
    logger: {
      debugNav: DEBUG_NAV ? (msg) => console.log(msg) : undefined,
      wpDebug: process.env.CODEENSTEIN_WPDEBUG ? (msg) => console.log(msg) : undefined,
      driftDebug: process.env.CODEENSTEIN_DRIFTDEBUG ? (msg) => console.log(msg) : undefined,
      trace: ANOMALY_SCAN || NAV_DIAG,
      navDiag: NAV_DIAG,
    },
  });

  for (let i = 0; i < levelPlans.length; i++) {
    const { map, routePlain, routeCoverage } = levelPlans[i];
    // static AmmoPickup positions are per-map; a fresh engine per level makes
    // prior "visited" state meaningless here — `startLevel` resets it.
    bot.startLevel(map);
    const route = profile.coverageMode ? routeCoverage : routePlain;

    const player0 = await bot.readState();
    if (player0.state !== "playing") {
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: player0.state === "over" ? "died" : "stuck" };
    }
    const prevExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());

    const legOutcome = route.ok ? await bot.driveLegs(route.legs) : { state: "stuck" };

    if (legOutcome.state === "over") {
      const deathResult = await pullLevelResult(page);
      levelSnapshots.push({ levelIndex: i, ...deathResult, incomplete: true });
      if (VERBOSE) logDeathDetail(i, deathResult);
      bot.reportAnomalies(label, i);
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
    }
    if (legOutcome.state === "stuck") {
      bot.reportAnomalies(label, i);
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
    }
    if (legOutcome.state === "playing") {
      const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
      const pushed = await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
      if (pushed.state === "over") {
        const deathResult = await pullLevelResult(page);
        levelSnapshots.push({ levelIndex: i, ...deathResult, incomplete: true });
        if (VERBOSE) logDeathDetail(i, deathResult);
        bot.reportAnomalies(label, i);
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
      }
      if (pushed.state !== "won") {
        bot.reportAnomalies(label, i);
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
      }
    }
    // else legOutcome.state === "won" already — fall through.
    bot.reportAnomalies(label, i);

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
  const finalScoreReached = computeFinalScoreReached(qualifyingRuns);

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
    finalScoreReached,
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

/** The score each qualifying run actually ended at — its last level
 * snapshot's `score` (a running campaign total, see `EngineStats.score`'s
 * doc comment, so the last snapshot already reflects everything earned
 * across every level that run reached, qualifying or not). Distinct from
 * `campaignAggregate`'s own `score` field (`aggregateLevelRuntime`'s
 * per-*level* mean, pooled across every level snapshot of every run) —
 * that one answers "what does a typical level-end score look like", this
 * one answers "what score does a run actually reach by the time it stops",
 * which is what the balance question ("is scoring paced sensibly across a
 * full run") actually needs. `spread(..., "mean")` also carries every raw
 * per-run sample, so a report can chart the spread, not just the average. */
function computeFinalScoreReached(qualifyingRuns) {
  const finalScores = qualifyingRuns
    .map((run) => run.levelSnapshots.at(-1)?.snapshot.score)
    .filter((s) => s !== undefined);
  return spread(finalScores, "mean");
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

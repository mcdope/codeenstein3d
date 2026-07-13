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
 * per-profile combat/navigation parameters, a 3-qualifying-runs-per-
 * profile×difficulty retry loop, and `window.__codeensteinTestHooks`'s
 * balancing-telemetry surface (`getTelemetrySnapshot()`/`getMines()`).
 *
 * A run only "counts" once it clears level 3 (proves it survived the
 * unarmed/unupgraded early game) — a run that dies on level 1 or 2 is
 * discarded outright, but once qualified, ALL of its levels' data (including
 * 1–2) is kept. Not CI-wired, not fast (up to 9 combos × 10 attempts × up to
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
const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const OUTPUT_FILE = path.join(REPO_ROOT, "balancing_telemetry.json");

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

const REQUIRED_QUALIFYING_RUNS = 3;
const QUALIFY_LEVEL_INDEX = 2; // 0-based — "level 3" in 1-based campaign numbering

const VIRTUAL_STEP_MS = 50;
const MAX_TICKS_PER_WAYPOINT = 600;
const FINAL_APPROACH_TICKS = 80;
const TURN_MOVE_EPS = 0.2;
const ARRIVE_EPS = 0.15;
const TIGHT_ARRIVE_EPS = 0.05;
const DOOR_OPEN_TICKS = 10;

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
// Angle tolerance for swinging a melee weapon — deliberately much wider than
// any profile's `fireAngleEps`, since a stab at something already adjacent
// doesn't need ranged-shot precision. Gating melee behind the same tight
// tolerance as ranged fire was a real bug: at melee range, small enemy
// movements cause large angular swings relative to the player, so Pro's
// very tight `fireAngleEps` (0.03) meant it could spend many ticks
// re-aligning against an adjacent enemy without ever landing the free,
// ammo-less melee hit — meanwhile the enemy bit for free the whole time
// (observed: up to 100 cumulative enemyMelee damage in a single fight).
const MELEE_ANGLE_EPS = 0.6;
const HAZARD_TILE = 2; // src/map/types.ts's Tile enum
const KNIFE_WEAPON_INDEX = 2;
const GDB_WEAPON_INDEX = 3;
const GHIDRA_WEAPON_INDEX = 4;
const FRIDAY_HOTFIX_WEAPON_INDEX = 5;
const TOOLCHAIN_WEAPON_INDEX = 6;
const STARTING_WEAPONS = [0, 1, 2];

const DIFFICULTIES = ["easy", "normal", "hard"];

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
 * high-accuracy player has no reason to proactively close distance into
 * melee range at all (that's *more* exposure to incoming fire, not less) —
 * the correct "skilled" behavior is exactly what every profile already
 * does, universally: snipe efficiently from range, and only melee
 * opportunistically once something's already adjacent (free, ammo-less,
 * lifesteal).
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
const PROFILES = {
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

async function main() {
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
async function runOneAttempt(browser, profile, difficulty, levelPlans) {
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

    if (!HEADED) await installVirtualClock(page); // headed mode runs on the real clock so a human can follow along
    await installDifficulty(page, difficulty);
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    const run = await playRun(page, profile, levelPlans);
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
      Array.from({ length: batchSize }, () => runOneAttempt(browser, profile, difficulty, levelPlans)),
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
  // sequential run.
  qualifyingRuns.length = Math.min(qualifyingRuns.length, REQUIRED_QUALIFYING_RUNS);

  return { qualifyingRuns, attemptsUsed: attempts, failureReasons };
}

/**
 * Plays one full campaign attempt for `profile`. Returns `{
 * reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel,
 * diedAtLevelIndex, reason }` — `levelSnapshots` is `{levelIndex, snapshot,
 * player, incomplete}[]`, one entry per level the run actually reached the
 * end of (won or died on); `incomplete: true` marks the death-level entry.
 */
async function playRun(page, profile, levelPlans) {
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
    const mineMemory = { retreatKey: null, retreatTicks: 0, shootKey: null, shootTicks: 0, abandoned: new Set() };
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
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
    }
    if (legOutcome.state === "stuck") {
      return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
    }
    if (legOutcome.state === "playing") {
      const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
      const pushed = await driveToward(page, exitCenter, TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS, profile, map, mineMemory);
      if (pushed.state === "over") {
        const deathResult = await pullLevelResult(page);
        levelSnapshots.push({ levelIndex: i, ...deathResult, incomplete: true });
        if (VERBOSE) logDeathDetail(i, deathResult);
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "died" };
      }
      if (pushed.state !== "won") {
        return { reachedExitForLevel, levelSnapshots, weaponFirstOwnedAtLevel, diedAtLevelIndex: i, reason: "stuck" };
      }
    }
    // else legOutcome.state === "won" already — fall through.

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
 */
async function maybeDetourForLoot(page, map, visitedPickups, profile, mineMemory) {
  const player = await readState(page);
  if (player.state !== "playing") return { state: player.state };

  const uncollected = map.ammoPickups.filter((p) => !visitedPickups.has(`${p.x},${p.y}`));
  if (uncollected.length === 0) return { state: "playing" };

  const urgent = player.healthFraction < profile.healthDetourThreshold;
  const healthOnly = uncollected.filter((p) => p.kind === "health");
  const pool = urgent && healthOnly.length > 0 ? healthOnly : uncollected;

  let best = null;
  let bestDist = Infinity;
  for (const p of pool) {
    const d = Math.hypot(p.x - player.x, p.y - player.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  visitedPickups.add(`${best.x},${best.y}`);

  const path = bfsPath(map, { x: Math.floor(player.x), y: Math.floor(player.y) }, { x: Math.floor(best.x), y: Math.floor(best.y) });
  if (!path) return { state: "playing" };
  for (const wp of pathToWaypoints(path)) {
    const result = await driveToward(page, wp, ARRIVE_EPS, MAX_TICKS_PER_WAYPOINT, profile, map, mineMemory);
    if (result.state !== "playing") return result;
  }
  return { state: "playing" };
}

async function driveLegs(page, legs, profile, map, visitedPickups, mineMemory) {
  for (const leg of legs) {
    const detour = await maybeDetourForLoot(page, map, visitedPickups, profile, mineMemory);
    if (detour.state !== "playing") return detour;

    if (leg.kind === "walk") {
      for (const wp of leg.waypoints) {
        const result = await driveToward(page, wp, ARRIVE_EPS, MAX_TICKS_PER_WAYPOINT, profile, map, mineMemory);
        if (result.state !== "playing") return result;
        if (result.reason === "stuck") return { state: "stuck" };
      }
    } else if (leg.kind === "openDoor") {
      const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
      const faced = await faceAngle(page, targetAngle, MAX_TICKS_PER_WAYPOINT, profile, mineMemory);
      if (faced.state !== "playing") return faced;
      const held = await holdForward(page, DOOR_OPEN_TICKS);
      if (held.state !== "playing") return held;
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
function pickThreat(enemies, player, profile) {
  const candidates = enemies
    .filter((e) => e.alive && e.aggroed)
    .map((e) => ({ ...e, dist: Math.hypot(e.x - player.x, e.y - player.y) }))
    .filter((e) => e.dist < profile.engageRadius);
  candidates.sort((a, b) => {
    const aQuick = a.dist <= MELEE_RANGE || a.edgeCase;
    const bQuick = b.dist <= MELEE_RANGE || b.edgeCase;
    if (aQuick !== bQuick) return aQuick ? -1 : 1;
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
 */
function findDisarmableMine(mines, player, abandoned, map) {
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist > MINE_BLAST_RADIUS && m.dist <= MINE_DISARM_RANGE)
    .filter((m) => hasLineOfSight(map, player.x, player.y, m.x, m.y))
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

/**
 * Best ranged weapon for the current situation — not just a fixed per-
 * profile preference order. "The bot should use all weapons at his disposal,
 * depending on situation and ammo availability" (user directive): prefers a
 * spread weapon (Regex Shotgun, 7 pellets — Friday Hotfix as a fallback
 * spread option within its short flamethrower range) once 2+ aggroed
 * enemies are clustered near the current threat, since a multi-pellet cone
 * can land hits on several of them per trigger pull instead of picking them
 * off one at a time; otherwise falls back to `profile.weaponPriority`
 * (unchanged for a single, isolated target). Never selects ghidra within
 * `ROCKET_SAFE_DISTANCE` regardless of source, at any priority — self-splash
 * damage isn't worth it that close. Never returns a melee index — melee
 * always goes through quick-melee (Space), never the equipped ranged slot
 * (mirrors `currentMeleeWeapon` in `src/engine/weapons.ts`).
 */
function pickRangedWeapon(player, profile, enemies, threat) {
  if (threat) {
    const clusterCount = enemies.filter(
      (e) => e.alive && e.aggroed && Math.hypot(e.x - threat.x, e.y - threat.y) <= CLUSTER_RADIUS,
    ).length;
    if (clusterCount >= 2) {
      if (player.ownedWeapons.includes(1) && hasAmmoFor(player, 1)) {
        return player.weaponIndex === 1 ? null : 1; // Regex Shotgun
      }
      if (player.ownedWeapons.includes(FRIDAY_HOTFIX_WEAPON_INDEX) && hasAmmoFor(player, FRIDAY_HOTFIX_WEAPON_INDEX) && threat.dist <= 3.5) {
        return player.weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX ? null : FRIDAY_HOTFIX_WEAPON_INDEX;
      }
    }
  }
  for (const idx of profile.weaponPriority) {
    if (idx === GHIDRA_WEAPON_INDEX && threat && threat.dist < ROCKET_SAFE_DISTANCE) continue;
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
    const moveKeys = new Set();
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    } else {
      // Sprint (2x MOVE_SPEED, see engine.ts's SPRINT_MULTIPLIER) while
      // actually crossing — halves time-in-hazard/on-an-active-spike for the
      // same HP cost per tile, worth it since standing still is never free
      // here (only entering/leaving faster reduces total exposure).
      moveKeys.add("KeyW");
      moveKeys.add("ShiftLeft");
    }
    return applyAction(page, moveKeys, false, null, false);
  }

  const threat = pickThreat(enemies, player, profile);

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
    const moveKeys = new Set();
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    } else {
      moveKeys.add("KeyW");
      moveKeys.add("ShiftLeft");
    }
    return applyAction(page, moveKeys, false, null, false);
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
        const moveKeys = new Set();
        if (Math.abs(delta) > TURN_MOVE_EPS) moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        else moveKeys.add("KeyW");
        return applyAction(page, moveKeys, false, null, false);
      }
      // else: gave up retreating — fall through to normal navigation below
      // rather than freezing here (this mine is now in `abandoned`, so
      // `findDisarmableMine` right below won't just immediately re-target it).
    }
  }

  let mineTarget = !threat && profile.proactiveMineDisarm && map ? findDisarmableMine(mines, player, mineMemory?.abandoned, map) : null;
  if (mineTarget && mineMemory) {
    const key = `${mineTarget.x},${mineTarget.y}`;
    mineMemory.shootTicks = mineMemory.shootKey === key ? mineMemory.shootTicks + 1 : 1;
    mineMemory.shootKey = key;
    if (mineMemory.shootTicks > MINE_TARGET_GIVEUP_TICKS) {
      mineMemory.abandoned.add(key); // e.g. a wall blocks line of fire — stop trying, in either mode, for the rest of the level
      mineTarget = null;
    }
  }
  const aimTarget = threat ?? mineTarget;

  const currentAngle = Math.atan2(player.dirY, player.dirX);
  const moveKeys = new Set();
  let fire = false;
  let weaponSwitch = null;
  let useMelee = false;

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
    // (and with a much looser tolerance than) the ranged `fireAngleEps`
    // gate below — see `MELEE_ANGLE_EPS`'s doc comment for why sharing the
    // ranged tolerance was a real bug.
    if (threat && threat.dist <= MELEE_RANGE) {
      if (Math.abs(delta) > MELEE_ANGLE_EPS) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      } else {
        fire = true;
        useMelee = true;
      }
    } else if (Math.abs(delta) > profile.fireAngleEps) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    } else {
      fire = true;
      weaponSwitch = pickRangedWeapon(player, profile, enemies, threat);
    }
  } else if (navTarget) {
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    if (Math.abs(delta) > TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    } else {
      // Don't step onto an active spike trap — wait out its cycle instead
      // (see `activeSpikeAt`). Opposite instinct from hazard-crossing above:
      // spikes cycle safe/active and are harmless in their safe half, so
      // waiting a moment costs nothing, versus hazard which is never safe to
      // linger in and is worth rushing through instead.
      const aheadX = player.x + player.dirX * 0.6;
      const aheadY = player.y + player.dirY * 0.6;
      if (!map || !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) moveKeys.add("KeyW");
    }
  }

  return applyAction(page, moveKeys, fire, weaponSwitch, useMelee);
}

async function driveToward(page, point, eps, maxTicks, profile, map, mineMemory) {
  let { player, enemies, mines } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") {
      await applyAction(page, new Set(), false, null, false);
      return { state: player.state, reason: player.state };
    }
    if (Math.hypot(point.x - player.x, point.y - player.y) < eps) {
      await applyAction(page, new Set(), false, null, false);
      return { state: "playing", reason: "arrived" };
    }
    ({ player, enemies, mines } = await tick(page, player, enemies, mines, point, profile, map, mineMemory));
  }
  await applyAction(page, new Set(), false, null, false);
  return { state: "playing", reason: "stuck" };
}

async function faceAngle(page, targetAngle, maxTicks, profile, mineMemory) {
  let { player, enemies, mines } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") return { state: player.state };
    const threat = pickThreat(enemies, player, profile);
    if (!threat) {
      const currentAngle = Math.atan2(player.dirY, player.dirX);
      const delta = angleDelta(currentAngle, targetAngle);
      if (Math.abs(delta) < TURN_MOVE_EPS) {
        await applyAction(page, new Set(), false, null, false);
        return { state: "playing" };
      }
    }
    ({ player, enemies, mines } = await tick(page, player, enemies, mines, null, profile, undefined, mineMemory));
  }
  await applyAction(page, new Set(), false, null, false);
  return { state: "playing" };
}

async function holdForward(page, ticks) {
  for (let t = 0; t < ticks; t++) {
    const { player } = await applyAction(page, new Set(["KeyW"]), false, null, false);
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
async function applyAction(page, desiredMoveKeys, fire, weaponSwitchIndex, useMelee) {
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
      if (fire) {
        const code = useMelee ? "Space" : "Backquote";
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
      }
      if (headed) return null;
      window.__pumpVirtualTime(stepMs, stepMs);
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
    },
    { desiredKeys: [...desiredMoveKeys], fire, weaponSwitchIndex, useMelee, stepMs: VIRTUAL_STEP_MS, headed: HEADED },
  );
  if (!HEADED) return dispatched;
  await page.waitForTimeout(WATCH_STEP_MS);
  return page.evaluate(() => {
    const hooks = window.__codeensteinTestHooks;
    return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
  });
}

async function waitForTestHooks(page) {
  await page.waitForFunction(() => window.__codeensteinTestHooks !== undefined, undefined, { timeout: 15000, polling: 100 });
}

async function dismissOverlay(page) {
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

async function installDifficulty(page, difficulty) {
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
  const available = {};
  const consumed = level.runtime.economyLootStarvation?.consumed?.total ?? {};
  for (const k of ["bullets", "rockets", "health", "swap"]) {
    available[k] = (level.static.prePlacedAmmo?.[k] ?? 0) + (level.runtime.economyLootStarvation?.lootRolled?.[k] ?? 0);
    if (available[k] - (consumed[k] ?? 0) < 0) flags.push(`ammo_starvation_${k}`);
  }
  return flags;
}

function buildComboOutput(levelPlans, combo) {
  const { qualifyingRuns, attemptsUsed, failureReasons } = combo;

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
  campaignAggregate.flags = computeLevelFlags({ static: { enemyDensity: campaignAvgDensity, prePlacedAmmo: sumStaticAmmo(levelPlans) }, runtime: campaignAggregate }, campaignAvgDensity);

  const weaponFirstOwnedAtLevel = mergeWeaponFirstOwned(qualifyingRuns);

  return { attemptsUsed, qualifyingRunCount: qualifyingRuns.length, failureReasons, weaponFirstOwnedAtLevel, levels, campaignAggregate };
}

function sumStaticAmmo(levelPlans) {
  const out = { bullets: 0, rockets: 0, health: 0, swap: 0, weaponUnlocks: 0 };
  for (const lp of levelPlans) for (const k of Object.keys(out)) out[k] += lp.staticAnalysis.prePlacedAmmo[k] ?? 0;
  return out;
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

main().catch((err) => {
  console.error("run-balancing-telemetry crashed:", err);
  process.exit(1);
});

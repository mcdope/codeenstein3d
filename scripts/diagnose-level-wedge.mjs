// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot diagnostic for "the bot wedges on level N of the demo campaign".
 *
 * Exists because the wedge only reproduces under
 * `scripts/generate-default-highscore.mjs`, and that script builds its `Bot`
 * with **no logger** — so it emits no trace at all. Every trace analysed while
 * chasing this came from `run-balancing-telemetry.mjs`, which uses a different
 * `recordStepMs` and does not reproduce the failure. Two days went into
 * diagnosing the wrong harness.
 *
 * So this replicates `driveFullCampaign` with the generator's *exact* bot
 * configuration and adds every observation channel at once:
 *
 *  - a real visible browser (`--headed`) while keeping the virtual clock, so
 *    timing stays byte-identical to the failing config rather than switching to
 *    `WATCH_STEP_MS` and possibly not reproducing
 *  - full per-decision nav trace, waypoint/leg trace, drift/replan trace
 *  - every `driveToward` call and its outcome, so the failing leg is explicit
 *  - the engine's own console output
 *  - screenshots through the wedge, plus one at the moment of failure
 *  - player state and the surrounding grid dumped where it wedged
 *
 * `--mp-shape` gives the bot `MultiplayerBot`'s decision-window shape on the
 * same deterministic map, which makes this a cheap first look at a
 * `verify:multiplayer-transition` failure — seconds per attempt, no session
 * setup, and a deterministic decision sequence. It is *not* a substitute for
 * running that script: see the flag's own comment for what it cannot see.
 *
 * Usage:
 *   node scripts/diagnose-level-wedge.mjs [--level 10] [--attempts 4] [--headed]
 *
 *   --mp-shape          MultiplayerBot's stepMs/minDecisionMs/teleport tuning
 *   --ignore-threats    never engage (the transition script's host)
 *   --god-mode          IDDQD, so a run ends on navigation and not on combat
 *   --all-attempts      run every attempt instead of stopping at the first
 *                       wedge, and stop each attempt once --level clears
 *   --window-histogram  bucket the dispatched decision windows
 *   --exit-drive driveToExit|driveToward   which final approach to use
 *
 * Everything lands in `wedge-diagnosis/` (gitignored scratch).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { Bot, detectAnomalies, detectHeldKeyNoMovement, detectOscillation, summarizeActivityDistance } from "./lib/bot.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { DEV_SERVER_URL, PROFILES, planLevels, waitForTestHooks, dismissOverlay, installDifficulty } from "./run-balancing-telemetry.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
// `--level any` (the default) captures whichever level wedges — there turned out
// to be several distinct wedge sites, and pinning one target meant an attempt
// that wedged elsewhere reported "did not wedge" and threw its evidence away.
const TARGET_ARG = arg("level", "any");
const TARGET_LEVEL = TARGET_ARG === "any" ? null : Number(TARGET_ARG); // 1-based
// Per-decision nav spam is only worth it for a known target; waypoint/drift
// tracing is cheap enough to leave on for every level.
const isTarget = (n) => TARGET_LEVEL === null || n === TARGET_LEVEL;
const MAX_ATTEMPTS = Number(arg("attempts", 4));
const HEADED = process.argv.includes("--headed");
const PROFILE_NAME = arg("profile", "Casual");

// --- multiplayer-shaped mode ------------------------------------------------
//
// `verify:multiplayer-transition`'s failure is pure navigation, and navigation
// is shared code — `MultiplayerBot` overrides only `readFull`/`readState`/
// `dispatchSegment`/`readLootSources`/`minDecisionMs`/`minPhaseMs`/
// `exitAccepted` and a handful of tuning values. Everything from `planRoute`
// down through `driveLegs` / `driveTowardWithReplan` / `driveToward` /
// `decide` is identical, and runs here in seconds against that script's
// minutes, deterministically.
//
// Historical note worth keeping, because it shaped this file: this mode was
// built on the belief that the real script could not be run locally at all
// (`notes` carried a 2026-07-30 entry claiming outbound UDP was blocked, so
// STUN never completed). That was re-tested on 2026-08-03 and is false — UDP
// egress works, all three default STUN servers answer, and both
// `verify:multiplayer-connect` and `verify:multiplayer-transition` pass from
// this machine. **Run the real script when a real answer is needed.**
//
// Verified rather than assumed: demo-campaign level 1's generated map is
// byte-identical with and without `maxPlayers: 2` (grid, exit, spawn, every
// enemy incl. hp and home, every pickup, every mine), and the host's live
// multiplayer spawn tile *is* `map.spawn`, so a single-player run starts from
// the same tile and plans the same route.
//
// What this deliberately does **not** reproduce is the ~100ms lockstep input
// delay (`INPUT_DELAY_TICKS`) or real `page.evaluate` latency — the virtual
// clock is kept precisely so the decision *sequence* stays deterministic. So
// `--mp-shape` reproduces the decision shape, not the transport; a stale-input
// hypothesis can be *measured* here (see `--window-histogram`) but not proven.
const MP_SHAPE = process.argv.includes("--mp-shape");
const IGNORE_THREATS = process.argv.includes("--ignore-threats");
const GOD_MODE = process.argv.includes("--god-mode");
// Don't stop at the first wedge: a stuck *rate* needs every attempt to run.
const ALL_ATTEMPTS = process.argv.includes("--all-attempts");
const WINDOW_HISTOGRAM = process.argv.includes("--window-histogram");
// `driveToExit` is what single-player callers use; `driveToward` mirrors what
// `verify-multiplayer-transition.mjs` does, so the two can be A/B'd on one map.
const EXIT_DRIVE = arg("exit-drive", "driveToExit");

// Mirrors generate-default-highscore.mjs exactly — this is the whole point.
const VIRTUAL_STEP_MS = 50;
const RECORD_STEP_MS = 1000 / 60;
const FINAL_APPROACH_TICKS = 80;
const TELEPORT_REPLAN_LIMIT = 4;

// `multiplayerBot.mjs`'s own DEFAULT_STEP_MS / MIN_DECISION_MS /
// DEFAULT_TELEPORT_JUMP_DETECT_TILES, mirrored rather than imported: importing
// `MultiplayerBot` would drag in its page-hook overrides, which is exactly what
// must *not* change here.
const MP_STEP_MS = 400;
const MP_MIN_DECISION_MS = 300;
const MP_TELEPORT_JUMP_DETECT_TILES = 4;
// The rest of `MultiplayerBot`'s tuning defaults. These have to be here too:
// they are the behaviour under test, and a `--mp-shape` run that left them at
// `DEFAULT_TUNING` would be measuring single-player behaviour while reporting
// it as multiplayer's.
const MP_MAX_TICKS_PER_WAYPOINT = 40;
const MP_NAV_STALL_BAIL_TICKS = 24;

/** `Bot` with `MultiplayerBot`'s decision-window shape and nothing else. */
class MpShapedBot extends Bot {
  get minDecisionMs() {
    return MP_MIN_DECISION_MS;
  }
  get minPhaseMs() {
    return MP_MIN_DECISION_MS;
  }
}

const OUT = path.join(REPO_ROOT, "wedge-diagnosis");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const flush = () => fs.writeFileSync(path.join(OUT, "trace.log"), lines.join("\n"));

function dumpGrid(map, cx, cy, r = 9) {
  const SYM = { 0: ".", 1: "#", 2: "~", 3: "D", 4: "T", 5: "^", 6: "S", 7: "L", 8: "b" };
  const out = [];
  const x0 = Math.max(0, Math.floor(cx) - r), x1 = Math.min(map.grid[0].length - 1, Math.floor(cx) + r);
  const y0 = Math.max(0, Math.floor(cy) - r), y1 = Math.min(map.grid.length - 1, Math.floor(cy) + r);
  out.push(`grid x=${x0}..${x1} y=${y0}..${y1}  (bot at ${cx.toFixed(2)},${cy.toFixed(2)} marked @)`);
  out.push("      " + Array.from({ length: x1 - x0 + 1 }, (_, i) => String((x0 + i) % 10)).join(""));
  for (let y = y0; y <= y1; y++) {
    let row = "";
    for (let x = x0; x <= x1; x++) row += Math.floor(cx) === x && Math.floor(cy) === y ? "@" : (SYM[map.grid[y]?.[x]] ?? "?");
    out.push(String(y).padStart(4) + "  " + row);
  }
  return out.join("\n");
}

/** Per-level trace digest: where the distance actually went, and every anomaly
 * the balancing scan's own detectors would report. This is what turns the
 * script from "capture one wedge" into "measure a stuck rate". */
function levelDigest(bot) {
  const trace = bot.mineMemory?.trace ?? [];
  const { rows, total } = summarizeActivityDistance(trace);
  const findings = [...detectHeldKeyNoMovement(trace), ...detectAnomalies(trace), ...detectOscillation(trace)];
  return {
    decisions: trace.length,
    tiles: total,
    minHpFrac: trace.length > 0 ? Math.min(...trace.map((r) => r.hpFrac)) : 1,
    activity: rows.map((r) => `${r.activity} ${r.tiles.toFixed(1)}t (${(r.share * 100).toFixed(0)}%)`).join(", ") || "(none)",
    findings,
  };
}

async function main() {
  const levelPlans = await planLevels();
  if (TARGET_LEVEL !== null && levelPlans.length < TARGET_LEVEL) { say(`only ${levelPlans.length} levels planned`); flush(); return; }

  const browser = await chromium.launch({ headless: !HEADED });
  const profile = PROFILES[PROFILE_NAME];
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    say(`\n${"=".repeat(70)}\nATTEMPT ${attempt} — ${PROFILE_NAME}, watching for a wedge on ${TARGET_LEVEL === null ? "any level" : "level " + TARGET_LEVEL}\n${"=".repeat(70)}`);
    let levelNo = 0;
    let decisions = 0;
    let shots = 0;
    // Ring-ish buffer of this level's trace, reset per level and only flushed
    // into the report if the level actually wedges.
    let perLevel = [];

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("console", (m) => { if (isTarget(levelNo)) perLevel.push(`[engine-console] ${m.text()}`); });
    page.on("pageerror", (e) => lines.push(`[page-error] ${e.message}`));
    await installVirtualClock(page);
    await installDifficulty(page, "normal");
    // Byte-identical to generate-default-highscore.mjs's runOneAttempt.
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1&botRotSpeedMul=${profile.rotSpeedMultiplier}`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    // IDDQD, typed letter by letter on the canvas exactly as a player would
    // (`InputController.onKeyDown`) — single-player has no `debugSetGodMode`
    // hook, that one is multiplayer-only. Matches the transition script's
    // invulnerable host so a run ends on navigation, never on combat.
    // `consumeCheat` matches on `e.key.toUpperCase()`, not `e.code`, so the
    // event needs both: `code` is what every other synthetic key in this
    // harness carries, `key` is what the cheat buffer actually reads.
    //
    // There is no hook that reports god-mode state, so it is asserted
    // indirectly but positively: without it this exact run dies on level 1
    // within ~34 decisions, so `minHpFrac` staying at 1.00 across a full level
    // is the observation that the cheat landed. The summary prints it, and a
    // `died` outcome makes a silent failure impossible to miss.
    if (GOD_MODE) {
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        for (const letter of "IDDQD") {
          const ev = { code: `Key${letter}`, key: letter.toLowerCase() };
          canvas.dispatchEvent(new KeyboardEvent("keydown", ev));
          canvas.dispatchEvent(new KeyboardEvent("keyup", ev));
        }
      });
      await page.evaluate(() => window.__pumpVirtualTime(100, 1000 / 60));
    }

    // Generator's exact Bot config, plus the logging it never had.
    const BotClass = MP_SHAPE ? MpShapedBot : Bot;
    const bot = new BotClass(page, profile, {
      realtime: false,
      stepMs: MP_SHAPE ? MP_STEP_MS : VIRTUAL_STEP_MS,
      recordStepMs: RECORD_STEP_MS,
      ignoreThreats: IGNORE_THREATS,
      ...(MP_SHAPE
        ? {
            tuning: {
              TELEPORT_JUMP_DETECT_TILES: MP_TELEPORT_JUMP_DETECT_TILES,
              MAX_TICKS_PER_WAYPOINT: MP_MAX_TICKS_PER_WAYPOINT,
              BOT_LOOT_ABANDON_ON_STUCK: true,
              BOT_NAV_STALL_BAIL_TICKS: MP_NAV_STALL_BAIL_TICKS,
            },
          }
        : {}),
      logger: {
        trace: true,
        navDiag: true,
        debugNav: (msg) => { if (TARGET_LEVEL !== null && levelNo === TARGET_LEVEL) perLevel.push(msg); },
        wpDebug: (msg) => perLevel.push(msg),
        driftDebug: (msg) => perLevel.push(msg),
      },
    });

    // Record every driveToward call and outcome — this is what makes the
    // failing leg explicit instead of inferred.
    const calls = [];
    const origDrive = bot.driveToward.bind(bot);
    bot.driveToward = async (point, eps, maxTicks) => {
      const before = await bot.readState();
      const t0 = decisions;
      const res = await origDrive(point, eps, maxTicks);
      const after = await bot.readState();
      const rec = {
        target: { x: +point.x.toFixed(2), y: +point.y.toFixed(2) }, eps, maxTicks,
        from: { x: +before.x.toFixed(2), y: +before.y.toFixed(2) },
        to: { x: +after.x.toFixed(2), y: +after.y.toFixed(2) },
        endDist: +Math.hypot(point.x - after.x, point.y - after.y).toFixed(3),
        reason: res.reason, state: res.state, ticks: decisions - t0,
      };
      {
        calls.push(rec);
        if (res.reason === "stuck") {
          perLevel.push(`[STUCK] ${JSON.stringify(rec)}`);
          await page.screenshot({ path: path.join(OUT, `stuck-L${levelNo}-a${attempt}-${calls.length}.png`) });
          perLevel.push(dumpGrid(levelPlans[levelNo - 1].map, after.x, after.y));
          perLevel.push(`[player-at-stuck] ${JSON.stringify(after)}`);
        }
      }
      return res;
    };

    // Decision-window histogram. In multiplayer the lockstep input delay is
    // INPUT_DELAY_TICKS(3) at TICK_RATE_HZ(30) = ~100ms, so a decision window
    // shorter than that reads the world back before its own input has landed.
    // `applyAction` dispatches `intent.durationMs` as-is and `minDecisionMs` is
    // only consulted for the sprint-safety gate, so short turn/move bursts
    // become short windows. This measures how often that actually happens
    // before anyone changes it — `segmentsFor`'s doc comment argues the current
    // collapse is deliberate, and `doc/dev/decisions.md` records per-key holds
    // measuring *worse* in single-player, so the burden of proof is on a fix.
    const windowBuckets = { "<50": 0, "50-100": 0, "100-300": 0, "300+": 0 };
    if (WINDOW_HISTOGRAM) {
      const origApply = bot.applyAction.bind(bot);
      bot.applyAction = async (intent, opts = {}) => {
        const ms = intent.durationMs ?? opts.maxDurationMs ?? bot.stepMs;
        windowBuckets[ms < 50 ? "<50" : ms < 100 ? "50-100" : ms < 300 ? "100-300" : "300+"]++;
        return origApply(intent, opts);
      };
    }

    // Count decisions and snapshot periodically once on the target level.
    const origTick = bot.tick.bind(bot);
    bot.tick = async (...a) => {
      decisions++;
      if (isTarget(levelNo) && decisions % 400 === 0 && shots < 25) {
        shots++;
        await page.screenshot({ path: path.join(OUT, `lvl${levelNo}-a${attempt}-${String(decisions).padStart(6, "0")}.png`) });
      }
      return origTick(...a);
    };

    let wedged = false;
    for (let i = 0; i < levelPlans.length; i++) {
      levelNo = i + 1;
      const { map, routePlain, filename } = levelPlans[i];
      perLevel = [];
      calls.length = 0;
      say(`  --- level ${levelNo} is ${filename} (${map.grid[0].length}x${map.grid.length}), legs=${routePlain.legs?.length} ---`);
      bot.startLevel(map);
      // Is the bot routing around the map it is actually standing on?
      //
      // `planLevels` enumerates in filename order; the game picks its entry
      // point with `findEntrypointByScanning` (lowest complexity, and only
      // among files scoring >0). A staged campaign whose slot 1 parses to
      // complexity 0 desynchronises them, and then every route is valid for a
      // level nobody is playing.
      //
      // This is checked by *grid equality* and not by enemy count, because
      // enemy count is what missed it: curl's planner slot 1 and the level the
      // browser actually loaded both held exactly 2 enemies, the count check
      // passed, and 58 runs went into a wall the planner believed was floor.
      // The mismatch is silent from every other angle — the run just wedges.
      {
        const liveGrid = await page.evaluate(() => window.__codeensteinTestHooks.getGrid());
        let diffs = 0;
        for (let y = 0; y < map.grid.length; y++) {
          for (let x = 0; x < map.grid[y].length; x++) if (map.grid[y][x] !== liveGrid[y]?.[x]) diffs++;
        }
        if (diffs) {
          say(`  *** PLAN/ENGINE MAP MISMATCH on level ${levelNo}: ${diffs} tiles differ ***`);
          const scores = levelPlans.map((pl, k) => {
            let d = 0;
            for (let y = 0; y < pl.map.grid.length; y++) for (let x = 0; x < pl.map.grid[y].length; x++) if (pl.map.grid[y][x] !== liveGrid[y]?.[x]) d++;
            return { k, d, filename: pl.filename };
          }).sort((a, b) => a.d - b.d);
          say(`      engine is actually playing: ${scores[0].d === 0 ? `idx ${scores[0].k} ${scores[0].filename}` : `(no exact match; closest idx ${scores[0].k} at ${scores[0].d} diffs)`}`);
          say(`      every route from here is planned for a map that is not loaded — stop and fix the staging.`);
        }
      }
      const route = routePlain;
      const p0 = await bot.readState();
      if (p0.state !== "playing") { say(`  level ${levelNo}: run ended (${p0.state})`); break; }
      const prevExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());

      let outcome = route.ok ? await bot.driveLegs(route.legs) : { state: "stuck" };
      for (let r = 0; r < TELEPORT_REPLAN_LIMIT && outcome.state === "playing" && outcome.reason === "teleported"; r++) {
        const here = await bot.readState();
        const resumed = planRoute(map, { x: Math.floor(here.x), y: Math.floor(here.y) });
        if (!resumed.ok) break;
        outcome = await bot.driveLegs(resumed.legs);
      }
      if (outcome.state === "playing") {
        const exitCenter = { x: map.exit.x + 0.5, y: map.exit.y + 0.5 };
        // `driveToward` is the transition script's shape: a straight line at
        // the exit with no pathfinding, so it is the arm that shows what that
        // costs when the route did not end on the exit tile.
        const pushed =
          EXIT_DRIVE === "driveToward"
            ? await bot.driveToward(exitCenter, bot.tuning.TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS)
            : await bot.driveToExit(exitCenter, FINAL_APPROACH_TICKS);
        if (pushed.state !== "won") outcome = { state: pushed.state === "over" ? "over" : "stuck" };
      }

      if (outcome.state === "over") { say(`  level ${levelNo}: DIED`); attempts.push({ attempt, levelNo, outcome: "died", ...levelDigest(bot) }); break; }
      if (outcome.state === "stuck") {
        say(`  level ${levelNo}: STUCK`);
        attempts.push({ attempt, levelNo, outcome: "stuck", ...levelDigest(bot) });
        {
          wedged = true;
          lines.push(...perLevel);
          const s = await bot.readState();
          say(`\n--- driveToward calls on level ${levelNo} (last 25) ---`);
          for (const c of calls.slice(-25)) say(`  ${JSON.stringify(c)}`);
          say(`\n--- stuck/near-miss summary ---`);
          const stuckCalls = calls.filter((c) => c.reason === "stuck");
          say(`  driveToward calls: ${calls.length}, stuck: ${stuckCalls.length}`);
          say(`  end distances of stuck calls: ${stuckCalls.map((c) => c.endDist).join(", ")}`);
          say(`  ARRIVE_EPS=${bot.tuning.ARRIVE_EPS} TIGHT=${bot.tuning.TIGHT_ARRIVE_EPS} oneStep=${(bot.tuning.ENGINE_MOVE_SPEED * VIRTUAL_STEP_MS / 1000).toFixed(3)} tiles`);
          // Decisive check on the exit gate: compare the browser's live enemy
          // roster against the bot's own planned map, and evaluate
          // `enemyBelongsToExitRoom` on both. A mismatch here means the bot is
          // routing against a different map than the one being played.
          const live = await page.evaluate(() => window.__codeensteinTestHooks.getEnemies());
          const { x: ex, y: ey } = map.exit;
          const inExitRoom = (h) => h && ex >= h.x && ex < h.x + h.w && ey >= h.y && ey < h.y + h.h;
          say(`\n--- exit gate at (${ex},${ey}) ---`);
          say(`  browser roster: ${live.length} enemies, ${live.filter((e) => e.alive).length} alive`);
          say(`  planned map roster: ${map.enemies.length} enemies  => ${live.length === map.enemies.length ? "SAME LENGTH" : "*** LENGTH MISMATCH ***"}`);
          const planned = map.enemies.map((e, i) => ({ i, home: e.home, exitRoom: inExitRoom(e.home) }));
          const gate = planned.filter((p) => p.exitRoom);
          say(`  exit-room indices (planned map): ${gate.map((g) => g.i).join(", ") || "(none)"}`);
          for (const g of gate) {
            const l = live[g.i];
            say(`    #${g.i}: live=${l ? `alive=${l.alive} at (${l.x.toFixed(1)},${l.y.toFixed(1)}) aggroed=${l.aggroed}` : "MISSING"}`);
          }
          const aliveNotInRoom = live.map((e, i) => ({ ...e, i })).filter((e) => e.alive && !planned[e.i]?.exitRoom);
          say(`  other alive enemies: ${aliveNotInRoom.map((e) => `#${e.i}@(${e.x.toFixed(0)},${e.y.toFixed(0)})`).join(" ") || "(none)"}`);
          say(`  => exitRoomHasAliveEnemy (per planned map) = ${gate.some((g) => live[g.i]?.alive)}`);
          say(`\n${dumpGrid(map, s.x, s.y)}`);
          await page.screenshot({ path: path.join(OUT, `wedge-final-L${levelNo}-a${attempt}.png`) });
        }
        break;
      }

      // Persist the target level's per-decision trace whether or not it
      // wedged. The wedge report below only runs on failure, but an
      // *inefficiency* investigation (e.g. `detectOscillation` findings) needs
      // the trace of a level the bot successfully completed.
      if (TARGET_LEVEL !== null && levelNo === TARGET_LEVEL && perLevel.length > 0) {
        const tracePath = path.join(OUT, `level${levelNo}-a${attempt}-trace.log`);
        fs.writeFileSync(tracePath, perLevel.join("\n"));
        say(`  --- wrote ${perLevel.length} trace lines to ${path.basename(tracePath)} ---`);
      }
      if (TARGET_LEVEL !== null && levelNo === TARGET_LEVEL) {
        attempts.push({ attempt, levelNo, outcome: "cleared", ...levelDigest(bot) });
        // A stuck *rate* for one level doesn't need the rest of the campaign,
        // and playing it out is most of the wall clock across 20 attempts.
        if (ALL_ATTEMPTS) { say(`  level ${levelNo}: cleared — stopping this attempt (target level only)`); break; }
      }
      await dismissOverlay(page); // Commit Summary overlay
      // `polling: 100` is load-bearing: the virtual clock replaces
      // requestAnimationFrame, so Playwright's default rAF polling never runs.
      const adv = await page
        .waitForFunction((pe) => {
          const h = window.__codeensteinTestHooks;
          if (!h) return null;
          const e = h.getExit();
          if (e.x !== pe.x || e.y !== pe.y) return "advanced";
          if (localStorage.getItem("codeenstein-highscores")) return "campaign-complete";
          return false;
        }, prevExit, { timeout: 20000, polling: 100 })
        .then((h) => h.jsonValue())
        .catch(() => "timeout");
      say(`  level ${levelNo}: cleared (${adv})`);
      if (adv !== "advanced") break;
      await dismissOverlay(page); // next level's briefing
    }

    await context.close();
    if (WINDOW_HISTOGRAM) say(`  [window] decision windows: ${Object.entries(windowBuckets).map(([k, v]) => `${k}ms:${v}`).join("  ")}`);
    flush();
    if (wedged && !ALL_ATTEMPTS) { say(`\nCaptured a level-${levelNo} wedge on attempt ${attempt}. Artifacts in wedge-diagnosis/`); break; }
    if (!wedged) say(`  (attempt ${attempt} ended without a wedge)`);
  }

  await browser.close();

  if (attempts.length > 0) {
    say(`\n${"=".repeat(70)}\nSUMMARY — ${PROFILE_NAME}${MP_SHAPE ? ", mp-shape" : ""}${IGNORE_THREATS ? ", ignoreThreats" : ""}${GOD_MODE ? ", godMode" : ""}, exit-drive=${EXIT_DRIVE}\n${"=".repeat(70)}`);
    say("  att lvl outcome   decisions   tiles  minHp  activity");
    for (const a of attempts) {
      say(`  ${String(a.attempt).padStart(3)} ${String(a.levelNo).padStart(3)} ${a.outcome.padEnd(9)} ${String(a.decisions).padStart(9)} ${a.tiles.toFixed(1).padStart(7)}  ${a.minHpFrac.toFixed(2)}   ${a.activity}`);
      for (const f of a.findings) say(`        [${f.type}] ${f.ticks} ticks, decisions ${f.startTick}-${f.endTick} ${f.detail}`);
    }
    const stuck = attempts.filter((a) => a.outcome === "stuck").length;
    const died = attempts.filter((a) => a.outcome === "died").length;
    say(`\n  stuck ${stuck}/${attempts.length}, died ${died}/${attempts.length}, cleared ${attempts.length - stuck - died}/${attempts.length}`);
    const worst = attempts.flatMap((a) => a.findings).sort((x, y) => y.ticks - x.ticks)[0];
    say(`  longest anomaly run: ${worst ? `${worst.type} ${worst.ticks} ticks` : "(none)"}`);
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(attempts, null, 2));
  }

  flush();
  say(`\nscreenshots: ${fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length}, trace: wedge-diagnosis/trace.log`);
  flush();
}

main().catch((e) => { say(`FAILED: ${e.stack}`); flush(); process.exit(1); });

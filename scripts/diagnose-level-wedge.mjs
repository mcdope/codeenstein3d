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
 * Usage:
 *   node scripts/diagnose-level-wedge.mjs [--level 10] [--attempts 4] [--headed]
 *
 * Everything lands in `wedge-diagnosis/` (gitignored scratch).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { Bot } from "./lib/bot.mjs";
import { planRoute } from "./lib/routePlanner.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { DEV_SERVER_URL, PROFILES, planLevels, waitForTestHooks, dismissOverlay, installDifficulty } from "./run-balancing-telemetry.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const TARGET_LEVEL = Number(arg("level", 10)); // 1-based
const MAX_ATTEMPTS = Number(arg("attempts", 4));
const HEADED = process.argv.includes("--headed");
const PROFILE_NAME = arg("profile", "Casual");

// Mirrors generate-default-highscore.mjs exactly — this is the whole point.
const VIRTUAL_STEP_MS = 50;
const RECORD_STEP_MS = 1000 / 60;
const FINAL_APPROACH_TICKS = 80;
const TELEPORT_REPLAN_LIMIT = 4;

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

async function main() {
  const levelPlans = await planLevels();
  if (levelPlans.length < TARGET_LEVEL) { say(`only ${levelPlans.length} levels planned`); flush(); return; }

  const browser = await chromium.launch({ headless: !HEADED });
  const profile = PROFILES[PROFILE_NAME];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    say(`\n${"=".repeat(70)}\nATTEMPT ${attempt} — ${PROFILE_NAME}, watching for a wedge on level ${TARGET_LEVEL}\n${"=".repeat(70)}`);
    let levelNo = 0;
    let decisions = 0;
    let shots = 0;

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("console", (m) => { if (levelNo === TARGET_LEVEL) lines.push(`[engine-console] ${m.text()}`); });
    page.on("pageerror", (e) => lines.push(`[page-error] ${e.message}`));
    await installVirtualClock(page);
    await installDifficulty(page, "normal");
    // Byte-identical to generate-default-highscore.mjs's runOneAttempt.
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1&botRotSpeedMul=${profile.rotSpeedMultiplier}`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    // Generator's exact Bot config, plus the logging it never had.
    const bot = new Bot(page, profile, {
      realtime: false,
      stepMs: VIRTUAL_STEP_MS,
      recordStepMs: RECORD_STEP_MS,
      logger: {
        trace: true,
        navDiag: true,
        debugNav: (msg) => { if (levelNo === TARGET_LEVEL) lines.push(msg); },
        wpDebug: (msg) => { if (levelNo === TARGET_LEVEL) lines.push(msg); },
        driftDebug: (msg) => { if (levelNo === TARGET_LEVEL) lines.push(msg); },
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
      if (levelNo === TARGET_LEVEL) {
        calls.push(rec);
        if (res.reason === "stuck") {
          lines.push(`[STUCK] ${JSON.stringify(rec)}`);
          await page.screenshot({ path: path.join(OUT, `stuck-${attempt}-${calls.length}.png`) });
          lines.push(dumpGrid(levelPlans[TARGET_LEVEL - 1].map, after.x, after.y));
          lines.push(`[player-at-stuck] ${JSON.stringify(after)}`);
        }
      }
      return res;
    };

    // Count decisions and snapshot periodically once on the target level.
    const origTick = bot.tick.bind(bot);
    bot.tick = async (...a) => {
      decisions++;
      if (levelNo === TARGET_LEVEL && decisions % 400 === 0 && shots < 25) {
        shots++;
        await page.screenshot({ path: path.join(OUT, `lvl${TARGET_LEVEL}-a${attempt}-${String(decisions).padStart(6, "0")}.png`) });
      }
      return origTick(...a);
    };

    let wedged = false;
    for (let i = 0; i < levelPlans.length; i++) {
      levelNo = i + 1;
      const { map, routePlain, routeCoverage, filename } = levelPlans[i];
      if (levelNo === TARGET_LEVEL) say(`  --- level ${levelNo} is ${filename} (${map.grid[0].length}x${map.grid.length}), legs=${(profile.coverageMode ? routeCoverage : routePlain).legs?.length} ---`);
      bot.startLevel(map);
      const route = profile.coverageMode ? routeCoverage : routePlain;
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
        const pushed = await bot.driveToExit({ x: map.exit.x + 0.5, y: map.exit.y + 0.5 }, FINAL_APPROACH_TICKS);
        if (pushed.state !== "won") outcome = { state: pushed.state === "over" ? "over" : "stuck" };
      }

      if (outcome.state === "over") { say(`  level ${levelNo}: DIED`); break; }
      if (outcome.state === "stuck") {
        say(`  level ${levelNo}: STUCK`);
        if (levelNo === TARGET_LEVEL) {
          wedged = true;
          const s = await bot.readState();
          say(`\n--- driveToward calls on level ${TARGET_LEVEL} (last 25) ---`);
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
          await page.screenshot({ path: path.join(OUT, `wedge-final-${attempt}.png`) });
        }
        break;
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
    flush();
    if (wedged) { say(`\nCaptured a level-${TARGET_LEVEL} wedge on attempt ${attempt}. Artifacts in wedge-diagnosis/`); break; }
    say(`  (attempt ${attempt} did not wedge on level ${TARGET_LEVEL})`);
  }

  await browser.close();
  flush();
  say(`\nscreenshots: ${fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length}, trace: wedge-diagnosis/trace.log`);
  flush();
}

main().catch((e) => { say(`FAILED: ${e.stack}`); flush(); process.exit(1); });

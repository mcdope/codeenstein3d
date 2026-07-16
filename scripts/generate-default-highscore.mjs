// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot dev tool: plays the bundled `demo-campaign/` 10 times via a
 * headless-Chromium bot (real, non-cheated input — see the combat/navigation
 * driver below), keeps the 3 highest-scoring runs, and writes them as
 * `src/engine/defaultHighscore.ts` — a small pre-populated leaderboard shown
 * to a first-time player whose own `localStorage` highscore board is empty
 * (see `loadHighscoresForDisplay` in `src/engine/highscores.ts`).
 *
 * Not CI-wired — there's no CI in this repo yet, and even once there is, a
 * 10x real-playthrough bot run has no place gating every push. Run manually
 * (`npm run generate:default-highscore`) against a locally running dev
 * server, review the printed summary and the resulting file's diff, and
 * commit if it looks right — the same one-shot, hand-reviewed-then-committed
 * workflow `demo-campaign/` itself and its own verifier scripts already use.
 *
 * The bot is a pragmatic heuristic, not a tactical AI (see
 * `scripts/lib/routePlanner.mjs` for the navigation half): BFS-plan a route
 * to the exit (detouring for keys/doors as needed), walk it with real
 * `KeyboardEvent`s, and whenever a nearby aggroed enemy is in view, stop and
 * fight it with real turning (`KeyQ`/`KeyE`) and real firing (`Backquote`).
 * Firing deliberately never touches the mouse: `Backquote` alone already
 * drives both a single-shot weapon's edge-triggered `fireQueued` and an auto
 * weapon's held-down `isFireHeld()` (`this.keys.has("Backquote")`, see
 * `src/engine/input.ts`), and empirically, `page.mouse.down()`/`up()` (the
 * first approach tried here) turned out to synthesize real `mousemove`
 * events even with no explicit `page.mouse.move()` call — once Pointer Lock
 * is active, those land as large, uncapped mouse-look rotations (unlike
 * keyboard turning, which is hard-capped at `ROT_SPEED*dt` per frame) and
 * made the bot's facing spin uncontrollably. `Backquote`-only firing
 * sidesteps Pointer Lock entirely, so the canvas never even needs a click —
 * it used to be `Space` until that key was repurposed for quick-melee (see
 * `src/engine/input.ts`'s `isMeleeHeld()` doc comment for why: holding the
 * old Left-Ctrl melee-fire while also pressing W spelled out the
 * browser-reserved, unblockable `Ctrl+W` "close tab" shortcut).
 * `Backquote` is a deliberate, undocumented escape hatch that exists
 * specifically for this bot — see `isFireHeld()`'s doc comment. It is not
 * expected to reliably clear all 17 levels, especially the multi-Elite
 * finale — that's fine: `recordHighscore` accepts any non-cheated run with
 * `levelsCleared >= 1`, and only the best 3 of 10 runs need to ship.
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { planRoute } from "./lib/routePlanner.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const CAMPAIGN_NAME = "demo-campaign";
const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const OUTPUT_FILE = path.join(REPO_ROOT, "src/engine/defaultHighscore.ts");

const RUN_COUNT = 10;
const KEEP_COUNT = 3;
// Each run gets its own fresh browser context (isolated localStorage) and
// only reads the shared, never-mutated `levelPlans` — so runs are fully
// independent and safe to drive concurrently, the same batched-Promise.all
// pattern `run-balancing-telemetry.mjs` already uses (see its
// `ATTEMPT_CONCURRENCY`). Kept lower than that script's default (12) since
// each run here plays a *full* campaign (17 levels) rather than one short
// attempt — default picked to meaningfully cut real wall-clock generation
// time without oversubscribing a single machine's headless Chromium.
const RUN_CONCURRENCY = process.env.CODEENSTEIN_HIGHSCORE_CONCURRENCY ? Number(process.env.CODEENSTEIN_HIGHSCORE_CONCURRENCY) : 4;

// How much virtual game-time one bot decision (one `applyAction` round trip)
// advances — the bot's own AI-tick cadence, not the recorded replay's frame
// size (see `RECORD_STEP_MS`). Keeping this separate from frame size means
// `MAX_TICKS_PER_WAYPOINT`/`FINAL_APPROACH_TICKS`/`DOOR_OPEN_TICKS`'s virtual-
// time budgets, and the real Playwright round-trip count driving them (the
// actual cost of running this script), are both untouched by how finely the
// replay gets recorded.
const VIRTUAL_STEP_MS = 50;
// Recorded `ReplayFrame` granularity — matches a real 60fps display frame so
// a default-highscore replay's frame density/dt distribution looks like a
// real live playthrough's, instead of the coarse `VIRTUAL_STEP_MS`-sized
// frames a bot-generated recording produced before (which played back ~3x
// too fast: `main.ts`'s replay `step()` advances exactly one recorded frame
// per real render tick, regardless of that frame's own `dt`, so a replay
// with 3x-fewer-but-3x-longer frames covering the same virtual duration
// finishes in ~1/3 the real time — see the `notes` root-cause entry this
// fixed). `VIRTUAL_STEP_MS` divides evenly into this (50 / (1000/60) = 3),
// so each bot decision now records exactly 3 real-frame-sized `ReplayFrame`s
// instead of 1 coarse one, with the bot's own decision cadence unchanged.
const RECORD_STEP_MS = 1000 / 60;
const MAX_TICKS_PER_WAYPOINT = 600; // 30s virtual time per waypoint — the effective per-level ceiling is this times the route's waypoint count
const FINAL_APPROACH_TICKS = 80; // extra push onto the exit tile's exact center

const TURN_MOVE_EPS = 0.2; // rad — turn until facing within this before moving
const FIRE_ANGLE_EPS = 0.12; // rad — only hold fire once aimed this tightly
const ARRIVE_EPS = 0.15; // tiles — waypoint arrival tolerance (matches verify-campaign-playthrough.mjs)
const TIGHT_ARRIVE_EPS = 0.05; // tiles — final-approach-onto-exit tolerance
const AGGRO_RADIUS = 7.5; // src/engine/enemyAi.ts
const ENGAGE_RADIUS = AGGRO_RADIUS + 2;
const DOOR_OPEN_TICKS = 10;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function angleDelta(current, target) {
  const d = target - current;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/** Node-side port of `decompressFromStorage` (`src/engine/storageCompression.ts`)
 * — no browser API needed, `localStorage`'s raw string is read via
 * `page.evaluate` and decompressed here in plain Node. */
function decompressHighscoreBlob(raw) {
  const COMPRESSED_PREFIX = "gz1:";
  if (!raw.startsWith(COMPRESSED_PREFIX)) return JSON.parse(raw);
  const bytes = Buffer.from(raw.slice(COMPRESSED_PREFIX.length), "base64");
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}

/** Same per-file AST hash `CampaignReplayRecorder.startLevel` records into
 * `ReplayLevelSegment.astHash` (`hashRun` in `src/engine/highscores.ts`),
 * computed independently in Node. */
function computeAstHash(parsed, campaignName) {
  const bytes = Buffer.from(`${campaignName} ${JSON.stringify(parsed)}`, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  console.log("Loading engine modules + planning routes in Node...\n");
  const { parseFile, extensionOf, MapGenerator } = await loadEngineModules();
  const generator = new MapGenerator();

  const filenames = fs
    .readdirSync(CAMPAIGN_DIR)
    .filter((f) => fs.statSync(path.join(CAMPAIGN_DIR, f)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // Phase 0: Node-only feasibility precheck — purely diagnostic, doesn't gate
  // Phase 1, just tells us up front which levels the bot can structurally
  // reach the exit of before spending browser time on any of them.
  const levelPlans = [];
  for (const filename of filenames) {
    const text = fs.readFileSync(path.join(CAMPAIGN_DIR, filename), "utf8");
    const parsed = await parseFile(filename, text);
    if (!parsed) {
      console.log(`[${filename}] PARSE FAIL — skipping`);
      continue;
    }
    const bonusLevel = extensionOf(filename) === "h";
    const map = generator.generate(parsed, bonusLevel, false, [3, 4, 5]);
    const route = planRoute(map);
    console.log(
      `[${filename}] route=${route.ok ? "OK" : `FAIL (${route.reason})`}${route.ok ? ` crossesHazard=${route.crossesHazard}` : ""} doors=${map.doors.length} keys=${map.keys.length} teleporters=${map.teleporters.length}`,
    );
    levelPlans.push({ filename, filePath: `${CAMPAIGN_NAME}/${filename}`, map, route });
  }
  const reachableCount = levelPlans.filter((l) => l.route.ok).length;
  console.log(`\n${reachableCount}/${levelPlans.length} levels have a planned route (bot may still die to combat before reaching some of them).\n`);

  console.log(`Launching headless Chromium for ${RUN_COUNT} playthroughs (concurrency ${RUN_CONCURRENCY})...\n`);
  const browser = await chromium.launch();
  const results = [];

  for (let batchStart = 1; batchStart <= RUN_COUNT; batchStart += RUN_CONCURRENCY) {
    const batchRuns = Array.from(
      { length: Math.min(RUN_CONCURRENCY, RUN_COUNT - batchStart + 1) },
      (_, i) => batchStart + i,
    );
    const batch = await Promise.all(batchRuns.map((run) => runOnePlaythrough(browser, run, levelPlans)));
    results.push(...batch.filter(Boolean));
  }

  await browser.close();

  if (results.length === 0) {
    console.error("\nNo run produced a valid highscore entry — nothing to ship. Bailing out.");
    process.exit(1);
  }

  results.sort((a, b) => b.entry.score - a.entry.score);
  const kept = results.slice(0, KEEP_COUNT);

  console.log(`\n${"=".repeat(72)}\nSummary (all ${results.length} valid runs, sorted by score)\n${"=".repeat(72)}`);
  for (const r of results) {
    const keptMark = kept.includes(r) ? "KEPT" : "    ";
    console.log(`  [${keptMark}] run ${r.run}: score=${r.entry.score} levelsCleared=${r.entry.levelsCleared} levelName=${r.entry.levelName}`);
  }

  console.log("\nRe-verifying kept entries' replay astHash values against fresh on-disk hashes...");
  for (const { run, entry } of kept) {
    check(`run ${run}: entry.source === "demo"`, entry.source === "demo");
    check(`run ${run}: replay.version === 2`, entry.replay?.version === 2);
    check(`run ${run}: replay has >=1 level segment`, (entry.replay?.levels?.length ?? 0) >= 1);
    for (const seg of entry.replay?.levels ?? []) {
      const filename = seg.filePath.split("/").pop();
      const text = fs.readFileSync(path.join(CAMPAIGN_DIR, filename), "utf8");
      const parsed = await parseFile(filename, text);
      const expected = computeAstHash(parsed, CAMPAIGN_NAME);
      check(`run ${run}: ${filename} astHash matches fresh on-disk parse`, seg.astHash === expected, `${seg.astHash} !== ${expected}`);
      check(`run ${run}: ${filename} replay segment has recorded frames`, Array.isArray(seg.frames) && seg.frames.length > 0);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed — not writing ${OUTPUT_FILE}. Investigate before regenerating.`);
    process.exit(1);
  }

  writeDefaultHighscoreFile(kept.map((r) => r.entry));
  console.log(`\nWrote ${OUTPUT_FILE} — review with \`git diff\` before committing.`);
}

/** Drives one full campaign playthrough in its own fresh, isolated browser
 * context and extracts the highscore entry it recorded, if any. Runs
 * concurrently with other calls (batched in `main`) — every side effect is
 * scoped to this call's own `context`/`page`, so there's no shared mutable
 * state between concurrent playthroughs beyond the read-only `levelPlans`.
 * Returns `null` instead of pushing/logging directly so `main` can collect
 * a whole concurrent batch via `Promise.all` before deciding what to do with
 * it. */
async function runOnePlaythrough(browser, run, levelPlans) {
  const log = (msg) => console.log(`[run ${run}] ${msg}`);
  log(`${"=".repeat(72)}\nRun ${run}/${RUN_COUNT}\n${"=".repeat(72)}`);
  const context = await browser.newContext(); // fresh, isolated localStorage per run
  const page = await context.newPage();
  page.on("pageerror", (err) => log(`[pageerror] ${err.message}`));

  try {
    await installVirtualClock(page);
    await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);
    await page.click("#tab-demo");
    await page.click("#launch-demo-campaign");
    await waitForTestHooks(page);
    await dismissOverlay(page);

    const outcome = await playRun(page, levelPlans);
    log(`run outcome: ${outcome.reason} (levels attempted: ${outcome.levelsAttempted})`);

    const highscoreRaw = await page
      .waitForFunction(() => localStorage.getItem("codeenstein-highscores"), undefined, { timeout: 15000, polling: 100 })
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    if (!highscoreRaw) {
      log("no highscore entry recorded (died on level 1, or got stuck before clearing one)");
      return null;
    }
    const board = decompressHighscoreBlob(highscoreRaw);
    const entry = board[0]; // fresh context — this run's is the only entry
    log(`recorded entry: score=${entry.score} levelsCleared=${entry.levelsCleared} levelName=${entry.levelName}`);
    return { run, entry };
  } finally {
    await context.close();
  }
}

/** Plays one full run: walks the precomputed route for each level in order,
 * fighting off nearby aggroed enemies along the way, until either death or
 * running out of levels (campaign complete). Returns `{ reason,
 * levelsAttempted }` — `reason` is one of `"died"`, `"campaign-complete"`,
 * `"stuck"` (a level's route/combat never resolved within its tick budget). */
async function playRun(page, levelPlans) {
  let prevExit = null;
  for (let i = 0; i < levelPlans.length; i++) {
    const { filename, route } = levelPlans[i];
    console.log(`  level ${i + 1}/${levelPlans.length}: ${filename}${route.ok ? "" : " (no planned route — combat/stray movement only)"}`);

    const player = await readState(page);
    if (player.state !== "playing") return { reason: player.state === "over" ? "died" : "stuck", levelsAttempted: i };
    prevExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());

    const legOutcome = route.ok ? await driveLegs(page, route.legs) : { state: "stuck" };
    if (legOutcome.state === "over") return { reason: "died", levelsAttempted: i + 1 };
    if (legOutcome.state === "stuck") return { reason: "stuck", levelsAttempted: i };
    if (legOutcome.state === "playing") {
      // finished every planned waypoint without the engine flipping to "won"
      // yet (rare epsilon miss) — push directly onto the exact exit center.
      const exitCenter = { x: levelPlans[i].map.exit.x + 0.5, y: levelPlans[i].map.exit.y + 0.5 };
      const pushed = await driveToward(page, exitCenter, TIGHT_ARRIVE_EPS, FINAL_APPROACH_TICKS);
      if (pushed.state === "over") return { reason: "died", levelsAttempted: i + 1 };
      if (pushed.state !== "won") return { reason: "stuck", levelsAttempted: i + 1 };
    }
    // else legOutcome.state === "won" — already flipped mid-drive, fall
    // through to the advance-or-complete wait below.

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

    if (advance === "campaign-complete") return { reason: "campaign-complete", levelsAttempted: i + 1 };
    if (advance !== "advanced") return { reason: "stuck", levelsAttempted: i + 1 };
    await dismissOverlay(page); // next level's briefing
  }
  return { reason: "campaign-complete", levelsAttempted: levelPlans.length };
}

/** Drives every leg of a planned route in order. Returns `{ state }` — the
 * player's terminal `state` field the moment it stops being `"playing"`, or
 * `"playing"` if every leg finished without that happening (see the
 * final-approach fallback in `playRun`). */
async function driveLegs(page, legs) {
  for (const leg of legs) {
    if (leg.kind === "walk") {
      for (const wp of leg.waypoints) {
        const result = await driveToward(page, wp, ARRIVE_EPS, MAX_TICKS_PER_WAYPOINT);
        if (result.state !== "playing") return result; // over/won mid-walk
        if (result.reason === "stuck") return { state: "stuck" };
      }
    } else if (leg.kind === "openDoor") {
      const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
      const faced = await faceAngle(page, targetAngle, MAX_TICKS_PER_WAYPOINT);
      if (faced.state !== "playing") return faced;
      const held = await holdForward(page, DOOR_OPEN_TICKS);
      if (held.state !== "playing") return held;
    }
  }
  return { state: "playing" };
}

/** One tick's worth of combat-aware decision-making: if a nearby aggroed
 * enemy is alive, turn to face it and fire once aimed (preempting whatever
 * navigation target the caller wanted this tick); otherwise turn/move toward
 * `target` ({x,y}), or just hold still (no `target`) while still fighting
 * back. Applies the decision, pumps one virtual step, and returns the fresh
 * `{player, enemies}` reading. */
async function tick(page, player, enemies, target) {
  const threat = enemies
    .filter((e) => e.alive && e.aggroed)
    .map((e) => ({ ...e, dist: Math.hypot(e.x - player.x, e.y - player.y) }))
    .filter((e) => e.dist < ENGAGE_RADIUS)
    .sort((a, b) => a.dist - b.dist)[0];

  const currentAngle = Math.atan2(player.dirY, player.dirX);
  const moveKeys = new Set();
  let fire = false;

  if (threat) {
    const targetAngle = Math.atan2(threat.y - player.y, threat.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    if (Math.abs(delta) > FIRE_ANGLE_EPS) moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    else fire = true;
  } else if (target) {
    const targetAngle = Math.atan2(target.y - player.y, target.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    if (Math.abs(delta) > TURN_MOVE_EPS) moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    else moveKeys.add("KeyW");
  }

  return applyAction(page, moveKeys, fire);
}

/** Drives straight toward a fixed `{x,y}` world point until within `eps`
 * tiles of it, the player's `state` stops being `"playing"`, or `maxTicks`
 * elapses (returns `reason: "stuck"` in that last case). Interleaves combat
 * every tick via the shared `tick()` decision function. */
async function driveToward(page, point, eps, maxTicks) {
  let { player, enemies } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") {
      await applyAction(page, new Set(), false);
      return { state: player.state, reason: player.state };
    }
    if (Math.hypot(point.x - player.x, point.y - player.y) < eps) {
      await applyAction(page, new Set(), false);
      return { state: "playing", reason: "arrived" };
    }
    ({ player, enemies } = await tick(page, player, enemies, point));
  }
  await applyAction(page, new Set(), false);
  return { state: "playing", reason: "stuck" };
}

/** Turns in place to face `targetAngle` (no forward movement), still
 * fighting back if something aggroed closes in while turning. */
async function faceAngle(page, targetAngle, maxTicks) {
  let { player, enemies } = await readFull(page);
  for (let t = 0; t < maxTicks; t++) {
    if (player.state !== "playing") return { state: player.state };
    const threat = enemies.find((e) => e.alive && e.aggroed && Math.hypot(e.x - player.x, e.y - player.y) < ENGAGE_RADIUS);
    if (!threat) {
      const currentAngle = Math.atan2(player.dirY, player.dirX);
      const delta = angleDelta(currentAngle, targetAngle);
      if (Math.abs(delta) < TURN_MOVE_EPS) {
        await applyAction(page, new Set(), false);
        return { state: "playing" };
      }
    }
    ({ player, enemies } = await tick(page, player, enemies, null));
  }
  await applyAction(page, new Set(), false);
  return { state: "playing" };
}

/** Holds forward (`KeyW`) for `ticks` virtual steps — used right after
 * `faceAngle` to trigger `openDoorAhead()`, which reads held W/S + facing
 * every frame (no explicit interact key). */
async function holdForward(page, ticks) {
  for (let t = 0; t < ticks; t++) {
    const { player } = await applyAction(page, new Set(["KeyW"]), false);
    if (player.state !== "playing") return { state: player.state };
  }
  await applyAction(page, new Set(), false);
  return { state: "playing" };
}

async function readFull(page) {
  return page.evaluate(() => {
    const hooks = window.__codeensteinTestHooks;
    return { player: hooks.getPlayerState(), enemies: hooks.getEnemies() };
  });
}

async function readState(page) {
  return page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
}

/** Diffs `desiredMoveKeys` against whatever's currently held (tracked
 * in-page, see `window.__botHeldKeys`), dispatches the resulting
 * keydown/keyup pairs on the canvas, optionally taps a fresh `Backquote`
 * keydown+keyup (edge-triggered — `Backquote` alone drives both single-shot
 * and held-auto weapon firing, see the module doc comment), pumps
 * `VIRTUAL_STEP_MS` of virtual time in `RECORD_STEP_MS`-sized sub-steps (so
 * this one bot decision still costs one in-page round trip, but records
 * several real-frame-sized `ReplayFrame`s instead of one coarse one — see
 * `RECORD_STEP_MS`'s doc comment), and returns the fresh `{player, enemies}`
 * reading. Keyboard input never needs to be trusted (`InputController`
 * doesn't check `isTrusted`), so this stays a single in-page round trip. */
async function applyAction(page, desiredMoveKeys, fire) {
  return page.evaluate(
    ({ desiredKeys, fire, stepMs, recordStepMs }) => {
      const canvas = document.querySelector("canvas");
      const hooks = window.__codeensteinTestHooks;
      const desired = new Set(desiredKeys);
      const held = (window.__botHeldKeys ??= new Set());
      for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
      for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
      window.__botHeldKeys = desired;
      if (fire) {
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote" }));
        canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "Backquote" }));
      }
      window.__pumpVirtualTime(stepMs, recordStepMs);
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies() };
    },
    { desiredKeys: [...desiredMoveKeys], fire, stepMs: VIRTUAL_STEP_MS, recordStepMs: RECORD_STEP_MS },
  );
}

async function waitForTestHooks(page) {
  await page.waitForFunction(() => window.__codeensteinTestHooks !== undefined, undefined, { timeout: 15000, polling: 100 });
}

/** Dismisses whichever `GameHud` canvas-drawn overlay is currently up (the
 * pre-level briefing or the post-exit Commit Summary) — see the identical
 * helper's doc comment in `verify-campaign-playthrough.mjs`. A no-op if none
 * is up. */
async function dismissOverlay(page) {
  await page.evaluate((recordStepMs) => {
    window.__pumpVirtualTime(1500, recordStepMs);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.__pumpVirtualTime(50, recordStepMs);
  }, RECORD_STEP_MS);
}

/** Synchronous virtual clock — see the identical stub's doc comment in
 * `verify-campaign-playthrough.mjs`. This script doesn't need the OPFS
 * workspace-picker stub that script also installs: the bundled Demo
 * Campaign tab (`#launch-demo-campaign`) needs no picker at all. */
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

function formatEntry(entry) {
  const lines = JSON.stringify(entry, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return lines;
}

function writeDefaultHighscoreFile(entries) {
  const header = `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shipped fallback leaderboard, shown only when a player's own localStorage
 * highscore board is empty (see \`loadHighscoresForDisplay\` in
 * \`./highscores.ts\`) — so a first-time visitor sees a populated Highscores
 * dialog (with working "Watch Replay" buttons) instead of "No runs recorded
 * yet".
 *
 * Generated by \`scripts/generate-default-highscore.mjs\`
 * (\`npm run generate:default-highscore\`): 10 automated headless-Chromium
 * playthroughs of the bundled \`demo-campaign/\`, keeping the 3
 * highest-scoring non-cheated runs. Regenerate this file if
 * \`demo-campaign/\`'s source files ever change — each entry's
 * \`replay.levels[].astHash\` is a SHA-256 of that level's parsed AST plus the
 * campaign name, and \`startReplay\` (\`src/main.ts\`) refuses to play back a
 * replay whose recomputed hash no longer matches, so an edited demo-campaign
 * file silently breaks these entries' "Watch Replay" buttons until this file
 * is regenerated.
 */
import type { HighscoreEntry } from "./highscores";

export const DEFAULT_HIGHSCORE_ENTRIES: HighscoreEntry[] = [
`;
  const body = entries.map((e) => formatEntry(e)).join(",\n");
  const footer = `\n];\n`;
  fs.writeFileSync(OUTPUT_FILE, header + body + footer);
}

main().catch((err) => {
  console.error("generate-default-highscore crashed:", err);
  process.exit(1);
});

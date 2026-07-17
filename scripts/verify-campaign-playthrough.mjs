// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Headless playthrough verifier for the save/highscore/replay *mechanism*:
 * drives the real app (src/main.ts) through Playwright, with two
 * browser-only seams stubbed out so no native dialog or wall-clock waiting is
 * required. Chromium by default; set `CODEENSTEIN_VERIFY_BROWSER=firefox`
 * (see `lib/browserEngine.mjs`) to run the same checks against Firefox
 * instead — safe to do here specifically because the OPFS stub below never
 * touches the real, genuinely Chromium-only `window.showDirectoryPicker`
 * dialog. **Not `webkit`**: Playwright's own WebKit build has no
 * `navigator.storage` at all (confirmed directly — a Playwright build gap,
 * not a real Safari limitation), so the OPFS stub itself has nothing to call
 * — CI skips this script for the `webkit` matrix leg for that reason, see
 * `.github/workflows/verify.yml`:
 *
 *  - `window.showDirectoryPicker` is replaced (via `page.addInitScript`, so
 *    the stub is in place before the app's own module-load-time feature
 *    check runs) with one that resolves to an Origin Private File System
 *    directory — a real `FileSystemDirectoryHandle`, so
 *    `readDirectoryTree`/`readFileText` in `src/fs/workspace.ts` need no
 *    changes or awareness of the swap.
 *  - `requestAnimationFrame`/`performance.now`/`Date.now` are replaced with a
 *    synchronous "virtual clock" (`window.__pumpVirtualTime`) so seconds of
 *    simulated gameplay (autosave's 3s throttle, a hazard-tile death)
 *    resolve in milliseconds of real test time instead of real waiting.
 *
 * Deliberate scope decision — this drives `scripts/fixtures/`, NOT
 * `demo-campaign/`: player movement/pathing here is real, not cheated
 * (`IDCLIP`/`IDDQD` would mark `cheatsUsed`, which disqualifies a run from
 * ever reaching the highscore board — see `src/main.ts` — so this script
 * never uses them), but it also never fights back or aims (facing never
 * rotates — see `walkWaypoints`'s doc comment). `demo-campaign/`'s levels are
 * deliberately authored to showcase every enemy type, including real combat
 * encounters a fighting-and-aiming player is expected to handle — main.c's
 * own first room, for instance, reliably kills a non-fighting walker
 * (confirmed empirically: identical outcome across repeated runs, since the
 * encounter is close enough that a roam-RNG head start never matters). Two
 * tiny, purpose-built fixtures (verified via the same Node BFS/MapGenerator
 * tooling to have a short, low-risk path to their exit/hazard) exercise the
 * exact same real code paths — `pickWorkspace`, `readDirectoryTree`,
 * `parseFile`, `MapGenerator`, `RaycasterEngine`, save/highscore/replay — with
 * content chosen for this script's own limits rather than the campaign's.
 * `scripts/fixtures/main.c` in particular is deliberately a single trivial
 * function: `MapGenerator`'s seed is hashed from a file's exact content
 * (name/LOC/entities), and every function-bearing room spawns its enemy at
 * the room's own center — exactly where a corridor to the next room starts
 * — so the walk to the exit unavoidably passes close by it. Editing this
 * fixture (even just its function's name) reseeds generation and can easily
 * regenerate a longer/closer path this script's non-fighting walker doesn't
 * survive; re-run this script after any change to it, and if it starts
 * failing here, retry with a different trivial name/body rather than adding
 * combat capability to `walkWaypoints`.
 * `demo-campaign/`'s structural correctness (every map feature/enemy type
 * present) is already covered exhaustively by `verify-demo-campaign.mjs`.
 *
 * What this proves, concretely:
 *  - Save: after a real level transition (the fixture's exit reached), the
 *    autosave fires and survives a full page reload + "Continue Run".
 *  - Highscore: a non-cheated death after clearing >=1 level records a new
 *    board entry whose `hash` this script independently recomputes (SHA-256
 *    over every parsed AST in the workspace + campaign name, exactly as
 *    `computeCodebaseStats`/`hashRun` do) and confirms matches.
 *  - The save is cleared on death (`clearCampaignSave`), and the new
 *    highscore entry carries an attached `replay` payload.
 *
 * Scope note: this does not re-drive the captured replay through a second
 * full playback pass (that would roughly double this script's complexity
 * for a determinism guarantee the engine's replay system already documents
 * and relies on internally) — it verifies the replay payload's structural
 * integrity (frame count, seed, per-level astHash) rather than bit-for-bit
 * re-simulating it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { bfsPath, pathToWaypoints } from "./lib/pathfind.mjs";
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "scripts/fixtures");
const CAMPAIGN_NAME = "playthrough-fixture";
const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5183";
const VIRTUAL_STEP_MS = 50;
const MAX_TICKS_PER_WAYPOINT = 600; // 30s of virtual time per waypoint

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Same combined-AST hash `computeCodebaseStats`/`hashRun` produce in
 * `src/main.ts`/`src/engine/highscores.ts`, computed independently in Node
 * so this script isn't just trusting the app's own arithmetic. */
async function computeExpectedHash(parseFile, filenames) {
  const sorted = [...filenames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const astParts = [];
  for (const name of sorted) {
    const text = fs.readFileSync(path.join(CAMPAIGN_DIR, name), "utf8");
    const parsed = await parseFile(name, text);
    const filePath = `${CAMPAIGN_NAME}/${name}`;
    astParts.push(`${filePath}\n${JSON.stringify(parsed)}`);
  }
  const astJson = astParts.join("\0");
  const bytes = Buffer.from(`${CAMPAIGN_NAME} ${astJson}`, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  console.log("Loading engine modules + computing BFS paths in Node...");
  const { parseFile, MapGenerator } = await loadEngineModules();
  const generator = new MapGenerator();

  const filenames = fs.readdirSync(CAMPAIGN_DIR).filter((f) => fs.statSync(path.join(CAMPAIGN_DIR, f)).isFile());

  const mainCSource = fs.readFileSync(path.join(CAMPAIGN_DIR, "main.c"), "utf8");
  const mainCParsed = await parseFile("main.c", mainCSource);
  const mainCMap = generator.generate(mainCParsed, false, false, [3, 4, 5]);
  const pathToExit = bfsPath(mainCMap, mainCMap.spawn, mainCMap.exit);
  if (!pathToExit) throw new Error("main.c: no BFS path from spawn to exit — map generation may have changed");
  const waypointsToExit = pathToWaypoints(pathToExit);

  const stage02Source = fs.readFileSync(path.join(CAMPAIGN_DIR, "stage02_hazard.c"), "utf8");
  const stage02Parsed = await parseFile("stage02_hazard.c", stage02Source);
  const stage02Map = generator.generate(stage02Parsed, false, false, [3, 4, 5]);
  if (stage02Map.hazards.length === 0) throw new Error("stage02_hazard.c: no hazard tile to route the death test to");
  const hazardTarget = stage02Map.hazards[0];
  const pathToHazard = bfsPath(stage02Map, stage02Map.spawn, hazardTarget);
  if (!pathToHazard) throw new Error("stage02_hazard.c: no BFS path from spawn to its hazard tile");
  const waypointsToHazard = pathToWaypoints(pathToHazard);

  const expectedHash = await computeExpectedHash(parseFile, filenames);
  console.log(`Expected campaign hash: ${expectedHash}`);

  const fileContents = {};
  for (const f of filenames) fileContents[f] = fs.readFileSync(path.join(CAMPAIGN_DIR, f), "utf8");

  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`\nLaunching headless ${engineName}...`);
  const browser = await engine.launch();
  const page = await browser.newPage();
  // Logged, not asserted against: on Firefox specifically, `page.reload()`
  // (used below, between phases A and B) fires `addInitScript` twice — once
  // for a transient intermediate document (`location.href === ""`, where
  // `navigator.storage` is genuinely undefined) that gets discarded before
  // this script ever interacts with it, then once for the real final
  // document (where OPFS works normally). Confirmed directly by instrumenting
  // the init script — not a bug in this app, and not something a real
  // player's browser would ever hit (this is specific to how Playwright's
  // `addInitScript` interacts with Firefox's reload navigation lifecycle).
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await installTestStubs(page, fileContents);

  page.on("console", (msg) => console.log("[browser]", msg.type(), msg.text()));

  await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);
  await page.waitForSelector("#select-workspace");
  await page.click("#select-workspace");
  await waitForTestHooks(page);
  await dismissLevelStartOverlay(page);

  console.log("\n--- Phase A: clear level 1 (main.c), verify save survives reload ---");
  const walkResult1 = await walkWaypoints(page, waypointsToExit);
  check(
    "Reached main.c's exit via real (non-cheat) navigation",
    walkResult1.ok && (walkResult1.reason === "arrived" || walkResult1.reason === "won"),
    JSON.stringify(walkResult1),
  );

  // Reaching the exit tile triggers `endGame("won")`, which shows the
  // "Commit Summary" overlay (another `GameHud.show()` — same dismiss
  // mechanism as the level-start briefing) before `advanceToNextLevel`
  // re-parses the next file and constructs a fresh engine.
  await dismissLevelStartOverlay(page);
  await page.waitForFunction(
    (prevExit) => {
      const hooks = window.__codeensteinTestHooks;
      if (!hooks) return false;
      const exit = hooks.getExit();
      return exit.x !== prevExit.x || exit.y !== prevExit.y;
    },
    mainCMap.exit,
    { timeout: 15000, polling: 100 },
  );
  console.log("  level transition to stage02_hazard.c confirmed (exit tile changed)");
  await dismissLevelStartOverlay(page);

  const saveRaw = await page.evaluate(() => localStorage.getItem("codeenstein-campaign-save"));
  check("Campaign save exists immediately after the level transition", saveRaw !== null);
  let save = null;
  if (saveRaw) {
    save = JSON.parse(saveRaw);
    check("Save workspaceName matches", save.workspaceName === CAMPAIGN_NAME, JSON.stringify(save.workspaceName));
    check("Save filePath points at stage02_hazard.c", save.filePath?.endsWith("stage02_hazard.c"), save.filePath);
    check("Save levelIndex is 2", save.levelIndex === 2, String(save.levelIndex));
  }

  console.log("\n--- Reloading page + resuming via Continue Run ---");
  await page.reload();
  await page.waitForSelector("#select-workspace");
  const continueTabVisible = await page.isVisible("#tab-continue");
  check("Continue tab appears after reload (save was persisted)", continueTabVisible);

  await page.click("#tab-continue");
  await page.click("#continue-run");
  await waitForTestHooks(page);
  await dismissLevelStartOverlay(page);
  const resumedExit = await page.evaluate(() => window.__codeensteinTestHooks.getExit());
  check(
    "Resumed level's exit matches stage02's generated map (same deterministic regeneration)",
    resumedExit.x === stage02Map.exit.x && resumedExit.y === stage02Map.exit.y,
    JSON.stringify({ resumedExit, expected: stage02Map.exit }),
  );

  console.log("\n--- Phase B: walk onto a hazard tile and let the run end (non-cheat death) ---");
  const walkResult2 = await walkWaypoints(page, waypointsToHazard);
  check(
    "Reached stage02's hazard tile, or died en route, via real navigation",
    walkResult2.ok && (walkResult2.reason === "arrived" || walkResult2.reason === "over"),
    JSON.stringify(walkResult2),
  );

  const died = await page.evaluate(async () => {
    const hooks = window.__codeensteinTestHooks;
    for (let i = 0; i < 4000; i++) {
      window.__pumpVirtualTime(50, 50);
      if (hooks.getPlayerState().health <= 0) return true;
    }
    return false;
  });
  check("Player health reached 0 while standing in the hazard", died);

  // `recordRunHighscore`/`clearCampaignSave` run off the engine's own
  // game-over handler, which awaits a background codebase-stats promise
  // (real `setTimeout`-based timeout, unaffected by the virtual clock) —
  // poll with a real (bounded) wait rather than assuming it's instant.
  const highscoreRaw = await page
    .waitForFunction(() => localStorage.getItem("codeenstein-highscores"), undefined, { timeout: 10000, polling: 100 })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check("A highscore entry was written after death", highscoreRaw !== null);

  const saveAfterDeath = await page.evaluate(() => localStorage.getItem("codeenstein-campaign-save"));
  check("Campaign save was cleared on death", saveAfterDeath === null);

  if (highscoreRaw) {
    const board = await page.evaluate(async (raw) => {
      const COMPRESSED_PREFIX = "gz1:";
      if (!raw.startsWith(COMPRESSED_PREFIX)) return JSON.parse(raw);
      const binary = atob(raw.slice(COMPRESSED_PREFIX.length));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      return JSON.parse(new TextDecoder().decode(decompressed));
    }, highscoreRaw);

    const entry = [...board].sort((a, b) => b.achievedAt - a.achievedAt)[0];
    check("Highscore entry has campaignName matching the workspace", entry?.campaignName === CAMPAIGN_NAME, entry?.campaignName);
    check("Highscore entry cleared >= 1 level (died on stage02, not level 1)", entry?.levelsCleared >= 1, String(entry?.levelsCleared));
    check(
      "Highscore entry's hash matches the independently-recomputed campaign hash",
      entry?.hash === expectedHash,
      `${entry?.hash} !== ${expectedHash}`,
    );
    check("Highscore entry has no cheatsUsed disqualification (real navigation only)", entry !== undefined);
    check("Highscore entry carries an attached replay payload", entry?.replay !== undefined);
    if (entry?.replay) {
      check("Replay payload version is 2 (campaign-scoped)", entry.replay.version === 2, String(entry.replay.version));
      // Exactly 1, not 2: this script deliberately reloads the page and
      // resumes via "Continue Run" between phases A and B to test the save
      // mechanism — main.ts's own doc comment on `currentReplayRecorder`
      // documents that a reload always starts a *fresh* campaign recording
      // (the in-memory recorder can't survive it), so main.c's segment is
      // intentionally not part of this run's replay. Only stage02's segment
      // (the level actually played after resuming) should be present.
      check("Replay payload has exactly 1 level segment (stage02, post-resume)", entry.replay.levels?.length === 1, String(entry.replay.levels?.length));
      const allHaveFrames = entry.replay.levels?.every((seg) => Array.isArray(seg.frames) && seg.frames.length > 0);
      check("Every replay level segment has recorded frames", allHaveFrames);
      const allHaveAstHash = entry.replay.levels?.every((seg) => typeof seg.astHash === "string" && seg.astHash.length > 0);
      check("Every replay level segment carries an astHash", allHaveAstHash);
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(72)}`);
  if (failures > 0) {
    console.error(`verify:campaign:playthrough FAILED — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("verify:campaign:playthrough PASSED.");
}

/** `page.waitForFunction`'s default polling strategy is `requestAnimationFrame`
 * — which never fires on its own under our virtual-clock stub (only when
 * explicitly pumped) — so every wait in this script must pass a numeric
 * `polling` interval instead. */
async function waitForTestHooks(page) {
  await page.waitForFunction(() => window.__codeensteinTestHooks !== undefined, undefined, {
    timeout: 15000,
    polling: 100,
  });
}

/** Dismisses whichever `GameHud` canvas-drawn overlay is currently blocking
 * play — the pre-level "Compiling <file>…" briefing (blocks `engine.start()`,
 * and therefore `InputController.attach()`, until acknowledged) or the
 * post-exit "Commit Summary" (blocks `advanceToNextLevel`). Both share the
 * same dismiss mechanism (`GameHud.show()`): a `Space`/`Enter`/`Escape`
 * keydown on `window`, locked out for `DISMISS_LOCK_MS` (1200ms) after the
 * overlay appears so a trigger-happy player can't skip it unseen — pumping
 * 1500ms of virtual time first clears that lock before dispatching. A no-op
 * if no such overlay happens to be up (the dispatched key is simply unheard).
 */
async function dismissLevelStartOverlay(page) {
  await page.evaluate(() => {
    window.__pumpVirtualTime(1500, 50);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    window.__pumpVirtualTime(50, 50);
  });
}

/** Stubs installed before any page script runs: OPFS-backed workspace
 * picker (no native dialog) and a synchronous virtual clock (no real
 * wall-clock waiting for autosave throttling or a chase-and-kill death). */
async function installTestStubs(page, fileContents) {
  await page.addInitScript(
    ({ fileContents, dirName }) => {
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

      window.__opfsReady = (async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(dirName, { create: true });
        for (const [name, content] of Object.entries(fileContents)) {
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        }
        return dir;
      })();
      window.showDirectoryPicker = async () => window.__opfsReady;
    },
    { fileContents, dirName: CAMPAIGN_NAME },
  );
}

/** Drives the real player (real WASD `KeyboardEvent`s dispatched on the
 * canvas, no cheats) from wherever it currently is through each waypoint in
 * turn, using live position feedback from `window.__codeensteinTestHooks`.
 * Facing never rotates (Q/E are never pressed), so each step is exactly one
 * of forward/back/strafe-left/strafe-right relative to the player's fixed
 * initial heading (`dirX=1, dirY=0`, `src/engine/player.ts`) — see the
 * module doc comment for why this needs no turning logic at all.
 *
 * Holds Shift (sprint, `SPRINT_MULTIPLIER=2` in `src/engine/engine.ts`) the
 * whole way — this script never fights back (no aiming, since facing never
 * turns), and main.c's deterministic layout routes past at least one real
 * enemy encounter before the exit; halving time-in-danger is enough to
 * survive it without adding an aim/fire capability this script doesn't
 * otherwise need. */
async function walkWaypoints(page, waypoints) {
  return page.evaluate(
    async ({ waypoints, stepMs, maxTicks }) => {
      const canvas = document.querySelector("canvas");
      const hooks = window.__codeensteinTestHooks;
      const AXIS_EPS = 0.1;
      const ARRIVE_EPS = 0.15;
      let held = new Set();

      canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" }));

      const setKeys = (desired) => {
        for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        held = desired;
      };

      for (const wp of waypoints) {
        let ticks = 0;
        for (;;) {
          const state = hooks.getPlayerState();
          // Both terminal states end the run — a hazard-seeking walk is
          // *expected* to end in "over" (death), and a level can be won
          // before every waypoint is technically reached (the exit tile
          // itself is one of them, but the engine stops updating position
          // the instant `state` flips, so exact arrival never fires).
          if (state.state !== "playing") {
            setKeys(new Set());
            canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" }));
            return { ok: true, reason: state.state, waypoint: wp, state };
          }
          const dx = wp.x - state.x;
          const dy = wp.y - state.y;
          if (Math.abs(dx) < ARRIVE_EPS && Math.abs(dy) < ARRIVE_EPS) break;
          // Correct both axes at once (a real diagonal WASD combo) rather
          // than fully resolving one before starting the other — sequencing
          // them left small perpendicular drift into the *next* segment,
          // which occasionally walked the player into a wall that wouldn't
          // have been in the way exactly on the intended waypoint line.
          const desired = new Set();
          if (Math.abs(dx) >= AXIS_EPS) desired.add(dx > 0 ? "KeyW" : "KeyS");
          if (Math.abs(dy) >= AXIS_EPS) desired.add(dy > 0 ? "KeyD" : "KeyA");
          setKeys(desired);
          window.__pumpVirtualTime(stepMs, stepMs);
          ticks += 1;
          if (ticks > maxTicks) {
            setKeys(new Set());
            canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" }));
            return { ok: false, reason: "stuck", waypoint: wp, state };
          }
        }
      }
      setKeys(new Set());
      canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "ShiftLeft" }));
      return { ok: true, reason: "arrived", state: hooks.getPlayerState() };
    },
    { waypoints, stepMs: VIRTUAL_STEP_MS, maxTicks: MAX_TICKS_PER_WAYPOINT },
  );
}

main().catch((err) => {
  console.error("verify:campaign:playthrough crashed:", err);
  process.exit(1);
});

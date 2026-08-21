// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Regenerates the screenshots embedded in `doc/user/colors-and-pickups.md`,
 * by driving the real game in headless Chromium against a real dev server.
 *
 *     npm run report:doc-screenshots
 *
 * Output goes to `doc/user/img/`, which — uniquely among this repo's
 * image-producing scripts — is **committed**. `level_maps/`, `.verify-output/`
 * and `wedge-diagnosis/` are all gitignored, because their images are read
 * once and thrown away; these ship to players via GitHub's rendering of
 * `doc/user/`, which the game itself links to.
 *
 * Dev-server only, and not by choice: `?testHooks=1` is gated on
 * `import.meta.env.DEV`, which Vite substitutes at build time, so the staging
 * hooks this needs do not exist in `dist/` or under `vite preview`. Pass
 * `CODEENSTEIN_DEV_URL` to attach to a server you started yourself; otherwise
 * one is started on `CODEENSTEIN_DOCSHOT_PORT` (5202) and stopped again at the
 * end. Never 5173 — that is where a developer's own `npm run dev` sits all day,
 * and pointing at it would silently capture whatever branch it happens to be
 * serving.
 *
 * ## Why this needs staging hooks rather than just playing the game
 *
 * Three of the eight pickup kinds cannot appear on a first level at all.
 * `rollLoot` filters rockets/smg/gas out entirely until the matching weapon is
 * owned, and `mapGenerator` decides a level's static pickups from the
 * *previous* level's carryover — so a fresh level 1 can never contain them,
 * however the fixture is written. IDKFA does not help: it grants weapons long
 * after the map was generated. The alternative was a multi-level cheat-driven
 * run, whose depot stock is still rolled rather than chosen. So the engine
 * exposes four `debug*` staging hooks (see `engine.ts`), used only here.
 *
 * ## Why the framing works without moving
 *
 * The camera never translates — it turns on the spot, and the subject is
 * spawned in front of it. That sidesteps the whole class of "held a movement
 * key for a turn-sized burst and travelled nothing" bugs, and it means no
 * cheats are needed: no IDCLIP to pass through walls, and no IDDQD, which
 * would stamp a "cheated run" badge onto every HUD in every screenshot.
 *
 * Because a spawned item sits exactly on the camera's own direction vector,
 * its projected screen position is not eyeballed — it falls out of
 * `projectPoint`'s arithmetic, so every crop rectangle here is computed.
 *
 * ## Why the output is stable enough to commit
 *
 * Byte-identical output is explicitly not the goal — this codebase jitters
 * texture texels per session by design. "A re-run looks the same to a reader"
 * is. To get there: the virtual clock is pumped to a fixed phase so the weapon
 * drop's pulsing ring lands at the same alpha every time; `Math.random` is
 * seeded before any module loads, which is the only thing that pins the
 * texture jitter (`?seed=` does not — it pins gameplay rolls only); enemies
 * are cleared so nothing wanders through a shot; and files are only written
 * when their bytes actually change, so a no-op regeneration leaves the working
 * tree clean instead of rewriting every blob into history.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ensureDevServer } from "./lib/devServer.mjs";
import { envNumber } from "./lib/envNumber.mjs";
import { installOpfsWorkspace } from "./lib/opfsWorkspace.mjs";
import { installVirtualClock } from "./lib/virtualClock.mjs";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";

const OUT_DIR = path.join(REPO_ROOT, "doc", "user", "img");
const FIXTURE_PATH = path.join(REPO_ROOT, "scripts", "fixtures", "doc-shots.php");
const FIXTURE_NAME = "doc-shots.php";

/** Pins gameplay rolls. Layout is content-addressed from the fixture's AST and
 * needs no seed at all; this covers everything else the engine draws from RNG. */
const GAMEPLAY_SEED = "0xc0de";
/** Capture at the game's native Classic resolution. The URL param beats the
 * persisted render-quality preference, so this is independent of whatever a
 * developer last picked in the UI. */
const RENDER_W = 640;
const RENDER_H = 400;

/**
 * How far in front of the camera a staged item is placed, in tiles.
 *
 * Comfortably outside `AMMO_PICKUP_RADIUS`/`KEY_PICKUP_RADIUS` (0.5), so an
 * item is never auto-collected on the next frame — and far enough back that a
 * row of eight actually fits on a 640px canvas, which is the binding
 * constraint. A billboard is `(RENDER_H / depth) * sizeFactor` px wide and a
 * lateral offset `k` moves it `(RENDER_W / 2) * k / (0.66 * depth)` px, so at
 * 2.0 tiles the row spans about 510px of the 640 available. At the 1.15 this
 * started as, each item was 90px and the outermost two fell off the canvas
 * entirely.
 */
const SUBJECT_DISTANCE = 2.0;
/**
 * Sideways spacing between items in the multi-item rows, in tiles.
 *
 * Derived rather than picked. A billboard's on-screen width is
 * `(RENDER_H / depth) * sizeFactor` and a lateral world offset `k` moves it
 * `(RENDER_W / 2) * k / (0.66 * depth)` pixels — both inversely proportional to
 * depth, so the *ratio* of gap to item width is constant. 0.27 tiles puts a
 * comfortable gap between neighbours at any distance the camera ends up at,
 * which matters because the fixture's spawn is a corridor and the usable
 * distance is whatever the heading search finds.
 *
 * Sized by the widest thing in the row, which is the weapon drop: its pulsing
 * ring reaches 1.5x the item's own footprint, so a spacing merely wide enough
 * for the squares leaves the ring touching its neighbour and drags a slice of
 * the wrong colour into that item's own close-up.
 */
const ROW_SPACING = 0.32;

/** `ROT_SPEED` in `engine.ts` — radians/sec while a turn key is held. Only a
 * starting estimate: `turnTo` closes the loop on the reported facing, so this
 * being stale costs an extra iteration rather than a wrong heading. */
const ROT_SPEED = 2.6;
const FRAME_MS = 1000 / 60;

/** The weapon drop's ring pulses as `0.5 + 0.5*sin(now/180)`, so it peaks when
 * `now/180 ≡ π/2 (mod 2π)` — i.e. every 360π ms. Landing every capture on that
 * exact phase is what stops the ring being a coin-flip between runs. */
const PULSE_PERIOD_MS = 360 * Math.PI;
const PULSE_PEAK_MS = 90 * Math.PI;

const LOOT_KINDS = ["health", "swap", "bullets", "shells", "rockets", "smg", "gas", "weapon"];
/** Matches `GATE_COLOR_NAMES` in `src/engine/gateColors.ts`, by value — the
 * same "each consumer keeps its own copy" convention the renderers follow. */
const GATE_NAMES = ["red", "blue", "green", "violet"];

function say(msg) {
  console.log(msg);
}

// --- Node-side ground truth -------------------------------------------------

/**
 * Regenerate the fixture's map in plain Node, with the same options
 * `src/main.ts` passes for a first level (nothing unlocked). Everything the
 * capture needs to plan — where the walls are, whether all four gates
 * survived — comes from here rather than from the page, so a mismatch between
 * the two is detectable instead of silently producing a wrong picture.
 */
/** The engine modules, loaded once.
 *
 * `loadEngineModules` runs a fresh esbuild bundle per call, so this memoises
 * the promise. It is also what fixes the HUD crop below: `layoutHud` and
 * `HUD_HEIGHT` were destructured inside `generateFixtureMap` and then used at
 * the top level of `main`, so the key-pip shot threw `layoutHud is not
 * defined` and every screenshot after it — the two maps and the HUD — has been
 * unreachable since the status bar started deriving its own crop.
 */
let enginePromise = null;
function engineModules() {
  enginePromise ??= loadEngineModules();
  return enginePromise;
}

async function generateFixtureMap() {
  const { parseFile, MapGenerator, UNLOCKABLE_WEAPONS } = await engineModules();
  const parsed = await parseFile(FIXTURE_NAME, fs.readFileSync(FIXTURE_PATH, "utf8"));
  const map = new MapGenerator().generate(parsed, {
    bonusLevel: false,
    // All four spelled out. `GENERATE_DEFAULTS` sets these to `true`, while the
    // browser passes `false` at level 1 — inheriting the defaults here would
    // generate a *different* map from the one the page is showing, and the
    // grid digest check below would fail with no obvious cause.
    hasRocketLauncher: false,
    hasSmg: false,
    hasGas: false,
    missingWeaponIndices: [...UNLOCKABLE_WEAPONS],
    maxPlayers: 1,
  });
  return map;
}

/** FNV-1a over a wall grid — the same fingerprint `verify-wad-textures.mjs`
 * uses to compare a live level against an expected one. */
function gridDigest(grid) {
  let h = 2166136261;
  for (const row of grid) {
    for (const tile of row) {
      h ^= tile;
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}

/**
 * Choose which way the camera should face for the item shots.
 *
 * Wants a heading whose sightline leaves the subject standing clear of
 * anything, against a plain wall close enough to read as a backdrop rather
 * than as a dark corridor. Rejects a line that passes over any tile that is
 * not plain floor, so no acid, door, teleporter, spike, lore terminal or
 * secret wall can end up behind the item and change what the shot is of.
 */
function pickCameraHeading(map) {
  const sx = map.spawn.x + 0.5;
  const sy = map.spawn.y + 0.5;
  const blocked = new Set();
  for (const p of [...map.hazards, ...map.spikeTraps.map((t) => t), ...map.teleporters, ...map.mines]) {
    blocked.add(`${Math.floor(p.x)},${Math.floor(p.y)}`);
  }
  for (const p of map.ammoPickups) blocked.add(`${Math.floor(p.x)},${Math.floor(p.y)}`);

  let best = null;
  for (let deg = 0; deg < 360; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let wallAt = Infinity;
    let clean = true;
    for (let d = 0.2; d < 9; d += 0.05) {
      const tx = Math.floor(sx + dx * d);
      const ty = Math.floor(sy + dy * d);
      if (ty < 0 || ty >= map.height || tx < 0 || tx >= map.width) {
        wallAt = d;
        break;
      }
      const tile = map.grid[ty][tx];
      if (tile !== 0) {
        // A plain wall is the backdrop we want; anything else in the way means
        // this heading would put a coloured tile behind the subject.
        if (tile !== 1) clean = false;
        wallAt = d;
        break;
      }
      if (blocked.has(`${tx},${ty}`)) clean = false;
    }
    if (!clean) continue;
    // The wall has to be behind the subject, with enough margin that the item
    // reads as standing in front of it rather than embedded in it. There is
    // deliberately no *lower* bound beyond that: the fixture spawns in a
    // corridor, and the headings with the most sideways room are exactly the
    // ones facing across it, where the far wall is close. A close wall is a
    // good backdrop anyway — it is lit and textured rather than fogged.
    if (wallAt < SUBJECT_DISTANCE + 0.35 || wallAt > 7) continue;

    // Every position an item will actually occupy must be open floor — checked
    // against the real row layout rather than a guessed margin, since that is
    // the thing that fails when the fixture's spawn changes shape.
    const widest = Math.max(LOOT_KINDS.length, GATE_NAMES.length);
    const px = -dy;
    const py = dx;
    let rowOk = true;
    for (let i = 0; i < widest; i++) {
      const k = (i - (widest - 1) / 2) * ROW_SPACING;
      const tx = Math.floor(sx + dx * SUBJECT_DISTANCE + px * k);
      const ty = Math.floor(sy + dy * SUBJECT_DISTANCE + py * k);
      if (ty < 0 || ty >= map.height || tx < 0 || tx >= map.width || map.grid[ty][tx] !== 0) rowOk = false;
    }
    if (!rowOk) continue;

    // Prefer the backdrop a little behind the subjects: close enough to stay
    // brightly lit and textured, far enough not to crowd them.
    const score = Math.abs(wallAt - 3.2);
    if (!best || score < best.score) best = { headingRad: a, wallAt, score, deg };
  }
  if (!best) {
    throw new Error("no clean camera heading from spawn — the fixture's spawn area changed shape; re-run scripts/fixtures/doc-shots.php through the generator and look at the spawn neighbourhood");
  }
  return best;
}

// --- page setup -------------------------------------------------------------

/**
 * Seed `Math.random` before any module loads. This is the only thing that pins
 * `textures.ts`'s per-texel jitter, which `?seed=` does not touch — without it
 * every wall in every screenshot is speckled differently on each regeneration
 * and the whole set churns for no reason.
 */
async function installSeededRandom(page) {
  await page.addInitScript(() => {
    let s = 0x9e3779b9;
    Math.random = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
}

async function launchFixtureLevel(page, baseUrl) {
  const url = `${baseUrl}/?testHooks=1&seed=${GAMEPLAY_SEED}&renderRes=${RENDER_W}x${RENDER_H}`;
  await page.goto(url);
  await page.click("#select-workspace");
  try {
    // `polling: 100` is not optional here. Playwright's default polling for
    // `waitForFunction` is requestAnimationFrame — and the virtual clock
    // replaces rAF with a queue that only drains when pumped, so the default
    // waits forever on a page that is otherwise perfectly healthy.
    await page.waitForFunction(() => !!window.__codeensteinTestHooks, undefined, { timeout: 60000, polling: 100 });
  } catch (err) {
    // The bare timeout says only "the hooks never appeared", which is true of
    // a parse failure, a stalled load and a wrong URL alike. Report what the
    // page actually got to.
    const status = await page.evaluate(() => ({
      spinner: document.querySelector("#viewport")?.textContent?.slice(0, 200) ?? null,
      hasCanvas: !!document.querySelector("canvas"),
    }));
    throw new Error(`${err.message}\n  viewport text: ${JSON.stringify(status.spinner)}\n  canvas present: ${status.hasCanvas}`);
  }
  // The briefing ignores every dismiss trigger for its first `DISMISS_LOCK_MS`
  // (1200ms), so a fire-mash in the fight that triggered it cannot skip it by
  // accident — and `gameHud.ts` measures that against `performance.now()`,
  // which the virtual clock owns. Sleeping in real time here leaves the lock
  // permanently armed and Space is silently swallowed for the rest of the run;
  // the *virtual* clock has to be pumped past it. (The other scripts that
  // dismiss this overlay with a real `waitForTimeout` install no virtual clock,
  // which is why they can.)
  await pump(page, 1500);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  // The engine attaches its canvas key listeners in `start()`, which the
  // dismissal itself triggers, so input dispatched too soon afterwards lands on
  // a listenerless canvas and vanishes.
  await page.waitForTimeout(400);
  await pump(page, FRAME_MS * 4);
}

/** Assert the level on screen is the level we planned against. Without this,
 * a drifted generator option or a stale dev server produces a plausible
 * screenshot of the wrong map, which is worse than a crash. */
async function assertMapMatches(page, map) {
  const live = await page.evaluate(() => ({
    digest: (() => {
      const grid = window.__codeensteinTestHooks.getGrid();
      let h = 2166136261;
      for (const row of grid) {
        for (const tile of row) {
          h ^= tile;
          h = Math.imul(h, 16777619);
        }
      }
      return (h >>> 0).toString(16);
    })(),
    styleSet: window.__codeensteinTestHooks.getStyleSet(),
  }));
  const expected = gridDigest(map.grid);
  if (live.digest !== expected) {
    throw new Error(`live map does not match the Node-side generation (grid ${live.digest} vs ${expected}) — generator options drifted, or the dev server is serving another branch`);
  }
  if (live.styleSet !== map.styleSet) {
    throw new Error(`styleset mismatch: page ${live.styleSet}, expected ${map.styleSet}`);
  }
}

// --- control ----------------------------------------------------------------

async function pump(page, ms) {
  await page.evaluate((totalMs) => window.__pumpVirtualTime(totalMs, 1000 / 60), ms);
}

/**
 * Turn the camera to an absolute heading, closed-loop.
 *
 * Deliberately never touches a movement key. `ROT_SPEED` only seeds the first
 * estimate; each pass re-reads the engine's own reported facing and corrects,
 * so a future rotation-speed change costs an extra iteration rather than
 * silently mis-aiming every shot.
 */
async function turnTo(page, headingRad) {
  const trace = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const { dirX, dirY } = await page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
    const current = Math.atan2(dirY, dirX);
    let delta = headingRad - current;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    trace.push(delta.toFixed(4));
    if (Math.abs(delta) < 0.004) return;
    const code = delta > 0 ? "KeyE" : "KeyQ";
    const holdMs = (Math.abs(delta) / ROT_SPEED) * 1000;
    await page.evaluate((c) => document.querySelector("canvas").dispatchEvent(new KeyboardEvent("keydown", { code: c })), code);
    await pump(page, holdMs);
    await page.evaluate((c) => document.querySelector("canvas").dispatchEvent(new KeyboardEvent("keyup", { code: c })), code);
    await pump(page, FRAME_MS);
  }
  // Print the residual per pass. A sequence that never shrinks means the sim is
  // not running at all (an undismissed overlay is the usual cause) rather than
  // a mistuned ROT_SPEED, and the two need completely different fixes.
  throw new Error(`turnTo did not converge; residual per pass: ${trace.join(" -> ")}. A flat sequence means the simulation is frozen (overlay never dismissed); a shrinking-but-slow one means ROT_SPEED or the Q/E binding moved.`);
}

/** Advance to the next moment at which the weapon ring's pulse is at its peak,
 * so that shot looks identical on every regeneration. */
async function pumpToPulsePeak(page) {
  const now = await page.evaluate(() => performance.now());
  const phase = ((now - PULSE_PEAK_MS) % PULSE_PERIOD_MS + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  await pump(page, PULSE_PERIOD_MS - phase);
}

/** Where the camera is and which way it points, right now. */
async function camera(page) {
  const { x, y, dirX, dirY } = await page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
  return { x, y, dirX, dirY };
}

/** Place `items` in a row across the camera's view, centred on its facing.
 * `offsets` are in tiles, perpendicular to the view direction. */
function rowPositions(cam, offsets) {
  const px = -cam.dirY;
  const py = cam.dirX;
  return offsets.map((k) => ({
    x: cam.x + cam.dirX * SUBJECT_DISTANCE + px * k,
    y: cam.y + cam.dirY * SUBJECT_DISTANCE + py * k,
  }));
}

/** Screen geometry of a billboard at world (x, y), mirroring `projectPoint`
 * in `sprites.ts` exactly — so crops are computed rather than eyeballed. */
function project(cam, x, y, sizeFactor) {
  const relX = x - cam.x;
  const relY = y - cam.y;
  const planeX = -cam.dirY * 0.66;
  const planeY = cam.dirX * 0.66;
  const invDet = 1 / (planeX * cam.dirY - cam.dirX * planeY);
  const transformX = invDet * (cam.dirY * relX - cam.dirX * relY);
  const depth = invDet * (-planeY * relX + planeX * relY);
  const screenX = (RENDER_W / 2) * (1 + transformX / depth);
  const size = Math.abs(RENDER_H / depth) * sizeFactor;
  return { screenX, size, depth };
}

// --- capture ----------------------------------------------------------------

/**
 * Crop the game canvas and return PNG bytes.
 *
 * Reads the canvas bitmap rather than using `page.screenshot({ clip })`: the
 * whole game is drawn into one canvas whose CSS size is whatever the viewport
 * leaves over, so a CSS-pixel clip would resample and would drift with layout
 * and device pixel ratio. `imageSmoothingEnabled = false` keeps the pixel art
 * exact when scaling up.
 */
async function grabCrop(page, { x, y, w, h, scale = 2, label }) {
  const dataUrl = await page.evaluate(
    ({ x, y, w, h, scale }) => {
      const src = document.querySelector("canvas");
      const cx = Math.max(0, Math.round(x));
      const cy = Math.max(0, Math.round(y));
      const cw = Math.min(src.width - cx, Math.round(w));
      const ch = Math.min(src.height - cy, Math.round(h));
      const out = document.createElement("canvas");
      out.width = cw * scale;
      out.height = ch * scale;
      const ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, cx, cy, cw, ch, 0, 0, cw * scale, ch * scale);
      return out.toDataURL("image/png");
    },
    { x, y, w, h, scale },
  );
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  if (buf.length < 400) throw new Error(`crop "${label}" came back suspiciously small (${buf.length} bytes)`);
  return buf;
}

/**
 * A blank-frame guard. A mistimed capture — briefing not dismissed, simulation
 * still frozen — produces a plausible-looking PNG that gets committed and only
 * fails a human's eye much later. Count distinct colours over a coarse sample,
 * the same cheap proxy `verify-wad-textures.mjs` uses.
 */
async function assertNotFlat(page, { x, y, w, h }, label, minColors = 12) {
  const colors = await page.evaluate(
    ({ x, y, w, h }) => {
      const src = document.querySelector("canvas");
      const ctx = src.getContext("2d");
      const data = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 3) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return seen.size;
    },
    { x, y, w, h },
  );
  if (colors < minColors) {
    throw new Error(`"${label}" looks flat (${colors} distinct colours) — the frame probably never rendered`);
  }
}

let written = 0;
let unchanged = 0;

function writeIfChanged(name, buf) {
  const file = path.join(OUT_DIR, name);
  if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), buf) === 0) {
    unchanged += 1;
    say(`  = ${name} (${(buf.length / 1024).toFixed(1)} KB, unchanged)`);
    return;
  }
  fs.writeFileSync(file, buf);
  written += 1;
  say(`  + ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}

// --- main -------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  say("Generating the fixture's map in Node…");
  const map = await generateFixtureMap();
  if (map.gates.length !== 4) {
    throw new Error(`fixture produced ${map.gates.length} gates, need 4 — every key colour has to exist for the key shots`);
  }
  const heading = pickCameraHeading(map);
  say(`  ${map.width}x${map.height}, styleset ${map.styleSet}, ${map.gates.length} gates; camera heading ${heading.deg}° (wall at ${heading.wallAt.toFixed(1)} tiles)`);

  const server = await ensureDevServer({
    url: process.env.CODEENSTEIN_DEV_URL,
    port: envNumber("CODEENSTEIN_DOCSHOT_PORT", 5202, { integer: true, min: 1, max: 65535 }),
    label: "doc-screenshots",
  });

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    // A page error here presents as a bare Playwright timeout further down,
    // with nothing pointing at the real cause — surface both streams.
    page.on("pageerror", (err) => say(`  [page error] ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") say(`  [console error] ${msg.text()}`);
    });
    await installSeededRandom(page);
    await installVirtualClock(page);
    await installOpfsWorkspace(page, { dirName: "codeenstein-doc-shots", files: { [FIXTURE_NAME]: fs.readFileSync(FIXTURE_PATH, "utf8") } });

    say("Launching the fixture level…");
    await launchFixtureLevel(page, server.url);
    await assertMapMatches(page, map);
    await page.evaluate(() => window.__codeensteinTestHooks.debugClearEnemies());
    await turnTo(page, heading.headingRad);
    await pump(page, FRAME_MS * 4);

    const cam = await camera(page);

    // --- the eight pickups, all from one frame ---------------------------
    //
    // One frame, nine files. Capturing each kind from its own frame would mean
    // nine relaunches (there is no "clear the drops" hook, deliberately — the
    // staging surface stays as small as it can be), and every pickup would sit
    // at a different pulse phase and a slightly different camera. From a single
    // frame they are guaranteed identical in everything except the one thing
    // the picture is about.
    say("Staging the eight pickup kinds…");
    const offsets = LOOT_KINDS.map((_, i) => (i - (LOOT_KINDS.length - 1) / 2) * ROW_SPACING);
    const positions = rowPositions(cam, offsets);
    await page.evaluate(
      (specs) => {
        for (const s of specs) window.__codeensteinTestHooks.debugSpawnDrop(s);
      },
      LOOT_KINDS.map((kind, i) => ({ x: positions[i].x, y: positions[i].y, kind })),
    );
    await pumpToPulsePeak(page);

    const projected = positions.map((p) => project(cam, p.x, p.y, 0.26));
    // Half-widths, not `size / 2`: the weapon drop's ring reaches 0.75x its
    // size from centre, so measuring the row by the squares alone clips the
    // ring off the edge of the very shot that exists to show it.
    const half = LOOT_KINDS.map((kind, i) => projected[i].size * (kind === "weapon" ? 0.78 : 0.5));
    const rowTop = Math.min(...projected.map((p, i) => RENDER_H / 2 + p.size * 0.45 - half[i])) - 12;
    const rowBottom = Math.max(...projected.map((p, i) => RENDER_H / 2 + p.size * 0.45 + half[i])) + 12;
    const rowLeft = Math.min(...projected.map((p, i) => p.screenX - half[i])) - 12;
    const rowRight = Math.max(...projected.map((p, i) => p.screenX + half[i])) + 12;
    const rowRect = { x: rowLeft, y: rowTop, w: rowRight - rowLeft, h: rowBottom - rowTop };
    await assertNotFlat(page, rowRect, "pickups-all");
    writeIfChanged("pickups-all.png", await grabCrop(page, { ...rowRect, label: "pickups-all" }));

    for (const [i, kind] of LOOT_KINDS.entries()) {
      const p = projected[i];
      // The weapon drop's ring reaches 1.5x the item's own footprint, so its
      // crop has to be wider or the very thing that distinguishes it is cut off.
      // The ring reaches 0.75x the item's size from its centre, i.e. 0.25x
      // beyond the square's own edge — so the weapon needs the wider pad, and
      // `ROW_SPACING` is what keeps that pad clear of the next item along.
      const pad = kind === "weapon" ? p.size * 0.42 : p.size * 0.32;
      const cy = RENDER_H / 2 + p.size * 0.45;
      writeIfChanged(
        `pickup-${kind}.png`,
        // Scale 4, not 2: pulled back far enough for the row to fit, a single
        // item is only ~52px square, which is too small to read inline in a
        // doc. Nearest-neighbour, so this stays honest pixel art rather than a
        // blurred upscale.
        await grabCrop(page, { x: p.screenX - p.size / 2 - pad, y: cy - p.size / 2 - pad, w: p.size + pad * 2, h: p.size + pad * 2, scale: 4, label: `pickup-${kind}` }),
      );
    }

    // --- the four key colours --------------------------------------------
    say("Staging the four key colours…");
    await page.reload();
    await launchFixtureLevel(page, server.url);
    await page.evaluate(() => window.__codeensteinTestHooks.debugClearEnemies());
    await turnTo(page, heading.headingRad);
    await pump(page, FRAME_MS * 4);
    const keyCam = await camera(page);
    const keyOffsets = GATE_NAMES.map((_, i) => (i - (GATE_NAMES.length - 1) / 2) * ROW_SPACING);
    const keyPositions = rowPositions(keyCam, keyOffsets);
    await page.evaluate(
      (specs) => {
        for (const s of specs) window.__codeensteinTestHooks.debugSpawnKey(s);
      },
      GATE_NAMES.map((_, i) => ({ x: keyPositions[i].x, y: keyPositions[i].y, gateId: i })),
    );
    await pump(page, FRAME_MS * 2);

    const keyProj = keyPositions.map((p) => project(keyCam, p.x, p.y, 0.28));
    const kTop = Math.min(...keyProj.map((p) => RENDER_H / 2 + p.size * 0.4 - p.size / 2)) - 14;
    const kBottom = Math.max(...keyProj.map((p) => RENDER_H / 2 + p.size * 0.4 + p.size / 2)) + 14;
    const kLeft = Math.min(...keyProj.map((p) => p.screenX - p.size / 2)) - 14;
    const kRight = Math.max(...keyProj.map((p) => p.screenX + p.size / 2)) + 14;
    const keyRect = { x: kLeft, y: kTop, w: kRight - kLeft, h: kBottom - kTop };
    await assertNotFlat(page, keyRect, "keys-all-colours");
    writeIfChanged("keys-all-colours.png", await grabCrop(page, { ...keyRect, label: "keys-all-colours" }));

    // --- HUD key pips -----------------------------------------------------
    //
    // The fixture's own four gates are already on the HUD as hollow pips.
    // Collecting one turns exactly one of them solid, which is the whole thing
    // the picture has to show: hollow means "still out there", filled means
    // "you have it".
    say("Collecting one key for the HUD pip shot…");
    await page.evaluate(() => {
      const s = window.__codeensteinTestHooks.getPlayerState();
      window.__codeensteinTestHooks.debugSpawnKey({ x: s.x + s.dirX * 0.2, y: s.y + s.dirY * 0.2, gateId: 1 });
    });
    await pump(page, FRAME_MS * 3);
    // Derived from `layoutHud`'s keys panel rather than eyeballed, because the
    // bar's panel positions are computed now — the previous literals (x=370,
    // w=120, h=58) were pinned to the old hard-coded x=375 KEYS label and
    // would have silently cropped a neighbouring panel once the layout moved,
    // producing a wrong screenshot rather than a failure.
    const canvasSize = await page.evaluate(() => {
      const c = document.querySelector("canvas.scene-canvas");
      return { w: c.width, h: c.height };
    });
    const { layoutHud, HUD_HEIGHT } = await engineModules();
    const keys = layoutHud(canvasSize.w, canvasSize.h).panels.keys;
    const hudRect = { x: keys.x - 2, y: keys.y, w: keys.w + 4, h: HUD_HEIGHT };
    await assertNotFlat(page, hudRect, "hud-key-pips", 4);
    writeIfChanged("hud-key-pips.png", await grabCrop(page, { ...hudRect, scale: 4, label: "hud-key-pips" }));

    // --- the maps, on a frame with nothing staged in it -------------------
    //
    // A third launch, and not a wasted one. Both maps are translucent overlays
    // drawn on top of the live 3D view, so anything staged in front of the
    // camera shows straight through them: taken on the key frame, the automap
    // came back with four big coloured blocks floating across it, which is the
    // key billboards seen through the overlay rather than anything the map
    // draws. A clean frame also gets the minimap the *fixture's own* four
    // uncollected keys, which is exactly what its legend needs to show.
    say("Relaunching for the map shots…");
    await page.reload();
    await launchFixtureLevel(page, server.url);
    await page.evaluate(() => window.__codeensteinTestHooks.debugClearEnemies());
    await pump(page, FRAME_MS * 4);

    // `renderMinimap` sizes its panel from the map: cell = max(1, floor(70 /
    // longest side)), padded 6px, plus the compass badge straddling the
    // bottom-right corner. Derived, so a differently-sized fixture still crops
    // correctly.
    const cell = Math.max(1, Math.floor(70 / Math.max(map.width, map.height)));
    const panel = 6 + Math.max(map.width, map.height) * cell + 4;
    const minimapRect = { x: 0, y: 0, w: panel + 20, h: panel + 20 };
    await assertNotFlat(page, minimapRect, "minimap");
    writeIfChanged("minimap.png", await grabCrop(page, { ...minimapRect, scale: 4, label: "minimap" }));

    // --- the automap ------------------------------------------------------
    await page.evaluate(() => window.__codeensteinTestHooks.debugRevealMap());
    await page.evaluate(() => document.querySelector("canvas").dispatchEvent(new KeyboardEvent("keydown", { code: "Tab" })));
    await pump(page, FRAME_MS * 3);
    const CELL_PX = 3;
    const span = Math.max(map.width, map.height) * CELL_PX;
    const automapRect = {
      x: Math.max(0, RENDER_W / 2 - span / 2 - 10),
      y: Math.max(0, (RENDER_H - 94) / 2 - span / 2 - 10),
      w: Math.min(RENDER_W, span + 20),
      h: Math.min(RENDER_H - 94, span + 20),
    };
    await assertNotFlat(page, automapRect, "automap");
    writeIfChanged("automap.png", await grabCrop(page, { ...automapRect, scale: 2, label: "automap" }));

    const total = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png")).reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
    say(`\n${written} written, ${unchanged} unchanged — ${(total / 1024).toFixed(0)} KB total in doc/user/img/`);
  } finally {
    await browser?.close();
    server.stop();
  }
}

await main();

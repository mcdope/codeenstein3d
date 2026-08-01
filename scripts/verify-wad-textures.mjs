// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Browser end-to-end verification of wall/door/floor/lore-terminal/hazard/
 * teleporter/spike-trap texturing, against a real running dev server
 * (`CODEENSTEIN_DEV_URL`, default `http://localhost:5173`) via headless
 * Chromium by default — structured like `verify-campaign-playthrough.mjs`,
 * including the same `CODEENSTEIN_VERIFY_BROWSER` override
 * (`lib/browserEngine.mjs`) to run against Firefox/WebKit instead; this
 * script never touches `window.showDirectoryPicker` at all (the bundled demo
 * campaign loads via `fetch`, and the WAD file loads via a plain
 * `<input type="file">`), so it's safe to run against any engine. Covers:
 *
 *   (a) the Milestone-1 gate: procedural default textures show real
 *       per-pixel variance, not a flat fill;
 *   (b) loading a synthetic WAD (via `buildTestWad`, in-memory — no real
 *       IWAD bundled, copyright) actually reaches the live renderer: status
 *       text reports the matched slots, and the rendered frame changes;
 *   (c) an invalid file produces a graceful status message and never leaves
 *       the game in a broken state;
 *   (e) the ceiling (never textured) stays a single flat color regardless
 *       of which texture pack is active;
 *   (g) per-level stylesets actually reach the screen: different campaign
 *       files render visibly different walls, and the *same* file renders
 *       identically every time. Asserted on rendered pixels rather than on
 *       an exposed styleset id on purpose — `GameMap.styleSet` being right
 *       while the renderer ignores it is exactly the failure a unit test
 *       can't see (`doc/dev/testing.md`, "what the test suite structurally
 *       cannot catch": the canvas mock draws nothing).
 *   (f) a real online-catalog entry (Freedoom: Phase 2, fetched at build
 *       time by `scripts/fetch-online-wads.mjs` into `public/wads/`) loads
 *       via the sidebar's online-picker click path, not just a synthetic
 *       in-memory WAD via the local-file `<input>` — catches a regression in
 *       the catalog's `servedPath`/fetch wiring or a stale allowlist against
 *       real game data, without hardcoding spoiler-risk map content.
 *
 * (d) — secret walls staying visually near-identical to plain walls, and
 * lore/hazard/teleporter/spike tiles actually rendering their new textures
 * in a live level — is deliberately NOT a hard automated assertion here:
 * reliably steering the bot to a specific tile of each kind would need new
 * spoiler-risk test-hook support (map grid / teleport) this feature doesn't
 * add, and "does this look like a real texture, not a flat fill" is
 * inherently a "can a human tell at a glance" property, not a pixel-exact
 * one (see `SECRET_WALL_OVERLAY`'s doc comment in raycaster.ts). A screenshot
 * is saved for manual spot-checking instead of a fabricated pass/fail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestWad } from "./fixtures/buildTestWad.mjs";
import { resolveBrowserEngine } from "./lib/browserEngine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.CODEENSTEIN_DEV_URL ?? "http://localhost:5173";
const SCREENSHOT_DIR = path.join(__dirname, "..", ".verify-output");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Distinct RGB colors across a coarse sample of the given rectangular
 * region — a cheap proxy for "is this a real texture, or a flat fill". */
function regionVariance(data, width, yStart, yEnd, xStart = 0, xEnd = width, step = 3) {
  const colors = new Set();
  for (let y = yStart; y < yEnd; y += step) {
    for (let x = xStart; x < xEnd; x += step) {
      const i = (y * width + x) * 4;
      colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
  }
  return colors.size;
}

/** Mean RGB of the mid-height band, rounded — a stable fingerprint of "what
 * palette is this level's walls/floor drawn in". Skips the left fifth of the
 * frame, which is where the minimap overlay lives (its own fixed colors would
 * otherwise drag every level's mean toward each other). */
function bandMeanColor(data, width, height) {
  const yStart = Math.floor(height * 0.35);
  const yEnd = Math.floor(height * 0.75);
  const xStart = Math.floor(width * 0.2);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = yStart; y < yEnd; y += 2) {
    for (let x = xStart; x < width; x += 2) {
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
}

/** Launches the `index`-th file in the sidebar tree (rows carry their path as
 * `title`, see `src/ui/fileTree.ts`), then dismisses the pre-level briefing.
 * Returns the file's path so failures name the level that produced them. */
async function launchCampaignFile(page, index) {
  const filePath = await page.evaluate((i) => {
    const rows = document.querySelectorAll("button.tree-row--file");
    if (i >= rows.length) return null;
    rows[i].click();
    return rows[i].title;
  }, index);
  if (filePath === null) return null;
  await page.waitForTimeout(1400); // GameHud's DISMISS_LOCK_MS, real wall-clock
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  await page.waitForTimeout(600);
  return filePath;
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    return { width, height, data: Array.from(data) }; // structured-clone friendly
  });
}

async function launchDemoCampaign(page) {
  await page.click("#tab-demo");
  await page.click("#launch-demo-campaign");
  await page.waitForFunction(() => window.__codeensteinTestHooks !== undefined, undefined, {
    timeout: 15000,
    polling: 100,
  });
  // GameHud's pre-level briefing ignores dismiss input for its first
  // DISMISS_LOCK_MS (1200ms, real wall-clock time here — no virtual clock
  // installed) to avoid an accidental instant-skip.
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  await page.waitForTimeout(800);
}

async function main() {
  const { name: engineName, engine } = resolveBrowserEngine();
  console.log(`Launching headless ${engineName}...\n`);
  const browser = await engine.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto(`${DEV_SERVER_URL}/?testHooks=1`);

  // --- (a) Milestone-1 gate: procedural defaults show real texture variance ---
  console.log("Default (procedural) textures:");
  await launchDemoCampaign(page);
  const before = await sampleCanvas(page);
  const beforeWallVariance = regionVariance(before.data, before.width, Math.floor(before.height * 0.3), Math.floor(before.height * 0.7));
  const beforeFloorVariance = regionVariance(before.data, before.width, Math.floor(before.height * 0.55), before.height);
  // A narrow strip near the very top, away from the minimap overlay (top-left
  // corner) and clear of any nearby wall/teleporter-portal silhouette tall
  // enough to reach this high — both of which are scene content, not ceiling.
  const beforeCeilingVariance = regionVariance(
    before.data,
    before.width,
    0,
    Math.floor(before.height * 0.04),
    Math.floor(before.width * 0.4),
    Math.floor(before.width * 0.6),
    1,
  );
  check("wall region shows real texture variance (not a flat fill)", beforeWallVariance > 3, `got ${beforeWallVariance}`);
  check("floor region shows real texture variance (not a flat fill)", beforeFloorVariance > 3, `got ${beforeFloorVariance}`);

  // --- (e) ceiling is never textured, regardless of which pack is active ---
  check("ceiling region is a single flat color", beforeCeilingVariance === 1, `got ${beforeCeilingVariance} distinct colors`);

  // --- (d) secret walls: not hard-asserted, see file doc comment — save a screenshot for manual spot-check ---
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "default-textures.png") });

  // --- (g) per-level stylesets reach the screen ---
  console.log("\nPer-level stylesets (procedural defaults):");
  const LEVELS_TO_SAMPLE = 8;
  const levelColors = new Map(); // path -> mean band color
  for (let i = 0; i < LEVELS_TO_SAMPLE; i++) {
    const filePath = await launchCampaignFile(page, i);
    if (filePath === null) break;
    const frame = await sampleCanvas(page);
    levelColors.set(filePath, bandMeanColor(frame.data, frame.width, frame.height));
  }
  const sampled = [...levelColors.entries()];
  const distinctColors = new Set(levelColors.values());
  console.log(`  sampled ${sampled.length} level(s): ${sampled.map(([p, c]) => `${p.split("/").pop()}=${c}`).join(", ")}`);
  check(`sampled at least 4 campaign levels`, sampled.length >= 4, `got ${sampled.length}`);
  check(
    "campaign levels do not all render the same palette",
    distinctColors.size >= 3,
    `only ${distinctColors.size} distinct mean color(s) across ${sampled.length} levels`,
  );

  // Stability: the same file must look the same every time it's launched.
  // This is the half of the feature a "just randomise it" implementation
  // would fail — and it's what makes a map export or a replay match the run.
  const [firstPath, firstColor] = sampled[0];
  await launchCampaignFile(page, 0);
  const relaunched = await sampleCanvas(page);
  const relaunchedColor = bandMeanColor(relaunched.data, relaunched.width, relaunched.height);
  check(
    `relaunching ${firstPath.split("/").pop()} renders an identical palette`,
    relaunchedColor === firstColor,
    `first ${firstColor}, again ${relaunchedColor}`,
  );
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "styleset-sample.png") });

  // Back to the campaign entrypoint so the WAD checks below compare against
  // the same level `before` was sampled from.
  await launchDemoCampaign(page);

  // --- (b) loading a synthetic WAD reaches the live renderer ---
  console.log("\nSynthetic WAD load:");
  const wadBytes = Buffer.from(buildTestWad());
  await page.setInputFiles("#wad-file-input", {
    name: "test.wad",
    mimeType: "application/octet-stream",
    buffer: wadBytes,
  });
  await page.waitForTimeout(300);
  const statusText = await page.textContent("#wad-status");
  check("status reports the matched wall slot", statusText.includes("STARTAN3"), statusText);
  check("status reports the matched door slot", statusText.includes("BIGDOOR2"), statusText);
  check("status reports the matched floor slot", statusText.includes("FLOOR4_8"), statusText);
  check("status reports the matched lore-terminal slot", statusText.includes("COMPUTE2"), statusText);
  check("status reports the matched hazard-floor slot", statusText.includes("NUKAGE3"), statusText);
  check("status reports the matched teleporter-floor slot", statusText.includes("GATE1"), statusText);
  check("status reports the matched spike-safe-floor slot", statusText.includes("FLOOR7_1"), statusText);
  check("status reports the matched spike-active-floor slot", statusText.includes("BLOOD1"), statusText);

  // Re-launch so the freshly active TextureSet is what the next frame renders.
  await launchDemoCampaign(page);
  const after = await sampleCanvas(page);
  const changedPixels = after.data.some((byte, i) => byte !== before.data[i]);
  check("rendered frame changed after loading the WAD (swap reached the renderer)", changedPixels);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "synthetic-wad-textures.png") });

  // --- (c) invalid file: graceful failure, game stays playable ---
  console.log("\nInvalid WAD file:");
  await page.setInputFiles("#wad-file-input", {
    name: "garbage.wad",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a wad file, just some bytes"),
  });
  await page.waitForTimeout(300);
  const errorStatusText = await page.textContent("#wad-status");
  check("status reports a graceful error (not a raw exception dump)", errorStatusText.toLowerCase().includes("failed"), errorStatusText);

  await launchDemoCampaign(page);
  const afterError = await sampleCanvas(page);
  const stillVariance = regionVariance(afterError.data, afterError.width, Math.floor(afterError.height * 0.3), Math.floor(afterError.height * 0.7));
  check("game still renders normally after a failed WAD load (fell back to defaults)", stillVariance > 3, `got ${stillVariance}`);

  // --- online WAD catalog: a real fetched-at-build-time entry loads too ---
  console.log("\nOnline WAD catalog (Freedoom: Phase 2):");
  await page.click("#wad-tab-online"); // switch off the Local File sub-tab first — its panel is otherwise hidden
  await page.click('#online-wad-list li[data-wad-id="freedoom-phase2"] .online-wad-select-btn');
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#wad-status")?.textContent ?? "";
      return text.includes("Using WAD textures") || text.toLowerCase().includes("failed");
    },
    undefined,
    { timeout: 15000 },
  );
  const onlineStatusText = await page.textContent("#wad-status");
  check("status reports matched slots, not a fetch/parse failure", onlineStatusText.includes("Using WAD textures"), onlineStatusText);
  // A real IWAD must resolve a distinct wall/floor/door triple for every
  // styleset — if a styleset were listed with a `·` placeholder here, its
  // levels would drop back to programmer art while others stayed WAD-textured.
  for (const styleSet of ["stone", "rust", "tech", "marble", "techCool"]) {
    check(`status reports a full triple for the ${styleSet} styleset`, new RegExp(`${styleSet} \\([^·)]+\\)`).test(onlineStatusText), onlineStatusText);
  }

  check("no console/page errors across the whole run", pageErrors.length === 0, pageErrors.join("; "));

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  console.log(`Screenshots written to ${SCREENSHOT_DIR}/ — spot-check secret-wall subtlety manually there.`);

  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

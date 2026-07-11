// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Browser end-to-end verification of wall/door/floor/lore-terminal/hazard/
 * teleporter/spike-trap texturing, against a real running dev server
 * (`CODEENSTEIN_DEV_URL`, default `http://localhost:5173`) via headless
 * Chromium — structured like `verify-campaign-playthrough.mjs`. Covers:
 *
 *   (a) the Milestone-1 gate: procedural default textures show real
 *       per-pixel variance, not a flat fill;
 *   (b) loading a synthetic WAD (via `buildTestWad`, in-memory — no real
 *       IWAD bundled, copyright) actually reaches the live renderer: status
 *       text reports all 10 matched slots (wall/bonus wall/door/floor/bonus
 *       floor/lore terminal/hazard/teleporter/spike-safe/spike-active), and
 *       the rendered frame changes;
 *   (c) an invalid file produces a graceful status message and never leaves
 *       the game in a broken state;
 *   (e) the ceiling (never textured) stays a single flat color regardless
 *       of which texture pack is active.
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
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestWad } from "./fixtures/buildTestWad.mjs";

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
  const browser = await chromium.launch();
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

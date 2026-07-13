// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Dev tool for eyeballing bot behavior: opens one real, visible Chromium
 * window per profile (Casual, then Gamer, then Pro, in that order by
 * default), plays a single full-campaign attempt at watchable real-time
 * speed, prints a short text summary, and waits for you to press Enter
 * before moving on to the next profile — so you can watch, take notes, and
 * only advance when you're ready.
 *
 * Reuses `run-balancing-telemetry.mjs`'s own profile definitions, level
 * planning, and per-attempt driving logic (`playRun`) rather than
 * duplicating them — this is a thin orchestration layer on top, not a
 * separate bot implementation. Requires a locally running dev server
 * (`npm run dev`, default http://localhost:5173).
 *
 * Usage:
 *   npm run balancing:watch                  # Casual -> Gamer -> Pro, normal difficulty
 *   npm run balancing:watch -- Gamer Pro      # only these two, in this order
 *   CODEENSTEIN_WATCH_DIFFICULTY=hard npm run balancing:watch
 */
import readline from "node:readline/promises";
import { chromium } from "playwright";

// Static `import` statements are hoisted and evaluate before any of this
// file's own top-level code runs — setting the env var above a static import
// of run-balancing-telemetry.mjs would be too late for its module-level
// `HEADED` const. A dynamic import (below, inside main()) evaluates only
// once actually awaited, so setting the env var first here works correctly.
process.env.CODEENSTEIN_TELEMETRY_HEADED = "1";
const { PROFILES, DEV_SERVER_URL, planLevels, playRun, waitForTestHooks, dismissOverlay, installDifficulty } = await import(
  "./run-balancing-telemetry.mjs"
);

const DIFFICULTY = process.env.CODEENSTEIN_WATCH_DIFFICULTY || "normal";
const requestedProfiles = process.argv.slice(2);
const profileNames = requestedProfiles.length ? requestedProfiles : ["Casual", "Gamer", "Pro"];

for (const name of profileNames) {
  if (!PROFILES[name]) {
    console.error(`Unknown profile "${name}" — valid profiles: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(1);
  }
}

async function playOneSession(browser, profileName, levelPlans) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

  await installDifficulty(page, DIFFICULTY);
  await page.goto(`${DEV_SERVER_URL}/?testHooks=1&botRotSpeedMul=${PROFILES[profileName].rotSpeedMultiplier}`);
  await page.click("#tab-demo");
  await page.click("#launch-demo-campaign");
  await waitForTestHooks(page);
  await dismissOverlay(page);

  const run = await playRun(page, PROFILES[profileName], levelPlans);
  await context.close();
  return run;
}

function summarize(run, levelCount) {
  const levelsCleared = run.reachedExitForLevel.filter(Boolean).length;
  const totalKills = run.levelSnapshots.reduce((sum, s) => sum + (s.snapshot.kills ?? 0), 0);
  console.log(`  outcome: ${run.reason}`);
  console.log(`  levels cleared: ${levelsCleared}/${levelCount}`);
  console.log(`  total kills: ${totalKills}`);
  if (run.diedAtLevelIndex !== null) {
    const last = run.levelSnapshots.at(-1);
    if (last?.snapshot) {
      console.log(`  died on level ${run.diedAtLevelIndex + 1}, fatal damage source: ${last.snapshot.fatalDamageSource}`);
      console.log(`  min health reached that level: ${Math.round(last.snapshot.minHealthReached)}`);
    }
  }
  const weaponsOwned = Object.entries(run.weaponFirstOwnedAtLevel);
  if (weaponsOwned.length) {
    console.log(`  weapons acquired at level: ${weaponsOwned.map(([w, lvl]) => `${w}@${lvl}`).join(", ")}`);
  }
}

async function main() {
  console.log(`Watch sessions: ${profileNames.join(" -> ")} @ ${DIFFICULTY} difficulty\n`);
  const levelPlans = await planLevels();
  const browser = await chromium.launch({ headless: false });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (let i = 0; i < profileNames.length; i++) {
      const profileName = profileNames[i];
      console.log(`=== Watching ${profileName} (${DIFFICULTY}) ===`);
      const run = await playOneSession(browser, profileName, levelPlans);
      summarize(run, levelPlans.length);

      const isLast = i === profileNames.length - 1;
      if (!isLast) {
        const next = profileNames[i + 1];
        const answer = await rl.question(`\nPress Enter to continue to ${next} (or type "q" to quit): `);
        console.log("");
        if (answer.trim().toLowerCase() === "q") break;
      }
    }
  } finally {
    rl.close();
    await browser.close();
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("watch-bot-sessions crashed:", err);
  process.exit(1);
});

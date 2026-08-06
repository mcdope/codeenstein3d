// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Is the bot routing around the map it is actually standing on?
 *
 * Two independent enumerations decide "level 1" and neither knows about the
 * other:
 *
 *   planLevels()               enumerates demo-campaign/ in FILENAME order and
 *                              hands the bot a route for slot 1.
 *   findEntrypointByScanning() returns `bestWithMain ?? bestOverall ??
 *   (src/main.ts)              firstParsed` — the cheapest file *containing a
 *                              `main`/`Main` function*, falling back to
 *                              cheapest-overall only when none has one.
 *
 * When they disagree the bot drives a route that is perfectly valid for a level
 * nobody is playing, walks into a wall its planner believes is floor, and
 * wedges. Nothing else reports it: the run just fails to progress, and the
 * position trace looks enough like a navigation oscillation to be misdiagnosed
 * as one — which is exactly what happened on 2026-08-06, for 58 runs and most
 * of a day.
 *
 * **Checked by grid equality, and deliberately not by enemy count.** The
 * pre-flight in place at the time compared level-1 enemy counts, and curl's two
 * candidates both held exactly 2 enemies, so it passed while every route was
 * computed for the wrong map. Counts collide; grids do not.
 *
 * Staging cannot prevent this on its own. `stage-campaign.mjs`'s ordering guard
 * keeps slot 1 at the global complexity minimum, which models only the
 * `bestOverall` branch — a campaign whose cheapest file lacks `main` while
 * another has one still diverges. This check is indifferent to the selection
 * rule, which is why it is the right instrument.
 *
 * Must run at level start, before anything drives. `Bot#startLevel` takes the
 * plan's map *by reference* and `#refreshGridIfChanged` later overwrites
 * `this.map.grid` with the live grid; after that, comparing plan against engine
 * compares the live grid with itself and passes unconditionally. `bot.mjs`'s
 * own comment there — "the map copy is already correct at level start" — is
 * precisely the invariant asserted here.
 */

/** Tiles differing between a planned grid and the engine's live grid. */
export function gridDiffCount(plannedGrid, liveGrid) {
  let diffs = 0;
  for (let y = 0; y < plannedGrid.length; y++) {
    for (let x = 0; x < plannedGrid[y].length; x++) {
      if (plannedGrid[y][x] !== liveGrid?.[y]?.[x]) diffs++;
    }
  }
  return diffs;
}

/**
 * Compares every plan against the live grid, nearest first. A zero-diff entry
 * names the level the engine is *actually* playing, which turns "something is
 * wrong" into "you staged the wrong slot 1" without further investigation.
 */
export function scorePlansAgainstGrid(levelPlans, liveGrid) {
  return levelPlans
    .map((plan, index) => ({ index, filename: plan.filename, diffs: gridDiffCount(plan.map.grid, liveGrid) }))
    .sort((a, b) => a.diffs - b.diffs);
}

/**
 * Reads the engine's live grid and compares it with `map`.
 *
 * Returns `{ ok: true }` when they agree, otherwise `{ ok: false, diffs,
 * scored, message }` — the caller decides whether to log or abort, because the
 * diagnostic wants to keep going and a capture must not.
 *
 * `levelPlans` is optional; without it the mismatch is still reported, just
 * without naming the culprit.
 */
export async function checkPlanMatchesEngine(page, map, { levelNo = null, levelPlans = null } = {}) {
  const liveGrid = await page.evaluate(() => window.__codeensteinTestHooks.getGrid());
  const diffs = gridDiffCount(map.grid, liveGrid);
  if (diffs === 0) return { ok: true, diffs: 0 };

  const scored = levelPlans ? scorePlansAgainstGrid(levelPlans, liveGrid) : null;
  const best = scored?.[0];
  const where = levelNo === null ? "" : ` on level ${levelNo}`;
  const lines = [
    `Refusing to continue: the engine is not playing the level the bot is routing${where}.`,
    `  ${diffs} grid tiles differ between the planned map and the engine's live grid.`,
  ];
  if (best) {
    lines.push(
      best.diffs === 0
        ? `  The engine is actually playing planned index ${best.index}: ${best.filename}`
        : `  No planned level matches exactly; closest is index ${best.index} (${best.diffs} diffs): ${best.filename}`,
    );
  }
  lines.push(
    "  planLevels() enumerates demo-campaign/ in filename order; the game picks the",
    "  cheapest file containing a main()/Main. Every route from here is planned for a",
    "  map that is not loaded, so the run would wedge rather than fail — fix the staging.",
  );
  return { ok: false, diffs, scored, message: lines.join("\n") };
}

/**
 * Capture/benchmark form: verify, or kill the process.
 *
 * Exits rather than throwing on purpose. `runOneAttempt` catches everything
 * into a discarded `attemptCrashed` attempt, and `runQualifyLoop` only gives up
 * after three consecutive fully-crashed batches — at concurrency 10 that is
 * roughly 30 attempts burned before anyone finds out. A plan/engine mismatch is
 * a staging fault, so every attempt after it is worthless; exiting matches the
 * `Refusing to start:` idiom the capture driver already uses for a dirty tree
 * and for unusable lane hosts.
 */
export async function assertPlanMatchesEngine(page, map, opts = {}) {
  const result = await checkPlanMatchesEngine(page, map, opts);
  if (result.ok) return;
  console.error(`\n${result.message}\n`);
  process.exit(1);
}

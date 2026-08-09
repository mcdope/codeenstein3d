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

/** Tile values the engine treats as solid — `isWall` in `src/engine/player.ts`:
 * wall, locked door, unopened secret wall, lore terminal, unopened branch door.
 * Everything else is walkable, including acid (2) and spike traps (5). */
const SOLID_TILES = new Set([1, 3, 6, 7, 8]);

/**
 * Tiles differing between a planned grid and the engine's live grid, split by
 * whether the difference can affect a route.
 *
 * The split is load-bearing. Comparing raw values flags differences that do not
 * matter: `planLevels` generates every level with a *fixed* loadout
 * (`hasRocketLauncher: false`, all weapons missing) while the engine generates
 * against the player's real progression, and that moves a handful of spike
 * traps. Measured on serilog level 12 — 8 tiles differ, all of them 0<->5, and
 * **none** change traversability. Killing a capture for that would be a false
 * positive; the routes are identical.
 *
 * `solid` is what actually breaks a run: a tile the planner thinks is floor and
 * the engine thinks is wall is how the bot walks into a wall it believes is
 * open, which is the failure this module exists to catch.
 */
export function gridDiffCount(plannedGrid, liveGrid) {
  let total = 0;
  let solid = 0;
  for (let y = 0; y < plannedGrid.length; y++) {
    for (let x = 0; x < plannedGrid[y].length; x++) {
      const a = plannedGrid[y][x];
      const b = liveGrid?.[y]?.[x];
      if (a === b) continue;
      total++;
      if (SOLID_TILES.has(a) !== SOLID_TILES.has(b)) solid++;
    }
  }
  return { total, solid };
}

/**
 * Compares every plan against the live grid, nearest first. A zero-diff entry
 * names the level the engine is *actually* playing, which turns "something is
 * wrong" into "you staged the wrong slot 1" without further investigation.
 */
export function scorePlansAgainstGrid(levelPlans, liveGrid) {
  return levelPlans
    .map((plan, index) => {
      const { total, solid } = gridDiffCount(plan.map.grid, liveGrid);
      return { index, filename: plan.filename, diffs: total, solidDiffs: solid };
    })
    .sort((a, b) => a.solidDiffs - b.solidDiffs || a.diffs - b.diffs);
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
  const { total: diffs, solid } = gridDiffCount(map.grid, liveGrid);
  // Only a traversability difference means the bot is routing against a map it
  // is not standing on. Value-only differences are reported by the caller if it
  // cares, but they do not invalidate a route — see `gridDiffCount`.
  if (solid === 0) return { ok: true, diffs, solid: 0 };

  const scored = levelPlans ? scorePlansAgainstGrid(levelPlans, liveGrid) : null;
  const best = scored?.[0];
  const where = levelNo === null ? "" : ` on level ${levelNo}`;
  const lines = [
    `Refusing to continue: the engine is not playing the level the bot is routing${where}.`,
    `  ${solid} of ${diffs} differing tiles change whether a tile can be walked through.`,
  ];
  if (best) {
    lines.push(
      best.solidDiffs === 0
        ? `  The engine is actually playing planned index ${best.index}: ${best.filename}`
        : `  No planned level matches; closest is index ${best.index} (${best.solidDiffs} solid diffs): ${best.filename}`,
    );
  }
  lines.push(
    "  planLevels() enumerates demo-campaign/ in filename order; the game picks the",
    "  cheapest file containing a main()/Main. Every route from here is planned for a",
    "  map that is not loaded, so the run would wedge rather than fail — fix the staging.",
  );
  return { ok: false, diffs, solid, scored, message: lines.join("\n") };
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

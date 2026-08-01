// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Node-side, browser-free per-level balancing metrics computed directly from
 * a generated `GameMap` (see `scripts/generate-default-highscore.mjs`'s
 * Phase 0 for how to produce one). No RNG, no engine runtime involved — map
 * layout doesn't depend on playstyle or difficulty, so a single analysis per
 * level is shared across every bot profile/difficulty/run in
 * `scripts/run-balancing-telemetry.mjs`.
 */

const WALL_TILE = 1;
const SECRET_WALL_TILE = 6;
const LORE_TILE = 7;

/** Mirrors `isWalkableTile` in `src/engine/engine.ts`. */
function isWalkableTile(tile) {
  return tile !== WALL_TILE && tile !== SECRET_WALL_TILE && tile !== LORE_TILE;
}

/** Mirrors `countWalkableTiles` in `src/engine/engine.ts`. */
function countWalkableTiles(map) {
  let count = 0;
  for (const row of map.grid) {
    for (const tile of row) {
      if (isWalkableTile(tile)) count += 1;
    }
  }
  return Math.max(1, count);
}

function enemyCategory(enemy) {
  if (enemy.elite) return "elite";
  if (enemy.edgeCase) return "edgeCase";
  return "normal";
}

function summarizePrePlacedAmmo(ammoPickups) {
  const totals = { bullets: 0, rockets: 0, health: 0, swap: 0, weaponUnlocks: 0 };
  for (const pickup of ammoPickups) {
    if (pickup.kind === "weapon") {
      totals.weaponUnlocks += 1;
    } else {
      totals[pickup.kind] += pickup.amount;
    }
  }
  return totals;
}

/**
 * Total walking distance the planned `route` asks for, in tiles: the spawn
 * followed by every waypoint of every leg, summed. `planRoute` emits one
 * waypoint per tile, so this straight-line sum equals the real walkable path
 * length (verified against a BFS re-measurement — the two agreed to the tile
 * on all eight demo levels).
 *
 * This is the honest denominator for "did the bot walk efficiently".
 * `shortestPathTiles` is a bare spawn->exit BFS, and comparing against it
 * conflates two unrelated things: on the demo campaign the *planned route* is
 * already 1.68x the shortest path, concentrated entirely in the two
 * key/locked-door levels (3.7x and 3.5x on demo levels 3 and 7; the other six
 * are within 5% of optimal). Fetching a key is not a navigation defect — a
 * human has to walk it too.
 *
 * `null` when the route did not plan (`route.ok === false`), so a consumer can
 * tell "no plan" from "a zero-length plan".
 */
function plannedRouteTilesOf(map, route) {
  if (!route?.ok) return null;
  let total = 0;
  let previous = { x: map.spawn.x + 0.5, y: map.spawn.y + 0.5 };
  for (const leg of route.legs ?? []) {
    // `openDoor` legs carry no waypoints — their staging walk is a fraction of
    // a tile off the previous waypoint and is deliberately not counted.
    for (const wp of leg.waypoints ?? []) {
      total += Math.hypot(wp.x - previous.x, wp.y - previous.y);
      previous = wp;
    }
  }
  return total;
}

/**
 * Per-level static balancing metrics for `map` (a generated `GameMap`) and
 * its planned `route` (a `planRoute()`/`planCoverageRoute()` result — `route.ok`
 * and its legs' waypoints are what get inspected here).
 */
export function analyzeStaticLevel(map, route) {
  const enemies = map.enemies;
  const enemyCounts = { normal: 0, elite: 0, edgeCase: 0 };
  let normalHpTotal = 0;
  for (const enemy of enemies) {
    const category = enemyCategory(enemy);
    enemyCounts[category] += 1;
    if (category === "normal") normalHpTotal += enemy.maxHp;
  }
  const walkableTileCount = countWalkableTiles(map);

  return {
    totalEnemies: enemies.length,
    enemyCounts,
    avgNormalEnemyHp: enemyCounts.normal > 0 ? normalHpTotal / enemyCounts.normal : 0,
    walkableTileCount,
    enemyDensity: enemies.length / walkableTileCount,
    prePlacedAmmo: summarizePrePlacedAmmo(map.ammoPickups),
    secretRoomCount: map.secretRoomCount,
    mineCount: map.mines.length,
    spikeTrapCount: map.spikeTraps.length,
    shortestPathTiles: map.shortestPathTiles,
    plannedRouteTiles: plannedRouteTilesOf(map, route),
    routeOk: route.ok,
  };
}

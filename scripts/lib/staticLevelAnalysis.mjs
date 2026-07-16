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
 * Per-level static balancing metrics for `map` (a generated `GameMap`) and
 * its planned `route` (a `planRoute()`/`planCoverageRoute()` result — only
 * `route.ok` is inspected here).
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
    routeOk: route.ok,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * How many *rooms* does a level actually gate, and how many doorways does that
 * cost?
 *
 * `MAX_GATES` (`src/map/generation/doorsKeys.ts`) budgets gates in **doorways**,
 * because today the engine charges one key per doorway. Nothing reports the
 * number a player actually experiences — locked *rooms* — and the two differ by
 * however many mouths each room has. That matters the moment a key opens a room
 * rather than a doorway: the budget has to be re-expressed in rooms, and the
 * only honest way to pick the new cap is to measure what levels already get.
 *
 * It also measures the *direction* of the change, which is not guessable.
 * Today's ranking divides worth by doorway count, so it systematically favours
 * one-mouth rooms: a level whose candidates are mostly single-mouth can already
 * spend the whole budget on six rooms, while a level with one six-mouth room
 * gets exactly one gate. Run this on both sides of the change and diff the
 * histograms rather than assuming either direction.
 *
 * Room attribution is pure geometry and does not use `roomMouths`: that helper
 * only matches tiles that are still floor (`grid === 0`), so it returns nothing
 * once doors have been placed. A door tile belongs to a room iff it sits
 * immediately outside that room's rect, on one of its four sides, within the
 * span of that side — which is exactly the set `roomMouths` would have produced
 * before the grid was mutated.
 *
 * Usage:
 *   node scripts/report-gate-budget.mjs                 # bundled demo campaign
 *   node scripts/report-gate-budget.mjs <dir> [maxLevels]
 */
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const UNLOCKABLE_WEAPONS = [2, 3, 4];

/** Every door tile of `map` that belongs to `room`, by the geometric rule above. */
function doorsOfRoom(room, doors) {
  return doors.filter((d) => {
    const onTopEdge = d.y === room.y - 1 && d.x >= room.x && d.x < room.x + room.w;
    const onBottomEdge = d.y === room.y + room.h && d.x >= room.x && d.x < room.x + room.w;
    const onLeftEdge = d.x === room.x - 1 && d.y >= room.y && d.y < room.y + room.h;
    const onRightEdge = d.x === room.x + room.w && d.y >= room.y && d.y < room.y + room.h;
    return onTopEdge || onBottomEdge || onLeftEdge || onRightEdge;
  });
}

function gateShape(map) {
  const gated = map.rooms
    .map((room) => ({ room, doors: doorsOfRoom(room, map.doors) }))
    .filter((g) => g.doors.length > 0);
  return {
    gatedRooms: gated.length,
    doorTiles: map.doors.length,
    keys: map.keys.length,
    // Door TILES per gated room (not contiguous runs — `keys` reflects runs) — the number that collapses to 1 per room once a
    // key opens a whole room.
    mouthsPerRoom: gated.map((g) => g.doors.length).sort((a, b) => b - a),
  };
}

function histogram(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function main() {
  const dirArg = process.argv[2];
  const maxLevels = Number(process.argv[3] ?? Infinity);
  const dir = dirArg ? path.resolve(dirArg) : CAMPAIGN_DIR;
  const { MapGenerator, parseFile, extensionOf } = await loadEngineModules();
  const generator = new MapGenerator();

  const filenames = fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .slice(0, maxLevels);

  console.log(`Gate shape for ${filenames.length} file(s) in ${path.relative(REPO_ROOT, dir) || "."}\n`);
  console.log("  level                                     rooms  gated  doorTiles  keys  tiles/room");

  const perLevelGatedRooms = [];
  for (const filename of filenames) {
    const parsed = await parseFile(filename, fs.readFileSync(path.join(dir, filename), "utf8"));
    if (!parsed) continue;
    const bonusLevel = extensionOf(filename) === "h";
    const map = generator.generate(parsed, {
      bonusLevel,
      hasRocketLauncher: false,
      missingWeaponIndices: UNLOCKABLE_WEAPONS,
      hasSmg: true,
      hasGas: true,
    });
    const shape = gateShape(map);
    perLevelGatedRooms.push(shape.gatedRooms);
    console.log(
      `  ${filename.padEnd(40)} ${String(map.rooms.length).padStart(5)}  ${String(shape.gatedRooms).padStart(5)}  ${String(shape.doorTiles).padStart(9)}  ${String(shape.keys).padStart(4)}  ${shape.mouthsPerRoom.join(",") || "-"}`,
    );
  }

  // Levels that gate nothing are excluded from the percentiles: C sources
  // produce zero doors (no private/protected members for `isLockableRoom` to
  // find), and including them buries the real distribution under zeros.
  const gating = perLevelGatedRooms.filter((n) => n > 0).sort((a, b) => a - b);
  console.log(`\n  levels: ${perLevelGatedRooms.length}, of which gate at least one room: ${gating.length}`);
  console.log(`  gated rooms/level (gating levels only) — histogram: ${histogram(gating).map(([v, c]) => `${v}:${c}`).join("  ")}`);
  console.log(`  p50 ${percentile(gating, 0.5)}   p90 ${percentile(gating, 0.9)}   max ${gating.at(-1) ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

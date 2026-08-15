// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Per-level geometry + entity density dump, for perf-scenario selection
 * (frame-budget audit Phase 0). Generates every level of a directory with the
 * real parser and `MapGenerator` — same enumeration and weapon-ownership
 * rules as `report-level-budget.mjs` — and emits the *render-cost* proxies
 * that report leaves out: map area, walkable tile count, wall-adjacency
 * count, and every placed-object count on the map.
 *
 * ```sh
 * node scripts/dump-level-density.mjs --dir balancing_corpus/stb --json out.json
 * node scripts/dump-level-density.mjs --dir balancing_corpus/stb --top 10
 * ```
 *
 * Read-only: writes nothing except the optional --json output.
 */
import fs from "node:fs";
import path from "node:path";

import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { loadWorkspaceModule } from "./lib/loadWorkspaceModule.mjs";

function parseArgs(argv) {
  const args = { dir: path.join(REPO_ROOT, "demo-campaign"), json: null, top: 15 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = path.resolve(argv[++i]);
    else if (arg === "--json") args.json = path.resolve(argv[++i]);
    else if (arg === "--top") args.top = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

/** Same recursion as report-level-budget.mjs: real workspace ignore rules +
 * ordering, so level indices match what the game would play. */
function collectSourceFiles(dir, workspace, relativeTo = dir) {
  const { isIgnoredDirectoryName, isIgnoredFileName, compareNodes } = workspace;
  const nodes = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() ? !isIgnoredDirectoryName(e.name) : e.isFile() && !isIgnoredFileName(e.name)))
    .map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : "file" }))
    .sort(compareNodes);

  const out = [];
  for (const node of nodes) {
    const full = path.join(dir, node.name);
    if (node.kind === "directory") out.push(...collectSourceFiles(full, workspace, relativeTo));
    else out.push({ absolute: full, relative: path.relative(relativeTo, full) });
  }
  return out;
}

/** Solid = the exact set `collidesWithWall` treats as solid
 * (src/engine/player.ts:133): wall, locked door, secret wall, lore terminal,
 * branch door. Everything else is walkable floor. */
const SOLID = new Set([1, 3, 6, 7, 8]);

function measureGrid(map) {
  const { width, height, grid } = map;
  let walkable = 0;
  let wallAdjacent = 0; // walkable tiles bordering >=1 solid tile: raycast-cost proxy
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (SOLID.has(grid[y][x])) continue;
      walkable++;
      const n =
        (y > 0 && SOLID.has(grid[y - 1][x])) ||
        (y < height - 1 && SOLID.has(grid[y + 1][x])) ||
        (x > 0 && SOLID.has(grid[y][x - 1])) ||
        (x < width - 1 && SOLID.has(grid[y][x + 1]));
      if (n) wallAdjacent++;
    }
  }
  return { walkable, wallAdjacent };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadEngineModules();
  const workspace = await loadWorkspaceModule();
  const { parseFile, extensionOf, MapGenerator, STARTING_WEAPONS, FORCED_UNLOCK_LEVELS, UNLOCKABLE_WEAPONS } = modules;
  const generator = new MapGenerator();

  const sourceFiles = collectSourceFiles(args.dir, workspace);
  const rows = [];
  for (const source of sourceFiles) {
    const filename = path.basename(source.absolute);
    const parsed = await parseFile(filename, fs.readFileSync(source.absolute, "utf8"));
    if (!parsed) continue;
    const campaignLevelIndex = rows.length + 1;
    const owned = new Set(STARTING_WEAPONS);
    for (const { level, weaponIndex } of FORCED_UNLOCK_LEVELS) {
      if (campaignLevelIndex >= level) owned.add(weaponIndex);
    }
    const map = generator.generate(parsed, {
      bonusLevel: extensionOf(filename) === "h",
      hasRocketLauncher: owned.has(modules.GHIDRA_WEAPON_INDEX),
      hasSmg: owned.has(modules.GDB_WEAPON_INDEX),
      hasGas: owned.has(modules.FRIDAY_HOTFIX_WEAPON_INDEX),
      missingWeaponIndices: UNLOCKABLE_WEAPONS.filter((i) => !owned.has(i)),
    });
    const { walkable, wallAdjacent } = measureGrid(map);
    rows.push({
      file: source.relative,
      levelIndex: campaignLevelIndex,
      width: map.width,
      height: map.height,
      area: map.width * map.height,
      walkable,
      wallAdjacent,
      rooms: map.rooms.length,
      breakupRooms: map.breakupRooms.length,
      doors: map.doors.length,
      keys: map.keys.length,
      decorations: map.decorations.length,
      teleporters: map.teleporters.length,
      spikeTraps: map.spikeTraps.length,
      mines: map.mines.length,
      ammoPickups: map.ammoPickups.length,
      loreTerminals: map.loreTerminals.length,
      hazards: map.hazards.length,
      enemies: map.enemies.length,
      elites: map.enemies.filter((e) => e.elite).length,
      edgeCases: map.enemies.filter((e) => e.edgeCase).length,
      bonusLevel: map.bonusLevel,
    });
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ dir: args.dir, levels: rows }, null, 1));
    console.log(`wrote ${rows.length} levels to ${args.json}`);
  }

  const fmt = (r) =>
    `${String(r.levelIndex).padStart(4)}  ${r.width}x${r.height}  walk=${r.walkable}  wallAdj=${r.wallAdjacent}  ` +
    `enemies=${r.enemies}(${r.elites}E/${r.edgeCases}X)  deco=${r.decorations}  tp=${r.teleporters}  ` +
    `mines=${r.mines}  traps=${r.spikeTraps}  lore=${r.loreTerminals}  ${r.file}`;

  const byArea = [...rows].sort((a, b) => b.area - a.area).slice(0, args.top);
  const byWallAdj = [...rows].sort((a, b) => b.wallAdjacent - a.wallAdjacent).slice(0, args.top);
  const byEnemies = [...rows].sort((a, b) => b.enemies - a.enemies).slice(0, args.top);
  console.log(`\n== top ${args.top} by map area (${rows.length} levels) ==`);
  for (const r of byArea) console.log(fmt(r));
  console.log(`\n== top ${args.top} by wall-adjacency (raycast proxy) ==`);
  for (const r of byWallAdj) console.log(fmt(r));
  console.log(`\n== top ${args.top} by enemy count ==`);
  for (const r of byEnemies) console.log(fmt(r));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

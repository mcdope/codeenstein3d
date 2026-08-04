// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The offline balance budget report: generate every level of a campaign
 * directory with the real parser and `MapGenerator`, solve each one against
 * the real combat constants, and print what the generator's budget actually
 * looks like — with no browser, no bot and nobody playing.
 *
 * ```sh
 * npm run balancing:budget                          # demo-campaign, normal
 * npm run balancing:budget -- --dir path/to/repo    # any repo
 * npm run balancing:budget -- --difficulty hard
 * npm run balancing:budget -- --all-difficulties    # sweep, comparison table
 * npm run balancing:budget -- --json out.json       # machine-readable
 * ```
 *
 * Exits non-zero when any level contains an enemy that cannot be killed with
 * every round obtainable on it. That direction is a hard result — see
 * `levelSolver.mjs`'s note on why the *passing* direction proves nothing, and
 * why this therefore gates on failure only.
 *
 * Formatting only. Every number comes from `scripts/lib/levelSolver.mjs`,
 * which in turn reads the real modules via `loadEngineModules()`; see
 * `doc/dev/balancing-telemetry.md`'s "The balance model" for the design.
 */
import fs from "node:fs";
import path from "node:path";

import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { solveCampaign, weaponProfiles } from "./lib/levelSolver.mjs";

const DIFFICULTIES = ["easy", "normal", "hard"];

/** Below this, a level has no margin for a missed shot; below 1.0 it is not
 * clearable at all. Both are read against `clearRatio.combined`, i.e. with
 * drops counted — the strictest reading a level gets. */
const RATIO_WARN = 1.2;
const RATIO_FAIL = 1.0;

function parseArgs(argv) {
  const args = { dir: path.join(REPO_ROOT, "demo-campaign"), difficulties: ["normal"], json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = path.resolve(argv[++i]);
    else if (arg === "--difficulty") args.difficulties = [argv[++i]];
    else if (arg === "--all-difficulties") args.difficulties = [...DIFFICULTIES];
    else if (arg === "--json") args.json = path.resolve(argv[++i]);
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  for (const d of args.difficulties) {
    if (!DIFFICULTIES.includes(d)) {
      console.error(`unknown difficulty: ${d} (expected one of ${DIFFICULTIES.join(", ")})`);
      process.exit(2);
    }
  }
  return args;
}

/** Campaign order is plain case-insensitive filename sort, the same ordering
 * `verify-demo-campaign.mjs` uses and `main.ts`'s own flattened file list
 * produces. */
function campaignOrder(filenames) {
  return [...filenames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/**
 * Generate every parsable file in `dir` as a level.
 *
 * Weapon-ownership options are derived from the *guaranteed* loadout at each
 * campaign position rather than passed as fixed flags, because they change
 * what the generator places: Vendor Depots only stock a pool the player can
 * already spend, and secret rooms only offer a weapon still missing. Passing
 * `hasSmg: true` everywhere (as the coverage sweep in `verify-demo-campaign.mjs`
 * deliberately does) would inflate the pre-placed budget of every early level
 * with ammo a real run cannot use yet.
 */
async function generateLevels(dir, modules) {
  const { parseFile, extensionOf, MapGenerator, STARTING_WEAPONS, FORCED_UNLOCK_LEVELS, UNLOCKABLE_WEAPONS } = modules;
  const generator = new MapGenerator();
  const filenames = campaignOrder(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()));

  const levels = [];
  const skipped = [];
  for (const filename of filenames) {
    const parsed = await parseFile(filename, fs.readFileSync(path.join(dir, filename), "utf8"));
    if (!parsed) {
      skipped.push(filename);
      continue;
    }
    const campaignLevelIndex = levels.length + 1;
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
    levels.push({ filename, map });
  }
  return { levels, skipped };
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  if (!Number.isFinite(value)) return "inf";
  return value.toFixed(digits);
}

function ratioFlag(ratio) {
  if (!Number.isFinite(ratio)) return " ";
  if (ratio < RATIO_FAIL) return "X";
  if (ratio < RATIO_WARN) return "!";
  return " ";
}

function printBudgetTable(results) {
  console.log("level  file                       enemies   HP tot   ammo dmg (carry/pre/drop)      ratio (nofarm/comb)");
  for (const r of results) {
    const flag = ratioFlag(r.clearRatio.combined);
    console.log(
      `${String(r.campaignLevelIndex).padStart(5)}  ${r.filename.padEnd(26).slice(0, 26)}` +
        `${String(r.enemies.totalCount).padStart(7)}  ${String(Math.round(r.enemies.totalHp)).padStart(7)}   ` +
        `${String(Math.round(r.carried.damage)).padStart(7)} /${String(Math.round(r.prePlaced.damage)).padStart(7)} /${String(Math.round(r.drops.damage)).padStart(7)}   ` +
        `${fmt(r.clearRatio.withoutFarming).padStart(8)} /${fmt(r.clearRatio.combined).padStart(7)} ${flag}`,
    );
  }
  console.log("\n  X  combined clear ratio below 1.0 -- NOT clearable even counting every drop");
  console.log("  !  combined clear ratio below 1.2 -- no margin for a missed shot");
  console.log("     'nofarm' counts only what you carried in plus what is on the floor.");
}

function printOutliers(results) {
  const rows = [];
  for (const r of results) {
    for (const o of r.outliers.slice(0, 3)) {
      if (o.archetype !== "elite" && !o.unkillable) continue;
      rows.push({ level: r.campaignLevelIndex, ...o });
    }
  }
  if (rows.length === 0) {
    console.log("\n## Enemy HP outliers\n\n  none -- no Elite on any level\n");
    return;
  }
  console.log("\n## Enemy HP outliers (complexity -> HP)\n");
  console.log("level  entity                          complexity  archetype       HP   vs level ammo");
  for (const o of rows.sort((a, b) => b.maxHp - a.maxHp)) {
    const mark = o.unkillable ? "  <-- EXCEEDS all obtainable damage" : "";
    console.log(
      `${String(o.level).padStart(5)}  ${String(o.name).padEnd(31).slice(0, 31)}` +
        `${String(o.complexity ?? "--").padStart(10)}  ${o.archetype.padEnd(9)}${String(Math.round(o.maxHp)).padStart(7)}   ` +
        `${fmt(o.shareOfObtainable)}x${mark}`,
    );
  }
}

function printThreat(results) {
  console.log("\n## Threat and survival\n");
  // Survival depends only on archetype and difficulty, never on the level, so
  // it is stated once rather than repeated identically down a column.
  const s = results[0]?.survival;
  if (s) {
    console.log(
      `  Survival at full health, no armour: ${fmt(s.vsOneNormal, 1)}s vs one regular enemy, ` +
        `${fmt(s.vsThreeNormal, 1)}s vs three, ${fmt(s.vsOneElite, 1)}s vs one Elite.`,
    );
  }
  console.log("  Per level, n/dps/threat -- threat is normalised so a regular enemy scores by its own mean HP.\n");
  console.log("level  enemy DPS   normal(n/dps/threat)     elite(n/dps/threat)      edgeCase(n/dps/threat)");
  for (const r of results) {
    const cell = (a) => {
      const stats = r.enemies.byArchetype[a];
      if (!stats || stats.count === 0) return "--".padEnd(25);
      return `${stats.count}/${fmt(stats.dps, 1)}/${fmt(stats.threat, 0)}`.padEnd(25);
    };
    console.log(
      `${String(r.campaignLevelIndex).padStart(5)}  ${fmt(r.enemies.totalDps, 1).padStart(9)}   ${cell("normal")}${cell("elite")}${cell("edgeCase")}`,
    );
  }
}

function printSelfSustain(results) {
  console.log("\n## Self-sustain by archetype (expected drop damage / damage to kill)\n");
  console.log("  Above 1.0 means fighting it is free ammo and the economy has no floor.\n");
  console.log("level  normal            elite             edgeCase");
  for (const r of results) {
    const cell = (s) => (s === null ? "--".padEnd(18) : `${fmt(s.ratio)} (hp ${Math.round(s.meanHp)})`.padEnd(18));
    console.log(
      `${String(r.campaignLevelIndex).padStart(5)}  ${cell(r.selfSustain.normal)}${cell(r.selfSustain.elite)}${cell(r.selfSustain.edgeCase)}`,
    );
  }
}

function printWeaponTable(profiles) {
  console.log("\n## Weapon efficiency (perfect accuracy)\n");
  console.log("idx  weapon           dmg/trigger   ammo/shot   dmg/ammo      dps   pool");
  for (const p of profiles) {
    console.log(
      `${String(p.index).padStart(3)}  ${p.name.padEnd(16)}${String(p.damagePerTrigger).padStart(11)}   ` +
        `${String(p.ammoPerShot).padStart(9)}   ${(Number.isFinite(p.damagePerAmmo) ? fmt(p.damagePerAmmo, 1) : "inf").padStart(8)}   ` +
        `${fmt(p.dps, 0).padStart(6)}   ${p.pool ?? "--"}`,
    );
  }
}

function printDifficultySweep(byDifficulty) {
  const difficulties = [...byDifficulty.keys()];
  console.log("\n## Difficulty sweep -- combined clear ratio\n");
  console.log(`level  ${difficulties.map((d) => d.padStart(8)).join("")}`);
  const levelCount = byDifficulty.get(difficulties[0]).length;
  for (let i = 0; i < levelCount; i++) {
    const cells = difficulties.map((d) => fmt(byDifficulty.get(d)[i].clearRatio.combined).padStart(8)).join("");
    console.log(`${String(i + 1).padStart(5)}  ${cells}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dir)) {
    console.error(`no such directory: ${args.dir}`);
    process.exit(2);
  }

  const modules = await loadEngineModules();
  const { levels, skipped } = await generateLevels(args.dir, modules);
  if (levels.length === 0) {
    console.error(`no parsable files in ${args.dir}`);
    process.exit(2);
  }

  const profiles = weaponProfiles(modules.WEAPONS);
  const constants = {
    ...modules,
    profiles,
    dropAmounts: {
      bullets: modules.BULLETS_DROP_AMOUNT,
      rockets: modules.ROCKETS_DROP_AMOUNT,
      smg: modules.SMG_DROP_AMOUNT,
      gas: modules.GAS_DROP_AMOUNT,
      health: modules.HEALTH_DROP_AMOUNT,
      swap: modules.SWAP_DROP_AMOUNT,
      eliteHealth: modules.ELITE_HEALTH_DROP_AMOUNT,
      eliteBullets: modules.ELITE_BULLETS_DROP_AMOUNT,
      eliteSwap: modules.ELITE_SWAP_DROP_AMOUNT,
    },
  };

  console.log(`# Balance budget -- ${path.relative(REPO_ROOT, args.dir) || args.dir}`);
  console.log(`# ${levels.length} levels, perfect-accuracy lower bound on cost`);
  if (skipped.length > 0) console.log(`# skipped (no parser matched): ${skipped.join(", ")}`);
  printWeaponTable(profiles);

  const byDifficulty = new Map();
  for (const difficulty of args.difficulties) {
    const results = solveCampaign({ levels, constants, difficulty });
    byDifficulty.set(difficulty, results);
    console.log(`\n\n===== difficulty: ${difficulty} =====\n`);
    printBudgetTable(results);
    printThreat(results);
    printSelfSustain(results);
    printOutliers(results);
  }
  if (byDifficulty.size > 1) printDifficultySweep(byDifficulty);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(Object.fromEntries(byDifficulty), null, 2));
    console.log(`\nwrote ${path.relative(REPO_ROOT, args.json)}`);
  }

  const unkillable = [...byDifficulty.entries()].flatMap(([difficulty, results]) =>
    results.flatMap((r) => r.outliers.filter((o) => o.unkillable).map((o) => ({ difficulty, level: r.campaignLevelIndex, ...o }))),
  );
  if (unkillable.length > 0) {
    console.error(`\nFAIL: ${unkillable.length} enemy/enemies exceed all obtainable damage on their level:`);
    for (const u of unkillable) console.error(`  ${u.difficulty} level ${u.level}: ${u.name}() ${Math.round(u.maxHp)} HP (${fmt(u.shareOfObtainable)}x)`);
    process.exit(1);
  }
  console.log("\nOK: every enemy is killable with the damage obtainable on its level.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

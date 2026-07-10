// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Headless structural verifier for `demo-campaign/`: parses every file with
 * the real parser registry and runs it through the real `MapGenerator`
 * (no browser, no DOM — see `scripts/lib/loadEngineModules.mjs`), then
 * reports what actually got generated per level and, in aggregate, whether
 * every map feature and enemy type the demo campaign was designed to
 * showcase actually showed up somewhere.
 *
 * Map generation is deterministic from file content (seeded PRNG hashed from
 * the parsed AST), but which room/enemy/secret/TODO-outcome a given seed
 * lands on isn't hand-computable — this script is the only reliable way to
 * confirm a file actually produced what it was authored for. Exits non-zero
 * if any file fails to parse or any coverage checklist item is unobserved,
 * so it's a real gate, not just a printout.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const CHEBYSHEV_TODO_RADIUS = 2;
const TODO_MARKERS = ["TODO", "FIXME"];

function isTodoFlagged(text) {
  return TODO_MARKERS.some((marker) => text.includes(marker));
}

/** Same directories-first/alphabetical-case-insensitive order the real game
 * uses (`compareNodes`, `src/fs/workspace.ts`) — moot for directories since
 * `demo-campaign/` is flat, but the comparator itself must match exactly. */
function campaignOrder(filenames) {
  return [...filenames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Best-effort: attribute a TODO/FIXME-flagged lore terminal to the trap,
 * mine, or "Bug" enemy `placeTodoEncounter` may have placed beside it. The
 * merged `GameMap` doesn't tag which encounter came from which terminal, so
 * this is a nearest-tile heuristic (Chebyshev distance <= 2, matching
 * `interiorNeighborOf` + its immediate neighbors) — not an exact attribution,
 * and is reported as such. */
function attributeTodoOutcome(terminal, map) {
  const nearTrap = map.spikeTraps.find((t) => chebyshev(t.x, t.y, terminal.x, terminal.y) <= CHEBYSHEV_TODO_RADIUS);
  if (nearTrap) return "trap";
  const nearMine = map.mines.find(
    (m) => chebyshev(Math.floor(m.x), Math.floor(m.y), terminal.x, terminal.y) <= CHEBYSHEV_TODO_RADIUS,
  );
  if (nearMine) return "mine";
  const nearBug = map.enemies.find(
    (e) => e.entity.name === "Bug" && chebyshev(Math.floor(e.x), Math.floor(e.y), terminal.x, terminal.y) <= CHEBYSHEV_TODO_RADIUS,
  );
  if (nearBug) return "bug";
  return "none";
}

function packSizeHistogram(enemies) {
  const groups = new Map();
  for (const enemy of enemies) {
    if (enemy.elite || enemy.edgeCase) continue;
    const key = `${enemy.entity.name}:${enemy.entity.startLine}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.values()];
}

async function main() {
  const { parseFile, extensionOf, MapGenerator } = await loadEngineModules();
  const generator = new MapGenerator();

  const filenames = campaignOrder(fs.readdirSync(CAMPAIGN_DIR).filter((f) => fs.statSync(path.join(CAMPAIGN_DIR, f)).isFile()));

  const coverage = {
    packSizes: new Set(),
    eliteCount: 0,
    edgeCaseCount: 0,
    todoOutcomes: new Set(),
    lockedDoorSeen: false,
    hazardSeen: false,
    teleporterPairLevels: [],
    secretKindsSeen: new Set(),
    bonusLevelCount: 0,
    languagesSeen: new Set(),
    parseFailures: [],
  };

  let anyFailure = false;

  for (const filename of filenames) {
    const filePath = path.join(CAMPAIGN_DIR, filename);
    const sourceText = fs.readFileSync(filePath, "utf8");
    const parsed = await parseFile(filename, sourceText);

    if (!parsed) {
      console.error(`[FAIL] ${filename}: did not parse (no adapter matched, or the adapter threw)`);
      coverage.parseFailures.push(filename);
      anyFailure = true;
      continue;
    }

    const bonusLevel = extensionOf(filename) === "h";
    const map = generator.generate(parsed, bonusLevel, false, [3, 4, 5]);

    coverage.languagesSeen.add(parsed.language);
    if (bonusLevel) coverage.bonusLevelCount += 1;

    const elites = map.enemies.filter((e) => e.elite);
    const edgeCases = map.enemies.filter((e) => e.edgeCase);
    const packSizes = packSizeHistogram(map.enemies);
    for (const size of packSizes) coverage.packSizes.add(size);
    coverage.eliteCount += elites.length;
    coverage.edgeCaseCount += edgeCases.length;
    if (map.doors.length > 0) coverage.lockedDoorSeen = true;
    if (map.hazards.length > 0) coverage.hazardSeen = true;
    if (map.teleporters.length > 0) coverage.teleporterPairLevels.push(filename);

    const secretKindsInSource = new Set(parsed.secretTriggers.map((t) => t.kind));
    if (map.secretRoomCount > 0) {
      for (const kind of secretKindsInSource) coverage.secretKindsSeen.add(kind);
    }

    const todoTerminals = map.loreTerminals.filter((t) => isTodoFlagged(t.text));
    const todoOutcomes = todoTerminals.map((t) => attributeTodoOutcome(t, map));
    for (const outcome of todoOutcomes) coverage.todoOutcomes.add(outcome);

    const entityKindCounts = {};
    for (const e of parsed.entities) entityKindCounts[e.kind] = (entityKindCounts[e.kind] ?? 0) + 1;

    console.log(`\n[${filename}] language=${parsed.language} LOC=${parsed.linesOfCode}`);
    console.log(`  entities: ${JSON.stringify(entityKindCounts)}`);
    console.log(`  map: ${map.width}x${map.height}, rooms=${map.rooms.length}, breakupRooms=${map.breakupRooms.length}`);
    console.log(
      `  enemies=${map.enemies.length} (elite=${elites.length}, edgeCase=${edgeCases.length}, packSizes=${JSON.stringify(packSizes)})`,
    );
    console.log(`  doors=${map.doors.length} keys=${map.keys.length} hazards=${map.hazards.length}`);
    console.log(`  teleporterPads=${map.teleporters.length} (labels: ${[...new Set(map.teleporters.map((t) => t.label))].join(", ") || "none"})`);
    console.log(`  secretRoomCount=${map.secretRoomCount}, secretTriggerKindsInSource=${[...secretKindsInSource].join(", ") || "none"}`);
    console.log(
      `  loreTerminals=${map.loreTerminals.length}, todoTerminals=${todoTerminals.length}, todoOutcomes(best-effort)=${JSON.stringify(todoOutcomes)}`,
    );
    console.log(`  bonusLevel=${map.bonusLevel}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("AGGREGATE COVERAGE CHECKLIST");
  console.log("=".repeat(72));

  const checks = [
    ["Pack size 1 (single regular enemy)", coverage.packSizes.has(1)],
    ["Pack size 2", coverage.packSizes.has(2)],
    ["Pack size 3", coverage.packSizes.has(3)],
    ["Pack size 4", coverage.packSizes.has(4)],
    ["Elite enemy observed", coverage.eliteCount > 0, `(${coverage.eliteCount} total)`],
    ["Edge Case enemy observed", coverage.edgeCaseCount > 0, `(${coverage.edgeCaseCount} total) — re-tune finale size if false`],
    ["TODO outcome: trap", coverage.todoOutcomes.has("trap")],
    ["TODO outcome: mine", coverage.todoOutcomes.has("mine")],
    ["TODO outcome: Bug enemy", coverage.todoOutcomes.has("bug")],
    ["Locked door + key observed", coverage.lockedDoorSeen],
    ["Hazard room observed", coverage.hazardSeen],
    ["Goto/teleporter pair observed", coverage.teleporterPairLevels.length > 0, `(levels: ${coverage.teleporterPairLevels.join(", ") || "none"})`],
    ["Both goto/teleporter levels present (>=2)", coverage.teleporterPairLevels.length >= 2],
    ["Secret trigger: deadCode", coverage.secretKindsSeen.has("deadCode")],
    ["Secret trigger: emptyCatch", coverage.secretKindsSeen.has("emptyCatch")],
    ["Secret trigger: deprecated", coverage.secretKindsSeen.has("deprecated")],
    ["Secret trigger: commentedCode", coverage.secretKindsSeen.has("commentedCode")],
    ["Secret trigger: magicBlob", coverage.secretKindsSeen.has("magicBlob")],
    ["Bonus level present exactly once", coverage.bonusLevelCount === 1, `(count=${coverage.bonusLevelCount})`],
    ["All 15 languages parsed", coverage.languagesSeen.size === 15, `(${coverage.languagesSeen.size}/15: ${[...coverage.languagesSeen].sort().join(", ")})`],
    ["No parse failures", coverage.parseFailures.length === 0, coverage.parseFailures.join(", ")],
  ];

  let anyChecklistFailure = false;
  for (const [label, passed, note] of checks) {
    if (!passed) anyChecklistFailure = true;
    console.log(`  [${passed ? "PASS" : "FAIL"}] ${label}${note ? ` ${note}` : ""}`);
  }

  console.log("=".repeat(72));

  if (anyFailure || anyChecklistFailure) {
    console.error("\nverify:campaign FAILED — see FAIL lines above.");
    process.exit(1);
  }
  console.log("\nverify:campaign PASSED — full coverage confirmed.");
}

main().catch((err) => {
  console.error("verify:campaign crashed:", err);
  process.exit(1);
});

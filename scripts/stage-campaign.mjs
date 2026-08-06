// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Stage a curated slice of a real repository into `demo-campaign/`, so the
 * playtest bot can actually play it.
 *
 * ```sh
 * npm run balancing:budget -- --dir balancing_corpus/wolf3d --all-difficulties --json wolf3d.json
 * node scripts/stage-campaign.mjs --repo balancing_corpus/wolf3d --solved wolf3d.json
 * ```
 *
 * **Why a curated slice and not the repo.** The bot harness plays whatever is
 * in `demo-campaign/`, and a real repo is far too big for that to be a
 * campaign: ripgrep is 87 levels, curl 648, `laravel/framework` 1,694. A level
 * cap would not help either — it truncates from the *start*, so the sample
 * would be whatever the repo happens to sort first and would never reach the
 * levels worth measuring. This selects ~15 files spanning the repo's own
 * difficulty range instead.
 *
 * **It is a constructed campaign, not a playthrough, and any report using it
 * has to say so.** It answers "are this repo's dangerous levels survivable",
 * not "is a real repo fun from level 1".
 *
 * Three rules, each for a reason:
 *
 * - **Flat, with ordering prefixes.** Three different enumerations have to
 *   agree on which file is level N — the game recurses with ignore rules, the
 *   solver recurses the same way, and `planLevels` is a flat `readdirSync`
 *   with none. Flat is the only shape where all three match, and `playRun`
 *   indexes `levelPlans[i]` positionally with no filename check, so a
 *   mismatch silently routes one level's map with another's plan.
 * - **Ascending difficulty.** Not cosmetic: weapons unlock by campaign
 *   position (Toolchain is gated to level 4+), and an extreme level in slot 1
 *   kills every run before it can measure anything. Mirrors `demo-campaign`'s
 *   own shape — a gentle ramp and one spike at the end.
 * - **Bonus levels excluded.** `planLevels` turns any `.h`/`.H` file into a
 *   bonus level with boosted ammo, which is trivial by construction (demo's
 *   one bonus level: 0% deaths at clear ratio 49.95). They would waste slots.
 *   This matters more than it sounds — wolf3d is 63% `.H` and stb 69%.
 *
 * Always-included levels, because they are the open questions: the repo's
 * highest incoming DPS, its largest single Elite, and its tightest clear
 * ratio. The rest fill in evenly across the DPS range.
 */
import fs from "node:fs";
import path from "node:path";

import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { solveCampaign, weaponProfiles } from "./lib/levelSolver.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const DEFAULT_SLOTS = 15;

function parseArgs(argv) {
  const args = { repo: null, solved: null, slots: DEFAULT_SLOTS, difficulty: "hard", dryRun: false, exclude: [], solvedOut: null, allowPickDrift: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = path.resolve(argv[++i]);
    else if (a === "--solved") args.solved = path.resolve(argv[++i]);
    else if (a === "--slots") args.slots = Number(argv[++i]);
    else if (a === "--difficulty") args.difficulty = argv[++i];
    // Repeatable path-substring filter. Needed because a repo can carry code
    // that is not *its* code: `mcdope/codeenstein3d` ships `demo-campaign/`,
    // the authored 17-file showcase, and 6 of the 12 Elites it generates come
    // from those fixtures rather than from the engine. Staging them would have
    // the game partly playing its own test data and would overstate what the
    // real source produces.
    else if (a === "--exclude") args.exclude.push(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--solved-out") args.solvedOut = path.resolve(argv[++i]);
    else if (a === "--allow-pick-drift") args.allowPickDrift = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.repo || !args.solved) {
    console.error("usage: node scripts/stage-campaign.mjs --repo <dir> --solved <budget.json> [--slots 15] [--dry-run]");
    process.exit(2);
  }
  return args;
}

/** Pick the slice. Difficulty only affects the *ordering* metrics, not which
 * files exist — the same files are levels at every difficulty. */
function select(levels, slots, complexity) {
  // Three exclusions, all matching a rule the engine already enforces:
  //   - bonus levels (.h/.H) get boosted ammo and are trivial by construction
  //   - zero-enemy levels are a walk to the exit with nothing in them
  //   - zero-complexity levels are SKIPPED by `findEntrypointByScanning`, so
  //     one in slot 1 would leave the browser opening on slot 2 while
  //     `planLevels` plans from slot 1 — the silent desync that wedged the
  //     first wolf3d pilot for 60 runs. `codeenstein3d`'s own
  //     `defaultHighscore.ts` is exactly this: complexity 0, but 2 Edge Cases
  //     from corridor dressing, so the enemy count alone would not catch it.
  const pool = levels.filter((l) => !l.bonusLevel && l.enemies.totalCount > 0 && (complexity.get(l.filename) ?? 0) > 0);
  if (pool.length === 0) throw new Error("no non-bonus, non-empty, non-trivial level here — nothing worth staging");
  if (pool.length <= slots) return pool.slice().sort(byDps);

  const dpsOf = (l) => l.enemies.totalDps;
  const eliteHpOf = (l) => l.enemies.byArchetype.elite.hp;
  const ratioOf = (l) => l.clearRatio?.combined ?? Infinity;

  const must = new Set();
  must.add(pool.reduce((a, b) => (dpsOf(b) > dpsOf(a) ? b : a)));
  const worstElite = pool.reduce((a, b) => (eliteHpOf(b) > eliteHpOf(a) ? b : a));
  if (eliteHpOf(worstElite) > 0) must.add(worstElite);
  must.add(pool.reduce((a, b) => (ratioOf(b) < ratioOf(a) ? b : a)));
  MUST_INCLUDE.clear();
  for (const l of must) MUST_INCLUDE.add(l.filename);

  // Fill the remaining slots evenly across the DPS-sorted pool, so the ramp
  // covers the repo's whole range rather than clustering at one end.
  const sorted = pool.slice().sort(byDps);
  const chosen = new Set(must);
  const remaining = slots - chosen.size;
  for (let i = 0; i < remaining; i++) {
    const target = sorted[Math.round((i * (sorted.length - 1)) / Math.max(1, remaining - 1))];
    if (!chosen.has(target)) {
      chosen.add(target);
      continue;
    }
    // Already taken by a must-include — walk outward for the nearest free one
    // rather than silently returning a short campaign.
    const idx = sorted.indexOf(target);
    for (let d = 1; d < sorted.length; d++) {
      const alt = sorted[idx - d] ?? sorted[idx + d];
      if (alt && !chosen.has(alt)) {
        chosen.add(alt);
        break;
      }
    }
  }
  return [...chosen].sort(byDps);
}

const byDps = (a, b) => a.enemies.totalDps - b.enemies.totalDps;

/** Filenames `select` flagged as must-includes, so `order` can put them last.
 * Module-level rather than threaded through, because `select` already returns
 * a plain level array that several callers read positionally. */
const MUST_INCLUDE = new Set();

/**
 * Slot order: ramp first, the levels under test last.
 *
 * Two constraints fight here and both are load-bearing.
 *
 * **Slot 1 must be the least-complex file**, because the game with no
 * conventional entrypoint name opens on the lowest-complexity file and
 * `planLevels` plans from slot 1 — if they disagree the bot routes one map
 * with another's plan and every run wedges silently.
 *
 * **The must-includes have to be reachable.** Ordering purely by complexity
 * put wolf3d's tightest-ratio level (1.63, with an Elite) at slot 5, where it
 * killed 100% of Pro and 78% of Gamer — so slots 6-15 were never played and
 * the two levels the capture existed to measure went untested. Pushing the
 * must-includes to the end gives the bot the full ramp first: more weapons
 * (Toolchain unlocks at level 4+), more carried ammo, and a fairer answer to
 * "is this level survivable" than meeting it half-equipped.
 *
 * Falls back to plain complexity order in the degenerate case where the
 * least-complex file is itself a must-include — correctness of slot 1 wins.
 */
function order(selected, complexity) {
  const cx = (l) => complexity.get(l.filename);
  const byCx = (a, b) => cx(a) - cx(b);
  const hasElite = (l) => l.enemies.byArchetype.elite.count > 0;
  const sorted = selected.slice().sort(byCx);

  // Elite-free levels first, then Elite levels, then the ones under test.
  // Measured on wolf3d, twice: whichever file landed in slot 5 killed 80-100%
  // of runs, and the only thing the two candidates shared was an Elite — one
  // at clear ratio 1.63, the other at 13.46, so ammo supply was not the
  // difference. A single 3,000 HP Elite is simply a wall for a bot five levels
  // into its weapon progression.
  //
  // This mirrors how `demo-campaign` is authored rather than inventing a rule:
  // its first Elite is level 12 of 17, and the bot clears that one at 0%
  // deaths. Real repos have no such ramp — complexity ordering alone put an
  // Elite at slot 5 — so the curation has to supply it, or nothing past the
  // first Elite is ever measured.
  const bucket = (l) => (MUST_INCLUDE.has(l.filename) ? 2 : hasElite(l) ? 1 : 0);
  const ordered = sorted.slice().sort((a, b) => bucket(a) - bucket(b) || cx(a) - cx(b));

  // Slot 1 must still be the global complexity minimum, or the browser opens
  // on a different level than `planLevels` planned. In practice safe — an
  // Elite needs complexity >= 40, so the least-complex level is almost never
  // one — but checked rather than assumed.
  return cx(ordered[0]) === cx(sorted[0]) ? ordered : sorted;
}

/**
 * Summed `complexityScore` per file — the *same* number
 * `findEntrypointByScanning` scores with.
 *
 * Slot order has to be built on this rather than on DPS, because the game does
 * not start at slot 1 by position: with no conventional entrypoint filename it
 * picks the least-complex file and progresses from there, while `planLevels`
 * plans in filename order from slot 1. If those disagree the bot navigates one
 * level's map with another's route plan and every run wedges — which is
 * exactly what the first wolf3d pilot did, silently, for 60 runs.
 *
 * DPS and complexity are correlated but not identical (edge-case enemies are
 * corridor dressing, not parsed entities), so "close enough" is not good
 * enough here.
 */
async function complexityByFile(repoDir, levels) {
  const { parseFile } = await loadEngineModules();
  const out = new Map();
  for (const level of levels) {
    const abs = path.join(repoDir, level.filename);
    let total = 0;
    try {
      const parsed = await parseFile(path.basename(level.filename), fs.readFileSync(abs, "utf8"));
      if (parsed) total = parsed.entities.reduce((sum, e) => sum + (e.complexityScore ?? 0), 0);
    } catch {
      total = 0;
    }
    out.set(level.filename, total);
  }
  return out;
}


/**
 * Re-solve the campaign this script is about to emit, in its own slot order.
 *
 * The `--solved` JSON is a *full-repo* solve: every level carries the ammo it
 * would have banked at its position in the whole repository's enumeration. The
 * emitted campaign is ~15 levels, so those numbers describe a campaign nobody
 * plays. Measured on curl: one level read clear ratio **261.43** full-repo and
 * **6.39** re-solved in staged order — a 41x overstatement, on the exact level
 * being cited as evidence.
 *
 * Only the min-clear-ratio must-include is affected. Max-DPS and max-Elite-HP
 * are level-local (`enemies.totalDps`, `enemies.byArchetype.elite.hp` are
 * functions of the roster and difficulty alone) and survive restaging unchanged;
 * so do the DPS-based fill and the complexity-based ordering.
 *
 * Maps are regenerated rather than reused, because generation itself is
 * position-dependent — `hasRocketLauncher`/`hasSmg`/`hasGas`/
 * `missingWeaponIndices` come from the campaign index and change secret-room
 * and exception-zone loot. Mirrors `report-level-budget.mjs`'s own
 * `generateLevels`/`constants` so the numbers are comparable to
 * `npm run balancing:budget`.
 */
async function resolveStagedOrder(picked, repoDir, difficulty) {
  const modules = await loadEngineModules();
  const { parseFile, extensionOf, MapGenerator, STARTING_WEAPONS, FORCED_UNLOCK_LEVELS, UNLOCKABLE_WEAPONS } = modules;
  const generator = new MapGenerator();

  const levels = [];
  for (const [i, level] of picked.entries()) {
    const abs = path.join(repoDir, level.filename);
    const name = path.basename(level.filename);
    const parsed = await parseFile(name, fs.readFileSync(abs, "utf8"));
    if (!parsed) throw new Error(`re-solve: ${level.filename} no longer parses`);
    const campaignLevelIndex = i + 1;
    const owned = new Set(STARTING_WEAPONS);
    for (const { level: unlockAt, weaponIndex } of FORCED_UNLOCK_LEVELS) {
      if (campaignLevelIndex >= unlockAt) owned.add(weaponIndex);
    }
    const map = generator.generate(parsed, {
      bonusLevel: extensionOf(name) === "h",
      hasRocketLauncher: owned.has(modules.GHIDRA_WEAPON_INDEX),
      hasSmg: owned.has(modules.GDB_WEAPON_INDEX),
      hasGas: owned.has(modules.FRIDAY_HOTFIX_WEAPON_INDEX),
      missingWeaponIndices: UNLOCKABLE_WEAPONS.filter((k) => !owned.has(k)),
    });
    levels.push({ filename: level.filename, map });
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
  return solveCampaign({ levels, constants, difficulty });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const solved = JSON.parse(fs.readFileSync(args.solved, "utf8"));
  const all = solved[args.difficulty];
  if (!all) throw new Error(`no "${args.difficulty}" section in ${args.solved}`);
  const levels = all.filter((l) => !args.exclude.some((x) => l.filename.includes(x)));
  if (args.exclude.length > 0) {
    console.log(`Excluded ${all.length - levels.length} level(s) matching: ${args.exclude.join(", ")}`);
  }

  const complexity = await complexityByFile(args.repo, levels);
  const selected = select(levels, args.slots, complexity);
  const picked = order(selected, complexity);

  console.log(`Staging ${picked.length} of ${levels.length} levels from ${path.relative(REPO_ROOT, args.repo)}`);
  console.log(`(${levels.filter((l) => l.bonusLevel).length} bonus levels excluded — .h/.H gets boosted ammo and is trivial)\n`);
  console.log(`${"slot".padEnd(5)}${"source".padEnd(40)}${"cx".padStart(6)}${"n".padStart(5)}${"dps".padStart(7)}${"eliteHP".padStart(9)}${"ratio".padStart(8)}`);

  const staged = [];
  picked.forEach((level, i) => {
    const slot = String(i + 1).padStart(2, "0");
    // Whole relative path in the name, not just the basename: two directories
    // can hold the same filename, and a silent overwrite would drop a level.
    const flat = `${slot}_${level.filename.replace(/[\\/]/g, "_")}`;
    const e = level.enemies;
    console.log(
      `${slot.padEnd(5)}${level.filename.slice(0, 39).padEnd(40)}${String(complexity.get(level.filename)).padStart(6)}${String(e.totalCount).padStart(5)}${String(Math.round(e.totalDps)).padStart(7)}` +
        `${String(e.byArchetype.elite.hp).padStart(9)}${(level.clearRatio?.combined ?? 0).toFixed(2).padStart(8)}${MUST_INCLUDE.has(level.filename) ? "  <-- under test" : ""}`,
    );
    staged.push({ from: path.join(args.repo, level.filename), to: path.join(CAMPAIGN_DIR, flat) });
  });

  // The picks were made against the full-repo solve; check them against the
  // campaign actually being emitted. See `resolveStagedOrder`.
  const stagedSolve = await resolveStagedOrder(picked, args.repo, args.difficulty);
  const ratio = (r) => r.clearRatio?.combined ?? Infinity;
  let worst = 0;
  for (let i = 1; i < stagedSolve.length; i++) if (ratio(stagedSolve[i]) < ratio(stagedSolve[worst])) worst = i;
  const claimed = picked.findIndex((l) => ratio(l) === Math.min(...picked.map(ratio)));

  console.log(`\nStaged-order re-solve (${args.difficulty}) — clear ratio per slot:`);
  console.log(stagedSolve.map((r, i) => `  ${String(i + 1).padStart(2, "0")} ${ratio(r).toFixed(2)}`).join(""));
  console.log(`  tightest in staged order:   slot ${worst + 1} (${ratio(stagedSolve[worst]).toFixed(2)}) — ${stagedSolve[worst].filename}`);
  console.log(`  full-repo pick was:       slot ${claimed + 1} (${ratio(picked[claimed]).toFixed(2)}) — ${picked[claimed].filename}`);

  if (args.solvedOut) {
    fs.writeFileSync(args.solvedOut, JSON.stringify({ [args.difficulty]: stagedSolve }, null, 1));
    console.log(`  wrote stagedSolve-order solve to ${path.relative(REPO_ROOT, args.solvedOut)}`);
  }

  if (worst !== claimed) {
    const msg =
      `\nRefusing to stage: the min-clear-ratio pick does not survive restaging.\n` +
      `  Chosen on the full-repo solve: ${picked[claimed].filename} (ratio ${ratio(picked[claimed]).toFixed(2)})\n` +
      `  Actually tightest once staged:  ${stagedSolve[worst].filename} (ratio ${ratio(stagedSolve[worst]).toFixed(2)})\n` +
      `  The full-repo solve credits each level with ammo banked across the whole\n` +
      `  repository, which this 15-level campaign never accumulates — on curl that\n` +
      `  was a 41x overstatement. The recorded rationale for that slot would be wrong.\n` +
      `  Re-run with --allow-pick-drift if the curation is deliberate.`;
    if (!args.allowPickDrift) {
      console.error(msg);
      process.exit(1);
    }
    console.log(`${msg}\n  (--allow-pick-drift set: continuing anyway)`);
  }

  if (args.dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  // Destructive, and deliberately so — the harness plays this directory and
  // nothing else. Guarded on branch rather than trusted: ~10 test files assert
  // against the real demo campaign, and a staged one must never reach a branch
  // anyone merges.
  // Everything after `refs/heads/`, not the last path segment: a branch called
  // `capture/wolf3d` is not "wolf3d", and splitting on "/" would also block a
  // perfectly fine `feature/main`.
  const head = fs.existsSync(path.join(REPO_ROOT, ".git"))
    ? fs.readFileSync(path.join(REPO_ROOT, ".git", "HEAD"), "utf8").trim()
    : "";
  const branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head;
  if (branch === "master" || branch === "main") {
    console.error(`\nRefusing to overwrite demo-campaign/ on "${branch}". Use a throwaway branch (e.g. capture/<repo>).`);
    process.exit(1);
  }

  for (const f of fs.readdirSync(CAMPAIGN_DIR)) fs.rmSync(path.join(CAMPAIGN_DIR, f), { force: true });
  for (const { from, to } of staged) fs.copyFileSync(from, to);

  console.log(`\nStaged into demo-campaign/ on branch "${branch}".`);
  console.log("Pre-flight before any bot run:");
  console.log("  npm run balancing:budget -- --dir demo-campaign --all-difficulties");
  console.log("Lane hosts clone from origin, so this must be committed AND pushed before capturing.");
}

main().catch((err) => {
  console.error("stage-campaign failed:", err.message);
  process.exit(1);
});

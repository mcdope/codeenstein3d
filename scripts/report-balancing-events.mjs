// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Turns a raw balancing event log into a readable markdown report.
 *
 * ```sh
 * npm run balancing:events -- balancing_events/Gamer-normal.ndjson
 * npm run balancing:events -- balancing_events/            # every log in a dir
 * ```
 *
 * The point of this script is that it was written *after* the data it reads
 * was collected, against a stream that knew nothing about it — which is the
 * entire argument for logging events rather than counters. Overkill, hit rate
 * bucketed by range, and measured self-sustain are all things the aggregate
 * counters cannot express at any sample size.
 *
 * Ammo is valued through the real `WEAPONS` table (via `loadEngineModules()`),
 * the same numbers `report-level-budget.mjs` uses, so the measured self-sustain
 * printed here is directly comparable to the solver's prediction. Where the
 * two disagree, that gap is the finding.
 *
 * Formatting only — every number comes from `scripts/lib/eventMetrics.mjs`.
 */
import fs from "node:fs";
import path from "node:path";

import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { readEventLog } from "./lib/eventLog.mjs";
import {
  damageTakenByAttacker,
  hitRateByDistance,
  killRateByHpBand,
  levelPacing,
  lootEconomy,
  measuredSelfSustain,
  survivability,
  timeToKillByArchetype,
  weaponChoiceByTarget,
  weaponUsage,
} from "./lib/eventMetrics.mjs";
import { poolDamageValues, weaponProfiles } from "./lib/levelSolver.mjs";

/** Below this share of kills, an owned weapon is content the player carries
 * and never uses. */
const DEAD_CONTENT_KILL_SHARE = 0.02;

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  if (!Number.isFinite(value)) return "inf";
  return value.toFixed(digits);
}

function pct(value) {
  return value === null || value === undefined ? "--" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Every `.ndjson` under `target`, at any depth.
 *
 * Recursive because a *capture* nests them one level down — `events/<combo>-<seq>/`
 * per invocation — while a plain telemetry run writes them flat. The
 * non-recursive version silently found **zero** logs when pointed at a capture's
 * `events/` directory and reported on nothing at all, which reads exactly like a
 * run that produced no events.
 */
function collectLogPaths(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".ndjson")) out.push(full);
    }
  }
  return out.sort();
}

function printWeapons(events, profiles) {
  console.log("\n## Weapon usage\n");
  console.log("Trigger-pulls and pellets are counted separately on purpose: the aggregate");
  console.log("`weaponEfficiency` divides pellet hits by trigger-pulls, which reads over 100%");
  console.log("for any multi-pellet weapon. A splash weapon shows `--` for hit rate: a rocket");
  console.log("resolves as blast damage and never emits a per-pellet hit, so any ratio would");
  console.log("be a structural zero. Judge those on damage and kill share.\n");
  console.log("| weapon | pulls | pellets fired | pellet hits | pellet hit rate | pulls that hit | damage share | kill share |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  const usage = weaponUsage(events);
  for (const w of usage) {
    const name = profiles[w.w]?.name ?? `#${w.w}`;
    console.log(
      `| ${name} | ${w.pulls} | ${w.pelletsFired} | ${w.pelletHits} | ${pct(w.pelletHitRate)} | ` +
        `${pct(w.triggerHitRate)} | ${pct(w.shareOfDamage)} | ${pct(w.shareOfKills)} |`,
    );
  }

  const dead = usage.filter((w) => w.pulls > 0 && (w.shareOfKills ?? 0) < DEAD_CONTENT_KILL_SHARE);
  if (dead.length > 0) {
    console.log(`\n**Dead content:** ${dead.map((w) => profiles[w.w]?.name ?? `#${w.w}`).join(", ")} — fired, but under ${pct(DEAD_CONTENT_KILL_SHARE)} of kills.`);
  }

  console.log("\n### Overkill (damage wasted on the killing blow)\n");
  console.log("| weapon | kills | mean | p90 | max |");
  console.log("|---|---:|---:|---:|---:|");
  for (const w of usage) {
    if (!w.overkill) continue;
    console.log(`| ${profiles[w.w]?.name ?? `#${w.w}`} | ${w.kills} | ${fmt(w.overkill.mean, 1)} | ${fmt(w.overkill.p90, 1)} | ${fmt(w.overkill.max, 0)} |`);
  }
}

function printHitRateByDistance(events, profiles) {
  const rows = hitRateByDistance(events).filter((r) => r.fired > 0);
  if (rows.length === 0) return;
  console.log("\n## Hit rate by engagement distance\n");
  console.log("The Cone of Fire deviates with the *cube* of range, so an unbucketed hit rate");
  console.log("averages a weapon's usable and useless ranges into one number.\n");
  console.log("| weapon | bucket (tiles) | pellets fired | hits | rate |");
  console.log("|---|---|---:|---:|---:|");
  for (const r of rows) {
    console.log(`| ${profiles[r.w]?.name ?? `#${r.w}`} | ${r.bucket} | ${r.fired} | ${r.hits} | ${pct(r.rate)} |`);
  }
}

function printWeaponChoice(events, profiles) {
  const names = Object.fromEntries(profiles.map((p) => [p.index, p.name]));
  const rows = weaponChoiceByTarget(events, names);
  if (rows.length === 0) return;
  console.log("\n## Weapon chosen, by target archetype and range\n");
  console.log("What the bot actually reaches for. The `>=4` tile rows against `normal` and");
  console.log("`elite` targets are where a rocket would be legal — see");
  console.log("`doc/dev/balancing-telemetry.md` 7.3a for why that question kept needing a");
  console.log("55-minute A/B to answer badly.\n");
  console.log("| target | range | shots | weapons chosen |");
  console.log("|---|---|---:|---|");
  for (const r of rows) {
    const mix = Object.entries(r.byWeapon)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n} ${Math.round((100 * c) / r.total)}%`)
      .join(", ");
    console.log(`| ${r.arch} | ${r.bucket} | ${r.total} | ${mix} |`);
  }
}

function printEconomy(events, damagePerAmmo) {
  const economy = lootEconomy(events);
  console.log("\n## Loot economy — pre-placed vs dropped\n");
  console.log("| measure | value |");
  console.log("|---|---:|");
  console.log(`| pickups collected, pre-placed | ${economy.collected.preplaced} |`);
  console.log(`| pickups collected, from drops | ${economy.collected.drop} |`);
  console.log(`| **reliance on drops** | **${pct(economy.relianceRatio)}** |`);
  console.log(`| drops spawned | ${economy.dropped.count} |`);
  console.log(`| pre-placed left uncollected (level-ends summed) | ${economy.uncollectedPrePlaced} |`);
  console.log(`| enemies left alive, i.e. unrealised drops | ${economy.unrealisedDropsFromAlive} |`);
  console.log(
    `| health pickups that granted nothing | ${economy.wastedHealthPickups.granted0} of ${economy.wastedHealthPickups.total} |`,
  );

  const byArch = Object.entries(economy.dropped.byArch).sort((a, b) => b[1] - a[1]);
  if (byArch.length > 0) {
    console.log("\n**Drops spawned by archetype:** " + byArch.map(([a, n]) => `${a} ${n}`).join(", "));
  }

  console.log("\n### Self-sustain, measured\n");
  console.log("Damage-worth of what an archetype actually dropped, over the HP it actually cost.");
  console.log("Above 1.0 means fighting it is net-positive ammo. Directly comparable to");
  console.log("`npm run balancing:budget`'s prediction, since both value ammo the same way.\n");
  console.log("| archetype | kills | mean HP | drop damage | ratio |");
  console.log("|---|---:|---:|---:|---:|");
  for (const [arch, stats] of Object.entries(measuredSelfSustain(events, damagePerAmmo))) {
    console.log(`| ${arch} | ${stats.kills} | ${fmt(stats.meanHp, 0)} | ${fmt(stats.dropDamage, 0)} | **${fmt(stats.ratio)}** |`);
  }
}

function printCombat(events) {
  console.log("\n## Combat pacing\n");
  console.log("| archetype | kills | mean TTK | p50 | p90 | max |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [arch, ttk] of Object.entries(timeToKillByArchetype(events))) {
    if (!ttk) continue;
    console.log(`| ${arch} | ${ttk.n} | ${fmt(ttk.mean)}s | ${fmt(ttk.p50)}s | ${fmt(ttk.p90)}s | ${fmt(ttk.max)}s |`);
  }

  const survival = survivability(events);
  console.log("\n## Damage taken\n");
  console.log("| source | total |");
  console.log("|---|---:|");
  for (const [source, total] of Object.entries(survival.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${source} | ${fmt(total, 0)} |`);
  }
  console.log(`\nDeaths: **${survival.deaths}**.`);

  const attribution = damageTakenByAttacker(events);
  console.log("\n### ...by attacking enemy\n");
  console.log("| archetype | damage | share | hits |");
  console.log("|---|---:|---:|---:|");
  for (const [arch, stats] of Object.entries(attribution.byArch)) {
    console.log(`| ${arch} | ${fmt(stats.amt, 0)} | ${pct(stats.share)} | ${stats.hits} |`);
  }
  console.log(
    `\nUnattributed (traps, hazards, splash — \`by\` is null for those): **${fmt(attribution.unattributedAmt, 0)}**` +
      ` of ${fmt(attribution.totalAmt, 0)}.`,
  );
  if (attribution.topAttackers.length > 0) {
    console.log("\nSingle enemies doing the most damage — a lone entry near 100% means one enemy *is* the level:\n");
    console.log("| level | eid | archetype | damage | share of all damage taken |");
    console.log("|---:|---:|---|---:|---:|");
    for (const a of attribution.topAttackers) {
      console.log(`| ${a.lvl} | ${a.eid} | ${a.arch} | ${fmt(a.amt, 0)} | ${pct(a.share)} |`);
    }
  }
}

/**
 * Whether an enemy of a given size ever actually dies. The contrast between
 * bands is the reading, not any single rate — most of the roster is walked past
 * rather than fought, so even a healthy band sits well under 100%.
 */
function printEnemyViability(events) {
  const { bands, maxHpKilled } = killRateByHpBand(events);
  if (bands.every((b) => b.spawned === 0)) return;
  console.log("\n## Enemy viability by size\n");
  console.log("| max HP | spawned | killed | kill rate | median TTK |");
  console.log("|---|---:|---:|---:|---:|");
  for (const band of bands) {
    const ttk = band.ttk ? `${fmt(band.ttk.p50)}s` : "--";
    console.log(`| ${band.band} | ${band.spawned} | ${band.killed} | ${pct(band.rate)} | ${ttk} |`);
  }
  if (maxHpKilled) {
    console.log(
      `\nLargest enemy ever killed: **${maxHpKilled.maxHp} HP** (${maxHpKilled.arch},` +
        ` level ${maxHpKilled.lvl}, ${maxHpKilled.difficulty}).`,
    );
  }
  const empty = bands.filter((b) => b.spawned === 0).map((b) => b.band);
  if (empty.length > 0) {
    console.log(`\n> No enemy is ever generated in ${empty.join(", ")} — that gap is structural, not a sampling artefact.`);
  }
}

function printPacing(events) {
  const levels = levelPacing(events);
  if (levels.length === 0) return;
  console.log("\n## Per-level pacing\n");
  console.log("| level | visits | mean time | mean kills | outcomes |");
  console.log("|---:|---:|---:|---:|---|");
  for (const l of levels) {
    const outcomes = Object.entries(l.outcomes).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`| ${l.lvl} | ${l.visits} | ${fmt(l.time?.mean, 1)}s | ${fmt(l.killCount?.mean, 1)} | ${outcomes} |`);
  }
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/report-balancing-events.mjs <log.ndjson | dir>");
    process.exit(2);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`no such file or directory: ${resolved}`);
    process.exit(2);
  }

  const paths = collectLogPaths(resolved);
  if (paths.length === 0) {
    console.error(`no .ndjson logs in ${resolved}`);
    process.exit(2);
  }

  const modules = await loadEngineModules();
  const profiles = weaponProfiles(modules.WEAPONS);
  // Valued for a fully-unlocked loadout: this is a report over runs that
  // already happened, so the question is what the ammo was worth to a player
  // holding everything, not what it was worth before an unlock.
  const damagePerAmmo = poolDamageValues(profiles, modules.WEAPONS.map((_, i) => i));

  for (const logPath of paths) {
    const { events, malformed, truncatedTail } = readEventLog(logPath);
    console.log(`\n# ${path.relative(REPO_ROOT, logPath)}\n`);
    console.log(`${events.length} events.`);
    if (truncatedTail) console.log("\n> The final line was truncated — this run was killed mid-write. Everything before it is intact.");
    if (malformed.length > 0) console.log(`\n> **${malformed.length} malformed line(s)** at ${malformed.slice(0, 5).join(", ")} — real corruption, not a truncation.`);
    const overflow = events.filter((e) => e.e === "bufferOverflow");
    if (overflow.length > 0) {
      const dropped = overflow.reduce((sum, e) => sum + e.dropped, 0);
      console.log(`\n> **${dropped} events were dropped** — the in-page buffer filled. Cumulative totals below understate the truth.`);
    }
    if (events.length === 0) continue;

    printWeapons(events, profiles);
    printHitRateByDistance(events, profiles);
    printWeaponChoice(events, profiles);
    printEconomy(events, damagePerAmmo);
    printCombat(events);
    printEnemyViability(events);
    printPacing(events);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

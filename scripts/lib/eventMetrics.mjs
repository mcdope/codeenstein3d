// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Derives the empirical half of the stat catalog from a raw event log.
 *
 * This is the payoff for logging events instead of counters: every function
 * here was written *after* the data was collected, against a stream that knew
 * nothing about it. Overkill, hit rate bucketed by range, and measured
 * self-sustain are all things `telemetry.ts`'s accumulators cannot express at
 * any sample size, because they discard the per-occurrence detail before
 * anything is written down.
 *
 * Pure and injection-based, like `levelSolver.mjs`: `damagePerAmmo` is passed
 * in from the real `WEAPONS` table rather than mirrored, so the analytic and
 * empirical halves are valued on the same numbers and can be compared
 * directly. Where they disagree, that gap is the finding.
 *
 * See `doc/dev/balancing-telemetry.md`'s "The balance model" for the schema
 * and for which catalog entry each of these serves.
 */

/** Distance buckets for hit rate, in tiles. The Cone of Fire's deviation goes
 * with the cube of range against `FOG_FAR` (14), so the useful resolution is
 * near the short end — a weapon that falls apart does it between 4 and 10
 * tiles, not between 12 and 14. */
const DISTANCE_BUCKETS = [
  { label: "0-2", max: 2 },
  { label: "2-4", max: 4 },
  { label: "4-7", max: 7 },
  { label: "7-10", max: 10 },
  { label: "10+", max: Infinity },
];

const AMMO_KINDS = ["bullets", "rockets", "smg", "gas"];

function bucketFor(distance) {
  return DISTANCE_BUCKETS.find((b) => distance < b.max) ?? DISTANCE_BUCKETS[DISTANCE_BUCKETS.length - 1];
}

/** Mean, median and p90 of a sample, plus its size. `null` for an empty
 * sample rather than 0 — "no observations" and "observed zero" are different
 * answers and conflating them is how a missing metric reads as a good one. */
export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    p50: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Per-weapon usage, split so trigger-pulls and pellets never get conflated.
 *
 * `pelletHitRate` is pellets landed over pellets fired and is comparable
 * across weapons; `triggerHitRate` is pulls that landed at least one pellet.
 * The existing aggregate `weaponEfficiency` computes neither — it divides
 * pellet hits by trigger-pulls, which is a shotgun reading 286%.
 *
 * `share.kills` is the dead-content check: an owned weapon below a couple of
 * percent is content the player is carrying and never using.
 */
export function weaponUsage(events) {
  const byWeapon = new Map();
  const get = (w) => {
    if (!byWeapon.has(w)) {
      byWeapon.set(w, { w, pulls: 0, pelletsFired: 0, pelletHits: 0, pullsThatHit: 0, damage: 0, kills: 0, overkill: [], splash: false });
    }
    return byWeapon.get(w);
  };

  // A pull "hit" if any pellet landed before the next pull from the same
  // weapon -- the events are in emission order, so the pellet hits belonging
  // to a pull are exactly those between it and the next one.
  let currentPull = null;
  for (const event of events) {
    if (event.e === "shot") {
      const stats = get(event.w);
      stats.pulls += 1;
      stats.pelletsFired += event.pellets ?? 1;
      if (event.splash) stats.splash = true;
      currentPull = { w: event.w, landed: false };
    } else if (event.e === "hit") {
      const stats = get(event.w);
      stats.pelletHits += 1;
      if (currentPull && currentPull.w === event.w && !currentPull.landed) {
        currentPull.landed = true;
        stats.pullsThatHit += 1;
      }
    } else if (event.e === "damageDealt" && event.w !== null && event.w !== undefined) {
      const stats = get(event.w);
      stats.damage += event.amt;
      if (event.hpAfter < 0) stats.overkill.push(-event.hpAfter);
    } else if (event.e === "kill" && event.w !== null && event.w !== undefined) {
      get(event.w).kills += 1;
    }
  }

  const totalDamage = [...byWeapon.values()].reduce((sum, s) => sum + s.damage, 0);
  const totalKills = [...byWeapon.values()].reduce((sum, s) => sum + s.kills, 0);
  return [...byWeapon.values()]
    .map((s) => ({
      ...s,
      // `null` for a splash weapon rather than a number: a projectile never
      // emits `hit` (it resolves as `damageDealt` from the blast), so the ratio
      // would be a structural zero -- and even with hit events one round can
      // strike several enemies, so pellets-landed-over-pellets-fired is not a
      // rate at all. Judge those on damage and kills instead.
      pelletHitRate: s.splash ? null : s.pelletsFired > 0 ? s.pelletHits / s.pelletsFired : null,
      triggerHitRate: s.splash ? null : s.pulls > 0 ? s.pullsThatHit / s.pulls : null,
      overkill: summarize(s.overkill),
      shareOfDamage: totalDamage > 0 ? s.damage / totalDamage : null,
      shareOfKills: totalKills > 0 ? s.kills / totalKills : null,
    }))
    .sort((a, b) => a.w - b.w);
}

/**
 * Hit rate per weapon per distance bucket — the shape of each weapon's
 * effective range, which is the thing the Cone of Fire actually controls.
 *
 * A pellet that misses produces no `hit` event, so misses are only knowable in
 * aggregate: the denominator is pellets *fired* at the pull's recorded range.
 * A pull with no range (no crosshair target) is excluded rather than bucketed
 * as zero.
 */
export function hitRateByDistance(events) {
  const table = new Map();
  const cell = (w, label) => {
    const key = `${w}|${label}`;
    if (!table.has(key)) table.set(key, { w, bucket: label, fired: 0, hits: 0 });
    return table.get(key);
  };

  let currentPull = null;
  for (const event of events) {
    if (event.e === "shot") {
      currentPull = event.dist === null || event.dist === undefined ? null : { w: event.w, bucket: bucketFor(event.dist).label };
      if (currentPull) cell(event.w, currentPull.bucket).fired += event.pellets ?? 1;
    } else if (event.e === "hit" && event.dist !== null && event.dist !== undefined) {
      cell(event.w, bucketFor(event.dist).label).hits += 1;
    }
  }
  return [...table.values()]
    .map((c) => ({ ...c, rate: c.fired > 0 ? c.hits / c.fired : null }))
    .sort((a, b) => a.w - b.w || DISTANCE_BUCKETS.findIndex((d) => d.label === a.bucket) - DISTANCE_BUCKETS.findIndex((d) => d.label === b.bucket));
}

/**
 * The loot economy, split pre-placed vs dropped — the split the whole design
 * exists to make visible, since pre-placed is a budget the generator controls
 * and dropped is a feedback loop that scales with how much you fight.
 *
 * `relianceRatio` is the share of *collected* loot that came from drops. High
 * means the level is only clearable by engaging enemies the route does not
 * require, which is worth knowing before tuning placement.
 */
export function lootEconomy(events) {
  const dropped = { count: 0, byArch: {}, byKind: {} };
  const collected = { preplaced: 0, drop: 0, byKind: { preplaced: {}, drop: {} } };
  let uncollectedPrePlaced = 0;
  let unrealisedDropsFromAlive = 0;
  const wastedHealthPickups = { total: 0, granted0: 0 };

  for (const event of events) {
    if (event.e === "lootDropped") {
      dropped.count += 1;
      dropped.byArch[event.fromArch] = (dropped.byArch[event.fromArch] ?? 0) + 1;
      dropped.byKind[event.kind] = (dropped.byKind[event.kind] ?? 0) + (event.amount ?? 0);
    } else if (event.e === "lootCollected") {
      collected[event.source] += 1;
      const bucket = collected.byKind[event.source];
      bucket[event.kind] = (bucket[event.kind] ?? 0) + 1;
      if (event.kind === "health") {
        wastedHealthPickups.total += 1;
        if (event.grantedHealth === 0) wastedHealthPickups.granted0 += 1;
      }
    } else if (event.e === "levelEnd") {
      uncollectedPrePlaced += (event.prePlacedUncollected ?? []).length;
      unrealisedDropsFromAlive += (event.enemiesAlive ?? []).length;
    }
  }

  const totalCollected = collected.preplaced + collected.drop;
  return {
    dropped,
    collected,
    relianceRatio: totalCollected > 0 ? collected.drop / totalCollected : null,
    uncollectedPrePlaced,
    unrealisedDropsFromAlive,
    wastedHealthPickups,
  };
}

/**
 * Self-sustain, measured: the damage-worth of loot an archetype actually
 * dropped, divided by the HP it actually cost to kill.
 *
 * Directly comparable to `levelSolver.mjs`'s analytic prediction, because both
 * value ammo through the same `damagePerAmmo` table. That comparison is the
 * point — the solver predicts from the drop tables, this observes what the
 * rolls did, and a gap between them means one of the two models is wrong.
 *
 * `damagePerAmmo` maps an ammo kind to damage per unit for the loadout in
 * question; health and swap are counted separately as effective health rather
 * than folded into a single number.
 */
export function measuredSelfSustain(events, damagePerAmmo) {
  const byArch = {};
  const get = (arch) => (byArch[arch] ??= { kills: 0, hpKilled: 0, dropDamage: 0, dropHealth: 0 });

  for (const event of events) {
    if (event.e === "kill") {
      const stats = get(event.arch);
      stats.kills += 1;
      stats.hpKilled += event.maxHp ?? 0;
    } else if (event.e === "lootDropped") {
      const stats = get(event.fromArch);
      if (AMMO_KINDS.includes(event.kind)) stats.dropDamage += (event.amount ?? 0) * (damagePerAmmo[event.kind] ?? 0);
      else if (event.kind === "health" || event.kind === "swap") stats.dropHealth += event.amount ?? 0;
    }
  }

  for (const stats of Object.values(byArch)) {
    stats.ratio = stats.hpKilled > 0 ? stats.dropDamage / stats.hpKilled : null;
    stats.meanHp = stats.kills > 0 ? stats.hpKilled / stats.kills : null;
  }
  return byArch;
}

/** Time-to-kill per archetype, from the aggro window each `kill` closes
 * inline. `null` aggro times (an enemy killed without ever being recorded as
 * aggroed) are excluded rather than counted as instant. */
export function timeToKillByArchetype(events) {
  const byArch = {};
  for (const event of events) {
    if (event.e !== "kill" || event.aggroAt === null || event.aggroAt === undefined) continue;
    (byArch[event.arch] ??= []).push(event.t - event.aggroAt);
  }
  return Object.fromEntries(Object.entries(byArch).map(([arch, values]) => [arch, summarize(values)]));
}

/** Damage taken by source, and how many runs ended in a death. */
export function survivability(events) {
  const bySource = {};
  let deaths = 0;
  const minHealthSeen = [];
  for (const event of events) {
    if (event.e === "damageTaken") {
      bySource[event.src] = (bySource[event.src] ?? 0) + event.amt;
      minHealthSeen.push(event.healthAfter);
    } else if (event.e === "playerDeath") {
      deaths += 1;
    }
  }
  return { bySource, deaths, healthAfterHits: summarize(minHealthSeen) };
}

/** Per-level pacing, keyed by campaign level. Reads `levelEnd`, which is the
 * only record that knows how a level actually finished. */
export function levelPacing(events) {
  const byLevel = new Map();
  for (const event of events) {
    if (event.e !== "levelEnd") continue;
    if (!byLevel.has(event.lvl)) byLevel.set(event.lvl, { lvl: event.lvl, visits: 0, times: [], kills: [], outcomes: {} });
    const stats = byLevel.get(event.lvl);
    stats.visits += 1;
    stats.times.push(event.t);
    stats.kills.push(event.killCount ?? 0);
    stats.outcomes[event.outcome] = (stats.outcomes[event.outcome] ?? 0) + 1;
  }
  return [...byLevel.values()]
    .map((s) => ({ ...s, time: summarize(s.times), killCount: summarize(s.kills) }))
    .sort((a, b) => a.lvl - b.lvl);
}

/**
 * Which weapon the bot chose, broken down by the target's archetype and the
 * range it fired at.
 *
 * This exists to make weapon-selection a query rather than a hypothesis. Two
 * attempts to get the bot to use ghidra were designed off a synthetic probe of
 * `pickRangedWeapon`, and both produced a null A/B after ~55 minutes each,
 * because the probe supplied an idealised threat that real play rarely
 * presents. The blocking suspicion — that the cluster fast-path refuses a
 * rocket whenever the threat is an Edge Case, and Edge Cases are 62-78% of the
 * roster on the levels in question — is answerable directly from `shot` events
 * once they carry `targetArch`: look at the `>=4` tile rows for `normal` and
 * `elite` targets and see what actually got fired.
 *
 * Shots with no crosshair target are excluded rather than bucketed, same as
 * everywhere else in this module.
 */
export function weaponChoiceByTarget(events, weaponNames = {}) {
  const table = new Map();
  for (const event of events) {
    if (event.e !== "shot") continue;
    if (event.targetArch === null || event.targetArch === undefined) continue;
    if (event.dist === null || event.dist === undefined) continue;
    const bucket = bucketFor(event.dist).label;
    const key = `${event.targetArch}|${bucket}`;
    if (!table.has(key)) table.set(key, { arch: event.targetArch, bucket, total: 0, byWeapon: {} });
    const cell = table.get(key);
    cell.total += 1;
    const name = weaponNames[event.w] ?? `#${event.w}`;
    cell.byWeapon[name] = (cell.byWeapon[name] ?? 0) + 1;
  }
  return [...table.values()].sort(
    (a, b) =>
      a.arch.localeCompare(b.arch) ||
      DISTANCE_BUCKETS.findIndex((d) => d.label === a.bucket) - DISTANCE_BUCKETS.findIndex((d) => d.label === b.bucket),
  );
}

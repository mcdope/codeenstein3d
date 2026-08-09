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

/**
 * HP bands for `killRateByHpBand`. Chosen to straddle the Elite threshold: a
 * pack member at complexity 39 is 244 HP and an Elite at 40 is 2,000, so the
 * bands in between exist precisely to show whether anything is generated there
 * at all. Do not collapse them because they look empty — an empty band *is* the
 * finding.
 */
const HP_BANDS = [
  { label: "<250", max: 250 },
  { label: "250-499", max: 500 },
  { label: "500-999", max: 1000 },
  { label: "1000-1999", max: 2000 },
  { label: "2000-2999", max: 3000 },
  { label: "3000-4999", max: 5000 },
  { label: "5000+", max: Infinity },
];

function hpBandFor(hp) {
  return HP_BANDS.find((b) => hp < b.max) ?? HP_BANDS[HP_BANDS.length - 1];
}

/**
 * How often an enemy of a given size actually dies — spawned vs killed, banded
 * by max HP.
 *
 * This is the metric that settles whether a tough enemy is a hard fight or an
 * unwinnable one, and neither half works alone: a kill count of 0 is
 * meaningless without knowing how many spawned, and a spawn count says nothing
 * about whether the fight is survivable. `levelStart.enemies[]` carries the
 * full roster with `maxHp`, so the denominator is exact rather than inferred.
 *
 * Beware one thing when reading `rate`: an enemy that is never engaged counts
 * as not-killed, so a low rate means "does not die", not "cannot be killed".
 * The <250 band sits at ~26% for exactly that reason — most of the roster is
 * walked past, not fought. The signal is the *contrast* between bands, and
 * `ttk` alongside it: a band that is fought and won has a finite median TTK.
 */
export function killRateByHpBand(events) {
  const bands = new Map(HP_BANDS.map((b) => [b.label, { band: b.label, spawned: 0, killed: 0, ttk: [] }]));
  let maxHpKilled = null;

  for (const event of events) {
    if (event.e === "levelStart") {
      for (const enemy of event.enemies ?? []) bands.get(hpBandFor(enemy.maxHp ?? 0).label).spawned += 1;
    } else if (event.e === "kill") {
      const hp = event.maxHp ?? 0;
      const cell = bands.get(hpBandFor(hp).label);
      cell.killed += 1;
      if (event.aggroAt !== null && event.aggroAt !== undefined) cell.ttk.push(event.t - event.aggroAt);
      if (maxHpKilled === null || hp > maxHpKilled.maxHp) {
        maxHpKilled = { maxHp: hp, arch: event.arch, lvl: event.lvl, difficulty: event.difficulty, w: event.w };
      }
    }
  }

  return {
    bands: [...bands.values()].map((cell) => ({
      band: cell.band,
      spawned: cell.spawned,
      killed: cell.killed,
      rate: cell.spawned > 0 ? cell.killed / cell.spawned : null,
      ttk: summarize(cell.ttk),
    })),
    maxHpKilled,
  };
}

/**
 * Who hurt the player, from `damageTaken.by`.
 *
 * `survivability` answers "what kind of thing hurt me" (`src`); this answers
 * "which enemy". That distinction is what turns "the player died on level 12"
 * into "one Elite dealt 93% of the damage on level 12", which no aggregate over
 * `src` can express.
 *
 * Two schema facts drive the shape here, both from `engine.ts:3939-3946`:
 * `by` is `null` for traps, hazards and splash — those are reported as
 * `unattributed` rather than dropped — and `by[].amt` sums to the *pre*-
 * multiplier total, so it is a set of shares, not magnitudes. Each event's own
 * `amt` is therefore split across its attackers in proportion to their `by`
 * shares; summing `by[].amt` directly would under-report by the multiplier.
 *
 * `eid` is only unique within a (level, run), and a level's roster is stable
 * across runs because the map is generated deterministically — so attackers are
 * keyed `lvl:eid`, which aggregates the same enemy across runs of a level
 * without colliding with the same index on another level.
 */
export function damageTakenByAttacker(events, { topAttackers = 10 } = {}) {
  const byArch = {};
  const byEnemy = new Map();
  let totalAmt = 0;
  let attributedAmt = 0;

  for (const event of events) {
    if (event.e !== "damageTaken") continue;
    const amt = event.amt ?? 0;
    totalAmt += amt;
    const attackers = event.by ?? [];
    if (attackers.length === 0) continue;

    const shareTotal = attackers.reduce((sum, a) => sum + (a.amt ?? 0), 0);
    attributedAmt += amt;
    for (const attacker of attackers) {
      const share = shareTotal > 0 ? (attacker.amt ?? 0) / shareTotal : 1 / attackers.length;
      const dealt = amt * share;

      const arch = (byArch[attacker.arch] ??= { amt: 0, hits: 0 });
      arch.amt += dealt;
      arch.hits += 1;

      const key = `${event.lvl}:${attacker.eid}`;
      if (!byEnemy.has(key)) byEnemy.set(key, { lvl: event.lvl, eid: attacker.eid, arch: attacker.arch, amt: 0, hits: 0 });
      const enemy = byEnemy.get(key);
      enemy.amt += dealt;
      enemy.hits += 1;
    }
  }

  const share = (amt) => (totalAmt > 0 ? amt / totalAmt : null);
  return {
    totalAmt,
    attributedAmt,
    unattributedAmt: totalAmt - attributedAmt,
    byArch: Object.fromEntries(
      Object.entries(byArch)
        .map(([arch, stats]) => [arch, { ...stats, share: share(stats.amt) }])
        .sort((a, b) => b[1].amt - a[1].amt),
    ),
    topAttackers: [...byEnemy.values()]
      .sort((a, b) => b.amt - a.amt)
      .slice(0, topAttackers)
      .map((enemy) => ({ ...enemy, share: share(enemy.amt) })),
  };
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

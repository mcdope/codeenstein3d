// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The offline balance solver: given a generated `GameMap` and the real combat
 * constants, compute a level's enemy budget, loot budget and the ratios
 * between them — with nobody playing it.
 *
 * **Why this exists.** Levels are generated from arbitrary repositories, so no
 * amount of playtesting `demo-campaign/` says whether someone else's repo
 * produces a clearable level. `staticLevelAnalysis.mjs` already counts enemies
 * and pre-placed ammo, but it never reads a weapon constant, so it cannot
 * answer "can this be cleared with the ammo on it". This can. See
 * `doc/dev/balancing-telemetry.md`'s "The balance model" for the full design
 * and the stat catalog each number here belongs to.
 *
 * **Every constant is injected, never mirrored.** The `constants` bag each
 * entry point takes comes from `loadEngineModules()`, i.e. from the real
 * `weapons.ts`/`loot.ts`/`ammo.ts`/`difficulty.ts`. Nothing in this file
 * hardcodes a damage number, a drop amount or a weight — that is the whole
 * point, and `combatPolicy.mjs`'s `ROCKET_TRAVEL_SPEED` (mirrored from the
 * wrong module, wrong by 3.6x, caught by nothing) is why the rule is absolute.
 * Injection also makes every function here unit-testable against fixture
 * constants without an esbuild bundle.
 *
 * **Everything is a perfect-accuracy figure.** The Cone of Fire deviates by
 * `(rng()*2-1) * rangeFraction**3 * maxConeDeviationPx` in *screen pixels*
 * against the per-column z-buffer (`engine.ts`'s `resolveShot`), so real hit
 * probability depends on raycast geometry this solver deliberately does not
 * model. Read the outputs accordingly: a level whose clear ratio is below 1.0
 * here is definitively unclearable, but one above 1.0 is not thereby proven
 * clearable. The failing direction is the trustworthy one.
 */

/** Melee weapons omit `fireIntervalSec`; the engine falls back to this for a
 * melee cooldown (`engine.ts`'s quick-melee branch). Every ranged weapon
 * defines its own, so this only ever applies to the knife. */
const MELEE_FALLBACK_INTERVAL_SEC = 0.15;

/** Loot kinds that convert to damage via a weapon, as opposed to effective
 * health. `weapon` and `key` are neither and are counted separately. */
const AMMO_KINDS = ["bullets", "rockets", "smg", "gas", "shells"];

/** Loot kinds that convert to effective health. `swap` absorbs damage 1:1
 * before health with no reduction curve (`engine.ts`'s `damage`), so one point
 * of swap really is worth one point of health. */
const HEALTH_KINDS = ["health", "swap"];

/**
 * Per-weapon derived numbers: what one trigger-pull costs and delivers.
 *
 * `damagePerTrigger` multiplies by `pellets` for hitscan weapons but not for
 * `isRocket` ones — ghidra fires a single projectile whose `damagePerPellet`
 * is its ground-zero blast damage, and its `pellets: 1` is ignored by the
 * engine anyway. Splash against a group is strictly better than this number,
 * so treating it as single-target is the conservative read.
 *
 * `damagePerAmmo` is `Infinity` for the melee weapons: they draw from no pool,
 * which is exactly what makes them the economy's floor.
 */
export function weaponProfile(weapon, index) {
  const damagePerTrigger = weapon.isRocket ? weapon.damagePerPellet : weapon.damagePerPellet * weapon.pellets;
  const fireIntervalSec = weapon.fireIntervalSec ?? MELEE_FALLBACK_INTERVAL_SEC;
  return {
    index,
    name: weapon.name,
    pool: weapon.ammoType ?? null,
    melee: weapon.meleeRange !== undefined,
    damagePerTrigger,
    fireIntervalSec,
    dps: damagePerTrigger / fireIntervalSec,
    damagePerAmmo: weapon.ammoType ? damagePerTrigger / weapon.ammoPerShot : Infinity,
    ammoPerShot: weapon.ammoPerShot,
    maxRange: weapon.maxRange ?? null,
  };
}

/** `weaponProfile` for every entry in `WEAPONS`, index-aligned. */
export function weaponProfiles(WEAPONS) {
  return WEAPONS.map((w, i) => weaponProfile(w, i));
}

/**
 * The best damage-per-ammo-unit obtainable from each pool, given what the
 * player currently owns — i.e. how much damage one unit of each ammo type is
 * worth to *this* loadout.
 *
 * "Best" rather than "typical" on purpose: this feeds an upper bound on
 * available damage, which pairs with the perfect-accuracy assumption to make
 * the whole clear-ratio an optimistic bound. A ratio below 1.0 under
 * optimistic assumptions is a hard result; that is what the number is for.
 *
 * A pool no owned weapon can spend is worth `0`, not `undefined` — rockets
 * lying on the floor before ghidra is unlocked really are worth nothing right
 * now, and `rollLoot` filters them out of drops for exactly that reason.
 */
export function poolDamageValues(profiles, ownedWeapons) {
  const owned = new Set(ownedWeapons);
  const values = {};
  for (const kind of AMMO_KINDS) values[kind] = 0;
  for (const p of profiles) {
    if (!p.pool || !owned.has(p.index)) continue;
    values[p.pool] = Math.max(values[p.pool] ?? 0, p.damagePerAmmo);
  }
  return values;
}

/**
 * Shots-to-kill and time-to-kill for one weapon against one HP pool.
 *
 * The `- 1` on the interval count is deliberate: N shots have N-1 gaps between
 * them, so a one-shot kill takes no time at all rather than one full cadence.
 * That matters most for ghidra, whose 1.1s cadence would otherwise dominate
 * every TTK it appears in.
 *
 * There is no reload term because there are no magazines — see the stat
 * catalog's "Deliberately excluded".
 */
export function timeToKill(profile, hp) {
  const shots = Math.ceil(hp / profile.damagePerTrigger);
  return {
    shots,
    seconds: Math.max(0, shots - 1) * profile.fireIntervalSec,
    ammo: profile.melee ? 0 : shots * profile.ammoPerShot,
  };
}

/**
 * Expected value of one regular (non-Elite) kill's loot, in damage and
 * effective health.
 *
 * Mirrors the engine's kill handler structurally rather than numerically:
 * health is its own always-on grant (so it is *not* part of the weighted
 * roll — `healthHandledSeparately`), the ammo/swap roll only fires on the
 * `1 - REGULAR_KILL_NO_DROP_CHANCE` share of kills, and the weight table is
 * filtered by ownership before being re-normalised, so an unowned weapon's
 * pool redistributes its share rather than producing dead loot.
 *
 * `playerAtFullHealth` reproduces the engine's own branch: at full health the
 * guaranteed grant is skipped and `health` stays out of the roll regardless.
 */
export function expectedRegularDrop({ constants, ownedWeapons, bonusLevel, difficulty, playerAtFullHealth = false }) {
  const { lootWeightsFor, REGULAR_KILL_NO_DROP_CHANCE, DIFFICULTY_MULTIPLIERS, dropAmounts } = constants;
  const owned = new Set(ownedWeapons);
  const ammoDropRate = DIFFICULTY_MULTIPLIERS[difficulty].ammoDropRate;
  const poolValue = poolDamageValues(constants.profiles, ownedWeapons);

  const usable = lootWeightsFor(bonusLevel, difficulty).filter((w) => {
    if (w.kind === "health") return false; // always excluded: healthHandledSeparately
    if (w.kind === "rockets") return owned.has(constants.GHIDRA_WEAPON_INDEX);
    if (w.kind === "smg") return owned.has(constants.GDB_WEAPON_INDEX);
    if (w.kind === "gas") return owned.has(constants.FRIDAY_HOTFIX_WEAPON_INDEX);
    return true;
  });
  const totalWeight = usable.reduce((sum, w) => sum + w.weight, 0);

  let damage = 0;
  let health = 0;
  if (totalWeight > 0) {
    for (const { kind, weight } of usable) {
      const share = weight / totalWeight;
      const amount = scaledAmount(dropAmounts[kind], ammoDropRate);
      if (AMMO_KINDS.includes(kind)) damage += share * amount * (poolValue[kind] ?? 0);
      else if (HEALTH_KINDS.includes(kind)) health += share * amount;
    }
  }
  const rollHitRate = 1 - REGULAR_KILL_NO_DROP_CHANCE;
  const guaranteedHealth = playerAtFullHealth ? 0 : scaledAmount(dropAmounts.health, ammoDropRate);

  return {
    damage: damage * rollHitRate,
    health: health * rollHitRate + guaranteedHealth,
    rollHitRate,
  };
}

/**
 * Expected value of one Elite kill's loot.
 *
 * Elites never touch `rollLoot` or the miss chance — `dropEliteLoot` is a
 * total branch. Its guaranteed drop is *health* unless the player is already
 * at full, in which case it is a 50/50 between bullets and swap. So an Elite's
 * expected ammo yield is zero for a damaged player, which is the whole reason
 * this is computed separately rather than folded into the regular path.
 */
export function expectedEliteDrop({ constants, ownedWeapons, difficulty, playerAtFullHealth = false }) {
  const { DIFFICULTY_MULTIPLIERS, dropAmounts } = constants;
  const ammoDropRate = DIFFICULTY_MULTIPLIERS[difficulty].ammoDropRate;
  const poolValue = poolDamageValues(constants.profiles, ownedWeapons);

  if (!playerAtFullHealth) {
    return { damage: 0, health: scaledAmount(dropAmounts.eliteHealth, ammoDropRate) };
  }
  const bullets = scaledAmount(dropAmounts.eliteBullets, ammoDropRate) * (poolValue.bullets ?? 0);
  const swap = scaledAmount(dropAmounts.eliteSwap, ammoDropRate);
  return { damage: 0.5 * bullets, health: 0.5 * swap };
}

/** The engine's own pickup scaling: `max(1, round(base * ammoDropRate))`
 * (`engine.ts`'s `scaledLootAmount`). The `max(1, ...)` floor is why Hard's
 * 0.7x leaves `ROCKETS_DROP_AMOUNT` (1) untouched rather than rounding it to
 * zero — a real asymmetry the ratios below would otherwise misstate. */
export function scaledAmount(base, ammoDropRate) {
  return Math.max(1, Math.round(base * ammoDropRate));
}

/** `elite` > `edgeCase` > `normal`, the same precedence `telemetry.ts`'s
 * `enemyCategory` and `staticLevelAnalysis.mjs` already use. */
export function archetypeOf(enemy) {
  return enemy.elite ? "elite" : enemy.edgeCase ? "edgeCase" : "normal";
}

/**
 * Apply difficulty HP scaling the way the engine does, returning a new roster
 * rather than mutating the map's own.
 *
 * The engine rescales `Enemy.hp`/`maxHp` in place immediately after
 * construction (`engine.ts`, right after the map is built) and *then* computes
 * `startingAmmo` from the result — so the starting-bullets formula already
 * sees scaled HP. The solver has to reproduce that order or every difficulty's
 * ratio comes out wrong in the same direction.
 */
export function scaleRosterForDifficulty(enemies, difficulty, DIFFICULTY_MULTIPLIERS) {
  const hpMultiplier = DIFFICULTY_MULTIPLIERS[difficulty].hp;
  return enemies.map((e) => ({
    ...e,
    hp: Math.round(e.hp * hpMultiplier),
    maxHp: Math.round(e.maxHp * hpMultiplier),
  }));
}

/**
 * Damage per second one enemy of an archetype puts out, split by attack.
 *
 * Melee is `ATTACK_DAMAGE / ATTACK_COOLDOWN` at contact, through the
 * archetype's damage multiplier and then the difficulty's — matching
 * `enemyAi.ts`'s `damageMultiplier` and the `damage` multiplier the engine
 * applies to enemy-dealt damage only (traps and self-splash are excluded
 * there, and so are excluded here).
 *
 * **Ranged reads the archetype's own weapon** (`ENEMY_WEAPONS`), not
 * `PROJECTILE_DAMAGE` times a multiplier: each archetype has its own damage
 * *and* its own cooldown window since the weapon table landed, and only the
 * ratio of the two is meaningful. It deliberately does not apply the archetype
 * multiplier again — `weapon.damage` already carries it, and doing both would
 * square it. The difficulty multiplier still applies, because that is engine
 * behaviour applied at damage time rather than a property of the weapon.
 *
 * The table holds each archetype's mean ranged DPS at exactly what the old
 * single-bolt model produced, so this rewrite changes no number today. It will
 * the moment either field is retuned, which is the reason to read the table
 * rather than mirror one constant out of it.
 *
 * `sustained` is melee + ranged, which is the correct read for an enemy in
 * contact: nothing in `enemyAi.ts` stops a melee-range enemy from also taking
 * ranged shots, and the two cooldowns are independent.
 */
export function incomingDps(archetype, constants, difficulty) {
  const C = constants.COMBAT;
  const damageMultiplier =
    archetype === "elite" ? C.ELITE_DAMAGE_MULTIPLIER : archetype === "edgeCase" ? C.EDGE_CASE_DAMAGE_MULTIPLIER : 1;
  const difficultyMultiplier = constants.DIFFICULTY_MULTIPLIERS[difficulty].damage;
  const scale = damageMultiplier * difficultyMultiplier;
  const melee = (C.ATTACK_DAMAGE / C.ATTACK_COOLDOWN) * scale;
  const weapon = C.ENEMY_WEAPONS[archetype] ?? C.ENEMY_WEAPONS.normal;
  const meanFireInterval = (weapon.cooldownMin + weapon.cooldownMax) / 2;
  const ranged = (weapon.damage / meanFireInterval) * difficultyMultiplier;
  return { melee, ranged, sustained: melee + ranged };
}

/**
 * How long the player survives N of an archetype at once, in seconds.
 *
 * Effective HP is `MAX_HEALTH + swap`, because swap absorbs 1:1 before health
 * with no reduction curve — there is no other mitigation in the game, so this
 * is exact rather than a model.
 */
export function survivalWindow(archetype, attackerCount, constants, difficulty, swap = 0) {
  const dps = incomingDps(archetype, constants, difficulty).sustained * attackerCount;
  const effectiveHp = constants.COMBAT.MAX_HEALTH + swap;
  return dps > 0 ? effectiveHp / dps : Infinity;
}

/**
 * A single comparable number per archetype, normalised so a regular enemy is
 * 1.0.
 *
 * `dps × √hp × rangeFactor × speedFactor`. The square root on HP is
 * deliberate: HP and DPS are not interchangeable — doubling an enemy's HP
 * doubles how long it threatens you, but doubling its DPS doubles how much it
 * takes off you per second *and* shortens your window, so a linear HP term
 * would let a damage sponge outrank a genuinely lethal enemy. Range and speed
 * enter linearly against the regular enemy's own values, so they are 1.0 for
 * anything that has not changed them.
 *
 * `hp` is the archetype's mean on the level being scored, so this ranks the
 * enemies actually present rather than the archetype in the abstract.
 */
export function threatScore(archetype, meanHp, constants, difficulty) {
  const C = constants.COMBAT;
  const dps = incomingDps(archetype, constants, difficulty).sustained;
  const speedFactor = archetype === "edgeCase" ? C.EDGE_CASE_SPEED_MULTIPLIER : 1;
  // Nothing varies ranged reach by archetype today, so this is 1.0 across the
  // board -- kept as an explicit term so adding a longer-reaching archetype
  // shows up in the score instead of silently not counting.
  const rangeFactor = C.RANGED_RANGE / C.RANGED_RANGE;
  return dps * Math.sqrt(Math.max(1, meanHp)) * rangeFactor * speedFactor;
}

/** Enemy budget: counts, HP and incoming DPS by archetype. */
export function enemyBudget(roster, constants = null, difficulty = "normal") {
  const byArchetype = {
    normal: { count: 0, hp: 0 },
    elite: { count: 0, hp: 0 },
    edgeCase: { count: 0, hp: 0 },
  };
  for (const e of roster) {
    const a = archetypeOf(e);
    byArchetype[a].count += 1;
    byArchetype[a].hp += e.maxHp;
  }
  let totalDps = null;
  if (constants?.COMBAT) {
    totalDps = 0;
    for (const [archetype, stats] of Object.entries(byArchetype)) {
      const dps = incomingDps(archetype, constants, difficulty).sustained;
      stats.dps = stats.count * dps;
      stats.meanHp = stats.count > 0 ? stats.hp / stats.count : 0;
      stats.threat = stats.count > 0 ? threatScore(archetype, stats.meanHp, constants, difficulty) : null;
      totalDps += stats.dps;
    }
  }
  return {
    totalCount: roster.length,
    totalHp: roster.reduce((sum, e) => sum + e.maxHp, 0),
    byArchetype,
    totalDps,
  };
}

/**
 * Pre-placed loot budget: what the generator actually put on the floor,
 * valued in damage and effective health for the current loadout.
 *
 * `weapon` pickups carry `amount: 0` and are counted, not valued — what a
 * weapon drop is worth depends on ownership at collection time, which is
 * exactly why `pushLootDrop` records them as an occurrence rather than an
 * amount too.
 */
export function prePlacedBudget({ ammoPickups, constants, ownedWeapons, difficulty }) {
  const ammoDropRate = constants.DIFFICULTY_MULTIPLIERS[difficulty].ammoDropRate;
  const poolValue = poolDamageValues(constants.profiles, ownedWeapons);
  const byKind = {};
  let damage = 0;
  let health = 0;
  let weaponPickups = 0;

  for (const pickup of ammoPickups) {
    if (pickup.kind === "weapon") {
      weaponPickups += 1;
      continue;
    }
    const amount = scaledAmount(pickup.amount, ammoDropRate);
    byKind[pickup.kind] = (byKind[pickup.kind] ?? 0) + amount;
    if (AMMO_KINDS.includes(pickup.kind)) damage += amount * (poolValue[pickup.kind] ?? 0);
    else if (HEALTH_KINDS.includes(pickup.kind)) health += amount;
  }
  return { damage, health, byKind, weaponPickups, pickupCount: ammoPickups.length };
}

/** Potential-drop budget: the expected value of killing everything on the
 * level. Deliberately the *whole* roster, not the shortest path's worth — the
 * question it answers is "if you fought everything, what would the level give
 * back", which is the ceiling the reliance ratio is measured against. */
export function dropBudget({ roster, constants, ownedWeapons, bonusLevel, difficulty }) {
  const regular = expectedRegularDrop({ constants, ownedWeapons, bonusLevel, difficulty });
  const elite = expectedEliteDrop({ constants, ownedWeapons, difficulty });
  let damage = 0;
  let health = 0;
  for (const e of roster) {
    const value = archetypeOf(e) === "elite" ? elite : regular;
    damage += value.damage;
    health += value.health;
  }
  return { damage, health, perRegularKill: regular, perEliteKill: elite };
}

/**
 * Self-sustain per archetype: expected damage-worth of one kill's drop divided
 * by the damage that kill costs.
 *
 * Above 1.0 means fighting that archetype is free ammo and the economy has no
 * floor. This is the single most useful number the solver produces, and it is
 * why Edge Cases are worth looking at: they take the regular drop path with no
 * special-casing, so a 12 HP nuisance is valued identically to a 250 HP
 * regular enemy.
 *
 * `null` for an archetype absent from the level — a ratio over an empty set is
 * not zero, and reporting it as zero would read as "terrible" rather than
 * "not present".
 */
export function selfSustainByArchetype({ roster, constants, ownedWeapons, bonusLevel, difficulty }) {
  const regular = expectedRegularDrop({ constants, ownedWeapons, bonusLevel, difficulty });
  const elite = expectedEliteDrop({ constants, ownedWeapons, difficulty });
  const out = {};
  for (const archetype of ["normal", "elite", "edgeCase"]) {
    const members = roster.filter((e) => archetypeOf(e) === archetype);
    if (members.length === 0) {
      out[archetype] = null;
      continue;
    }
    const meanHp = members.reduce((sum, e) => sum + e.maxHp, 0) / members.length;
    const value = archetype === "elite" ? elite : regular;
    out[archetype] = { meanHp, dropDamage: value.damage, ratio: meanHp > 0 ? value.damage / meanHp : null };
  }
  return out;
}

/**
 * Entities whose single-enemy HP exceeds the total damage obtainable on the
 * level — the hard-failure check.
 *
 * This is the check the whole solver exists for. `enemies.ts` maps an Elite's
 * HP as `complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER` with no clamp,
 * cap or normalisation of any kind, so the relationship is linear and
 * unbounded in a number that comes from someone else's source file. A
 * sufficiently tangled function produces an enemy that cannot be killed with
 * every round on the level, and nothing in the generator prevents it.
 */
export function hpOutliers(roster, obtainableDamage) {
  return roster
    .map((e) => ({
      name: e.entity?.name ?? "(unnamed)",
      complexity: e.entity?.complexityScore ?? null,
      archetype: archetypeOf(e),
      maxHp: e.maxHp,
      shareOfObtainable: obtainableDamage > 0 ? e.maxHp / obtainableDamage : Infinity,
      unkillable: e.maxHp > obtainableDamage,
    }))
    .sort((a, b) => b.maxHp - a.maxHp);
}

/**
 * Solve one level.
 *
 * `carriedAmmo` is what the player arrives with. Pass `null` for the first
 * level of a campaign to use the engine's own `startingAmmo(enemies)`; every
 * later level must pass the carried pools, because `createPlayerState` takes
 * carryover over the starting formula from level 2 on. Getting that wrong
 * makes every level after the first read as far poorer than it plays.
 */
export function solveLevel({ map, constants, difficulty, ownedWeapons, carriedAmmo = null, campaignLevelIndex = 1 }) {
  const roster = scaleRosterForDifficulty(map.enemies, difficulty, constants.DIFFICULTY_MULTIPLIERS);
  const bonusLevel = Boolean(map.bonusLevel);
  const poolValue = poolDamageValues(constants.profiles, ownedWeapons);

  const startAmmo = carriedAmmo ?? constants.startingAmmo(roster);
  const carriedDamage = AMMO_KINDS.reduce((sum, kind) => sum + (startAmmo[kind] ?? 0) * (poolValue[kind] ?? 0), 0);

  const enemies = enemyBudget(roster, constants, difficulty);
  const prePlaced = prePlacedBudget({ ammoPickups: map.ammoPickups, constants, ownedWeapons, difficulty });
  const drops = dropBudget({ roster, constants, ownedWeapons, bonusLevel, difficulty });

  const obtainable = carriedDamage + prePlaced.damage + drops.damage;
  const ratio = (damage) => (enemies.totalHp > 0 ? damage / enemies.totalHp : Infinity);

  return {
    campaignLevelIndex,
    bonusLevel,
    difficulty,
    ownedWeapons: [...ownedWeapons],
    enemies,
    carried: { ammo: startAmmo, damage: carriedDamage, fromStartingFormula: carriedAmmo === null },
    prePlaced,
    drops,
    clearRatio: {
      carriedOnly: ratio(carriedDamage),
      prePlacedOnly: ratio(prePlaced.damage),
      dropsOnly: ratio(drops.damage),
      // What the player can actually bring to bear: what they walked in with,
      // plus what is on the floor, plus what the roster gives back.
      combined: ratio(obtainable),
      // Without farming: no drops at all. The generator's own budget, alone.
      withoutFarming: ratio(carriedDamage + prePlaced.damage),
    },
    obtainableDamage: obtainable,
    selfSustain: selfSustainByArchetype({ roster, constants, ownedWeapons, bonusLevel, difficulty }),
    outliers: hpOutliers(roster, obtainable),
    health: { prePlaced: prePlaced.health, drops: drops.health },
    ttk: ttkTable(constants.profiles, roster, ownedWeapons),
    // Against the level's own worst case: everything that can aggro at once is
    // bounded above by the roster, so this is the pessimistic end of the
    // survival window rather than an observed peak.
    survival: constants.COMBAT
      ? {
          vsOneNormal: survivalWindow("normal", 1, constants, difficulty),
          vsThreeNormal: survivalWindow("normal", 3, constants, difficulty),
          vsOneElite: survivalWindow("elite", 1, constants, difficulty),
        }
      : null,
  };
}

/** Per-weapon TTK against each archetype's mean HP on this level, restricted
 * to weapons the player actually owns — a TTK for a locked weapon is not a
 * balance fact about this level. */
export function ttkTable(profiles, roster, ownedWeapons) {
  const owned = new Set(ownedWeapons);
  const out = {};
  for (const archetype of ["normal", "elite", "edgeCase"]) {
    const members = roster.filter((e) => archetypeOf(e) === archetype);
    if (members.length === 0) continue;
    const meanHp = members.reduce((sum, e) => sum + e.maxHp, 0) / members.length;
    out[archetype] = { meanHp, byWeapon: {} };
    for (const p of profiles) {
      if (!owned.has(p.index)) continue;
      out[archetype].byWeapon[p.index] = { name: p.name, ...timeToKill(p, meanHp) };
    }
  }
  return out;
}

/**
 * Which weapons a run is *guaranteed* to own at a given 1-based campaign
 * level: the starting three, plus `main.ts`'s forced-unlock safety net.
 *
 * Deliberately the guaranteed floor, not an expected loadout. Elite bonus
 * drops, secret rooms and the 1% per-kill roll can all unlock things earlier,
 * but none of them is certain, and a solver that assumed the lucky case would
 * understate scarcity exactly where scarcity matters. Toolchain is never
 * included — it has no forced-unlock entry at all, so a run can finish the
 * campaign without it.
 */
export function guaranteedLoadout(campaignLevelIndex, constants) {
  const owned = new Set(constants.STARTING_WEAPONS);
  for (const { level, weaponIndex } of constants.FORCED_UNLOCK_LEVELS) {
    if (campaignLevelIndex >= level) owned.add(weaponIndex);
  }
  return [...owned].sort((a, b) => a - b);
}

/**
 * Solve a whole campaign, carrying ammo forward the way the engine does.
 *
 * `killRate` is the fraction of a level's roster the player is assumed to
 * fight. It drives both the HP they pay and the drops they bank, and getting it
 * wrong silently corrupts every level after the first.
 *
 * **This was a real bug, caught by checking the model against play.** The carry
 * originally excluded drops entirely, on the reasoning that counting them would
 * let the campaign bootstrap itself into a paper surplus. But `clearRatio` adds
 * that level's drops back in — so a level was credited with its own drops while
 * being denied every previous level's, which double-penalises deep levels and
 * compounds down the campaign. On the demo campaign at hard it manufactured a
 * collapse that does not exist: carry-in fell to 0 by level 14 and levels 15 and
 * 17 reported as unclearable at 0.30 and 0.92. Measured against a real 12-level
 * capture, carry-in is *flat* at 5,400–6,800 over the same span. At a measured
 * rate the same levels read 2.53 and 1.79 — tight, not impossible.
 *
 * The default of **0.71** is measured, not chosen: over a 12-level hard capture
 * the bot killed 71% of the roster and collected 99% of what dropped. Pass `1`
 * for a completionist run who clears every level. Note the old model is not
 * reachable by any single value here, because it was not self-consistent: it
 * charged for the whole roster (a kill rate of 1) while banking none of the
 * drops (a rate of 0).
 */
export function solveCampaign({ levels, constants, difficulty, killRate = DEFAULT_KILL_RATE }) {
  const results = [];
  let carried = null;
  for (const [i, level] of levels.entries()) {
    const campaignLevelIndex = i + 1;
    const ownedWeapons = guaranteedLoadout(campaignLevelIndex, constants);
    const solved = solveLevel({ map: level.map, constants, difficulty, ownedWeapons, carriedAmmo: carried, campaignLevelIndex });
    results.push({ ...solved, filename: level.filename });
    carried = carryForward(solved, constants, killRate);
  }
  return results;
}

/**
 * Fraction of a level's roster a route-following player is assumed to fight.
 *
 * It governs both sides of the ledger at once — the HP paid for and the drops
 * banked — because you only get a drop by making the kill. Decoupling them is
 * precisely the bug described on `solveCampaign`.
 *
 * Measured over a 12-level Gamer/hard capture: 790 enemies spawned, 232 left
 * alive (71% killed), and 615 of 624 spawned drops collected (99%). So the
 * binding constraint is how much of the roster gets fought, not how much of
 * what drops gets picked up.
 */
export const DEFAULT_KILL_RATE = 0.71;

/**
 * Ammo left after a level, at perfect accuracy with the most ammo-efficient
 * owned weapon per pool.
 *
 * Spends the HP the player actually fights (`killRate` of the roster —
 * the same fraction whose drops they collect, since you only get a drop by
 * making the kill) and banks that share of the level's drops. Never negative:
 * a pool that runs dry carries zero, and the level's own ratio is what reports
 * that it did. See `solveCampaign` for why the rate matters so much.
 */
export function carryForward(solved, constants, killRate = DEFAULT_KILL_RATE) {
  const poolValue = poolDamageValues(constants.profiles, solved.ownedWeapons);
  const next = {};
  let remainingHp = solved.enemies.totalHp * killRate;
  // Banked as bullets: the pools a drop actually lands in depend on roll order,
  // which this model does not simulate, and bullets is both the commonest drop
  // and the pool every loadout can spend. Overstating bullets slightly against
  // rockets is immaterial to a damage total.
  const bankedDamage = solved.drops.damage * killRate;

  // Pools are drained in `AMMO_TYPES` order — bullets, then rockets, then
  // smg, then gas. The *total* damage carried forward is the same whatever
  // order is used (the level costs a fixed amount of damage and this subtracts
  // it), so this only decides the split across pools. It matters in exactly
  // one case: when the next level unlocks a weapon and re-prices a pool. Fixed
  // order keeps that reproducible, and draining bullets before rockets matches
  // how the reserve is actually spent — rockets are the scarce pool nobody
  // burns first.
  for (const kind of AMMO_KINDS) {
    const gained = Object.entries(solved.prePlaced.byKind)
      .filter(([k]) => k === kind)
      .reduce((sum, [, amount]) => sum + amount, 0);
    const available = (solved.carried.ammo[kind] ?? 0) + gained;
    const value = poolValue[kind] ?? 0;
    if (value <= 0 || remainingHp <= 0) {
      next[kind] = available;
      continue;
    }
    const unitsNeeded = remainingHp / value;
    const spent = Math.min(available, unitsNeeded);
    remainingHp -= spent * value;
    next[kind] = available - spent;
  }
  if (bankedDamage > 0 && (poolValue.bullets ?? 0) > 0) {
    next.bullets = (next.bullets ?? 0) + bankedDamage / poolValue.bullets;
  }
  return next;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Pins the bot's hand-maintained mirrors of engine constants against the real
 * `src/` modules.
 *
 * **Why this exists.** `src/` cannot import from `scripts/`, and
 * `combatPolicy.mjs` is deliberately kept liftable back into
 * `src/engine/combatPolicy.ts` as the basis of an in-game deathmatch opponent
 * — so it mirrors the weapon table and a set of engine scalars as plain
 * literals rather than importing them. `doc/dev/adding-a-weapon.md` has warned
 * since it was written that "nothing links the two, and nothing fails when
 * they drift".
 *
 * That warning came true. `ROCKET_TRAVEL_SPEED` was 5, mirroring
 * `PROJECTILE_SPEED` — the *enemy bolt's* speed — while being used to model
 * the flight time of the player's own ghidra rocket, which travels at 18. The
 * bot was out by 3.6x for however long that stood, and nothing in the build
 * could notice, because a mirror with no link is exactly as correct as
 * whoever last typed it.
 *
 * The mirror stays (the liftability argument is real). What changes is that it
 * is now *pinned*: this file imports both sides and asserts they agree, so a
 * future divergence is a red test rather than a silent behavioural bug. Adding
 * a weapon or retuning one will fail here until the mirror is updated, which
 * is the entire point — see `doc/dev/adding-a-weapon.md`'s checklist.
 *
 * Vitest resolves the `.ts` imports below through Vite's transform, so a
 * plain-`.mjs` test can read the real TypeScript modules directly. `scripts/**`
 * is excluded from the `src/` coverage denominator but is still executed by
 * `vitest run`, so this runs in CI.
 */
import { describe, expect, it } from "vitest";

import {
  ATTACK_DAMAGE,
  EDGE_CASE_DAMAGE_MULTIPLIER,
  EDGE_CASE_SPEED_MULTIPLIER,
  ELITE_DAMAGE_MULTIPLIER,
  MOVEMENT_SPEED,
  PROJECTILE_SPEED,
  ROCKET_ENEMY_TRIGGER_RADIUS,
  ROCKET_SPEED,
} from "../../src/engine/combatConstants";
import { MINE_BLAST_RADIUS } from "../../src/engine/traps";
import {
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  KNIFE_WEAPON_INDEX,
  PISTOL_WEAPON_INDEX,
  SHOTGUN_WEAPON_INDEX,
  TOOLCHAIN_WEAPON_INDEX,
  WEAPONS,
} from "../../src/engine/weapons";
import { DEFAULT_TUNING, MELEE_WEAPON_STATS, WEAPON_STATS } from "./combatPolicy.mjs";

describe("engine scalars mirrored in DEFAULT_TUNING", () => {
  it.each([
    ["ENGINE_MOVE_SPEED", 3.2, "engine.ts MOVE_SPEED"],
    ["ENGINE_SPRINT_MULTIPLIER", 2.0, "engine.ts SPRINT_MULTIPLIER"],
    ["ENGINE_ROT_SPEED", 2.6, "engine.ts ROT_SPEED"],
  ])("%s matches %s", (key, expected) => {
    // engine.ts cannot be imported here -- it is the whole game, DOM and all --
    // so these three are pinned against the literal instead. Weaker than the
    // imports below, but it still fails loudly if someone retunes one side.
    expect(DEFAULT_TUNING[key]).toBe(expected);
  });

  it("models the player's own rocket at the player's rocket speed, not the enemy bolt's", () => {
    // The regression this whole file exists for. Both assertions matter: the
    // first is the fix, the second is what makes the mistake possible, and
    // asserting they differ documents that mirroring the other one is wrong.
    expect(DEFAULT_TUNING.ROCKET_TRAVEL_SPEED).toBe(ROCKET_SPEED);
    expect(PROJECTILE_SPEED).not.toBe(ROCKET_SPEED);
  });

  it("mirrors the enemy bolt speed separately and correctly", () => {
    expect(DEFAULT_TUNING.PROJECTILE_SPEED).toBe(PROJECTILE_SPEED);
  });

  it("mirrors enemy chase speeds, including the pre-multiplied Edge Case one", () => {
    expect(DEFAULT_TUNING.ENEMY_CHASE_SPEED).toBe(MOVEMENT_SPEED);
    expect(DEFAULT_TUNING.EDGE_CASE_CHASE_SPEED).toBeCloseTo(MOVEMENT_SPEED * EDGE_CASE_SPEED_MULTIPLIER, 10);
  });

  it("mirrors the hazard radii the bot navigates around", () => {
    expect(DEFAULT_TUNING.MINE_BLAST_RADIUS).toBe(MINE_BLAST_RADIUS);
    expect(DEFAULT_TUNING.ROCKET_ENEMY_TRIGGER_RADIUS).toBe(ROCKET_ENEMY_TRIGGER_RADIUS);
  });

  it("mirrors Friday Hotfix's hard range limit from the weapon that owns it", () => {
    expect(DEFAULT_TUNING.FRIDAY_HOTFIX_MAX_RANGE).toBe(WEAPONS[FRIDAY_HOTFIX_WEAPON_INDEX].maxRange);
  });

  it("mirrors melee reach from the weapon table", () => {
    expect(DEFAULT_TUNING.MELEE_RANGE).toBe(WEAPONS[KNIFE_WEAPON_INDEX].meleeRange);
  });
});

describe("WEAPON_STATS mirrors the real ranged weapons", () => {
  const RANGED = [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX];

  it.each(RANGED)("weapon %i agrees on damage, pellets and ammo cost", (index) => {
    const engine = WEAPONS[index];
    const mirror = WEAPON_STATS[index];
    expect(mirror, `WEAPON_STATS has no entry for weapon ${index} (${engine.name})`).toBeDefined();
    expect(mirror.damagePerPellet).toBe(engine.damagePerPellet);
    expect(mirror.pellets).toBe(engine.pellets);
    expect(mirror.ammoPerShot).toBe(engine.ammoPerShot);
  });

  it.each(RANGED)("weapon %i agrees on which pool it draws from", (index) => {
    // Was not asserted until the shotgun moved off the shared `bullets` pool.
    // Nothing else links the two tables, and the failure is silent in the
    // worst way: `hasAmmoFor` reads this field, so a stale copy makes the bot
    // believe it can fire a weapon whose real pool is empty — or refuse to
    // fire one that is full.
    expect(WEAPON_STATS[index].ammoType).toBe(WEAPONS[index].ammoType);
  });

  it("covers every ranged weapon, so a newly added one cannot be silently ignored", () => {
    const rangedIndices = WEAPONS.map((w, i) => (w.meleeRange === undefined ? i : null)).filter((i) => i !== null);
    expect(Object.keys(WEAPON_STATS).map(Number).sort((a, b) => a - b)).toEqual(rangedIndices);
  });
});

describe("MELEE_WEAPON_STATS mirrors the real melee weapons", () => {
  it.each([KNIFE_WEAPON_INDEX, TOOLCHAIN_WEAPON_INDEX])("weapon %i agrees on damage", (index) => {
    expect(MELEE_WEAPON_STATS[index].damagePerPellet).toBe(WEAPONS[index].damagePerPellet);
  });

  it("covers every melee weapon", () => {
    const meleeIndices = WEAPONS.map((w, i) => (w.meleeRange !== undefined ? i : null)).filter((i) => i !== null);
    expect(Object.keys(MELEE_WEAPON_STATS).map(Number).sort((a, b) => a - b)).toEqual(meleeIndices);
  });
});

describe("archetype damage multipliers the bot reasons about", () => {
  it("keeps the Elite and Edge Case damage multipliers as the engine defines them", () => {
    // Not mirrored in DEFAULT_TUNING today; asserted so that if someone adds a
    // mirror later it starts out agreeing, and so the values are visible here
    // alongside the speeds that are mirrored.
    expect(ELITE_DAMAGE_MULTIPLIER).toBe(2);
    expect(EDGE_CASE_DAMAGE_MULTIPLIER).toBe(0.4);
    expect(ATTACK_DAMAGE).toBe(10);
  });
});

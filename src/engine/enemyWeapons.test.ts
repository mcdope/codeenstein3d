// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The claim `ENEMY_WEAPONS` is built around, asserted rather than asserted-in-prose:
 * **every archetype's mean ranged DPS is exactly what it was before the table
 * existed.**
 *
 * Before, one bolt existed and the archetype was a multiplier on its damage:
 *
 *     dps = PROJECTILE_DAMAGE * archetypeMultiplier / mean(FIRE_COOLDOWN_MIN..MAX)
 *
 * The table gives each archetype its own damage *and* its own cooldown window,
 * and the pairs are chosen so that ratio is unchanged — Elite doubles both,
 * Edge Case halves both. That is the whole reason this change can be read as a
 * texture change: three prior A/Bs left total damage taken invariant while
 * redistributing it, so a table that also moved the mean would be
 * indistinguishable from that history.
 *
 * If a future retune *intends* to move a DPS, this test is what it has to
 * argue with — update it deliberately, with a number, rather than deleting it.
 */
import { describe, expect, it } from "vitest";
import {
  EDGE_CASE_DAMAGE_MULTIPLIER,
  ELITE_DAMAGE_MULTIPLIER,
  ENEMY_WEAPONS,
  FIRE_COOLDOWN_MAX,
  FIRE_COOLDOWN_MIN,
  PROJECTILE_DAMAGE,
  PROJECTILE_RADIUS,
  PROJECTILE_SPEED,
  type EnemyArchetype,
  type EnemyWeapon,
} from "./combatConstants";

const meanCooldown = (w: EnemyWeapon) => (w.cooldownMin + w.cooldownMax) / 2;
const rangedDps = (w: EnemyWeapon) => w.damage / meanCooldown(w);

/** What the pre-table model produced, spelled out rather than imported, so
 * this is a genuine second opinion and not the same expression twice. */
const LEGACY_MEAN_COOLDOWN = (FIRE_COOLDOWN_MIN + FIRE_COOLDOWN_MAX) / 2;
const legacyDps = (archetypeMultiplier: number) => (PROJECTILE_DAMAGE * archetypeMultiplier) / LEGACY_MEAN_COOLDOWN;

describe("ENEMY_WEAPONS holds mean ranged DPS exactly where it was", () => {
  it.each([
    ["normal", 1],
    ["elite", ELITE_DAMAGE_MULTIPLIER],
    ["edgeCase", EDGE_CASE_DAMAGE_MULTIPLIER],
  ] as const)("%s", (archetype, multiplier) => {
    expect(rangedDps(ENEMY_WEAPONS[archetype as EnemyArchetype])).toBeCloseTo(legacyDps(multiplier), 10);
  });

  it("does so by moving both terms, not by leaving the weapons identical", () => {
    // Guards the vacuous pass: three identical weapons would satisfy every
    // equality above for `normal` and fail the others, but a careless "fix"
    // that reverted the table to one shared bolt should be caught explicitly.
    const damages = new Set(Object.values(ENEMY_WEAPONS).map((w) => w.damage));
    const cooldowns = new Set(Object.values(ENEMY_WEAPONS).map((w) => meanCooldown(w)));
    expect(damages.size).toBe(3);
    expect(cooldowns.size).toBe(3);
  });
});

describe("ENEMY_WEAPONS is internally consistent", () => {
  it("stores each weapon under its own archetype", () => {
    for (const [key, weapon] of Object.entries(ENEMY_WEAPONS)) {
      expect(weapon.archetype, `ENEMY_WEAPONS.${key}`).toBe(key);
    }
  });

  it("leaves the normal archetype byte-identical to the old single bolt", () => {
    // The baseline the other two are defined against — if this drifts, the
    // legacy comparison above stops meaning anything.
    expect(ENEMY_WEAPONS.normal.speed).toBe(PROJECTILE_SPEED);
    expect(ENEMY_WEAPONS.normal.damage).toBe(PROJECTILE_DAMAGE);
    expect(ENEMY_WEAPONS.normal.radius).toBe(PROJECTILE_RADIUS);
    expect(ENEMY_WEAPONS.normal.cooldownMin).toBe(FIRE_COOLDOWN_MIN);
    expect(ENEMY_WEAPONS.normal.cooldownMax).toBe(FIRE_COOLDOWN_MAX);
    expect(ENEMY_WEAPONS.normal.spreadDeg).toBe(0);
  });

  it("keeps collision size uniform, which is what the DPS invariant rests on", () => {
    // A wider bolt connects more often, so a per-archetype radius would move
    // effective DPS without touching either term the tests above compare.
    // Deliberately deferred — see ENEMY_WEAPONS' doc comment. This is the
    // assertion that has to be changed if that budget is ever spent.
    const radii = new Set(Object.values(ENEMY_WEAPONS).map((w) => w.radius));
    expect(radii).toEqual(new Set([PROJECTILE_RADIUS]));
  });

  it("gives every archetype a positive, finite weapon", () => {
    for (const [key, w] of Object.entries(ENEMY_WEAPONS)) {
      expect(w.speed, key).toBeGreaterThan(0);
      expect(w.damage, key).toBeGreaterThan(0);
      expect(w.radius, key).toBeGreaterThan(0);
      expect(w.cooldownMin, key).toBeGreaterThan(0);
      expect(w.cooldownMax, key).toBeGreaterThanOrEqual(w.cooldownMin);
      expect(w.spreadDeg, key).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives each archetype a visually distinct bolt", () => {
    const cores = new Set(Object.values(ENEMY_WEAPONS).map((w) => w.palette.core));
    expect(cores.size).toBe(3);
  });
});

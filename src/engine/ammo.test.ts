// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { Enemy } from "../map/types";
import { AMMO_META, AMMO_TYPES, startingAmmo } from "./ammo";
import {
  BULLETS_DROP_AMOUNT,
  ELITE_BULLETS_DROP_AMOUNT,
  ELITE_GAS_DROP_AMOUNT,
  ELITE_ROCKETS_DROP_AMOUNT,
  ELITE_SMG_DROP_AMOUNT,
  GAS_DROP_AMOUNT,
  ROCKETS_DROP_AMOUNT,
  SMG_DROP_AMOUNT,
} from "./loot";
import { WEAPONS } from "./weapons";

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 1,
    y: 1,
    hp: 25,
    maxHp: 25,
    alive: true,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 1, h: 1 },
    aggroed: false,
    discovered: false,
    roamX: 1,
    roamY: 1,
    fireCooldown: 0,
    entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

describe("AMMO_TYPES", () => {
  it("is the fixed 4-pool order", () => {
    expect(AMMO_TYPES).toEqual(["bullets", "rockets", "smg", "gas"]);
  });
});

describe("AMMO_META", () => {
  it("has metadata for every pool, matching loot.ts's real drop constants", () => {
    expect(AMMO_META.bullets).toEqual({
      label: "bullets",
      logColor: "#3fd0e0",
      dropAmount: BULLETS_DROP_AMOUNT,
      eliteTopUp: ELITE_BULLETS_DROP_AMOUNT,
    });
    expect(AMMO_META.rockets).toEqual({
      label: "rockets",
      logColor: "#ff9d3f",
      dropAmount: ROCKETS_DROP_AMOUNT,
      eliteTopUp: ELITE_ROCKETS_DROP_AMOUNT,
    });
    expect(AMMO_META.smg).toEqual({
      label: "smg ammo",
      logColor: "#3fa9ff",
      dropAmount: SMG_DROP_AMOUNT,
      eliteTopUp: ELITE_SMG_DROP_AMOUNT,
    });
    expect(AMMO_META.gas).toEqual({
      label: "gas",
      logColor: "#ff5a1a",
      dropAmount: GAS_DROP_AMOUNT,
      eliteTopUp: ELITE_GAS_DROP_AMOUNT,
    });
  });
});

describe("startingAmmo", () => {
  it("gives flat starting reserves for rockets/smg/gas regardless of enemies", () => {
    const ammo = startingAmmo([]);
    expect(ammo.rockets).toBe(4);
    expect(ammo.smg).toBe(40);
    expect(ammo.gas).toBe(40);
  });

  it("floors bullets at 28 for zero (or very weak) enemies", () => {
    expect(startingAmmo([]).bullets).toBe(28);
  });

  it("scales bullets with total enemy HP and count", () => {
    const enemies = [enemy({ maxHp: 100 }), enemy({ maxHp: 50 })];
    const pistolDamage = WEAPONS[0].damagePerPellet;
    const shotsToClear = Math.ceil(100 / pistolDamage) + Math.ceil(50 / pistolDamage);
    const missBuffer = enemies.length * 2.5;
    const expected = Math.max(28, Math.round(shotsToClear * 1.7 + missBuffer) + 10);
    expect(startingAmmo(enemies).bullets).toBe(expected);
  });

  it("increases bullets for a larger, tougher pack", () => {
    const small = startingAmmo([enemy({ maxHp: 25 })]);
    const big = startingAmmo(Array.from({ length: 10 }, () => enemy({ maxHp: 200 })));
    expect(big.bullets).toBeGreaterThan(small.bullets);
  });
});

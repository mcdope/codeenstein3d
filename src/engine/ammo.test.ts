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
  ELITE_SHELLS_DROP_AMOUNT,
  ELITE_SMG_DROP_AMOUNT,
  GAS_DROP_AMOUNT,
  ROCKETS_DROP_AMOUNT,
  SHELLS_DROP_AMOUNT,
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
  it("is the fixed pool order, with shells appended rather than inserted", () => {
    // `shells` reads out of place next to `bullets` on purpose: this order
    // decides the sequence a disconnecting player's inventory is converted
    // into drops, so a new pool goes on the end. See AMMO_TYPES' doc comment.
    expect(AMMO_TYPES).toEqual(["bullets", "rockets", "smg", "gas", "shells"]);
  });
});

describe("AMMO_META", () => {
  it("gives every pool a short name that fits the status bar's fixed column", () => {
    // The table's rows sit under a big numeral in a fixed-width panel, exactly
    // as DOOM's BULL/SHEL/RCKT/CELL do. `label.toUpperCase()` cannot serve —
    // "smg ammo" is nine characters — which is why `short` is stored beside
    // `label` rather than derived from it at draw time.
    for (const type of AMMO_TYPES) {
      expect(AMMO_META[type].short.length, type).toBeLessThanOrEqual(4);
      expect(AMMO_META[type].short, type).toBe(AMMO_META[type].short.toUpperCase());
    }
    // Distinct, or two rows would read identically.
    const shorts = AMMO_TYPES.map((t) => AMMO_META[t].short);
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it("has metadata for every pool, matching loot.ts's real drop constants", () => {
    expect(AMMO_META.bullets).toEqual({
      label: "bullets",
      short: "BULL",
      logColor: "#3fd0e0",
      hudColor: "#4cff6a",
      dropAmount: BULLETS_DROP_AMOUNT,
      eliteTopUp: ELITE_BULLETS_DROP_AMOUNT,
    });
    expect(AMMO_META.shells).toEqual({
      label: "shells",
      short: "SHEL",
      logColor: "#ffb547",
      hudColor: "#ffb547",
      dropAmount: SHELLS_DROP_AMOUNT,
      eliteTopUp: ELITE_SHELLS_DROP_AMOUNT,
    });
    expect(AMMO_META.rockets).toEqual({
      label: "rockets",
      short: "RCKT",
      logColor: "#ff9d3f",
      hudColor: "#ff9d3f",
      dropAmount: ROCKETS_DROP_AMOUNT,
      eliteTopUp: ELITE_ROCKETS_DROP_AMOUNT,
    });
    expect(AMMO_META.smg).toEqual({
      label: "smg ammo",
      short: "SMG",
      logColor: "#3fa9ff",
      hudColor: "#3fa9ff",
      dropAmount: SMG_DROP_AMOUNT,
      eliteTopUp: ELITE_SMG_DROP_AMOUNT,
    });
    expect(AMMO_META.gas).toEqual({
      label: "gas",
      short: "GAS",
      logColor: "#ff5a1a",
      hudColor: "#ff8a4a",
      dropAmount: GAS_DROP_AMOUNT,
      eliteTopUp: ELITE_GAS_DROP_AMOUNT,
    });
  });
});

describe("startingAmmo", () => {
  it("gives flat starting reserves for shells/rockets/smg/gas regardless of enemies", () => {
    const ammo = startingAmmo([]);
    expect(ammo.shells).toBe(12);
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

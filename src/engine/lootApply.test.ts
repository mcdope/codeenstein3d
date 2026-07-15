// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it, vi } from "vitest";
import type { Enemy, LootDrop } from "../map/types";
import { applyLootDrop, dropEliteLoot, grantOrTopUpWeapon, rollMissChanceToolchain, type LootContext } from "./lootApply";
import { TOOLCHAIN_MIN_LEVEL, TOOLCHAIN_WEAPON_INDEX, UNLOCKABLE_WEAPONS } from "./weapons";

function fakeContext(overrides: Partial<LootContext> = {}): LootContext {
  return {
    ammo: { bullets: 0, rockets: 0, smg: 0, gas: 0 },
    scaledAmount: (base) => base,
    heal: vi.fn(),
    addSwap: vi.fn(),
    healthAtMax: () => false,
    ownedWeapons: new Set([0, 1, 2]),
    equip: vi.fn(),
    pushDrop: vi.fn(),
    rng: () => 0,
    campaignLevelIndex: 1,
    ...overrides,
  };
}

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 5,
    y: 5,
    hp: 0,
    maxHp: 100,
    alive: false,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 1, h: 1 },
    aggroed: false,
    discovered: false,
    roamX: 5,
    roamY: 5,
    fireCooldown: 0,
    entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 1, nestingDepth: 0 },
    elite: true,
    edgeCase: false,
    ...overrides,
  };
}

describe("applyLootDrop", () => {
  it("grants a still-unowned weapon for a 'weapon' drop", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "weapon", weaponIndex: 3 }, ctx);
    expect(ctx.ownedWeapons.has(3)).toBe(true);
  });

  it("does nothing for a 'weapon' drop with no weaponIndex", () => {
    const ctx = fakeContext();
    const before = new Set(ctx.ownedWeapons);
    applyLootDrop({ x: 0, y: 0, kind: "weapon" }, ctx);
    expect(ctx.ownedWeapons).toEqual(before);
  });

  it("heals for a 'health' drop, using scaledAmount and the drop's own amount", () => {
    const ctx = fakeContext({ scaledAmount: (b) => b * 2 });
    applyLootDrop({ x: 0, y: 0, kind: "health", amount: 10 }, ctx);
    expect(ctx.heal).toHaveBeenCalledWith(20);
  });

  it("heals with the default HEALTH_DROP_AMOUNT when the drop has no amount", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "health" } as LootDrop, ctx);
    expect(ctx.heal).toHaveBeenCalledWith(14); // HEALTH_DROP_AMOUNT
  });

  it("adds swap for a 'swap' drop", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "swap", amount: 7 }, ctx);
    expect(ctx.addSwap).toHaveBeenCalledWith(7);
  });

  it("adds swap with the default SWAP_DROP_AMOUNT when unspecified", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "swap" } as LootDrop, ctx);
    expect(ctx.addSwap).toHaveBeenCalledWith(11); // SWAP_DROP_AMOUNT
  });

  it("reports a swap drop via recordApplied when it's provided", () => {
    const recordApplied = vi.fn();
    const ctx = fakeContext({ recordApplied });
    applyLootDrop({ x: 0, y: 0, kind: "swap", amount: 7 }, ctx);
    expect(recordApplied).toHaveBeenCalledWith("swap", 7, "dynamic");
  });

  it("adds to the matching ammo pool for an ammo-kind drop", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "bullets", amount: 9 }, ctx);
    expect(ctx.ammo.bullets).toBe(9);
  });

  it("uses the pool's default drop amount when the drop's own amount is unspecified", () => {
    const ctx = fakeContext();
    applyLootDrop({ x: 0, y: 0, kind: "rockets" } as LootDrop, ctx);
    expect(ctx.ammo.rockets).toBe(1); // ROCKETS_DROP_AMOUNT
  });
});

describe("grantOrTopUpWeapon", () => {
  it("grants and equips a still-unowned ranged weapon", () => {
    const ctx = fakeContext();
    grantOrTopUpWeapon(3, ctx); // gdb, ranged
    expect(ctx.ownedWeapons.has(3)).toBe(true);
    expect(ctx.equip).toHaveBeenCalledWith(3);
  });

  it("grants but does not equip a melee weapon (Toolchain)", () => {
    const ctx = fakeContext();
    grantOrTopUpWeapon(TOOLCHAIN_WEAPON_INDEX, ctx);
    expect(ctx.ownedWeapons.has(TOOLCHAIN_WEAPON_INDEX)).toBe(true);
    expect(ctx.equip).not.toHaveBeenCalled();
  });

  it("tops up ammo when the weapon is already owned", () => {
    const ctx = fakeContext({ ownedWeapons: new Set([0, 1, 2, 3]) });
    grantOrTopUpWeapon(3, ctx); // gdb -> smg pool
    expect(ctx.ammo.smg).toBeGreaterThan(0);
    expect(ctx.equip).not.toHaveBeenCalled();
  });

  it("reports the top-up amount via recordApplied when the weapon is already owned", () => {
    const recordApplied = vi.fn();
    const ctx = fakeContext({ ownedWeapons: new Set([0, 1, 2, 3]), recordApplied });
    grantOrTopUpWeapon(3, ctx, "static"); // gdb -> smg pool
    expect(recordApplied).toHaveBeenCalledWith("smg", ctx.ammo.smg, "static");
  });

  it("does nothing for an already-owned ammo-less (melee) duplicate", () => {
    const ctx = fakeContext({ ownedWeapons: new Set([0, 1, 2]) }); // knife (index 2) already owned
    const before = { ...ctx.ammo };
    grantOrTopUpWeapon(2, ctx);
    expect(ctx.ammo).toEqual(before);
    expect(ctx.equip).not.toHaveBeenCalled();
  });
});

describe("dropEliteLoot", () => {
  it("drops health when the player isn't at full stability", () => {
    const ctx = fakeContext({ healthAtMax: () => false });
    dropEliteLoot(enemy(), ctx);
    expect(ctx.pushDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "health", amount: 50 }));
  });

  it("drops bullets or swap instead when the player is at full stability", () => {
    const ctx = fakeContext({ healthAtMax: () => true, rng: () => 0 });
    dropEliteLoot(enemy(), ctx);
    expect(ctx.pushDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "bullets" }));
  });

  it("drops swap (not bullets) at full stability when the coin flip lands the other way", () => {
    const ctx = fakeContext({ healthAtMax: () => true, rng: () => 0.99 });
    dropEliteLoot(enemy(), ctx);
    expect(ctx.pushDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "swap" }));
  });

  it("can also drop a bonus unlockable weapon on top of the guaranteed drop", () => {
    const ctx = fakeContext({ ownedWeapons: new Set([0, 1, 2]), rng: () => 0 });
    dropEliteLoot(enemy(), ctx);
    const calls = (ctx.pushDrop as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([drop]) => drop.kind === "weapon")).toBe(true);
  });

  it("never drops a bonus weapon once every unlockable is already owned (below Toolchain's level floor)", () => {
    const ctx = fakeContext({
      ownedWeapons: new Set([0, 1, 2, ...UNLOCKABLE_WEAPONS]),
      campaignLevelIndex: TOOLCHAIN_MIN_LEVEL - 1,
      rng: () => 0,
    });
    dropEliteLoot(enemy(), ctx);
    const calls = (ctx.pushDrop as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([drop]) => drop.kind === "weapon")).toBe(false);
  });

  it("includes Toolchain as a bonus-drop candidate once the level floor is reached", () => {
    const ctx = fakeContext({
      ownedWeapons: new Set([0, 1, 2, ...UNLOCKABLE_WEAPONS]),
      campaignLevelIndex: TOOLCHAIN_MIN_LEVEL,
      rng: () => 0,
    });
    dropEliteLoot(enemy(), ctx);
    const calls = (ctx.pushDrop as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([drop]) => drop.kind === "weapon" && drop.weaponIndex === TOOLCHAIN_WEAPON_INDEX)).toBe(true);
  });

  it("does not offer Toolchain again once it's already owned", () => {
    const ctx = fakeContext({
      ownedWeapons: new Set([0, 1, 2, ...UNLOCKABLE_WEAPONS, TOOLCHAIN_WEAPON_INDEX]),
      campaignLevelIndex: TOOLCHAIN_MIN_LEVEL,
      rng: () => 0,
    });
    dropEliteLoot(enemy(), ctx);
    const calls = (ctx.pushDrop as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([drop]) => drop.kind === "weapon")).toBe(false);
  });
});

describe("rollMissChanceToolchain", () => {
  it("returns false below Toolchain's level floor, regardless of the roll", () => {
    const ctx = fakeContext({ campaignLevelIndex: TOOLCHAIN_MIN_LEVEL - 1, rng: () => 0 });
    expect(rollMissChanceToolchain(ctx)).toBe(false);
  });

  it("returns false once Toolchain is already owned, regardless of the roll", () => {
    const ctx = fakeContext({
      campaignLevelIndex: TOOLCHAIN_MIN_LEVEL,
      ownedWeapons: new Set([0, 1, 2, TOOLCHAIN_WEAPON_INDEX]),
      rng: () => 0,
    });
    expect(rollMissChanceToolchain(ctx)).toBe(false);
  });

  it("returns true when eligible and the roll hits", () => {
    const ctx = fakeContext({ campaignLevelIndex: TOOLCHAIN_MIN_LEVEL, rng: () => 0 });
    expect(rollMissChanceToolchain(ctx)).toBe(true);
  });

  it("returns false when eligible but the roll misses", () => {
    const ctx = fakeContext({ campaignLevelIndex: TOOLCHAIN_MIN_LEVEL, rng: () => 0.99 });
    expect(rollMissChanceToolchain(ctx)).toBe(false);
  });
});

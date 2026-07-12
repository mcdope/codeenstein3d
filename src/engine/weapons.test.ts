// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  currentMeleeWeapon,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  MELEE_WEAPON,
  NUMBER_KEY_WEAPONS,
  pelletOffsets,
  STARTING_WEAPONS,
  TOOLCHAIN_MIN_LEVEL,
  TOOLCHAIN_WEAPON_INDEX,
  UNLOCKABLE_WEAPONS,
  WEAPONS,
} from "./weapons";

describe("WEAPONS data", () => {
  it("is a nonempty array of weapons with distinct names", () => {
    expect(WEAPONS.length).toBeGreaterThan(0);
    const names = WEAPONS.map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("named index constants point at the weapon they claim to", () => {
    expect(WEAPONS[GDB_WEAPON_INDEX].name).toBe("gdb");
    expect(WEAPONS[GHIDRA_WEAPON_INDEX].name).toBe("ghidra");
    expect(WEAPONS[FRIDAY_HOTFIX_WEAPON_INDEX].name).toBe("Friday Hotfix");
    expect(WEAPONS[TOOLCHAIN_WEAPON_INDEX].name).toBe("Toolchain");
  });

  it("STARTING_WEAPONS covers pistol/shotgun/knife and nothing unlockable", () => {
    expect(STARTING_WEAPONS).toEqual([0, 1, 2]);
    for (const i of STARTING_WEAPONS) expect(UNLOCKABLE_WEAPONS).not.toContain(i);
  });

  it("UNLOCKABLE_WEAPONS is exactly gdb/ghidra/Friday Hotfix, never Toolchain", () => {
    expect(UNLOCKABLE_WEAPONS).toEqual([GDB_WEAPON_INDEX, GHIDRA_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX]);
    expect(UNLOCKABLE_WEAPONS).not.toContain(TOOLCHAIN_WEAPON_INDEX);
  });

  it("TOOLCHAIN_MIN_LEVEL is a positive campaign level", () => {
    expect(TOOLCHAIN_MIN_LEVEL).toBeGreaterThan(0);
  });

  it("NUMBER_KEY_WEAPONS excludes every melee (meleeRange-having) weapon", () => {
    for (const i of NUMBER_KEY_WEAPONS) expect(WEAPONS[i].meleeRange).toBeUndefined();
    // Every non-melee weapon is present exactly once.
    const nonMelee = WEAPONS.map((_, i) => i).filter((i) => WEAPONS[i].meleeRange === undefined);
    expect([...NUMBER_KEY_WEAPONS].sort()).toEqual(nonMelee.sort());
  });

  it("MELEE_WEAPON is the knife (the first meleeRange-having entry)", () => {
    expect(MELEE_WEAPON.name).toBe("SIGKILL Knife");
    expect(MELEE_WEAPON.meleeRange).toBeDefined();
  });
});

describe("currentMeleeWeapon", () => {
  it("returns the knife when Toolchain isn't owned", () => {
    expect(currentMeleeWeapon(new Set([0, 1, 2]))).toBe(MELEE_WEAPON);
  });

  it("returns Toolchain once it's owned", () => {
    expect(currentMeleeWeapon(new Set([0, 1, 2, TOOLCHAIN_WEAPON_INDEX]))).toBe(WEAPONS[TOOLCHAIN_WEAPON_INDEX]);
  });

  it("returns the knife for an empty owned set", () => {
    expect(currentMeleeWeapon(new Set())).toBe(MELEE_WEAPON);
  });
});

describe("pelletOffsets", () => {
  it("returns a single centered offset for a 1-pellet weapon regardless of spreadPx", () => {
    expect(pelletOffsets(WEAPONS[GDB_WEAPON_INDEX])).toEqual([0]);
  });

  it("returns a single centered offset for a 0-pellet edge case too", () => {
    expect(pelletOffsets({ ...WEAPONS[0], pellets: 0 })).toEqual([0]);
  });

  it("spreads a multi-pellet weapon symmetrically from -spread to +spread", () => {
    const shotgun = WEAPONS.find((w) => w.name === "Regex Shotgun")!;
    const offsets = pelletOffsets(shotgun);
    expect(offsets).toHaveLength(shotgun.pellets);
    expect(offsets[0]).toBeCloseTo(-shotgun.spreadPx);
    expect(offsets[offsets.length - 1]).toBeCloseTo(shotgun.spreadPx);
    expect(offsets[Math.floor(offsets.length / 2)]).toBeCloseTo(0, 5);
  });

  it("evenly spaces pellets for a 2-pellet weapon at exactly -spread and +spread", () => {
    const twoPellet = { ...WEAPONS[0], pellets: 2, spreadPx: 10 };
    expect(pelletOffsets(twoPellet)).toEqual([-10, 10]);
  });
});

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
  rangeDamageScale,
  PISTOL_WEAPON_INDEX,
  SHOTGUN_WEAPON_INDEX,
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

  it("rate-caps every ranged weapon, leaving only melee uncapped", () => {
    // The invariant `updateFiring` now leans on: a ranged weapon without an
    // interval fires as fast as the trigger can be pressed, which is what
    // turned the shotgun into an automatic weapon. Melee is exempt because
    // quick-melee runs through `meleeCooldown`'s separate path instead.
    for (const w of WEAPONS) {
      if (w.meleeRange !== undefined) continue;
      expect(w.fireIntervalSec, `${w.name} has no fire interval`).toBeGreaterThan(0);
    }
    expect(MELEE_WEAPON.fireIntervalSec).toBeUndefined();
  });

  it("makes the shotgun's pump cycle far slower than the pistol's trigger", () => {
    const pistol = WEAPONS[PISTOL_WEAPON_INDEX];
    const shotgun = WEAPONS[SHOTGUN_WEAPON_INDEX];
    expect(shotgun.fireIntervalSec!).toBeGreaterThan(pistol.fireIntervalSec! * 4);
    // ...but the slower cadence must not make it a worse pistol: the whole
    // point of the shotgun is burst damage up close, so its damage-per-second
    // ceiling (every pellet connecting) has to stay clearly ahead. Parity
    // here would mean identical output for 4x the ammo, out of the same
    // shared pool — see its `damagePerPellet` comment in weapons.ts.
    const dps = (w: (typeof WEAPONS)[number]) => (w.pellets * w.damagePerPellet) / w.fireIntervalSec!;
    expect(dps(shotgun)).toBeGreaterThan(dps(pistol) * 1.25);
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

describe("rangeDamageScale", () => {
  const flame = WEAPONS[FRIDAY_HOTFIX_WEAPON_INDEX];

  it("leaves every weapon without a range curve untouched", () => {
    // Only the flamethrower opts in. A plain `maxRange` (melee) keeps its
    // all-or-nothing behaviour, and the caller stays responsible for rejecting
    // anything past it.
    for (const w of WEAPONS) {
      if (w.fullDamageRange !== undefined) continue;
      expect(rangeDamageScale(w, 0)).toBe(1);
      expect(rangeDamageScale(w, 99)).toBe(1);
    }
  });

  it("gives full damage across the plateau and nothing at the far end", () => {
    expect(rangeDamageScale(flame, 0)).toBe(1);
    expect(rangeDamageScale(flame, flame.fullDamageRange!)).toBe(1);
    expect(rangeDamageScale(flame, flame.maxRange!)).toBe(0);
    expect(rangeDamageScale(flame, flame.maxRange! + 5)).toBe(0);
  });

  it("decays linearly between the two, so half-way along is half damage", () => {
    const mid = (flame.fullDamageRange! + flame.maxRange!) / 2;
    expect(rangeDamageScale(flame, mid)).toBeCloseTo(0.5, 6);
    // Monotonic, which is the property that makes "thins out" true rather than
    // just "stops somewhere else".
    let previous = 1;
    for (let d = flame.fullDamageRange!; d <= flame.maxRange!; d += 0.25) {
      const scale = rangeDamageScale(flame, d);
      expect(scale).toBeLessThanOrEqual(previous);
      previous = scale;
    }
  });

  it("replaces a binary gate: the old cutoff distance now still does real damage", () => {
    // The whole point of the item. At 3.5 tiles the weapon used to deal full
    // damage and at 3.6 literally nothing; now 3.5 is partway down a curve and
    // the band beyond it is reachable at all.
    expect(rangeDamageScale(flame, 3.5)).toBeGreaterThan(0);
    expect(rangeDamageScale(flame, 3.5)).toBeLessThan(1);
    expect(rangeDamageScale(flame, 4.6)).toBeGreaterThan(0); // the median range regular enemies fight at
  });

  it("is a redistribution, not a buff: close range gives some back", () => {
    // The plateau deliberately ends short of the old 3.5 cutoff, so the reach
    // is paid for rather than added on top of the highest-DPS profile in the
    // table.
    expect(flame.fullDamageRange!).toBeLessThan(3.5);
    expect(rangeDamageScale(flame, 3.0)).toBeLessThan(1);
  });
});

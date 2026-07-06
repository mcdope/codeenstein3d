// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Weapon definitions for the arsenal. A weapon is pure data: how many hitscan
 * pellets it fires, how far they spread across the screen (the cone), damage
 * per pellet, and how much ammo (of which type) a trigger-pull costs. The
 * engine reads these to resolve a shot — see `RaycasterEngine.fire()`.
 */

/** Which ammo pool a weapon draws from; `undefined` = infinite (the knife). */
export type AmmoType = "bullets" | "rockets";

/** Distinct viewmodel silhouette drawn at the bottom of the screen — see
 * `drawWeapon` in `viewmodel.ts`. */
export type WeaponViewKind = "pistol" | "shotgun" | "knife" | "mp" | "rocket";

export interface Weapon {
  /** Stable id / display name. */
  name: string;
  /** Number of hitscan rays fired per trigger-pull. Ignored for `isRocket`
   * weapons, which fire one real projectile instead. */
  pellets: number;
  /**
   * Half-width of the pellet cone in screen pixels (at the internal render
   * resolution). 0 = a single centered ray (the pistol).
   */
  spreadPx: number;
  /**
   * Damage each pellet that connects deals — or, for `isRocket` weapons, the
   * ground-zero (center-of-blast) damage the one projectile it fires deals on
   * detonation, before distance falloff (see `rockets.ts`).
   */
  damagePerPellet: number;
  /** Ammo consumed per trigger-pull, from `ammoType`'s pool. */
  ammoPerShot: number;
  /** Ammo pool this weapon draws from; omitted entirely for the knife
   * (infinite, no pool to deplete). */
  ammoType?: AmmoType;
  /** Tracer line color (a CSS color string) — lets each weapon's shots read
   * as visually distinct at a glance. */
  tracerColor: string;
  /** Distinct viewmodel silhouette. */
  viewKind: WeaponViewKind;
  /**
   * Melee weapons only: max distance in tiles a pellet can actually connect
   * at, regardless of what's aimed at down the screen column. Ranged (hitscan)
   * weapons omit this entirely.
   */
  meleeRange?: number;
  /** Stability restored to the player on every kill with this weapon. */
  lifesteal?: number;
  /** True for the rocket launcher: `fire()` spawns a real, slow-traveling
   * projectile with AoE splash damage (see `rockets.ts`) instead of resolving
   * instant hitscan pellets. */
  isRocket?: boolean;
  /** Fully-automatic: fires repeatedly while the trigger is held, at
   * `fireIntervalSec` between shots, instead of once per press. */
  auto?: boolean;
  /** Minimum seconds between shots — required for `auto` weapons, and used to
   * throttle the rocket launcher (a real click-rate limit, not just letting
   * whatever the player can physically click through fire instantly). Weapons
   * that omit this have no cooldown beyond the trigger's own press rate. */
  fireIntervalSec?: number;
}

/**
 * The arsenal. Ranged weapons are reachable via the number keys and the
 * mousewheel (1 → pistol, 2 → shotgun, (4) → gdb, (5) → ghidra, once
 * owned) — any weapon with `meleeRange` set is structurally excluded from
 * both (see `RaycasterEngine`'s `canWieldViaNumberKey`), since melee has its
 * own dedicated input instead of a number-key slot. Only the pistol/shotgun
 * (plus the knife, which is always available regardless of slot) are owned
 * from the start — gdb/ghidra have to be earned from an Elite kill's
 * guaranteed weapon drop, or are force-unlocked at campaign levels 4/8 as a
 * progression safety net (see `RaycasterEngine`'s `ownedWeapons`, `main.ts`'s
 * `applyForcedUnlocks`).
 * - **echo pistol**: precise single hitscan, cheap.
 * - **Regex Shotgun**: 7 pellets in a cone — devastating up close, useless at
 *   range as the spread misses; costs more heap.
 * - **SIGKILL Knife**: infinite-ammo melee fallback, bound to Left-Ctrl as an
 *   instant "quick-melee" overlay rather than an equippable slot — point-blank
 *   only, but a kill heals a sliver of stability, rewarding aggressive play
 *   when heap runs dry instead of leaving the player stuck out of options.
 *   See `MELEE_WEAPON` and `RaycasterEngine`'s quick-melee handling.
 * - **gdb**: fully automatic, high fire rate, low damage per round — sprays
 *   bullets fast rather than hitting hard. (Named for the GNU debugger — was
 *   called "MP" through Task 30.)
 * - **ghidra**: one slow, visible projectile per trigger-pull that explodes
 *   for splash damage — devastating against packs, but scarce ammo and a
 *   real cooldown between shots keep it from replacing everything. (Named
 *   for the reverse-engineering tool — was called "Rocket Launcher" through
 *   Task 30.)
 */
export const WEAPONS: readonly Weapon[] = [
  {
    name: "echo pistol",
    pellets: 1,
    spreadPx: 0,
    damagePerPellet: 25,
    ammoPerShot: 1,
    ammoType: "bullets",
    tracerColor: "#fff05a",
    viewKind: "pistol",
  },
  {
    name: "Regex Shotgun",
    pellets: 7,
    spreadPx: 70,
    damagePerPellet: 12,
    ammoPerShot: 4,
    ammoType: "bullets",
    tracerColor: "#ff9d3f",
    viewKind: "shotgun",
  },
  {
    name: "SIGKILL Knife",
    pellets: 1,
    spreadPx: 0,
    damagePerPellet: 40,
    ammoPerShot: 0,
    tracerColor: "#d8dde3",
    viewKind: "knife",
    meleeRange: 1.5,
    lifesteal: 1,
  },
  {
    name: "gdb",
    pellets: 1,
    spreadPx: 6,
    damagePerPellet: 7,
    ammoPerShot: 1,
    ammoType: "bullets",
    tracerColor: "#3fa9ff",
    viewKind: "mp",
    auto: true,
    fireIntervalSec: 0.09,
  },
  {
    name: "ghidra",
    pellets: 1,
    spreadPx: 0,
    damagePerPellet: 70,
    ammoPerShot: 1,
    ammoType: "rockets",
    tracerColor: "#ff6a2a",
    viewKind: "rocket",
    isRocket: true,
    fireIntervalSec: 1.1,
  },
];

/** Weapons owned from the start of every run — everything else has to be
 * earned (currently: an Elite kill's guaranteed weapon drop, or the
 * campaign-level-4/8 forced-unlock safety net in `main.ts`). */
export const STARTING_WEAPONS: readonly number[] = [0, 1, 2];

/** Array indices of gdb/ghidra in `WEAPONS` — named so `RaycasterEngine`'s
 * `UNLOCKABLE_WEAPONS` and `main.ts`'s forced-unlock levels don't each
 * hardcode the same literal indices independently. */
export const GDB_WEAPON_INDEX = 3;
export const GHIDRA_WEAPON_INDEX = 4;

/**
 * The knife's `Weapon` object, looked up by its defining trait (`meleeRange`
 * set) rather than a hardcoded array index — so nothing else in the engine
 * needs to know or assume where it sits in `WEAPONS`. Used directly by the
 * Left-Ctrl quick-melee action (see `RaycasterEngine`), which fires it
 * independent of `weaponIndex` entirely.
 */
export const MELEE_WEAPON: Weapon = WEAPONS.find((w) => w.meleeRange !== undefined)!;

/**
 * Screen-x offsets (from center) for a weapon's pellets, evenly spread across
 * the cone. A single-pellet weapon fires straight ahead (offset 0).
 */
export function pelletOffsets(weapon: Weapon): number[] {
  if (weapon.pellets <= 1) return [0];
  const offsets: number[] = [];
  for (let i = 0; i < weapon.pellets; i++) {
    const t = i / (weapon.pellets - 1); // 0..1
    offsets.push((t * 2 - 1) * weapon.spreadPx); // -spread..+spread
  }
  return offsets;
}

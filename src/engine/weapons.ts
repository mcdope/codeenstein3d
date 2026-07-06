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
 * The arsenal, indexed by the number keys (1 → pistol, 2 → shotgun, 3 → knife,
 * 4 → MP, 5 → rocket launcher). Only the first three are owned from the start
 * — the MP and Rocket Launcher have to be earned from an Elite kill's
 * guaranteed weapon drop (see `RaycasterEngine`'s `ownedWeapons`).
 * - **echo pistol**: precise single hitscan, cheap.
 * - **Regex Shotgun**: 7 pellets in a cone — devastating up close, useless at
 *   range as the spread misses; costs more heap.
 * - **SIGKILL Knife**: infinite-ammo melee fallback — point-blank only, but a
 *   kill heals a sliver of stability, rewarding aggressive play when heap runs
 *   dry instead of leaving the player stuck out of options.
 * - **MP**: fully automatic, high fire rate, low damage per round — sprays
 *   bullets fast rather than hitting hard.
 * - **Rocket Launcher**: one slow, visible projectile per trigger-pull that
 *   explodes for splash damage — devastating against packs, but scarce
 *   ammo and a real cooldown between shots keep it from replacing everything.
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
    name: "MP",
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
    name: "Rocket Launcher",
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
 * earned (currently: an Elite kill's guaranteed weapon drop). */
export const STARTING_WEAPONS: readonly number[] = [0, 1, 2];

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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Weapon definitions for the arsenal. A weapon is pure data: how many hitscan
 * pellets it fires, how far they spread across the screen (the cone), damage
 * per pellet, and how much heap (ammo) a trigger-pull costs. The engine reads
 * these to resolve a shot — see `RaycasterEngine.fire()`.
 */
export interface Weapon {
  /** Stable id / display name. */
  name: string;
  /** Number of hitscan rays fired per trigger-pull. */
  pellets: number;
  /**
   * Half-width of the pellet cone in screen pixels (at the internal render
   * resolution). 0 = a single centered ray (the pistol).
   */
  spreadPx: number;
  /** Damage each pellet that connects deals. */
  damagePerPellet: number;
  /** Heap (ammo) consumed per trigger-pull. 0 = infinite (the knife). */
  ammoPerShot: number;
  /**
   * Melee weapons only: max distance in tiles a pellet can actually connect
   * at, regardless of what's aimed at down the screen column. Ranged (hitscan)
   * weapons omit this entirely.
   */
  meleeRange?: number;
  /** Stability restored to the player on every kill with this weapon. */
  lifesteal?: number;
}

/**
 * The arsenal, indexed by the number keys (1 → pistol, 2 → shotgun, 3 → knife).
 * - **echo pistol**: precise single hitscan, cheap.
 * - **Regex Shotgun**: 7 pellets in a cone — devastating up close, useless at
 *   range as the spread misses; costs more heap.
 * - **SIGKILL Knife**: infinite-ammo melee fallback — point-blank only, but a
 *   kill heals a sliver of stability, rewarding aggressive play when heap runs
 *   dry instead of leaving the player stuck out of options.
 */
export const WEAPONS: readonly Weapon[] = [
  { name: "echo pistol", pellets: 1, spreadPx: 0, damagePerPellet: 25, ammoPerShot: 1 },
  { name: "Regex Shotgun", pellets: 7, spreadPx: 70, damagePerPellet: 12, ammoPerShot: 4 },
  { name: "SIGKILL Knife", pellets: 1, spreadPx: 0, damagePerPellet: 40, ammoPerShot: 0, meleeRange: 1.5, lifesteal: 1 },
];

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

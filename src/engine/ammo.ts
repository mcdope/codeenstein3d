// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The four ammo pools as one keyed record, plus per-pool metadata — replaces
 * the four parallel `RaycasterEngine` fields and the same 4-way
 * `AmmoType` branch that used to be repeated across pickup, loot, weapon
 * top-up, cheat, and firing code.
 */
import type { Enemy } from "../map/types";
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
import { WEAPONS, type AmmoType } from "./weapons";

/** Live (or starting-reference) reserves of every ammo pool. */
export type AmmoPools = Record<AmmoType, number>;

/** Every pool in one fixed order — loops over the pools must iterate this,
 * never `Object.keys`, so iteration order is a compile-time constant rather
 * than an object-shape accident (replay determinism). */
export const AMMO_TYPES: readonly AmmoType[] = ["bullets", "rockets", "smg", "gas"];

/** Per-pool display/drop metadata. `label`/`logColor` are kept byte-identical
 * to the console-log strings the old per-pool branches produced. */
export interface AmmoMeta {
  /** Console-log noun ("+N <label>"). */
  label: string;
  /** Console-log color for loot lines. */
  logColor: string;
  /** Default amount for a regular enemy-kill drop of this pool. */
  dropAmount: number;
  /** Elite-sized top-up when a duplicate weapon grant falls back to ammo. */
  eliteTopUp: number;
}

export const AMMO_META: Record<AmmoType, AmmoMeta> = {
  bullets: { label: "bullets", logColor: "#3fd0e0", dropAmount: BULLETS_DROP_AMOUNT, eliteTopUp: ELITE_BULLETS_DROP_AMOUNT },
  rockets: { label: "rockets", logColor: "#ff9d3f", dropAmount: ROCKETS_DROP_AMOUNT, eliteTopUp: ELITE_ROCKETS_DROP_AMOUNT },
  smg: { label: "smg ammo", logColor: "#3fa9ff", dropAmount: SMG_DROP_AMOUNT, eliteTopUp: ELITE_SMG_DROP_AMOUNT },
  gas: { label: "gas", logColor: "#ff5a1a", dropAmount: GAS_DROP_AMOUNT, eliteTopUp: ELITE_GAS_DROP_AMOUNT },
};

/**
 * A modest flat reserve of rockets — not scaled to the level like the bullets
 * formula below, since ghidra itself has to be earned from an Elite kill
 * first; most levels' rockets go unused until it's unlocked, at which point
 * they (and any since scavenged) carry over via `EngineCarryover`.
 */
const STARTING_ROCKETS = 4;

/**
 * A modest flat reserve of smg ammo — same "not scaled to the level" shape as
 * `STARTING_ROCKETS`, since gdb itself has to be earned first (an Elite kill,
 * or the level-4 forced-unlock safety net). A bit more than one regular
 * `SMG_DROP_AMOUNT` pickup, so the weapon feels usable right away once it's
 * actually unlocked rather than emptying in a couple of bursts.
 */
const STARTING_SMG_AMMO = 40;

/** A modest flat reserve of gas ammo — same "not scaled to the level" shape
 * as `STARTING_ROCKETS`/`STARTING_SMG_AMMO`, since Friday Hotfix itself has
 * to be earned first (an Elite kill, or the level-12 forced-unlock safety
 * net). */
const STARTING_GAS_AMMO = 40;

/**
 * Give the player enough bullets to clear the level with the pistol, plus a
 * generous margin, so the fight itself never grinds to a halt for lack of
 * ammo — but scattered ammo pickups are still meant to matter across a real
 * playthrough (missed shots, backtracking, mixing in the heavier shotgun),
 * not just be a nice-to-have. Scales with both total enemy HP (`shotsToClear`,
 * the theoretical perfect-accuracy cost) and raw enemy count (`missBuffer`,
 * covering the missed shots/repositioning a pack of separate encounters
 * costs that a flat HP-total multiplier alone wouldn't capture). The shotgun
 * (and MP) trade bullet efficiency for burst/rate-of-fire, so this
 * undercounts their cost.
 */
function startingBullets(enemies: Enemy[]): number {
  const pistolDamage = WEAPONS[0].damagePerPellet;
  const shotsToClear = enemies.reduce(
    (n, e) => n + Math.ceil(e.maxHp / pistolDamage),
    0,
  );
  const missBuffer = enemies.length * 2.5;
  return Math.max(28, Math.round(shotsToClear * 1.7 + missBuffer) + 10);
}

/** What a level would start the player out with in every pool, before any
 * carryover — also the ammo-bonus baseline `computeScore` scores remaining
 * ammo against (see `./scoring.ts`). */
export function startingAmmo(enemies: Enemy[]): AmmoPools {
  return {
    bullets: startingBullets(enemies),
    rockets: STARTING_ROCKETS,
    smg: STARTING_SMG_AMMO,
    gas: STARTING_GAS_AMMO,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Applying collected loot to the player's run state: dynamic drop effects,
 * weapon grant/duplicate top-up, and the guaranteed Elite drop rolls. Split
 * out of `RaycasterEngine` behind the narrow `LootContext` so the "what does
 * this pickup actually do" rules read in one place — the same
 * behavior-vs-state split `loot.ts` (which *rolls* the drops) already uses.
 */
import type { Enemy, LootDrop, LootKind } from "../map/types";
import { AMMO_META, type AmmoPools } from "./ammo";
import { audio } from "./audio";
import {
  ELITE_BONUS_WEAPON_DROP_CHANCE,
  ELITE_BULLETS_DROP_AMOUNT,
  ELITE_HEALTH_DROP_AMOUNT,
  ELITE_SWAP_DROP_AMOUNT,
  HEALTH_DROP_AMOUNT,
  SWAP_DROP_AMOUNT,
  rollBonusWeaponDrop,
} from "./loot";
import { TOOLCHAIN_MIN_LEVEL, TOOLCHAIN_WEAPON_INDEX, UNLOCKABLE_WEAPONS, WEAPONS } from "./weapons";

/** The slice of `RaycasterEngine` state loot application is allowed to touch
 * — built once as closures over the engine's private fields (see its
 * constructor), so this module never needs the engine itself. */
export interface LootContext {
  /** Live ammo reserves — mutated in place. */
  ammo: AmmoPools;
  /** Difficulty-scaled loot amount (see `RaycasterEngine.scaledLootAmount`). */
  scaledAmount: (base: number) => number;
  /** Add stability, clamped at max health. */
  heal: (amount: number) => void;
  /** Add swap points, clamped at `MAX_SWAP`. */
  addSwap: (amount: number) => void;
  /** True at full stability — steers an Elite's guaranteed drop away from a
   * health pack that would be wasted. */
  healthAtMax: () => boolean;
  /** Indices into `WEAPONS` the player owns — mutated by a weapon grant. */
  ownedWeapons: Set<number>;
  /** Equip the (ranged) weapon at this index. */
  equip: (index: number) => void;
  /** Leave a world drop behind (at a defeated Elite's position). */
  pushDrop: (drop: LootDrop) => void;
  /** The engine's seeded rng stream — every loot roll must stay on it. */
  rng: () => number;
  /** 1-based campaign level — gates Toolchain's Elite bonus drop. */
  campaignLevelIndex: number;
  /** Balancing telemetry only — fired with the actual (difficulty-scaled)
   * amount granted, once it's known here (a `LootDrop`'s raw `amount` is
   * often unset and defaulted internally, so this is the first point the
   * real number exists). `"weapon"` amount is always `1` (an occurrence, not
   * a quantity). See `telemetry.ts`'s `recordLootCollected`. */
  recordApplied?: (kind: LootKind, amount: number, origin: "dynamic" | "static") => void;
}

/** Apply one dynamic loot drop's effect and log it. */
export function applyLootDrop(drop: LootDrop, ctx: LootContext): void {
  audio.playPickup();
  const kind = drop.kind;
  if (kind === "weapon") {
    if (drop.weaponIndex !== undefined) grantOrTopUpWeapon(drop.weaponIndex, ctx, "dynamic");
    return;
  }
  if (kind === "health") {
    const amount = ctx.scaledAmount(drop.amount ?? HEALTH_DROP_AMOUNT);
    ctx.heal(amount);
    ctx.recordApplied?.("health", amount, "dynamic");
    console.log(`%c[loot] +${amount} stability`, "color:#4cff6a");
    return;
  }
  if (kind === "swap") {
    const amount = ctx.scaledAmount(drop.amount ?? SWAP_DROP_AMOUNT);
    ctx.addSwap(amount);
    ctx.recordApplied?.("swap", amount, "dynamic");
    console.log(`%c[loot] +${amount} swap`, "color:#4a7fff");
    return;
  }
  const meta = AMMO_META[kind];
  const amount = ctx.scaledAmount(drop.amount ?? meta.dropAmount);
  ctx.ammo[kind] += amount;
  ctx.recordApplied?.(kind, amount, "dynamic");
  console.log(`%c[loot] +${amount} ${meta.label}`, `color:${meta.logColor}`);
}

/**
 * Grant a still-unowned weapon, switching to it immediately — or, if it's
 * already owned by the time this is collected (e.g. a duplicate roll from
 * another Elite kill or secret room), an elite-sized top-up of whatever
 * ammo pool it uses instead, so the pickup/drop is never just wasted.
 * Shared by `applyLootDrop`'s `"weapon"` `LootDrop` case and `collectLoot`'s
 * `"weapon"` static `AmmoPickup` case (see `RaycasterEngine`).
 */
export function grantOrTopUpWeapon(weaponIndex: number, ctx: LootContext, origin: "dynamic" | "static" = "dynamic"): void {
  const weapon = WEAPONS[weaponIndex];
  if (ctx.ownedWeapons.has(weaponIndex)) {
    if (!weapon.ammoType) return; // an ammo-less duplicate (melee) grants nothing
    const meta = AMMO_META[weapon.ammoType];
    const amount = ctx.scaledAmount(meta.eliteTopUp);
    ctx.ammo[weapon.ammoType] += amount;
    ctx.recordApplied?.(weapon.ammoType, amount, origin);
    console.log(`%c[loot] +${amount} ${meta.label} (${weapon.name} already owned)`, `color:${meta.logColor}`);
  } else {
    ctx.ownedWeapons.add(weaponIndex);
    // A melee grant (Toolchain) must never stomp the equipped slot — that's
    // the *ranged* slot, and melee is never wielded through it (see
    // `currentMeleeWeapon`, which picks it up from `ownedWeapons` instead).
    if (weapon.meleeRange === undefined) ctx.equip(weaponIndex);
    ctx.recordApplied?.("weapon", 1, origin);
    console.log(`%c[loot] unlocked ${weapon.name}!`, "color:#e06aff;font-weight:bold");
  }
}

/**
 * An Elite's death always leaves something worth the fight: a large
 * stability pack, or (if that would be wasted at full health) an
 * elite-sized ammo/swap drop instead — always rolled, never skipped. On
 * top of that guaranteed drop, a still-unowned heavier weapon (see
 * `UNLOCKABLE_WEAPONS`) has its own independent `ELITE_BONUS_WEAPON_DROP_CHANCE`
 * (60%) odds of dropping as a *second*, separate pickup — so most Elites
 * leave two items behind once a weapon's still missing, not a choice
 * between them. Toolchain rides this same 60% roll once
 * `campaignLevelIndex` reaches `TOOLCHAIN_MIN_LEVEL` — it's deliberately
 * not in `UNLOCKABLE_WEAPONS` itself (see that constant's doc comment), so
 * it's added to the candidate list here instead of flowing through
 * automatically.
 */
export function dropEliteLoot(enemy: Enemy, ctx: LootContext): void {
  if (ctx.healthAtMax()) {
    const kind = ctx.rng() < 0.5 ? "bullets" : "swap";
    const amount = kind === "bullets" ? ELITE_BULLETS_DROP_AMOUNT : ELITE_SWAP_DROP_AMOUNT;
    ctx.pushDrop({ x: enemy.x, y: enemy.y, kind, amount });
  } else {
    ctx.pushDrop({ x: enemy.x, y: enemy.y, kind: "health", amount: ELITE_HEALTH_DROP_AMOUNT });
  }

  const missing = UNLOCKABLE_WEAPONS.filter((i) => !ctx.ownedWeapons.has(i));
  if (ctx.campaignLevelIndex >= TOOLCHAIN_MIN_LEVEL && !ctx.ownedWeapons.has(TOOLCHAIN_WEAPON_INDEX)) {
    missing.push(TOOLCHAIN_WEAPON_INDEX);
  }
  const bonusWeaponIndex = rollBonusWeaponDrop(missing, ctx.rng, ELITE_BONUS_WEAPON_DROP_CHANCE);
  if (bonusWeaponIndex !== undefined) {
    ctx.pushDrop({ x: enemy.x, y: enemy.y, kind: "weapon", weaponIndex: bonusWeaponIndex });
  }
}

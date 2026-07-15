// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Loot drop resolution: what a defeated (non-elite) enemy leaves behind, and
 * how much of it. Kept separate from `RaycasterEngine` (which owns the actual
 * drop list, pickup radius, and application of the effect) the same way
 * `enemyAi.ts`/`projectiles.ts`/`traps.ts` split behavior from state.
 */
import type { DifficultyLevel } from "../difficulty";
import type { LootKind } from "../map/types";

/** Relative odds of each loot kind on a regular enemy kill. Rockets are the
 * scarcest/highest-value ammo type, so they're weighted well below bullets;
 * smg/gas (gdb's/Friday Hotfix's own pools, see `AmmoType`) sit between the
 * two — each is drawn down fast by its full-auto weapon but each drop is a
 * full "magazine" (see `SMG_DROP_AMOUNT`/`GAS_DROP_AMOUNT`), not a scarce
 * high-value item like rockets; health and swap sit in between. */
const LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 40 },
  { kind: "smg", weight: 18 },
  { kind: "gas", weight: 18 },
  { kind: "rockets", weight: 10 },
  { kind: "health", weight: 16 },
  { kind: "swap", weight: 16 },
];

/** Normal difficulty only: a slightly higher ammo (bullets/rockets/smg/gas)
 * share than the base `LOOT_WEIGHTS`, trimmed from health/swap — Easy/Hard
 * already have their own scarcity curve via `DifficultyMultipliers.ammoDropRate`
 * (the *amount* per drop), so this only tweaks Normal's drop *kind* odds, per
 * playtest feedback that ammo ran too scarce there specifically. */
const NORMAL_LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 46 },
  { kind: "smg", weight: 20 },
  { kind: "gas", weight: 20 },
  { kind: "rockets", weight: 12 },
  { kind: "health", weight: 11 },
  { kind: "swap", weight: 11 },
];

/** On a bonus (restock-arena) level, kills lean harder toward the scarcer,
 * higher-value drops — it's meant to feel like a resupply stop. */
const BONUS_LOOT_WEIGHTS: { kind: Exclude<LootKind, "weapon">; weight: number }[] = [
  { kind: "bullets", weight: 24 },
  { kind: "smg", weight: 20 },
  { kind: "gas", weight: 20 },
  { kind: "rockets", weight: 20 },
  { kind: "health", weight: 20 },
  { kind: "swap", weight: 16 },
];

/** Chance a regular (non-elite) kill drops nothing at all — checked by the
 * caller (`RaycasterEngine`'s kill handler) before it ever calls `rollLoot`,
 * not inside it, so `rollLoot`'s own weighted-kind logic and its tests stay
 * untouched. Elites always drop (see `dropEliteLoot`) — this only applies to
 * the "every regular kill guarantees something" case the balance-telemetry
 * report flagged as making dynamic supply overwhelm static placement. */
export const REGULAR_KILL_NO_DROP_CHANCE = 0.2;

/** Roll a random loot kind for a regular (non-elite) enemy kill, weighted by
 * `LOOT_WEIGHTS` (`NORMAL_LOOT_WEIGHTS` on Normal difficulty specifically, or
 * `BONUS_LOOT_WEIGHTS` on a bonus level, which takes priority over both).
 * Elites use their own guaranteed-drop logic instead — see
 * `RaycasterEngine`'s `dropEliteLoot`.
 *
 * `rng` defaults to `Math.random` but `RaycasterEngine` always passes its own
 * seeded stream instead — a loot roll changes what ammo/health is available
 * for the rest of the run, so it has to go through the same deterministic
 * source as everything else the replay system depends on (see `src/prng.ts`'s
 * doc comment for the full seeded/cosmetic split).
 *
 * `hasRocketLauncher`/`hasGdb`/`hasFridayHotfix` gate the
 * `"rockets"`/`"smg"`/`"gas"` entries out of the weight table entirely
 * (rather than re-rolling into them) — until a weapon is unlocked, its ammo
 * would just be dead loot cluttering the drop, so its share is redistributed
 * across the remaining kinds instead.
 *
 * `playerAtFullHealth` does the same for `"health"` — a health pack is dead
 * loot at 100% stability, so its share goes to ammo/swap instead.
 * `healthHandledSeparately` also excludes `"health"`, unconditionally —
 * `RaycasterEngine`'s regular-kill handler now grants a health top-up as its
 * own always-on check (see its doc comment), so `"health"` competing for the
 * *same* roll here would double the drop on kills where both happen to line
 * up. Defaults to `false` so every pre-existing caller/test keeps the old
 * weighted-health-in-the-roll behavior. */
export function rollLoot(
  bonusLevel = false,
  difficulty: DifficultyLevel = "normal",
  rng: () => number = Math.random,
  hasRocketLauncher = true,
  hasGdb = true,
  playerAtFullHealth = false,
  hasFridayHotfix = true,
  healthHandledSeparately = false,
): Exclude<LootKind, "weapon"> {
  const weights = bonusLevel
    ? BONUS_LOOT_WEIGHTS
    : difficulty === "normal"
      ? NORMAL_LOOT_WEIGHTS
      : LOOT_WEIGHTS;
  let usable = weights.filter(
    (w) =>
      (w.kind !== "rockets" || hasRocketLauncher) &&
      (w.kind !== "smg" || hasGdb) &&
      (w.kind !== "gas" || hasFridayHotfix) &&
      (w.kind !== "health" || !healthHandledSeparately),
  );
  if (playerAtFullHealth) usable = usable.filter((w) => w.kind !== "health");
  const total = usable.reduce((sum, w) => sum + w.weight, 0);
  let r = rng() * total;
  for (const w of usable) {
    if (r < w.weight) return w.kind;
    r -= w.weight;
  }
  return usable[0].kind;
}

/** Default pickup amounts, per loot kind (overridable per-drop for elite
 * kills — see `LootDrop.amount`). Ammo/swap pools cut ~30% from their
 * original 6/2/30/30/15 per balance-telemetry findings: across a 450-run,
 * 836-attempt campaign, dynamic (kill-drop) supply so overwhelmingly
 * dominated static placement (93-100% of everything actually consumed,
 * every resource type, every combo) that ammo never meaningfully ran low —
 * regular-kill loot alone was generous enough to make the level-placed
 * pickups nearly vestigial. Health is deliberately excluded from this cut —
 * see its own doc comment below. Elite drop amounts further below are also
 * untouched — those are a deliberate bigger reward for a harder kill, not
 * part of the "every regular kill floods you" problem this cut addresses.
 * See also `REGULAR_KILL_NO_DROP_CHANCE`. */
export const BULLETS_DROP_AMOUNT = 4;
/** Already the scarcest/highest-value drop by design (see `LOOT_WEIGHTS`) —
 * the same ~30% cut rounds 2 down to 1, a proportionally bigger reduction
 * than the other pools get purely from rounding at this small a base value,
 * which is fine here since rockets are supposed to stay the tightest
 * resource anyway. */
export const ROCKETS_DROP_AMOUNT = 1;
/** gdb burns one round per shot at up to ~11/sec (see `WEAPONS`'
 * `fireIntervalSec`), so a drop sized like the shared bullets pool (6) would
 * empty in about half a second — sized instead like a real SMG magazine. */
export const SMG_DROP_AMOUNT = 21;
/** Friday Hotfix burns gas at the same ~10/sec rate as gdb burns smg ammo
 * (see `WEAPONS`' `fireIntervalSec`) — same magazine-sized drop. */
export const GAS_DROP_AMOUNT = 21;
/** Deliberately NOT cut like the other pools above — health is the one
 * resource that directly causes death when it runs short, unlike ammo
 * (still survivable via the universal melee fallback). Cutting it the same
 * ~30% compounded with Hard's own 0.7x ammoDropRate (14 * 0.7 ≈ 10, down
 * from the original 20 * 0.7 = 14) and the new 20% miss chance to collapse
 * Gamer/Hard's qualifying rate from a report-baseline ~48% to 4% (1/25) in a
 * live verification batch — confirmed via a verbose trace showing deaths
 * from cumulative melee+ranged+mine damage, not ammo starvation
 * (desperation metrics stayed at 0). Reverted to its original value. */
export const HEALTH_DROP_AMOUNT = 20;
export const SWAP_DROP_AMOUNT = 11;
/** Elite kills guarantee a bigger heal than a regular enemy's health drop. */
export const ELITE_HEALTH_DROP_AMOUNT = 50;
/** Elite-sized fallbacks for when the health drop above would be wasted
 * (player already at full health) — same "bigger than a regular drop" scale
 * as `ELITE_HEALTH_DROP_AMOUNT` is to `HEALTH_DROP_AMOUNT`. */
export const ELITE_BULLETS_DROP_AMOUNT = 18;
export const ELITE_ROCKETS_DROP_AMOUNT = 6;
export const ELITE_SMG_DROP_AMOUNT = 80;
export const ELITE_GAS_DROP_AMOUNT = 80;
export const ELITE_SWAP_DROP_AMOUNT = 30;
/** Maximum swap the player can stockpile. */
export const MAX_SWAP = 100;

/** Very small chance for a regular (non-elite) enemy kill to also drop a
 * still-locked heavier weapon, stacked on top of its usual `rollLoot` drop
 * rather than replacing it — a rare bonus so players aren't strictly locked
 * into hunting elites/secret rooms for an unlock, not a primary drop path. */
export const NORMAL_KILL_WEAPON_DROP_CHANCE = 0.01;

/** Elites already guarantee their usual health/ammo drop outright (see
 * `RaycasterEngine.dropEliteLoot`); this is the independent, much higher
 * odds of *additionally* dropping a still-locked weapon on top of it. */
export const ELITE_BONUS_WEAPON_DROP_CHANCE = 0.6;

/**
 * Roll whether a kill's already-rolled loot should be topped with a bonus
 * unlockable-weapon drop, at the given `chance` (defaults to the regular-kill
 * rate; elites pass `ELITE_BONUS_WEAPON_DROP_CHANCE` instead — see
 * `RaycasterEngine.dropEliteLoot`). Returns the weapon index to drop, or
 * `undefined` if there's nothing left to unlock or the roll missed. Only
 * draws a second `rng()` value (to pick *which* missing weapon) once the
 * odds roll actually hits, so a run with every weapon already owned never
 * spends an extra rng() draw on a kill.
 */
export function rollBonusWeaponDrop(
  missingWeaponIndices: readonly number[],
  rng: () => number = Math.random,
  chance: number = NORMAL_KILL_WEAPON_DROP_CHANCE,
): number | undefined {
  if (missingWeaponIndices.length === 0) return undefined;
  if (rng() >= chance) return undefined;
  return missingWeaponIndices[Math.floor(rng() * missingWeaponIndices.length)];
}

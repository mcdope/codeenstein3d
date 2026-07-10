// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Weapon definitions for the arsenal. A weapon is pure data: how many hitscan
 * pellets it fires, how far they spread across the screen (the cone), damage
 * per pellet, and how much ammo (of which type) a trigger-pull costs. The
 * engine reads these to resolve a shot — see `RaycasterEngine.fire()`.
 */

/** Which ammo pool a weapon draws from; `undefined` = infinite (the knife).
 * `"smg"` is gdb's own pool — it used to share `"bullets"` with the pistol/
 * shotgun, which made a shared bullets pickup implicitly restock three very
 * different guns at once and made "10 bullets" pickups feel wrong for a
 * full-auto weapon that burns through them in under a second. `"gas"` is
 * Friday Hotfix's own pool, for the same reason. */
export type AmmoType = "bullets" | "rockets" | "smg" | "gas";

/** Distinct viewmodel silhouette drawn at the bottom of the screen — see
 * `drawWeapon` in `viewmodel.ts`. */
export type WeaponViewKind = "pistol" | "shotgun" | "knife" | "mp" | "rocket" | "flamethrower";

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
  /**
   * Ranged weapons only: hard max distance in tiles a pellet can actually
   * connect at, layered on top of the Cone of Fire's soft accuracy falloff
   * (see `fire()`'s doc comment) — for a weapon whose real-world reach is
   * short enough that "wide spread" alone doesn't sell it. Only Friday
   * Hotfix uses this; every other ranged weapon omits it and relies on
   * spread/falloff the way `fire()` already handles range.
   */
  maxRange?: number;
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
  /** Overrides `RaycasterEngine`'s shared `MAX_CONE_DEVIATION_PX` (see its doc
   * comment) for this weapon specifically — a smaller value means this
   * weapon's shots stay accurate further out before the range-based "Cone of
   * Fire" deviation starts meaningfully throwing them off. Omitted for every
   * weapon but gdb, which uses this to feel genuinely usable at range despite
   * its low per-shot damage, rather than sharing the same falloff tuned
   * primarily around the pistol. */
  maxConeDeviationPx?: number;
}

/**
 * The arsenal. Ranged weapons are reachable via the number keys and the
 * mousewheel (1 → pistol, 2 → shotgun, (3) → gdb, (4) → ghidra, (5) →
 * Friday Hotfix, once owned — kept contiguous by `NUMBER_KEY_WEAPONS`
 * regardless of where a ranged weapon actually sits in this array) — any
 * weapon with `meleeRange` set is structurally excluded from both (see
 * `RaycasterEngine`'s `canWieldViaNumberKey`), since melee has its own
 * dedicated input instead of a number-key slot. Only the pistol/shotgun
 * (plus the knife, which is always available regardless of slot) are owned
 * from the start — gdb/ghidra/Friday Hotfix have to be earned from an Elite
 * kill's high-odds bonus weapon drop, a rare drop from any kill, or are
 * force-unlocked at campaign levels 4/8/12 as a progression safety net (see
 * `RaycasterEngine`'s `ownedWeapons`, `main.ts`'s `applyForcedUnlocks`).
 * - **echo pistol**: precise single hitscan, cheap.
 * - **Regex Shotgun**: 7 pellets in a cone — devastating up close, useless at
 *   range as the spread misses; costs more heap.
 * - **SIGKILL Knife**: infinite-ammo melee fallback, bound to Left-Ctrl as an
 *   instant "quick-melee" overlay rather than an equippable slot — point-blank
 *   only, but a kill heals a sliver of stability, rewarding aggressive play
 *   when heap runs dry instead of leaving the player stuck out of options.
 *   See `MELEE_WEAPON` and `RaycasterEngine`'s quick-melee handling.
 * - **gdb**: fully automatic, high fire rate, moderate damage per round —
 *   draws from its own `"smg"` ammo pool rather than sharing `"bullets"`
 *   with the pistol/shotgun (see `AmmoType`). (Named for the GNU debugger —
 *   was called "MP" through Task 30.)
 * - **ghidra**: one slow, visible projectile per trigger-pull that explodes
 *   for splash damage — devastating against packs, but scarce ammo and a
 *   real cooldown between shots keep it from replacing everything. (Named
 *   for the reverse-engineering tool — was called "Rocket Launcher" through
 *   Task 30.)
 * - **Friday Hotfix**: fully automatic flamethrower — a tight jet (narrower
 *   than the shotgun's own cone) enforced by a hard 3.5-tile `maxRange`, so
 *   it melts anything at point-blank range but genuinely cannot reach past a
 *   couple of tiles no matter how the Cone of Fire spread happens to land.
 *   Draws from its own `"gas"` ammo pool. The latest and heaviest unlock
 *   (forced at campaign level 12, one past ghidra's 8).
 */
export const WEAPONS: readonly Weapon[] = [
  {
    name: "echo pistol",
    pellets: 1,
    spreadPx: 0,
    // Slightly down from 25, mirrored by the shotgun's +6 below (twice the
    // reduction) — playtest feedback was that the shotgun felt weaker than
    // the pistol despite firing 7 pellets per shot, since its wide cone
    // (spreadPx: 70) means only a fraction connect outside point-blank range.
    damagePerPellet: 22,
    ammoPerShot: 1,
    ammoType: "bullets",
    tracerColor: "#fff05a",
    viewKind: "pistol",
  },
  {
    name: "Regex Shotgun",
    pellets: 7,
    spreadPx: 70,
    // Up from 12 by twice the pistol's 3-point reduction above — see its
    // comment for why.
    damagePerPellet: 18,
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
    // A single-pellet weapon always fires dead-center regardless of this
    // value (see `pelletOffsets`'s "single-pellet weapon fires straight
    // ahead" doc comment) — 0 here just says so honestly, rather than an
    // inert nonzero value implying a pellet cone that was never actually
    // applied.
    spreadPx: 0,
    damagePerPellet: 12,
    ammoPerShot: 1,
    ammoType: "smg",
    tracerColor: "#3fa9ff",
    viewKind: "mp",
    auto: true,
    // Tighter than the shared default (see `Weapon.maxConeDeviationPx`) — a
    // playtest follow-up ask for "more range" specifically for gdb, without
    // retuning the shared curve every other hitscan weapon (pistol
    // especially) also depends on.
    maxConeDeviationPx: 20,
    fireIntervalSec: 0.09,
  },
  {
    name: "ghidra",
    pellets: 1,
    spreadPx: 0,
    // Up from 70, then 100 — still felt weak in a second playtest pass.
    // Regular (non-pack, non-Elite) enemies can sit well above 100, up to
    // ~225 HP at the top of the single-enemy complexity band (see
    // `HP_PER_COMPLEXITY`/`ELITE_COMPLEXITY_THRESHOLD` in `mapGenerator.ts`),
    // and a rocket launcher routinely needing 2+ hits to drop something it
    // should flatten read as backwards for the weapon.
    damagePerPellet: 150,
    ammoPerShot: 1,
    ammoType: "rockets",
    tracerColor: "#ff6a2a",
    viewKind: "rocket",
    isRocket: true,
    fireIntervalSec: 1.1,
  },
  {
    name: "Friday Hotfix",
    // The hard 3.5-tile `maxRange` (not a wide cone) is what actually enforces
    // its short reach — playtesting showed relying on cone-spread alone still
    // let it connect from further out than a real flamethrower should ever
    // reach. `spreadPx` is deliberately narrower than the shotgun's 70px now:
    // a tight jet that only fans out near `maxRange` (see `FlameStream`'s
    // visual, drawn narrow-at-muzzle/wide-at-tip to match), not a wide blast
    // from the nozzle.
    pellets: 6,
    spreadPx: 45,
    damagePerPellet: 8,
    ammoPerShot: 1,
    ammoType: "gas",
    tracerColor: "#ff5a1a",
    viewKind: "flamethrower",
    auto: true,
    fireIntervalSec: 0.1,
    maxRange: 3.5,
  },
];

/** Weapons owned from the start of every run — everything else has to be
 * earned (currently: an Elite kill's high-odds bonus weapon drop, a rare
 * drop from any kill, or the campaign-level-4/8 forced-unlock safety net in
 * `main.ts`). */
export const STARTING_WEAPONS: readonly number[] = [0, 1, 2];

/** Array indices of gdb/ghidra/Friday Hotfix in `WEAPONS` — named so
 * `UNLOCKABLE_WEAPONS` and `main.ts`'s forced-unlock levels don't each
 * hardcode the same literal indices independently. */
export const GDB_WEAPON_INDEX = 3;
export const GHIDRA_WEAPON_INDEX = 4;
export const FRIDAY_HOTFIX_WEAPON_INDEX = 5;

/** Weapon indices whose only in-level acquisition path is an Elite kill's
 * high-odds bonus drop, a regular kill's rare bonus drop (both
 * `RaycasterEngine.dropEliteLoot`/`damageEnemy`, via `loot.ts`'s
 * `rollBonusWeaponDrop`), or a secret room's weapon-unlock loot slot
 * (`placeSecretRooms` in `mapGenerator.ts`) — plus
 * `main.ts`'s forced-unlock safety net at campaign levels 4/8/12, a separate,
 * out-of-band path onto these same indices. Lives here rather than in
 * `engine.ts` so both the engine layer and `main.ts` (which has to compute
 * which of these are still missing, to hand the map layer an opaque list of
 * candidate indices without the map layer importing engine-layer weapon
 * concepts — see `doc/dev/architecture.md`'s "map must never import engine"
 * rule) can both import one shared source of truth. */
export const UNLOCKABLE_WEAPONS: readonly number[] = [
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  FRIDAY_HOTFIX_WEAPON_INDEX,
];

/**
 * `WEAPONS` indices in number-key order: the Nth entry here is what the
 * (N+1)th number key (`1`, `2`, …) switches to, via `RaycasterEngine`'s
 * `consumeWeaponRequest()` handling — melee (the knife, index 2) is skipped
 * since it's structurally excluded from number-key switching (see
 * `canWieldViaNumberKey`) and bound to Left-Ctrl instead. Without this
 * indirection, a raw digit-to-array-index mapping would leave key `3` dead
 * (it used to land on the knife's slot) and push gdb/ghidra to `4`/`5`
 * instead of `3`/`4` — exactly the "hole" a prior playtest flagged. Derived
 * from `WEAPONS` rather than hardcoded so a future non-melee addition to the
 * array automatically gets a contiguous slot without this needing an update;
 * a future *melee* addition just needs the same `meleeRange` exclusion to
 * keep working. Doesn't change `WEAPONS`' own array order or any persisted
 * `weaponIndex`/`ownedWeapons` numeric semantics (campaign saves, replays,
 * highscores) — only how a number-key press is translated into one. */
export const NUMBER_KEY_WEAPONS: readonly number[] = WEAPONS.map((_, i) => i).filter(
  (i) => WEAPONS[i].meleeRange === undefined,
);

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

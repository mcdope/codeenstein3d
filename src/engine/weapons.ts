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
export type AmmoType = "bullets" | "shells" | "rockets" | "smg" | "gas";

/** Distinct viewmodel silhouette drawn at the bottom of the screen — see
 * `drawWeapon` in `viewmodel.ts`. */
export type WeaponViewKind = "pistol" | "shotgun" | "knife" | "mp" | "rocket" | "flamethrower" | "chainsaw";

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
   * Ranged weapons only: max distance in tiles a pellet can connect at,
   * layered on top of the Cone of Fire's soft accuracy falloff (see `fire()`'s
   * doc comment) — for a weapon whose real-world reach is short enough that
   * "wide spread" alone doesn't sell it. Only Friday Hotfix uses this; every
   * other ranged weapon omits it and relies on spread/falloff the way `fire()`
   * already handles range.
   *
   * Paired with `fullDamageRange`, this is the *end* of a decay curve rather
   * than a wall: damage is already zero when it gets here. See
   * `rangeDamageScale`.
   */
  maxRange?: number;
  /**
   * Ranged weapons only, and only meaningful alongside `maxRange`: the
   * distance out to which a pellet does its full `damagePerPellet`. Past it,
   * damage decays linearly to zero at `maxRange`.
   *
   * Exists because a hard `maxRange` alone is a binary gate, not a range
   * curve: the flamethrower dealt its full 8 per pellet at 3.4 tiles and
   * literally nothing at 3.6. A flame jet should thin out, not stop at an
   * invisible wall — which is also what `FlameStream`'s narrow-at-muzzle,
   * wide-at-tip visual has always implied.
   */
  fullDamageRange?: number;
  /** Stability restored to the player on every kill with this weapon. */
  lifesteal?: number;
  /** True for the rocket launcher: `fire()` spawns a real, slow-traveling
   * projectile with AoE splash damage (see `rockets.ts`) instead of resolving
   * instant hitscan pellets. */
  isRocket?: boolean;
  /** Fully-automatic: fires repeatedly while the trigger is held, at
   * `fireIntervalSec` between shots, instead of once per press. */
  auto?: boolean;
  /** Minimum seconds between shots. **Every ranged weapon defines this** — a
   * real rate limit, rather than letting whatever the player can physically
   * click (or an autoclicker, or a bot dispatching a keydown per tick) fire
   * instantly. For `auto` weapons it's the sustained rate while the trigger
   * is held; for semi-auto ones it's a floor on top of "once per press", so
   * click-spam can't turn a shotgun into an automatic weapon.
   *
   * Only *melee* weapons may omit it — the knife, which swings once per
   * press through `meleeCooldown`'s separate path. It stays optional for
   * that reason alone. */
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
 * - **echo pistol**: precise single hitscan, cheap, and the fastest-cycling
 *   thing in the arsenal that isn't fully automatic (~6.6 shots/sec).
 * - **Regex Shotgun**: 7 pellets in a cone — devastating up close, useless at
 *   range as the spread misses; costs more heap. Pump-action: one blast per
 *   0.85s, which is the trade for that burst damage. Its per-pellet damage is
 *   tuned *against* that cadence (see its entry), so the two move together.
 * - **SIGKILL Knife**: infinite-ammo melee fallback, bound to Space as an
 *   instant "quick-melee" overlay rather than an equippable slot — point-blank
 *   only, but a kill heals a sliver of stability, rewarding aggressive play
 *   when heap runs dry instead of leaving the player stuck out of options.
 *   See `MELEE_WEAPON`/`currentMeleeWeapon` and `RaycasterEngine`'s
 *   quick-melee handling. Wielded on Space until Toolchain is unlocked,
 *   which permanently replaces it there (see `currentMeleeWeapon`).
 * - **gdb**: fully automatic, high fire rate, moderate damage per round —
 *   draws from its own `"smg"` ammo pool, as every ranged weapon now does —
 *   the pistol keeps `"bullets"` and the shotgun has its own `"shells"`
 *   (see `AmmoType`). (Named for the GNU debugger —
 *   was called "MP" through Task 30.)
 * - **ghidra**: one slow, visible projectile per trigger-pull that explodes
 *   for splash damage — devastating against packs, but scarce ammo and a
 *   real cooldown between shots keep it from replacing everything. (Named
 *   for the reverse-engineering tool — was called "Rocket Launcher" through
 *   Task 30.)
 * - **Friday Hotfix**: fully automatic flamethrower — a tight jet (narrower
 *   than the shotgun's own cone) whose reach is set by a damage curve rather
 *   than a hard cutoff: full damage out to 2.5 tiles, decaying linearly to
 *   nothing at 6.5. That replaced a flat 3.5-tile `maxRange`, and is a
 *   redistribution rather than a buff — see its entry below for the
 *   measurement behind it. Draws from its own `"gas"` ammo pool. The latest
 *   and heaviest unlock (forced at campaign level 12, one past ghidra's 8).
 * - **Toolchain**: a second, stronger melee weapon — infinite ammo like the
 *   knife, double its damage, a bigger lifesteal heal, and fires repeatedly
 *   while Space is held instead of once per press (see `auto`). Has no
 *   forced-unlock safety net and isn't in `UNLOCKABLE_WEAPONS` — only
 *   reachable via a secret room or an Elite kill, and only from campaign
 *   level `TOOLCHAIN_MIN_LEVEL` on (see `RaycasterEngine.dropEliteLoot` and
 *   `main.ts`'s `computeMissingWeaponIndices`). Replaces the knife on
 *   Space the instant it's owned — see `currentMeleeWeapon`. (Bound to
 *   Space, not a modifier key like the original Left-Ctrl, specifically
 *   because holding Ctrl together with W spells out the browser-reserved
 *   `Ctrl+W` "close tab" shortcut — unblockable by page JS — which closed
 *   the whole browser the instant a player swung the chainsaw while moving
 *   forward.)
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
    // ~6.6 shots/sec: a fast but genuinely human semi-auto trigger-pull rate.
    // Before this existed, the pistol's rate was whatever the player's mouse
    // hand (or an autoclicker, or a bot dispatching one keydown per decision
    // tick) could produce — see `updateFiring`'s doc comment in `engine.ts`.
    fireIntervalSec: 0.15,
    tracerColor: "#fff05a",
    viewKind: "pistol",
  },
  {
    name: "Regex Shotgun",
    pellets: 7,
    spreadPx: 70,
    // 18 -> 25, together with the `fireIntervalSec` below and *because* of it.
    // The pump cap alone would have left the shotgun at 7x18/0.85s = 148 DPS
    // point-blank against the pistol's 147 — identical output for 4x the
    // ammo, out of what was then a shared "bullets" pool, and only at contact
    // range where the whole cone connects. That erases the reason to ever pick
    // it. (The pool is no longer shared — see `ammoPerShot` below — but the
    // damage reasoning stands on the DPS comparison, not on the pool.)
    // At 25 it lands 7x25/0.85s = 206 DPS, ~1.4x the pistol, so "devastating
    // up close, useless at range" survives the cadence cap.
    //
    // (The previous 18 was itself "up from 12 by twice the pistol's 3-point
    // reduction", from an earlier playtest pass with the same complaint: the
    // shotgun felt weaker than the pistol despite firing 7 pellets, since its
    // wide cone means only a fraction connect outside point-blank range.)
    damagePerPellet: 25,
    // One shell per pull, out of the shotgun's **own** pool.
    //
    // It used to spend 4 from the shared `bullets` pool, which made every
    // trigger-pull cost four pistol shots and put the two weapons in direct
    // competition for one resource. Splitting the pool is what lets a
    // magazine mean anything here: "2 rounds loaded" is now two shells and
    // two shots, rather than 8 bullets that the pistol also wants. The
    // damage numbers below are unchanged — this is a change to what a shot
    // *costs*, not to what it does.
    ammoPerShot: 1,
    ammoType: "shells",
    // A pump-action cycle: ~1.2 shots/sec. The one weapon this whole cap
    // existed to fix — 7 pellets and 175 damage a blast turned into an
    // automatic weapon by nothing more than clicking fast. Paired with
    // `playShotgunPump` in `audio.ts`, which racks audibly inside this
    // window so the delay reads as the gun cycling rather than a dropped
    // click; the two numbers are related but not derived from each other, so
    // retuning this one means re-checking that cue still lands inside it.
    fireIntervalSec: 0.85,
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
    // Reach is enforced by the damage curve below, not by a wide cone —
    // playtesting showed relying on cone-spread alone let it connect from
    // further out than a real flamethrower should ever reach. `spreadPx` is
    // deliberately narrower than the shotgun's 70px: a tight jet that only
    // fans out near its tip (see `FlameStream`'s visual, drawn
    // narrow-at-muzzle/wide-at-tip to match), not a wide blast from the
    // nozzle.
    pellets: 6,
    spreadPx: 45,
    damagePerPellet: 8,
    // 2.5x the flat 1-per-shot every other weapon pays — its damage output
    // (48 dmg/trigger-pull across 6 pellets, autofire at 10/sec) would let a
    // full 40-unit gas pool outdamage everything else if it cost the same.
    ammoPerShot: 2.5,
    ammoType: "gas",
    tracerColor: "#ff5a1a",
    viewKind: "flamethrower",
    auto: true,
    fireIntervalSec: 0.1,
    // Full damage to 2.5 tiles, decaying to nothing at 6.5, replacing a flat
    // 3.5-tile cutoff. Deliberately a *redistribution* rather than a buff: the
    // plateau ends short of the old cutoff so close range gives a little back,
    // paying for reach the weapon never had. Measured over the 2026-08-04
    // capture, it was locked to the wrong band — fights against regular
    // enemies happen at a median 4.6 tiles, outside its reach entirely, while
    // Edge Cases (10-15 HP trash) sit at 2.7. Only 30 pellets out of ~71,000
    // ever landed in the 4-6 tile bucket.
    //
    // The pairing matters: at 48 damage per trigger-pull and a 0.1s interval
    // this is already the highest-DPS weapon in the game, which is what
    // `ammoPerShot: 2.5` exists to pay for. Extending reach *without* decay
    // would be a straight buff to the strongest damage profile in the table.
    fullDamageRange: 2.5,
    maxRange: 6.5,
  },
  {
    // Not in `UNLOCKABLE_WEAPONS` — deliberately excluded from the ordinary
    // per-kill 1% bonus-drop roll and `main.ts`'s forced-unlock safety net
    // (see `TOOLCHAIN_MIN_LEVEL` and `RaycasterEngine.dropEliteLoot`'s doc
    // comment). Only reachable via a secret room or an Elite kill, and only
    // from campaign level 4 on.
    name: "Toolchain",
    pellets: 1,
    spreadPx: 0,
    damagePerPellet: 80, // 2x the knife's 40, per its unlock note
    ammoPerShot: 0,
    tracerColor: "#e8b23d",
    viewKind: "chainsaw",
    meleeRange: 1.5,
    lifesteal: 3, // stronger than the knife's 1
    auto: true,
    fireIntervalSec: 0.35,
  },
];

/** Array indices of every weapon in `WEAPONS`, named so `UNLOCKABLE_WEAPONS`,
 * `STARTING_WEAPONS`, and `main.ts`'s forced-unlock levels don't each
 * hardcode the same literal indices independently. Pure array-index
 * identities (the same thing `ownedWeapons`/`weaponIndex`/saves/replays use)
 * — unrelated to which number key fires which weapon; see
 * `NUMBER_KEY_WEAPONS` for that separate, derived mapping. */
export const PISTOL_WEAPON_INDEX = 0;
export const SHOTGUN_WEAPON_INDEX = 1;
export const KNIFE_WEAPON_INDEX = 2;
export const GDB_WEAPON_INDEX = 3;
export const GHIDRA_WEAPON_INDEX = 4;
export const FRIDAY_HOTFIX_WEAPON_INDEX = 5;
export const TOOLCHAIN_WEAPON_INDEX = 6;

/** Weapons owned from the start of every run — everything else has to be
 * earned (currently: an Elite kill's high-odds bonus weapon drop, a rare
 * drop from any kill, or the campaign-level-4/8 forced-unlock safety net in
 * `main.ts`). */
export const STARTING_WEAPONS: readonly number[] = [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, KNIFE_WEAPON_INDEX];

/** Minimum 1-based campaign level Toolchain can appear at all, in either a
 * secret room (`main.ts`'s `computeMissingWeaponIndices`) or an Elite kill's
 * bonus drop (`RaycasterEngine.dropEliteLoot`) — unlike gdb/ghidra/Friday
 * Hotfix, which have no such floor (only a forced-unlock *ceiling*), and
 * unlike those three, Toolchain has no forced-unlock entry at all: a
 * loot-unlucky run can finish the whole campaign without ever finding it. */
export const TOOLCHAIN_MIN_LEVEL = 4;

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
 * rule) can both import one shared source of truth. Deliberately does NOT
 * include `TOOLCHAIN_WEAPON_INDEX` — Toolchain rides the same Elite-drop and
 * secret-room mechanisms (via `main.ts`'s `computeMissingWeaponIndices`) but
 * is excluded here so it never enters the ordinary per-kill 1% roll or the
 * forced-unlock safety net, only this array's three ranged members do. */
export const UNLOCKABLE_WEAPONS: readonly number[] = [
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  FRIDAY_HOTFIX_WEAPON_INDEX,
];

/** Weapon indices force-unlocked once the player reaches the given 1-based
 * campaign level, regardless of whether an Elite has actually dropped them yet
 * — a progression safety net so a long, loot-unlucky run doesn't leave
 * gdb/ghidra/Friday Hotfix permanently unreachable.
 *
 * Lives here rather than in `main.ts` for the same reason `UNLOCKABLE_WEAPONS`
 * does (see its comment): more than one consumer needs it, and a second copy
 * would drift. `main.ts` owns *applying* it; the offline balance solver reads
 * it to derive the loadout a run is guaranteed to have at each campaign level,
 * which is what makes its scarcity figures a floor rather than a guess. */
export const FORCED_UNLOCK_LEVELS: readonly { level: number; weaponIndex: number; name: string }[] = [
  { level: 4, weaponIndex: GDB_WEAPON_INDEX, name: "gdb" },
  { level: 8, weaponIndex: GHIDRA_WEAPON_INDEX, name: "ghidra" },
  { level: 12, weaponIndex: FRIDAY_HOTFIX_WEAPON_INDEX, name: "Friday Hotfix" },
];

/**
 * `WEAPONS` indices in number-key order: the Nth entry here is what the
 * (N+1)th number key (`1`, `2`, …) switches to, via `RaycasterEngine`'s
 * `consumeWeaponRequest()` handling — melee (the knife, index 2) is skipped
 * since it's structurally excluded from number-key switching (see
 * `canWieldViaNumberKey`) and bound to Space instead. Without this
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
 * The knife's `Weapon` object — the *first* `meleeRange`-having entry in
 * `WEAPONS` (still correctly the knife now that Toolchain is a second melee
 * entry later in the array), looked up by its defining trait rather than a
 * hardcoded index. Don't use this directly to decide what Space fires —
 * that depends on which melee weapon is actually owned, so use
 * `currentMeleeWeapon` instead. Exists as its own constant since it's still
 * the correct "default/fallback melee weapon" value on a fresh run.
 */
export const MELEE_WEAPON: Weapon = WEAPONS.find((w) => w.meleeRange !== undefined)!;

/**
 * Which melee weapon Space's quick-melee action currently wields: the
 * knife until Toolchain is unlocked, then Toolchain permanently — it
 * replaces the knife on pickup rather than sitting alongside it (see the
 * `notes` entry this shipped for). Takes the engine's live `ownedWeapons` set
 * since, unlike every other `WEAPONS` lookup here, this can change mid-run.
 */
export function currentMeleeWeapon(ownedWeapons: ReadonlySet<number>): Weapon {
  return ownedWeapons.has(TOOLCHAIN_WEAPON_INDEX) ? WEAPONS[TOOLCHAIN_WEAPON_INDEX] : MELEE_WEAPON;
}

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

/**
 * Fraction of `damagePerPellet` a pellet delivers at `distance` tiles.
 *
 * 1 for every weapon that declares no `fullDamageRange` — a plain `maxRange`
 * (melee, or any future short-reach weapon) keeps its old all-or-nothing
 * behaviour, and the caller is still responsible for rejecting anything beyond
 * it. Only a weapon opting into a curve gets one.
 *
 * Same shape as `rocketDamageAt` in `rockets.ts`, minus the floor: a rocket's
 * splash keeps a minimum bite at the edge of its radius because a near miss
 * should still hurt, whereas a flame that has thinned out to nothing should
 * deal nothing rather than a guaranteed chip.
 */
export function rangeDamageScale(weapon: Weapon, distance: number): number {
  const full = weapon.fullDamageRange;
  const max = weapon.maxRange;
  if (full === undefined || max === undefined || max <= full) return 1;
  if (distance <= full) return 1;
  if (distance >= max) return 0;
  return (max - distance) / (max - full);
}

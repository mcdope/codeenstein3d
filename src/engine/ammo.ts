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
  ELITE_SHELLS_DROP_AMOUNT,
  ELITE_SMG_DROP_AMOUNT,
  GAS_DROP_AMOUNT,
  ROCKETS_DROP_AMOUNT,
  SHELLS_DROP_AMOUNT,
  SMG_DROP_AMOUNT,
} from "./loot";
import { PISTOL_WEAPON_INDEX, WEAPONS, type AmmoType } from "./weapons";

/** Live (or starting-reference) reserves of every ammo pool. */
export type AmmoPools = Record<AmmoType, number>;

/** Every pool in one fixed order — loops over the pools must iterate this,
 * never `Object.keys`, so iteration order is a compile-time constant rather
 * than an object-shape accident (replay determinism).
 *
 * **A new pool is appended, never inserted**, for the same reason: this order
 * decides the sequence of drops a disconnecting multiplayer player's
 * inventory is converted into (`engine.ts`), so inserting `shells` in its
 * "natural" place next to `bullets` would silently change that sequence for
 * every existing recording. It reads out of order here on purpose. */
export const AMMO_TYPES: readonly AmmoType[] = ["bullets", "rockets", "smg", "gas", "shells"];

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
  /** Colour of the HUD's ammo readout while this pool is the active weapon's.
   * Deliberately separate from `logColor`: the console line and the HUD
   * number were picked against different backgrounds and have never matched
   * (bullets read `#3fd0e0` in the log and `#4cff6a` on the HUD). The HUD
   * label itself is `label.toUpperCase()`, which is where those strings
   * already came from. */
  hudColor: string;
  /** Four-or-fewer-character name for the status bar's per-type ammo table.
   *
   * Beside `label` rather than derived from it, and beside it for the same
   * reason `hudColor` is: the table's rows have to fit a fixed-width column
   * under a big numeral, exactly as DOOM's `BULL`/`SHEL`/`RCKT`/`CELL` do,
   * and `label.toUpperCase()` gives "SMG AMMO" — nine characters. Truncating
   * `label` at draw time would put the naming decision in the renderer, which
   * is the pairing this block exists to prevent. */
  short: string;
}

export const AMMO_META: Record<AmmoType, AmmoMeta> = {
  bullets: { label: "bullets", short: "BULL", logColor: "#3fd0e0", hudColor: "#4cff6a", dropAmount: BULLETS_DROP_AMOUNT, eliteTopUp: ELITE_BULLETS_DROP_AMOUNT },
  shells: { label: "shells", short: "SHEL", logColor: "#ffb547", hudColor: "#ffb547", dropAmount: SHELLS_DROP_AMOUNT, eliteTopUp: ELITE_SHELLS_DROP_AMOUNT },
  rockets: { label: "rockets", short: "RCKT", logColor: "#ff9d3f", hudColor: "#ff9d3f", dropAmount: ROCKETS_DROP_AMOUNT, eliteTopUp: ELITE_ROCKETS_DROP_AMOUNT },
  smg: { label: "smg ammo", short: "SMG", logColor: "#3fa9ff", hudColor: "#3fa9ff", dropAmount: SMG_DROP_AMOUNT, eliteTopUp: ELITE_SMG_DROP_AMOUNT },
  gas: { label: "gas", short: "GAS", logColor: "#ff5a1a", hudColor: "#ff8a4a", dropAmount: GAS_DROP_AMOUNT, eliteTopUp: ELITE_GAS_DROP_AMOUNT },
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
 * Six shotgun magazines. Flat rather than scaled to the level, like the three
 * pools above — but for the opposite reason: those weapons have to be earned
 * first, whereas the shotgun is a starting weapon and this is simply the
 * shotgun's own share of a supply that used to come out of `bullets`.
 *
 * Sized from what the shared pool actually afforded: at 4 bullets a pull, a
 * typical starting reserve bought somewhere around a dozen shotgun shots *if
 * the player spent all of it there and left the pistol dry*. Twelve keeps
 * that ceiling while removing the trade-off, which is the point of the split.
 * Unmeasured — see `SHELLS_DROP_AMOUNT`.
 */
export const STARTING_SHELLS = 12;

/**
 * Ceiling on ammo carried into a level, as a multiple of what a *fresh* player
 * would start that same level holding.
 *
 * **The generator has no repo-size normalisation except map dimension**, and
 * carryover had none at all: `createPlayerState` took the previous level's
 * reserve unconditionally, so a campaign accumulated ammo while its opposition
 * did not scale. Solved across 23 repositories on `hard`, the median level's
 * clear ratio without farming ran **7.1 at levels 1-3 against 882.8 past level
 * 200** — a campaign trivialising itself, measured at **17.9x** median per-repo
 * drift (last eight levels over first eight).
 *
 * At 3 that drift becomes **1.8x** and the deep levels land at 23.9 rather than
 * 882.8, while levels 1-3 do not move at all (7.1 either way) — the cap is a
 * ceiling, and the early game is nowhere near it. The cost is that **410 of
 * 5,668 levels (7.2%) now need their drops picked up** to clear, against 29
 * before, which is the intended direction: farming was previously irrelevant.
 *
 * **No level becomes unclearable**: 4 on `hard` with the cap and 4 without,
 * unchanged. That is new — an earlier pricing showed the cap creating
 * unclearable levels, which turned out to be an artifact of the solver banking
 * every drop as bullets, harmless only while carryover was unbounded.
 *
 * 5 is the gentler setting (drift 2.3x, 291 levels needing farming) and 2 the
 * harsher (1.3x, 497, and it starts eating the early game at 6.3). The knee is
 * between 5 and 3; below 3 the returns are small and the cost is not.
 *
 * Applied per pool, so a pool the level cannot supply fresh (rockets before
 * ghidra is owned) is capped against its own flat reserve rather than zero.
 */
export const CARRYOVER_CAP_MULTIPLE = 3;

/**
 * Give the player enough bullets to clear the level with the pistol, plus a
 * generous margin, so the fight itself never grinds to a halt for lack of
 * ammo — but scattered ammo pickups are still meant to matter across a real
 * playthrough (missed shots, backtracking, mixing in the heavier shotgun),
 * not just be a nice-to-have. Scales with both total enemy HP (`shotsToClear`,
 * the theoretical perfect-accuracy cost) and raw enemy count (`missBuffer`,
 * covering the missed shots/repositioning a pack of separate encounters
 * costs that a flat HP-total multiplier alone wouldn't capture).
 *
 * **This pool now feeds the pistol alone.** It used to be shared with the
 * shotgun (4 bullets a pull), which is what the old note here meant by
 * "undercounts their cost" — so the same formula is strictly *more* generous
 * than it was, by whatever share of it a player used to spend on the shotgun.
 * Left unchanged deliberately rather than trimmed by a guess: it is one half
 * of a balance change that only a staged-repo capture can settle, and
 * trimming it here would confound that measurement with this one.
 */
function startingBullets(enemies: Enemy[]): number {
  const pistolDamage = WEAPONS[PISTOL_WEAPON_INDEX].damagePerPellet;
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
    shells: STARTING_SHELLS,
    rockets: STARTING_ROCKETS,
    smg: STARTING_SMG_AMMO,
    gas: STARTING_GAS_AMMO,
  };
}

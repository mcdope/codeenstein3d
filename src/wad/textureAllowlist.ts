// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hardcoded texture/flat names, one list per slot, tried in order — the
 * first name present in a loaded WAD wins; if none are, that slot falls
 * back to its procedural default (see `loadWad.ts`). No texture-picker UI:
 * this is the entire selection mechanism.
 *
 * Every candidate below has been verified end-to-end against a real Doom
 * IWAD by driving this repo's own parser (`pnames.ts`/`textureLump.ts`/
 * `compositeTexture.ts`/`flatLump.ts`) directly, not just checked for name
 * presence — each one decodes to real, fully-opaque pixels.
 */

export const WALL_TEXTURE_ALLOWLIST: readonly string[] = [
  "STARTAN3",
  "STONE2",
  "BROWN1",
  "TEKWALL4",
  "SUPPORT2",
  "METAL",
];

export const BONUS_WALL_TEXTURE_ALLOWLIST: readonly string[] = [
  "COMPBLUE",
  "COMPTALL",
  "SHAWN2",
  "TEKGREN2",
  "STARTAN2",
];

export const DOOR_TEXTURE_ALLOWLIST: readonly string[] = ["BIGDOOR2", "DOOR3", "DOOR1", "SPCDOOR1"];

export const FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["FLOOR4_8", "FLAT5_4", "FLOOR7_2", "FLOOR0_3"];

export const BONUS_FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["CEIL5_1", "FLOOR1_1", "FLAT1", "CEIL3_5"];

/** Wall-style composite texture for lore-terminal tiles — a computer-bank/
 * computer-station look, thematically fitting a terminal. Verified against a
 * real Doom IWAD (all five candidates decode). */
export const LORE_WALL_TEXTURE_ALLOWLIST: readonly string[] = [
  "COMPUTE2",
  "COMPUTE1",
  "COMPSTA2",
  "COMPSTA1",
  "SKINMET1",
];

/** Toxic-sludge flat for hazard (acid pool) tiles. */
export const HAZARD_FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["NUKAGE3", "NUKAGE2", "NUKAGE1", "FWATER1"];

/** Swirling teleporter-pad flat. */
export const TELEPORTER_FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["GATE1", "GATE2", "GATE3", "GATE4"];

/** Plain/metal flat shown while a spike trap is in its safe phase. */
export const SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["FLOOR7_1", "FLAT5_2", "CEIL5_2"];

/** Blood/lava flat shown while a spike trap is in its damaging phase. */
export const SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST: readonly string[] = ["BLOOD1", "BLOOD2", "LAVA1"];

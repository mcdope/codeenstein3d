// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hardcoded texture/flat names, one list per slot, tried in order — the
 * first name present in a loaded WAD wins; if none are, that slot falls
 * back to its procedural default (see `loadWad.ts`). No texture-picker UI:
 * this is the entire selection mechanism.
 *
 * Recalled from general Doom/Doom2 IWAD knowledge, not yet verified against
 * a real WAD binary (none exists in this repo/sandbox) — verifying at least
 * one name per list resolves against a real `doom.wad`/`doom2.wad`/
 * `freedoom1.wad` is a required gate before this feature ships (see
 * `wad-support-state.md`), not an optional follow-up.
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

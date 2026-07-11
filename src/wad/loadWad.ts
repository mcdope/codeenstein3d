// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Sole public entry point for `src/wad/` — parses a DOOM WAD `ArrayBuffer`
 * and pulls out real wall/door/floor textures for the 5 slots this game
 * uses, auto-selecting from a hardcoded name allowlist per slot (see
 * `textureAllowlist.ts`). Never throws: any fatal parse failure (bad magic,
 * an out-of-range lump offset that trips a `DataView` `RangeError`) is
 * caught and reported via `ok`/`error`. A slot with no matching name in the
 * WAD, or whose composite data turned out corrupt, simply comes back
 * `null` — every other slot still resolves independently (see
 * `resolveCompositeSlot`/`resolveFlatSlot`'s per-candidate try/catch).
 */
import { compositeTexture, type WadTexturePixels } from "./compositeTexture";
import { findFlat, parseFlat } from "./flatLump";
import { parsePlaypal, type Palette } from "./playpal";
import { parsePnames } from "./pnames";
import {
  BONUS_FLOOR_TEXTURE_ALLOWLIST,
  BONUS_WALL_TEXTURE_ALLOWLIST,
  DOOR_TEXTURE_ALLOWLIST,
  FLOOR_TEXTURE_ALLOWLIST,
  WALL_TEXTURE_ALLOWLIST,
} from "./textureAllowlist";
import { parseTextureLump, type TextureDef } from "./textureLump";
import { findLump, parseLumpDirectory, parseWadHeader, type LumpEntry } from "./wadFile";

export interface WadLoadResult {
  ok: boolean;
  error: string | null;
  wallName: string | null;
  bonusWallName: string | null;
  doorName: string | null;
  floorName: string | null;
  bonusFloorName: string | null;
  wallTexture: WadTexturePixels | null;
  bonusWallTexture: WadTexturePixels | null;
  doorTexture: WadTexturePixels | null;
  floorTexture: WadTexturePixels | null;
  bonusFloorTexture: WadTexturePixels | null;
}

function emptyResult(error: string | null): WadLoadResult {
  return {
    ok: error === null,
    error,
    wallName: null,
    bonusWallName: null,
    doorName: null,
    floorName: null,
    bonusFloorName: null,
    wallTexture: null,
    bonusWallTexture: null,
    doorTexture: null,
    floorTexture: null,
    bonusFloorTexture: null,
  };
}

interface SlotResult {
  name: string | null;
  texture: WadTexturePixels | null;
}

/** Tries each allowlisted name against `defs` in order; the first one
 * present wins. A composite failure for one candidate (corrupt patch data)
 * is skipped rather than aborting the whole slot — the next name on the
 * list still gets a chance. */
function resolveCompositeSlot(
  allowlist: readonly string[],
  defs: Map<string, TextureDef>,
  pnames: string[],
  lumps: LumpEntry[],
  view: DataView,
  palette: Palette,
): SlotResult {
  for (const name of allowlist) {
    const def = defs.get(name);
    if (!def) continue;
    try {
      return { name, texture: compositeTexture(def, pnames, (n) => findLump(lumps, n), view, palette) };
    } catch {
      continue;
    }
  }
  return { name: null, texture: null };
}

function resolveFlatSlot(
  allowlist: readonly string[],
  lumps: LumpEntry[],
  view: DataView,
  palette: Palette,
): SlotResult {
  for (const name of allowlist) {
    const lump = findFlat(lumps, name);
    if (!lump) continue;
    try {
      return { name, texture: parseFlat(view, lump, palette) };
    } catch {
      continue;
    }
  }
  return { name: null, texture: null };
}

export function loadWadTextures(bytes: ArrayBuffer): WadLoadResult {
  try {
    const view = new DataView(bytes);
    const header = parseWadHeader(view);
    const lumps = parseLumpDirectory(view, header);

    const playpalLump = findLump(lumps, "PLAYPAL");
    if (!playpalLump) return emptyResult(null); // nothing decodable without a palette — clean fallback, not an error
    const palette = parsePlaypal(view, playpalLump);

    const result = emptyResult(null);

    const pnamesLump = findLump(lumps, "PNAMES");
    const texture1Lump = findLump(lumps, "TEXTURE1");
    const texture2Lump = findLump(lumps, "TEXTURE2");
    if (pnamesLump && (texture1Lump || texture2Lump)) {
      const pnames = parsePnames(view, pnamesLump);
      const defs = new Map<string, TextureDef>();
      if (texture1Lump) for (const [name, def] of parseTextureLump(view, texture1Lump)) defs.set(name, def);
      if (texture2Lump) for (const [name, def] of parseTextureLump(view, texture2Lump)) defs.set(name, def);

      const wall = resolveCompositeSlot(WALL_TEXTURE_ALLOWLIST, defs, pnames, lumps, view, palette);
      result.wallName = wall.name;
      result.wallTexture = wall.texture;

      const bonusWall = resolveCompositeSlot(BONUS_WALL_TEXTURE_ALLOWLIST, defs, pnames, lumps, view, palette);
      result.bonusWallName = bonusWall.name;
      result.bonusWallTexture = bonusWall.texture;

      const door = resolveCompositeSlot(DOOR_TEXTURE_ALLOWLIST, defs, pnames, lumps, view, palette);
      result.doorName = door.name;
      result.doorTexture = door.texture;
    }

    const floor = resolveFlatSlot(FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);
    result.floorName = floor.name;
    result.floorTexture = floor.texture;

    const bonusFloor = resolveFlatSlot(BONUS_FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);
    result.bonusFloorName = bonusFloor.name;
    result.bonusFloorTexture = bonusFloor.texture;

    return result;
  } catch (err) {
    return emptyResult(err instanceof Error ? err.message : "Failed to parse WAD file.");
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Sole public entry point for `src/wad/` — parses a DOOM WAD `ArrayBuffer`
 * and pulls out real textures/flats for the slots this game uses:
 * three *structural* slots (wall, floor, door) resolved separately **for each
 * styleset**, plus five *gameplay-signal* slots (lore-terminal wall, hazard
 * floor, teleporter floor, spike-trap safe/active floor) resolved once and
 * shared by every styleset. Selection is a hardcoded name allowlist per slot
 * (see `textureAllowlist.ts`).
 *
 * Never throws: any fatal parse failure (bad magic, an out-of-range lump
 * offset that trips a `DataView` `RangeError`) is caught and reported via
 * `ok`/`error`. A slot with no match anywhere, or whose composite data turned
 * out corrupt, simply comes back `null` — every other slot still resolves
 * independently (see `resolveCompositeSlot`/`resolveFlatSlot`'s per-candidate
 * try/catch) and `src/engine/textures.ts` fills it with that styleset's
 * procedural default.
 *
 * See `doc/dev/wad-texture-packs.md` for the pack-author view of all of this:
 * the required lumps, the format limits that silently drop a slot, and the
 * fallback chain `candidatesFor` implements below.
 */
import { STYLE_SET_IDS, type StyleSetId } from "../map/types";
import { compositeTexture, type WadTexturePixels } from "./compositeTexture";
import { findFlat, parseFlat } from "./flatLump";
import { parsePlaypal, type Palette } from "./playpal";
import { parsePnames } from "./pnames";
import {
  HAZARD_FLOOR_TEXTURE_ALLOWLIST,
  LORE_WALL_TEXTURE_ALLOWLIST,
  SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST,
  STYLE_WAD_ALLOWLISTS,
  TELEPORTER_FLOOR_TEXTURE_ALLOWLIST,
} from "./textureAllowlist";
import { parseTextureLump, type TextureDef } from "./textureLump";
import { findLump, parseLumpDirectory, parseWadHeader, type LumpEntry } from "./wadFile";

/** One resolved slot: which allowlisted name matched (`null` if none did) and
 * its decoded pixels. The two are always both set or both `null`. */
export interface WadSlot {
  name: string | null;
  texture: WadTexturePixels | null;
}

/** The structural slots, resolved for one styleset. */
export interface WadStyleSlots {
  wall: WadSlot;
  floor: WadSlot;
  door: WadSlot;
}

/** The gameplay-signal slots — one set, shared by every styleset. */
export interface WadSignalSlots {
  loreWall: WadSlot;
  hazardFloor: WadSlot;
  teleporterFloor: WadSlot;
  spikeSafeFloor: WadSlot;
  spikeActiveFloor: WadSlot;
}

export interface WadLoadResult {
  ok: boolean;
  error: string | null;
  styles: Record<StyleSetId, WadStyleSlots>;
  signals: WadSignalSlots;
}

/** Which structural slot is being resolved — the key into a
 * `WadStyleAllowlist`, used to walk the *other* stylesets' lists for the same
 * slot during cross-styleset fallback. */
type StructuralSlot = keyof WadStyleSlots;

const EMPTY_SLOT: WadSlot = { name: null, texture: null };

function emptySlot(): WadSlot {
  return { ...EMPTY_SLOT };
}

function emptyResult(error: string | null): WadLoadResult {
  const styles = {} as Record<StyleSetId, WadStyleSlots>;
  for (const id of STYLE_SET_IDS) {
    styles[id] = { wall: emptySlot(), floor: emptySlot(), door: emptySlot() };
  }
  return {
    ok: error === null,
    error,
    styles,
    signals: {
      loreWall: emptySlot(),
      hazardFloor: emptySlot(),
      teleporterFloor: emptySlot(),
      spikeSafeFloor: emptySlot(),
      spikeActiveFloor: emptySlot(),
    },
  };
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
): WadSlot {
  for (const name of allowlist) {
    const def = defs.get(name);
    if (!def) continue;
    try {
      return { name, texture: compositeTexture(def, pnames, (n) => findLump(lumps, n), view, palette) };
    } catch {
      continue;
    }
  }
  return emptySlot();
}

function resolveFlatSlot(allowlist: readonly string[], lumps: LumpEntry[], view: DataView, palette: Palette): WadSlot {
  for (const name of allowlist) {
    const lump = findFlat(lumps, name);
    if (!lump) continue;
    try {
      return { name, texture: parseFlat(view, lump, palette) };
    } catch {
      continue;
    }
  }
  return emptySlot();
}

/**
 * Candidate names for one styleset's structural slot, in fallback order: that
 * styleset's own list first, then every *other* styleset's list for the same
 * slot, in `STYLE_SET_IDS` order.
 *
 * The tail matters. Resolving each styleset strictly in isolation would mean a
 * sparse WAD (the DOOM shareware IWAD, a small texture pack) leaves one
 * styleset fully WAD-textured and the next fully on programmer art — the
 * player would see the campaign flip between "real textures" and "defaults"
 * from level to level, which reads as a bug rather than as variety. Falling
 * through to a sibling styleset's candidates keeps a WAD session coherently
 * all-WAD; the price is that on a sparse WAD two stylesets may land on the
 * same texture, which is a much gentler failure. Only when no styleset has
 * anything for that slot does it drop to the procedural default (handled by
 * `src/engine/textures.ts`).
 *
 * Duplicates across the concatenated lists are harmless — a name that already
 * failed simply fails the same way again, at the cost of one `Map` lookup.
 */
function candidatesFor(style: StyleSetId, slot: StructuralSlot): readonly string[] {
  const own = STYLE_WAD_ALLOWLISTS[style][slot];
  const siblings = STYLE_SET_IDS.filter((id) => id !== style).flatMap((id) => STYLE_WAD_ALLOWLISTS[id][slot]);
  return [...own, ...siblings];
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

      for (const style of STYLE_SET_IDS) {
        // Deliberately re-composited per styleset even when two of them land
        // on the same name: `bitmapFromWadPixels` (textures.ts) mutates the
        // returned buffer in place with that slot's own hole-fill colour, so
        // sharing one buffer between two stylesets would corrupt whichever
        // got filled second.
        result.styles[style].wall = resolveCompositeSlot(
          candidatesFor(style, "wall"),
          defs,
          pnames,
          lumps,
          view,
          palette,
        );
        result.styles[style].door = resolveCompositeSlot(
          candidatesFor(style, "door"),
          defs,
          pnames,
          lumps,
          view,
          palette,
        );
      }

      result.signals.loreWall = resolveCompositeSlot(
        LORE_WALL_TEXTURE_ALLOWLIST,
        defs,
        pnames,
        lumps,
        view,
        palette,
      );
    }

    for (const style of STYLE_SET_IDS) {
      result.styles[style].floor = resolveFlatSlot(candidatesFor(style, "floor"), lumps, view, palette);
    }

    result.signals.hazardFloor = resolveFlatSlot(HAZARD_FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);
    result.signals.teleporterFloor = resolveFlatSlot(TELEPORTER_FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);
    result.signals.spikeSafeFloor = resolveFlatSlot(SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);
    result.signals.spikeActiveFloor = resolveFlatSlot(SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST, lumps, view, palette);

    return result;
  } catch (err) {
    return emptyResult(err instanceof Error ? err.message : "Failed to parse WAD file.");
  }
}

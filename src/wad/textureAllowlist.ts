// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hardcoded texture/flat names, tried in order — the first name present in a
 * loaded WAD wins. There is no texture-picker UI: this is the entire
 * selection mechanism.
 *
 * Two shapes, because only some surfaces vary by styleset:
 *
 * - `STYLE_WAD_ALLOWLISTS` — the *structural* slots (wall, floor, door), one
 *   list per slot **per styleset**, so a WAD-textured session gets the same
 *   per-level visual variety the procedural defaults do. Each styleset's names
 *   were grouped to match that styleset's procedural palette (see
 *   `STYLE_PALETTES` in `src/engine/textures.ts`), so swapping a WAD in
 *   doesn't make a "marble" level suddenly read as rust.
 * - The `*_TEXTURE_ALLOWLIST` constants below — the *gameplay-signal* slots
 *   (lore terminal, hazard, teleporter, spike safe/active), which are
 *   deliberately identical in every styleset so their meaning never shifts
 *   from level to level.
 *
 * Every candidate here must decode to real, fully-opaque pixels through this
 * repo's own parser (`pnames.ts`/`textureLump.ts`/`compositeTexture.ts`/
 * `flatLump.ts`) against a real WAD — presence of the name alone is not
 * enough. `scripts/report-wad-styleset-coverage.mjs` prints the full
 * styleset x slot resolution matrix across every catalog WAD and is how that
 * bar is checked when this list changes.
 *
 * `doc/dev/wad-texture-packs.md` is the contributor-facing version of this
 * file: the same table, plus what a WAD must actually contain to work as a
 * texture pack (required lumps, the 4096-byte flat rule, the unsupported
 * tall-patch encoding) and the checklist for adding a candidate here.
 */
import type { StyleSetId } from "../map/types";

/** The three structural slots a styleset varies. */
export interface WadStyleAllowlist {
  readonly wall: readonly string[];
  readonly floor: readonly string[];
  readonly door: readonly string[];
}

/**
 * Per-styleset candidates for the structural slots. A slot with no match in a
 * given WAD does *not* immediately fall back to programmer art — see
 * `loadWad.ts`'s cross-styleset fallback, which first tries the other
 * stylesets' candidates for the same slot so a sparse WAD degrades to "some
 * stylesets look alike" rather than "some levels are WAD-textured and others
 * aren't".
 */
export const STYLE_WAD_ALLOWLISTS: Readonly<Record<StyleSetId, WadStyleAllowlist>> = {
  stone: {
    wall: ["STONE2", "STONE3", "BROWN1", "STONE", "BROWNGRN"],
    floor: ["FLAT5_4", "FLOOR7_2", "FLOOR0_3", "FLAT10"],
    door: ["DOOR3", "DOOR1", "BIGDOOR4"],
  },
  rust: {
    wall: ["METAL", "BROWN96", "BROWNPIP", "SUPPORT3", "METAL1"],
    floor: ["FLOOR0_1", "FLAT5_2", "FLOOR3_3", "FLAT5_5"],
    door: ["BIGDOOR1", "BIGDOOR2", "DOOR1"],
  },
  tech: {
    wall: ["STARTAN3", "TEKWALL4", "SUPPORT2", "STARTAN1", "TEKWALL1"],
    floor: ["FLOOR4_8", "FLOOR0_6", "FLAT14", "FLOOR5_1"],
    door: ["SPCDOOR1", "BIGDOOR2", "DOOR3"],
  },
  marble: {
    // GRAY4/GRAYTALL sit third and fourth on purpose: MARBLE* is the better
    // match for this palette but is absent from the DOOM shareware IWAD and
    // from HACX, where without a pale fallback of its own `marble` would
    // borrow `stone`'s STONE2 and the two stylesets would look identical.
    // Both greys were confirmed present and decodable in every catalog WAD by
    // `scripts/report-wad-styleset-coverage.mjs`.
    wall: ["MARBLE1", "MARBLE2", "GRAY4", "GRAYTALL", "GRAY1", "GRAYBIG", "MARBFACE"],
    floor: ["FLAT1", "FLOOR1_1", "CEIL3_5", "FLAT18"],
    door: ["BIGDOOR5", "BIGDOOR6", "DOOR3"],
  },
  techCool: {
    wall: ["COMPBLUE", "COMPTALL", "SHAWN2", "TEKGREN2", "STARTAN2"],
    floor: ["CEIL5_1", "FLOOR1_1", "FLAT1", "CEIL3_5"],
    door: ["BIGDOOR2", "DOOR3", "DOOR1"],
  },
};

/** Wall-style composite texture for lore-terminal tiles — a computer-bank/
 * computer-station look, thematically fitting a terminal. Shared by every
 * styleset: a lore terminal has to stay recognisable as one. */
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

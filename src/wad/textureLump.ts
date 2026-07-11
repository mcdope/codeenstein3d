// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `TEXTURE1`/`TEXTURE2`: definitions of composite wall/door textures, each
 * built from one or more named patches placed at fixed offsets. Layout:
 * `int32 numtextures`, then `int32[numtextures]` offsets (relative to the
 * start of this lump) to each `maptexture_t`:
 *   `char[8] name`, `int32 masked` (unused), `int16 width`, `int16 height`,
 *   `int32 columndirectory` (obsolete, unused but still present), `int16
 *   patchcount`, then `patchcount × mappatch_t` (10 bytes each): `int16
 *   originx`, `int16 originy`, `int16 patch` (index into PNAMES), `int16
 *   stepdir` (unused), `int16 colormap` (unused).
 */
import { readPaddedName, type LumpEntry } from "./wadFile";

export interface PatchPlacement {
  originX: number;
  originY: number;
  /** Index into the PNAMES list. */
  patchIndex: number;
}

export interface TextureDef {
  name: string;
  width: number;
  height: number;
  patches: PatchPlacement[];
}

const MAPTEXTURE_HEADER_SIZE = 22;
const MAPPATCH_SIZE = 10;

export function parseTextureLump(view: DataView, lump: LumpEntry): Map<string, TextureDef> {
  const defs = new Map<string, TextureDef>();
  const numTextures = view.getInt32(lump.filePos, true);

  for (let i = 0; i < numTextures; i++) {
    const texOffset = lump.filePos + view.getInt32(lump.filePos + 4 + i * 4, true);
    const name = readPaddedName(view, texOffset, 8);
    const width = view.getInt16(texOffset + 12, true);
    const height = view.getInt16(texOffset + 14, true);
    const patchCount = view.getInt16(texOffset + 20, true);

    const patches: PatchPlacement[] = [];
    for (let p = 0; p < patchCount; p++) {
      const patchOffset = texOffset + MAPTEXTURE_HEADER_SIZE + p * MAPPATCH_SIZE;
      patches.push({
        originX: view.getInt16(patchOffset, true),
        originY: view.getInt16(patchOffset + 2, true),
        patchIndex: view.getInt16(patchOffset + 4, true),
      });
    }
    defs.set(name, { name, width, height, patches });
  }
  return defs;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Flattens a `TextureDef`'s patches into one RGBA buffer, painting each
 * patch in listed order (later patches over earlier ones, matching Doom's
 * own compositing order) via the palette. Pixels never covered by any patch
 * stay fully transparent (`alpha === 0`) — this module doesn't fill "holes"
 * with a fallback color; that's the engine layer's job (`textures.ts`), to
 * keep this module a plain byte-in/byte-out transform with no notion of the
 * game's flat-color theme.
 */
import type { LumpEntry } from "./wadFile";
import { parsePatch } from "./patch";
import type { Palette } from "./playpal";
import type { TextureDef } from "./textureLump";

export interface WadTexturePixels {
  width: number;
  height: number;
  /** `width * height * 4` bytes, row-major RGBA. */
  rgba: Uint8ClampedArray;
}

export function compositeTexture(
  def: TextureDef,
  pnames: string[],
  findLump: (name: string) => LumpEntry | undefined,
  view: DataView,
  palette: Palette,
): WadTexturePixels {
  const rgba = new Uint8ClampedArray(def.width * def.height * 4); // zero-init: fully transparent

  for (const placement of def.patches) {
    const patchName = pnames[placement.patchIndex];
    if (!patchName) continue;
    const lump = findLump(patchName);
    if (!lump) continue;

    const patch = parsePatch(view, lump);
    for (let x = 0; x < patch.columns.length; x++) {
      const destX = placement.originX + x;
      if (destX < 0 || destX >= def.width) continue;

      for (const post of patch.columns[x]) {
        for (let i = 0; i < post.pixels.length; i++) {
          const destY = placement.originY + post.topDelta + i;
          if (destY < 0 || destY >= def.height) continue;

          const [r, g, b] = palette[post.pixels[i]] ?? [0, 0, 0];
          const di = (destY * def.width + destX) * 4;
          rgba[di] = r;
          rgba[di + 1] = g;
          rgba[di + 2] = b;
          rgba[di + 3] = 255;
        }
      }
    }
  }

  return { width: def.width, height: def.height, rgba };
}

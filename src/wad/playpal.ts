// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `PLAYPAL`: 14 palettes of 256 RGB triples each (used in-game for damage
 * flash / radiation-suit tints). Only palette 0 (the normal palette) is
 * used here — the first 768 bytes of the lump.
 */
import type { LumpEntry } from "./wadFile";

export type Palette = [number, number, number][];

export function parsePlaypal(view: DataView, lump: LumpEntry): Palette {
  const palette: Palette = [];
  for (let i = 0; i < 256; i++) {
    const offset = lump.filePos + i * 3;
    palette.push([view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2)]);
  }
  return palette;
}

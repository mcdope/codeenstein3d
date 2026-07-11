// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Flats (used here as floor textures): raw 64×64 row-major palette-index
 * bytes, no posts/patches/transparency — structurally much simpler than a
 * composite wall texture. They live between marker lumps in the directory
 * (`F_START`/`F_END`, with `F1_START`/`F1_END` as an alternate pairing seen
 * in some IWADs). A lump inside that range sized anything other than 4096
 * bytes (standard Doom/Doom2 flats are always 64×64) is skipped as an
 * unsupported variant — out of scope.
 */
import type { LumpEntry } from "./wadFile";
import type { Palette } from "./playpal";
import type { WadTexturePixels } from "./compositeTexture";

const FLAT_SIZE = 64;
const FLAT_BYTES = FLAT_SIZE * FLAT_SIZE;

const FLAT_MARKER_PAIRS: [string, string][] = [
  ["F_START", "F_END"],
  ["F1_START", "F1_END"],
];

function findFlatRange(lumps: LumpEntry[]): { start: number; end: number } | null {
  for (const [startName, endName] of FLAT_MARKER_PAIRS) {
    const start = lumps.findIndex((l) => l.name === startName);
    const end = lumps.findIndex((l) => l.name === endName);
    if (start !== -1 && end !== -1 && end > start) return { start, end };
  }
  return null;
}

/** The named flat lump, if it's inside a flat marker block and is a
 * standard 64×64 (4096-byte) flat. */
export function findFlat(lumps: LumpEntry[], name: string): LumpEntry | null {
  const range = findFlatRange(lumps);
  if (!range) return null;
  for (let i = range.start + 1; i < range.end; i++) {
    if (lumps[i].name === name && lumps[i].size === FLAT_BYTES) return lumps[i];
  }
  return null;
}

export function parseFlat(view: DataView, lump: LumpEntry, palette: Palette): WadTexturePixels {
  const rgba = new Uint8ClampedArray(FLAT_BYTES * 4);
  for (let i = 0; i < FLAT_BYTES; i++) {
    const [r, g, b] = palette[view.getUint8(lump.filePos + i)] ?? [0, 0, 0];
    const di = i * 4;
    rgba[di] = r;
    rgba[di + 1] = g;
    rgba[di + 2] = b;
    rgba[di + 3] = 255;
  }
  return { width: FLAT_SIZE, height: FLAT_SIZE, rgba };
}

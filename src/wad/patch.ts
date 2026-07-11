// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A patch lump (picture format): `int16 width/height/leftoffset/topoffset`
 * (the offsets are unused here — a patch's placement in a composite texture
 * comes from the owning `mappatch_t`'s origin, not from this header), then
 * `int32[width] columnofs` (byte offsets from the start of this lump to each
 * column's post data). Each column is a run of "posts" — `u8 topdelta, u8
 * length, u8 pad, u8[length] palette-index pixels, u8 pad` — terminated by a
 * post whose `topdelta` is `0xFF`.
 *
 * Known, accepted limitation: the "tall patch" cumulative-topdelta encoding
 * (for patches taller than 254px) isn't handled — no shareware/registered
 * Doom/Doom2 IWAD wall patch needs it; only unusual custom PWADs might,
 * which is out of scope.
 */
import type { LumpEntry } from "./wadFile";

export interface Post {
  topDelta: number;
  /** Palette-index bytes, one per pixel in this run. */
  pixels: number[];
}

export interface Patch {
  width: number;
  height: number;
  /** `columns[x]` is that column's list of posts. */
  columns: Post[][];
}

const POST_TERMINATOR = 0xff;

export function parsePatch(view: DataView, lump: LumpEntry): Patch {
  const base = lump.filePos;
  const width = view.getInt16(base, true);
  const height = view.getInt16(base + 2, true);

  const columns: Post[][] = [];
  for (let x = 0; x < width; x++) {
    let offset = base + view.getInt32(base + 8 + x * 4, true);
    const posts: Post[] = [];
    for (;;) {
      const topDelta = view.getUint8(offset);
      if (topDelta === POST_TERMINATOR) break;
      const length = view.getUint8(offset + 1);
      const pixels: number[] = [];
      for (let i = 0; i < length; i++) {
        pixels.push(view.getUint8(offset + 3 + i));
      }
      posts.push({ topDelta, pixels });
      offset += 4 + length; // topdelta(1) + length(1) + pad(1) + pixels(length) + pad(1)
    }
    columns.push(posts);
  }
  return { width, height, columns };
}

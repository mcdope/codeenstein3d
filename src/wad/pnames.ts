// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `PNAMES`: the list of patch lump names a `TEXTURE1`/`TEXTURE2` definition
 * refers to by index. Layout: `int32 numpatches`, then `numpatches × char[8]`
 * names.
 */
import { readPaddedName, type LumpEntry } from "./wadFile";

export function parsePnames(view: DataView, lump: LumpEntry): string[] {
  const numPatches = view.getInt32(lump.filePos, true);
  const names: string[] = [];
  for (let i = 0; i < numPatches; i++) {
    names.push(readPaddedName(view, lump.filePos + 4 + i * 8, 8));
  }
  return names;
}

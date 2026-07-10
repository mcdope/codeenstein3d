// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Deterministic per-file map seed. */
import type { ParsedFile } from "../../parser/types";

/** Stable seed from the file's content signature (FNV-1a). */
export function seedFrom(parsed: ParsedFile): number {
  const signature =
    `${parsed.language}:${parsed.linesOfCode}:` +
    parsed.entities.map((e) => `${e.kind}/${e.name}/${e.complexityScore}`).join(",");
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

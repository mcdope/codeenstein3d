// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Deterministic per-file map seed. */
import type { ParsedFile } from "../../parser/types";

/**
 * FNV-1a over a string. Extracted from `seedFrom` so the second caller
 * (`placeTodoEncounter`, which derives a TODO's encounter kind from the
 * comment's own text) shares this one rather than carrying a copy — the
 * `ROCKET_TRAVEL_SPEED` drift is what two copies of a constant look like when
 * nothing links them.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable seed from the file's content signature (FNV-1a). */
export function seedFrom(parsed: ParsedFile): number {
  return fnv1a(
    `${parsed.language}:${parsed.linesOfCode}:` + parsed.entities.map((e) => `${e.kind}/${e.name}/${e.complexityScore}`).join(","),
  );
}

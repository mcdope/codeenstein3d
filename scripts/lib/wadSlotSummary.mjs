// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Shared summarising of a `loadWadTextures` result for the plain-Node scripts
 * (`fetch-online-wads.mjs`'s per-entry `[OK] n/m` line and
 * `report-wad-styleset-coverage.mjs`'s matrix).
 *
 * Deliberately mirrors `src/map/types.ts`'s `STYLE_SET_IDS` and the slot names
 * in `src/wad/loadWad.ts` rather than importing them: these scripts bundle
 * `src/wad/` through esbuild, which would drag `src/map/types.ts` in for one
 * array of strings. `summarizeWadSlots` throws if the result's styleset keys
 * don't match `STYLE_SET_IDS` below, so the duplication can't drift silently.
 */

/** Must match `STYLE_SET_IDS` in `src/map/types.ts`. */
export const STYLE_SET_IDS = ["stone", "rust", "tech", "marble", "techCool"];

/** The three slots that vary per styleset (`WadStyleSlots`). */
export const STRUCTURAL_SLOTS = ["wall", "floor", "door"];

/** The gameplay-signal slots, shared by every styleset (`WadSignalSlots`). */
export const SIGNAL_SLOTS = [
  "loreWall",
  "hazardFloor",
  "teleporterFloor",
  "spikeSafeFloor",
  "spikeActiveFloor",
];

export const TOTAL_SLOTS = STYLE_SET_IDS.length * STRUCTURAL_SLOTS.length + SIGNAL_SLOTS.length;

/**
 * `{ matched, total, styles, signals }` for one `WadLoadResult`, where
 * `styles[id][slot]` and `signals[slot]` are the matched name or `null`.
 */
export function summarizeWadSlots(result) {
  const actualIds = Object.keys(result.styles ?? {}).sort();
  const expectedIds = [...STYLE_SET_IDS].sort();
  if (actualIds.join(",") !== expectedIds.join(",")) {
    throw new Error(
      `styleset ids drifted: src/wad/ returned [${actualIds.join(", ")}], this script expects [${expectedIds.join(", ")}]`,
    );
  }

  const styles = {};
  let matched = 0;
  for (const id of STYLE_SET_IDS) {
    styles[id] = {};
    for (const slot of STRUCTURAL_SLOTS) {
      const name = result.styles[id][slot].name;
      styles[id][slot] = name;
      if (name) matched++;
    }
  }

  const signals = {};
  for (const slot of SIGNAL_SLOTS) {
    const name = result.signals[slot].name;
    signals[slot] = name;
    if (name) matched++;
  }

  return { matched, total: TOTAL_SLOTS, styles, signals };
}

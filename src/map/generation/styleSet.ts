// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Picks the one visual styleset a level keeps for its whole duration.
 *
 * The map layer deliberately only ever produces an opaque `StyleSetId` here —
 * it never learns what a wall *looks* like. `src/engine/textures.ts` owns the
 * id-to-pixels table. Same reasoning as `GenerateOptions.missingWeaponIndices`
 * (see `mapGenerator.ts`), where the map layer receives an opaque list of
 * numbers rather than an engine-layer weapon concept.
 *
 * **This never draws from `MapGenerator`'s `rng`, and must not start.** That
 * stream's draw *sequence* is load-bearing: `mapGenerator.ts`'s header warns
 * that reordering its `generation/*` calls changes every existing map layout,
 * which in turn invalidates every recorded replay and the shipped
 * `src/engine/defaultHighscore.ts` board. Taking even one value from it to
 * pick a wall colour would do exactly that, for a purely cosmetic reason. So
 * this runs its own single-draw `mulberry32` off the same `seedFrom(parsed)`
 * content hash instead: still fully deterministic per source file, still
 * identical on every multiplayer peer and on replay, but provably zero-impact
 * on layout.
 */
import { mulberry32 } from "../../prng";
import type { ParsedFile } from "../../parser/types";
import type { StyleSetId } from "../types";
import { seedFrom } from "./seed";

/**
 * Stylesets a normal combat level can draw. `stone` reproduces the exact
 * palette every level used before stylesets existed, so it reads as "one of
 * the variations" rather than as a re-theme of the game.
 */
export const NORMAL_STYLE_SETS: readonly StyleSetId[] = ["stone", "rust", "tech", "marble"];

/**
 * Bonus (restock-arena) levels always get this one, reproducing the cool teal
 * theme they already had — "this is a restock stop, not a fight" has to stay
 * an unambiguous signal, so it deliberately does not vary. `techCool` is
 * therefore never in `NORMAL_STYLE_SETS`: seeing it *means* bonus level.
 */
export const BONUS_STYLE_SET: StyleSetId = "techCool";

/** Mixed into the layout seed so a file's styleset isn't correlated with the
 * first draw of its layout stream — 0x5741_4c4c is ASCII `"WALL"`. */
const STYLE_SEED_SALT = 0x5741_4c4c;

/**
 * The styleset for a level generated from `parsed`. Pure and total: the same
 * file always yields the same id, forever, which is what makes a level look
 * the same across a replay, a re-run, and every peer of a multiplayer session.
 *
 * A dedicated `mulberry32` draw rather than `seedFrom(parsed) % length` — the
 * modulo would key the choice off FNV-1a's low bits, which are the least
 * scrambled part of that hash, and a real campaign's files (same language,
 * similar entity names) can land in the same bucket far more often than
 * chance. The demo campaign's spread is asserted in this module's test.
 */
export function styleSetFor(parsed: ParsedFile, bonusLevel: boolean): StyleSetId {
  if (bonusLevel) return BONUS_STYLE_SET;
  const pick = mulberry32((seedFrom(parsed) ^ STYLE_SEED_SALT) >>> 0)();
  return NORMAL_STYLE_SETS[Math.floor(pick * NORMAL_STYLE_SETS.length)];
}

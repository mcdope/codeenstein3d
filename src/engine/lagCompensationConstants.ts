// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The one lag-compensation tunable `RaycasterEngine` itself needs
 * (`rewoundEnemyPositions()`) — same tiny, dependency-free,
 * re-exported-by-`netcodeConstants.ts` shape as `reconciliationConstants.ts`/
 * `transitionConstants.ts` — see `reconciliationConstants.ts`'s own doc
 * comment for the full reasoning (engine layer never imports from the
 * multiplayer layer; `engine.ts` itself transitively imports `textures.ts`,
 * which touches `document` at module load).
 */

/** How many simulation ticks a sampled input is scheduled into the future
 * before it's actually applied — `netcodeConstants.ts`'s own doc comment has
 * the full "why" (giving the network time to deliver a tick's input before
 * it's due). Symmetrically, this is also exactly how far back
 * `RaycasterEngine.rewoundEnemyPositions()` must rewind a moving enemy's
 * position before hit-testing a multiplayer shot against it: by the time any
 * player's fire input actually executes, it represents a decision made this
 * many ticks ago, against a world that's since moved on. */
export const INPUT_DELAY_TICKS = 3;

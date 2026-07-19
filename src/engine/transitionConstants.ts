// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The one level-transition tunable `RaycasterEngine` itself needs
 * (`checkExit()` — `multiplayer-netcode-spec.md` §7). Same tiny,
 * dependency-free, re-exported-by-`netcodeConstants.ts` shape as
 * `reconciliationConstants.ts` — see that file's own doc comment for the
 * full reasoning (engine layer never imports from the multiplayer layer;
 * `engine.ts` itself transitively imports `textures.ts`, which touches
 * `document` at module load).
 */

/** How many simulation ticks a multiplayer session's exit countdown runs
 * for, once any living player first touches `map.exit` — 5s at
 * `TICK_RATE_HZ` (30, `netcodeConstants.ts`). A reasoned starting point, not
 * a validated value; real tuning needs actual playtest feedback. Expressed
 * in ticks, not milliseconds, so it survives unchanged regardless of tick
 * rate — the same reasoning `INPUT_DELAY_TICKS`/`RECONCILE_INTERVAL_TICKS`
 * already use. */
export const COUNTDOWN_TICKS = 150;

/** Purely a display conversion for the "Build finishing in Ns…" overlay
 * (`hud.ts`'s `drawExitCountdownToast`) — ticks-to-seconds needs a rate, but
 * this file can't import the real `TICK_RATE_HZ` (`netcodeConstants.ts`) for
 * the same engine-never-imports-multiplayer reason `COUNTDOWN_TICKS`'s own
 * doc comment gives. Kept in lockstep with `TICK_RATE_HZ` by hand — both are
 * effectively fixed by the wire protocol already, neither is expected to
 * change independently of the other. */
export const COUNTDOWN_DISPLAY_HZ = 30;

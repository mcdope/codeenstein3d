// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The two drift-correction tunables `RaycasterEngine` itself needs
 * (`applyReconciliationSnapshot()`/`render()` — `multiplayer-netcode-spec.md`
 * §4). Deliberately its own tiny, dependency-free file rather than exports
 * on `engine.ts` directly: `netcodeConstants.ts` (multiplayer layer)
 * re-exports these (the engine layer never imports from the multiplayer
 * layer, only the reverse — same reasoning as `reconciliationSnapshot.ts`),
 * and `engine.ts` itself transitively imports `textures.ts`, which touches
 * `document` at module load — pulling that whole graph into every
 * plain-Node consumer of `netcodeConstants.ts` (e.g. `tickClockWorker.ts`,
 * running in a Worker with no DOM) would break them. This file has no
 * imports of its own, so re-exporting it costs nothing.
 */

/** How long (real wall-clock milliseconds) a smoothed drift correction's
 * render offset takes to decay to zero — a reasoned starting point, not a
 * validated value; real tuning needs actual multi-peer network conditions.
 * Independent of the simulation tick rate: recomputed every `render()` call
 * from elapsed real time, not tick count. */
export const CORRECTION_SMOOTH_MS = 150;

/** Below this magnitude (in tiles), `applyReconciliationSnapshot()` uses the
 * smoothed render-offset treatment for a position correction; at or above
 * it, the correction snaps instantly with no smoothing at all — a mismatch
 * this large means something categorically worse than ordinary float drift
 * happened, and smoothing it over `CORRECTION_SMOOTH_MS` would read as
 * rubber-banding, not better netcode. */
export const SNAP_THRESHOLD_TILES = 0.5;

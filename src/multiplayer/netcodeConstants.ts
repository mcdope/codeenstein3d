// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Tuning constants for the netcode core (`doc/dev/multiplayer-netcode-spec.md`).
 * Reasoned starting points, not validated values — real tuning needs actual
 * multi-peer network conditions to validate against (see the spec's own "Open
 * tuning parameters" section). Grouped in one file so every tunable lives in
 * one obvious place rather than scattered across the modules that use them.
 */

/** Fixed simulation tick rate every peer ticks at — agreed once at session
 * setup, never a per-peer measured wall-clock rate (see the spec's "dt
 * unification" section for why: every peer's `performance.now()` drifts
 * slightly, which is unsafe once N peers must derive identical simulation
 * state from identical inputs). */
export const TICK_RATE_HZ = 30;

/** One simulation tick's duration, in seconds — the literal constant every
 * peer passes to `engine.simulate()`, every tick, never a measured value. */
export const FIXED_DT = 1 / TICK_RATE_HZ;

/** How many ticks in the future a sampled input is scheduled for, at
 * `TICK_RATE_HZ` (~100ms) — gives the network time to deliver a tick's input
 * before that tick is actually due, so ordinary latency doesn't stall the
 * session (see the spec's "Input delay buffer" section). */
export const INPUT_DELAY_TICKS = 3;

/** Conventional safe `RTCDataChannel` message chunk size in bytes — a real
 * message has a practical cross-browser size floor around 64 KiB, so a
 * chunked transfer (the session-setup `GameMap` payload) stays comfortably
 * under it. */
export const MAP_CHUNK_SIZE_BYTES = 16 * 1024;

/** How many ticks between the host's periodic `ReconciliationSnapshot`
 * broadcasts (once per second, at `TICK_RATE_HZ`). This is also the upper
 * bound on how long a PRNG-stream desync can persist before being corrected
 * (see `reconciliationTypes.ts`'s `rngState` doc comment) — a second
 * pressure on this value beyond bandwidth, worth weighing together once real
 * multi-peer data exists. */
export const RECONCILE_INTERVAL_TICKS = 30;

/** How long a peer's connection can sit in a non-`"connected"` transport
 * state before the other side treats it as gone (see
 * `doc/dev/multiplayer-netcode-spec.md` §5) — long enough to ride out a
 * brief ICE restart/network blip without dropping a still-recoverable peer,
 * short enough that a genuinely gone peer doesn't leave the session stalled
 * for long. A reasoned starting point, not a validated value, same caveat as
 * every other constant in this file. */
export const DISCONNECT_GRACE_MS = 10_000;

/** How long (real wall-clock milliseconds) the host waits for every
 * connected guest's `level-transition-ack` before proceeding to
 * `startLevel()` on the new payload anyway — a guest that never acks in
 * time is presumed gone and falls into the existing disconnect path via the
 * same connection-state signal, not a special case here. A reasoned
 * starting point, not a validated value, same caveat as every other
 * constant in this file. */
export const TRANSITION_ACK_TIMEOUT_MS = 10_000;

/** `CORRECTION_SMOOTH_MS`/`SNAP_THRESHOLD_TILES`/`COUNTDOWN_TICKS` live in
 * `engine/reconciliationConstants.ts`/`engine/transitionConstants.ts`, not
 * here, and are re-exported — `RaycasterEngine.applyReconciliationSnapshot()`/
 * `render()`/`checkExit()` need them directly, and the engine layer never
 * imports from the multiplayer layer (only the reverse), the same reasoning
 * `reconciliationTypes.ts` documents for the snapshot shape itself. Both
 * source files are deliberately tiny and import-free (not just re-exported
 * from `engine.ts` proper) — `engine.ts` transitively imports `textures.ts`,
 * which touches `document` at module load, which would break every
 * plain-Node consumer of this file (e.g. `tickClockWorker.ts`, running in a
 * Worker with no DOM). */
export { CORRECTION_SMOOTH_MS, SNAP_THRESHOLD_TILES } from "../engine/reconciliationConstants";
export { COUNTDOWN_TICKS } from "../engine/transitionConstants";

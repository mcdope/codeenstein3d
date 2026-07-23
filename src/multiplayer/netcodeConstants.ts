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

/** Above this much buffered-but-not-yet-transmitted data on a chunked
 * `RTCDataChannel` transfer (session setup's/a level transition's `GameMap`
 * payload), `sendJsonWithBackpressure()` pauses and waits for the buffer to
 * drain before sending more — real `RTCDataChannel.send()` calls have no
 * built-in flow control of their own, and firing many chunks synchronously
 * with none can overflow a channel's internal send buffer and throw
 * (confirmed directly: this was the real cause of a real, reproducible CI
 * failure — see that function's own doc comment). Sized relative to
 * `MAP_CHUNK_SIZE_BYTES` rather than an unrelated magic number — a handful
 * of chunks' worth of slack before backpressure kicks in. */
export const BACKPRESSURE_HIGH_WATERMARK_BYTES = MAP_CHUNK_SIZE_BYTES * 4;

/** The `bufferedAmountLowThreshold` `sendJsonWithBackpressure()` waits for
 * once paused — draining back down to roughly one chunk's worth before
 * resuming, not all the way to zero (that would mean waiting for the
 * transport to go fully idle between every pause, needlessly slow). */
export const BACKPRESSURE_LOW_THRESHOLD_BYTES = MAP_CHUNK_SIZE_BYTES;

/** Safety timeout on a backpressure wait — a buffer that never drains this
 * long indicates a genuinely broken channel, not ordinary flow control;
 * matches `TRANSITION_ACK_TIMEOUT_MS`'s own order of magnitude, the same
 * "never wait forever on something that might not happen" discipline this
 * file already applies elsewhere. */
export const BUFFER_DRAIN_TIMEOUT_MS = 10_000;

/** The largest `width`/`height` a guest will trust from a host-sent map
 * payload (initial session setup or a level transition) before allocating
 * its own `visited` grid — real generated maps top out at 160
 * (`mapGenerator.ts`'s own `maxSize`); this is a generous multiple of that,
 * not a tight validated bound. Without this, a tiny, well-formed payload
 * declaring absurd dimensions (e.g. `{"width":1e9,"height":1e9}`) passes
 * every existing chunk-count/byte cap (those bound wire size, not declared
 * dimensions) and triggers a multi-gigabyte `Array.from` allocation. */
export const MAX_TRANSFERRED_MAP_DIMENSION = 2048;

/** `CORRECTION_SMOOTH_MS`/`SNAP_THRESHOLD_TILES`/`COUNTDOWN_TICKS`/
 * `INPUT_DELAY_TICKS` live in `engine/reconciliationConstants.ts`/
 * `engine/transitionConstants.ts`/`engine/lagCompensationConstants.ts`, not
 * here, and are re-exported — `RaycasterEngine.applyReconciliationSnapshot()`/
 * `render()`/`checkExit()`/`rewoundEnemyPositions()` need them directly, and
 * the engine layer never imports from the multiplayer layer (only the
 * reverse), the same reasoning `reconciliationTypes.ts` documents for the
 * snapshot shape itself. Every source file is deliberately tiny and
 * import-free (not just re-exported from `engine.ts` proper) — `engine.ts`
 * transitively imports `textures.ts`, which touches `document` at module
 * load, which would break every plain-Node consumer of this file (e.g.
 * `tickClockWorker.ts`, running in a Worker with no DOM). */
export { CORRECTION_SMOOTH_MS, SNAP_THRESHOLD_TILES } from "../engine/reconciliationConstants";
export { COUNTDOWN_TICKS } from "../engine/transitionConstants";
export { INPUT_DELAY_TICKS } from "../engine/lagCompensationConstants";

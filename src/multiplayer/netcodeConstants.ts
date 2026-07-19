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

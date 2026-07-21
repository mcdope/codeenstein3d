// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wire shapes for the netcode core's per-tick lockstep traffic, over the
 * `input` data channel (see `doc/dev/multiplayer-netcode-spec.md`'s "Message
 * flow per tick" section) — session-setup handshake shapes (a later step)
 * live in their own module, over the `reconciliation` channel instead.
 */
import type { PlayerId } from "../engine/engine";
import type { InputSnapshot } from "../engine/input";

/** One player's sampled input for one tick — same shape `replay.ts`'s
 * `InputSnapshot` already records per-frame, reused as-is, not reinvented.
 * Sent guest -> host (and recorded locally by the host for its own input),
 * always tagged for a tick `INPUT_DELAY_TICKS` in the future. */
export interface TickInput {
  tick: number;
  playerId: PlayerId;
  input: InputSnapshot;
}

/** What the host broadcasts once a tick's input set is finalized — every
 * peer (host included) calls `engine.simulate(dt)` from this, never from its
 * own locally sampled input alone. */
export interface TickInputBundle {
  tick: number;
  /** Always `FIXED_DT` — included for a receiver-side sanity check, not
   * because it varies. */
  dt: number;
  inputs: Record<PlayerId, InputSnapshot>;
  /** playerIds whose input for this tick used the held-last-input fallback
   * (no real, on-time packet had arrived) — diagnostic-only. */
  heldInputFallback: PlayerId[];
  /** playerIds removed from the session effective this tick — the live
   * disconnect-removal signal (`multiplayer-research.md` step 8): the host
   * populates this the same tick a guest's disconnect grace expires
   * (`multiplayerSessionHost.ts`'s own `rosterRemovalsToApply`), and every
   * peer (host included) applies it via `engine.applyRosterRemoval()` before
   * that tick's `advance()`, the same synchronized-lockstep-event ordering
   * every other bundle field already uses. */
  rosterRemove?: PlayerId[];
}

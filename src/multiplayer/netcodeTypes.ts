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
  /** Always `FIXED_DT` — every peer's `dt` is structurally guaranteed to
   * agree for the whole session by the session-setup-time
   * `checkNetcodeConstantsMatch` hard-fail (`sessionSetupHost.ts`/
   * `sessionSetupGuest.ts`), not by any per-bundle comparison against this
   * field (there isn't one — a receiver just uses it directly). */
  dt: number;
  /** A purely local counter, incremented independently by the host and each
   * guest inside their own `startLevel()` call (never transmitted/agreed as
   * its own handshake) — host and guest advance it in lockstep, since both
   * sides call `startLevel()` exactly once per transition. Exists because
   * `input`/`reconciliation` are two independent WebRTC data channels with
   * no cross-channel ordering guarantee: a guest that's already swapped to a
   * new level (via a `reconciliation`-channel level-transition handshake)
   * can still receive one or more already-in-flight OLD-level
   * `TickInputBundle`s on the `input` channel afterward. A guest discards
   * any incoming bundle whose `levelEpoch` doesn't match its own current
   * one, rather than `engine.advance()`-ing a stale bundle against the
   * freshly-swapped engine. */
  levelEpoch: number;
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

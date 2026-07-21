// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Host-side input buffering and per-tick bundle finalization (see
 * `doc/dev/multiplayer-netcode-spec.md`'s "Input delay buffer" section).
 * Every peer samples and sends input for a tick `INPUT_DELAY_TICKS` ahead of
 * when it's actually due, giving the network time to deliver it; this class
 * buffers whatever has arrived, keyed by tick, and finalizes one canonical
 * `TickInputBundle` per due tick from it — holding a player's last-received
 * `InputSnapshot` if their real input for that tick hasn't arrived yet,
 * rather than stalling the whole session for one slow peer.
 */
import type { PlayerId } from "../engine/engine";
import type { InputSnapshot } from "../engine/input";
import { EMPTY_SNAPSHOT } from "../engine/replay";
import { INPUT_DELAY_TICKS } from "./netcodeConstants";
import type { TickInputBundle } from "./netcodeTypes";

/** How far behind `lastFinalizedTick` a `record()`'d tick is still accepted
 * — a genuinely late-but-real packet for a tick that's just about to
 * finalize (or was finalized moments ago) shouldn't be dropped outright, but
 * this must stay small: it's not a real "still useful" window (a finalized
 * tick's own entry is already deleted by `finalize()`), just tolerance for
 * ordinary jitter in *when* `record()`/`finalize()` calls interleave. */
const PAST_GRACE_TICKS = INPUT_DELAY_TICKS;

/** How far ahead of `lastFinalizedTick` a `record()`'d tick is still
 * accepted — every real sender only ever tags input `INPUT_DELAY_TICKS` into
 * the future (see `TickInput`'s own doc comment), so this is that plus a
 * small slack margin for ordinary network jitter, not a second independent
 * tunable. Anything further out than this is either a hostile peer or a
 * buggy one (e.g. replaying/fabricating tick numbers) — dropped rather than
 * buffered forever. */
const FUTURE_SLACK_TICKS = INPUT_DELAY_TICKS;

export class InputDelayBuffer {
  private readonly pending = new Map<number, Map<PlayerId, InputSnapshot>>();
  private readonly lastKnown = new Map<PlayerId, InputSnapshot>();
  /** The most recent tick `finalize()` has produced a bundle for, or `null`
   * before the first call — `record()`'s own bound-and-drop window (see
   * `PAST_GRACE_TICKS`/`FUTURE_SLACK_TICKS`) is centered on this. `null`
   * disables the bound entirely (nothing to center it on yet, and the real
   * in-flight window genuinely can't be known before the first `finalize()`
   * call — the very first ticks reasonably arrive well ahead, see
   * `INPUT_DELAY_TICKS`'s own bootstrap-transient behavior). */
  private lastFinalizedTick: number | null = null;

  /** Records one player's sampled input for a future tick, as it arrives —
   * over the network for a remote player, or immediately for the host's own
   * locally-sampled input (delayed the exact same way, per the spec, so the
   * host gets no built-in input-latency advantage). A `tick` outside the
   * real in-flight window around `lastFinalizedTick` is silently dropped
   * (no-op) rather than buffered — a hostile or buggy peer sending a
   * far-future or replayed tick number would otherwise grow `pending`
   * without bound, since only an actually-finalized tick's entry is ever
   * cleaned up (see `finalize()`'s own doc comment). Deliberately
   * bound-and-drop only: a dropped tick is simply never recorded, never
   * promoted into `lastKnown` — the same "held-last-input for a real gap,
   * not a substitute for real data" boundary `finalize()`'s own `graceIds`
   * handling already draws. */
  record(tick: number, playerId: PlayerId, input: InputSnapshot): void {
    if (
      this.lastFinalizedTick !== null &&
      (tick < this.lastFinalizedTick - PAST_GRACE_TICKS || tick > this.lastFinalizedTick + INPUT_DELAY_TICKS + FUTURE_SLACK_TICKS)
    ) {
      return;
    }
    let forTick = this.pending.get(tick);
    if (!forTick) {
      forTick = new Map();
      this.pending.set(tick, forTick);
    }
    forTick.set(playerId, input);
  }

  /**
   * Finalizes `tick`'s bundle from whatever has arrived for every player in
   * `rosterIds`: real input where present (which also becomes that player's
   * new held-fallback value for any later tick), else that player's last-
   * received snapshot, else — nothing ever received for this player at
   * all, not expected in normal operation — the neutral idle snapshot.
   * Never stalls: always returns a complete bundle, covering every roster
   * id. Drops the now-finalized tick's buffered entries afterward, so
   * `pending` never grows past the ticks genuinely still in flight.
   *
   * `graceIds` (a player currently inside its post-disconnect grace period —
   * see `DISCONNECT_GRACE_MS`) always gets the neutral idle snapshot for
   * this tick and skips the `lastKnown` update entirely, real input or not:
   * grace means genuinely inert (nobody's driving that player anymore, so it
   * should stand still, not keep repeating whatever it was last doing —
   * held-last-input is for a brief real-input gap, not a peer that's gone).
   */
  finalize(tick: number, rosterIds: readonly PlayerId[], dt: number, graceIds?: ReadonlySet<PlayerId>): TickInputBundle {
    const forTick = this.pending.get(tick);
    const inputs: Record<PlayerId, InputSnapshot> = {};
    const heldInputFallback: PlayerId[] = [];

    for (const playerId of rosterIds) {
      if (graceIds?.has(playerId)) {
        inputs[playerId] = EMPTY_SNAPSHOT;
        continue;
      }
      const real = forTick?.get(playerId);
      if (real) {
        inputs[playerId] = real;
        this.lastKnown.set(playerId, real);
      } else {
        inputs[playerId] = this.lastKnown.get(playerId) ?? EMPTY_SNAPSHOT;
        heldInputFallback.push(playerId);
      }
    }

    this.pending.delete(tick);
    // Recorded *after* the read above (this tick's own now-consumed entries
    // must never be judged against a window centered on themselves) —
    // re-centers `record()`'s own bound-and-drop window on the tick genuinely
    // now in progress, so `pending` can never accumulate far-future/replayed
    // tick numbers a hostile or buggy peer might send (see `record()`'s own
    // doc comment).
    this.lastFinalizedTick = tick;
    return { tick, dt, inputs, heldInputFallback };
  }

  /** Test-only: the number of distinct tick numbers currently buffered in
   * `pending` — the only way to observe `record()`'s own bound-and-drop
   * window actually keeping this bounded (see its own doc comment)
   * without exposing `pending` itself to real callers. */
  get pendingTickCountForTest(): number {
    return this.pending.size;
  }
}

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
import { TICK_RATE_HZ } from "./netcodeConstants";
import type { TickInputBundle } from "./netcodeTypes";

/** How far `lastFinalizedTick` and a `record()`'d tick may drift apart
 * (either direction) before the tick is dropped rather than buffered —
 * purely a DoS-prevention ceiling against a hostile/buggy peer replaying or
 * fabricating a wildly out-of-range tick number (see `record()`'s own doc
 * comment), *not* a per-packet network-jitter tolerance. That distinction
 * matters: this was originally tied to `INPUT_DELAY_TICKS` (3 ticks, 100ms)
 * on the assumption sender and finalizer stay in near-lockstep, but
 * `TickAccumulator.advance()`'s own doc comment already documents that a
 * real stall (a GC pause, a slow frame, real resource contention) can make
 * the tick-processing loop post *many* due ticks in one burst to catch up —
 * confirmed directly: a real CI run under heavy load needed 23/25 combat
 * retries and the host's own bot went from reliably surviving to dying
 * almost every attempt once this bound was tied to `INPUT_DELAY_TICKS`,
 * because a catch-up burst that size trivially exceeded a ~9-tick (300ms)
 * window, silently dropping the other peer's genuinely still-useful input
 * for the whole burst. Sized instead like `DISCONNECT_GRACE_MS` — a real,
 * generous "how long is an ordinary hiccup tolerated" budget (here, 10
 * seconds of ticks) — comfortably survives any realistic stall while still
 * being a real, bounded ceiling against actual abuse (a hostile tick number
 * many minutes away is still rejected). */
const MAX_TICK_DRIFT_TICKS = TICK_RATE_HZ * 10;

export class InputDelayBuffer {
  private readonly pending = new Map<number, Map<PlayerId, InputSnapshot>>();
  private readonly lastKnown = new Map<PlayerId, InputSnapshot>();
  /** The most recent tick `finalize()` has produced a bundle for, or `null`
   * before the first call — `record()`'s own bound-and-drop window (see
   * `MAX_TICK_DRIFT_TICKS`) is centered on this. `null` disables the bound
   * entirely (nothing to center it on yet, and the real in-flight window
   * genuinely can't be known before the first `finalize()` call — the very
   * first ticks reasonably arrive well ahead, see `INPUT_DELAY_TICKS`'s own
   * bootstrap-transient behavior). */
  private lastFinalizedTick: number | null = null;

  /** Records one player's sampled input for a future tick, as it arrives —
   * over the network for a remote player, or immediately for the host's own
   * locally-sampled input (delayed the exact same way, per the spec, so the
   * host gets no built-in input-latency advantage). A `tick` more than
   * `MAX_TICK_DRIFT_TICKS` away from `lastFinalizedTick` (either direction)
   * is silently dropped (no-op) rather than buffered — a hostile or buggy
   * peer sending a far-future or replayed tick number would otherwise grow
   * `pending` without bound, since only an actually-finalized tick's entry
   * is ever cleaned up (see `finalize()`'s own doc comment). A tick *at or
   * below* `lastFinalizedTick` is likewise dropped, even well inside that
   * drift window: `finalize()` is strictly monotonic and deletes only the
   * exact tick it finalizes, so a tick it has already passed can never be
   * revisited — a late/replayed packet for such a tick (one-way latency
   * exceeding `INPUT_DELAY_TICKS`, or a replay of a tick just behind the
   * current one) would re-create a `pending[tick]` entry under an
   * already-past key that `finalize()` will never match and sweep, leaking
   * one entry per stale packet forever (~30/sec/guest on a lossy link). The
   * far-drift bound above assumes records only ever land on *future* ticks
   * and so misses this near-past case on its own; both guards apply.
   * Deliberately
   * bound-and-drop only: a dropped tick is simply never recorded, never
   * promoted into `lastKnown` — the same "held-last-input for a real gap,
   * not a substitute for real data" boundary `finalize()`'s own `graceIds`
   * handling already draws.
   *
   * Callers must validate `tick`/`input` before calling this — this method
   * trusts both completely and does no runtime shape-checking of its own
   * (see `inputValidation.ts`'s `isValidWireTick`/`isValidInputSnapshot`,
   * used at this class's one real call site in `multiplayerSessionHost.ts`).
   * A non-numeric `tick` defeats the drift bound above via `NaN` comparisons
   * (always `false`, so the entry is buffered under a key `finalize()` can
   * never match and sweep — an unbounded leak); a malformed `input` gets
   * promoted into `lastKnown` and crashes every peer's input consumer later. */
  record(tick: number, playerId: PlayerId, input: InputSnapshot): void {
    if (this.lastFinalizedTick !== null && Math.abs(tick - this.lastFinalizedTick) > MAX_TICK_DRIFT_TICKS) {
      return;
    }
    // A tick `finalize()` has already produced a bundle for (or passed) can
    // never be finalized again — it's strictly monotonic and deletes only
    // the exact tick it finalizes. Buffering a late/replayed packet for such
    // a tick, even one inside the drift window above, is a pure leak: nothing
    // ever sweeps its `pending[tick]` entry. Drop it.
    if (this.lastFinalizedTick !== null && tick <= this.lastFinalizedTick) {
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
   *
   * Returns everything but `levelEpoch` — that field is a purely local
   * counter the session driver (not this buffer) tracks, incremented inside
   * its own `startLevel()` call (see `TickInputBundle.levelEpoch`'s own doc
   * comment); the caller stamps it onto the bundle this returns before
   * broadcasting it.
   */
  finalize(tick: number, rosterIds: readonly PlayerId[], dt: number, graceIds?: ReadonlySet<PlayerId>): Omit<TickInputBundle, "levelEpoch"> {
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

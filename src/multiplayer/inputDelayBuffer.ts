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
import type { TickInputBundle } from "./netcodeTypes";

export class InputDelayBuffer {
  private readonly pending = new Map<number, Map<PlayerId, InputSnapshot>>();
  private readonly lastKnown = new Map<PlayerId, InputSnapshot>();

  /** Records one player's sampled input for a future tick, as it arrives —
   * over the network for a remote player, or immediately for the host's own
   * locally-sampled input (delayed the exact same way, per the spec, so the
   * host gets no built-in input-latency advantage). */
  record(tick: number, playerId: PlayerId, input: InputSnapshot): void {
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
   */
  finalize(tick: number, rosterIds: readonly PlayerId[], dt: number): TickInputBundle {
    const forTick = this.pending.get(tick);
    const inputs: Record<PlayerId, InputSnapshot> = {};
    const heldInputFallback: PlayerId[] = [];

    for (const playerId of rosterIds) {
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
    return { tick, dt, inputs, heldInputFallback };
  }
}

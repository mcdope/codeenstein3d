// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { EMPTY_SNAPSHOT } from "../engine/replay";
import type { InputSnapshot } from "../engine/input";
import { InputDelayBuffer } from "./inputDelayBuffer";
import { TICK_RATE_HZ } from "./netcodeConstants";

// Mirrors inputDelayBuffer.ts's own MAX_TICK_DRIFT_TICKS exactly (not exported —
// a DoS-prevention ceiling, not something real callers should ever need to know).
const MAX_TICK_DRIFT_TICKS = TICK_RATE_HZ * 10;

function snapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

describe("InputDelayBuffer", () => {
  it("uses real recorded input for a tick when every roster player's input arrived", () => {
    const buffer = new InputDelayBuffer();
    const p1Input = snapshot({ fireQueued: true });
    const p2Input = snapshot({ mouseDX: 5 });
    buffer.record(10, "p1", p1Input);
    buffer.record(10, "p2", p2Input);

    const bundle = buffer.finalize(10, ["p1", "p2"], 1 / 30);
    expect(bundle).toEqual({
      tick: 10,
      dt: 1 / 30,
      inputs: { p1: p1Input, p2: p2Input },
      heldInputFallback: [],
    });
  });

  it("holds a player's last-received snapshot when their real input for this tick hasn't arrived", () => {
    const buffer = new InputDelayBuffer();
    const p1Tick10 = snapshot({ fireQueued: true });
    buffer.record(10, "p1", p1Tick10);
    buffer.record(10, "p2", snapshot({ mouseDX: 1 }));
    buffer.finalize(10, ["p1", "p2"], 1 / 30); // establishes p1's lastKnown

    buffer.record(11, "p2", snapshot({ mouseDX: 2 })); // p1's tick-11 input never arrives
    const bundle = buffer.finalize(11, ["p1", "p2"], 1 / 30);

    expect(bundle.inputs.p1).toEqual(p1Tick10); // held from tick 10
    expect(bundle.heldInputFallback).toEqual(["p1"]);
  });

  it("falls back to the neutral idle snapshot for a player nothing was ever recorded for", () => {
    const buffer = new InputDelayBuffer();
    const bundle = buffer.finalize(0, ["p1"], 1 / 30);
    expect(bundle.inputs.p1).toEqual(EMPTY_SNAPSHOT);
    expect(bundle.heldInputFallback).toEqual(["p1"]);
  });

  it("never stalls: finalize always returns a complete bundle covering every roster id", () => {
    const buffer = new InputDelayBuffer();
    const bundle = buffer.finalize(5, ["a", "b", "c"], 1 / 30);
    expect(Object.keys(bundle.inputs).sort()).toEqual(["a", "b", "c"]);
  });

  it("drops a finalized tick's buffered entries so pending never grows unbounded", () => {
    const buffer = new InputDelayBuffer();
    buffer.record(1, "p1", snapshot({ fireQueued: true }));
    buffer.finalize(1, ["p1"], 1 / 30);
    // Re-recording under the same (already-finalized) tick number should
    // start from a clean slate, not silently reuse a stale buffered entry
    // that finalize() should have discarded.
    const bundle = buffer.finalize(1, ["p1"], 1 / 30);
    expect(bundle.inputs.p1).toEqual(snapshot({ fireQueued: true })); // held from the first finalize's lastKnown update
    expect(bundle.heldInputFallback).toEqual(["p1"]);
  });

  it("only marks players actually missing real input as held, in a mixed roster", () => {
    const buffer = new InputDelayBuffer();
    buffer.record(3, "p1", snapshot({ fireQueued: true }));
    const bundle = buffer.finalize(3, ["p1", "p2", "p3"], 1 / 30);
    expect(bundle.heldInputFallback.sort()).toEqual(["p2", "p3"]);
  });

  describe("record() bounds pending against out-of-window tick values (finding 5)", () => {
    it("drops wildly out-of-window tick values (far-future/replayed) instead of buffering them forever", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(0, "p1", snapshot());
      buffer.finalize(0, ["p1"], 1 / 30); // establishes lastFinalizedTick = 0
      expect(buffer.pendingTickCountForTest).toBe(0);

      // A hostile/buggy peer sending wildly out-of-window tick numbers —
      // neither should ever be buffered.
      buffer.record(1_000_000, "p1", snapshot({ fireQueued: true }));
      buffer.record(-1_000_000, "p1", snapshot({ fireQueued: true }));
      expect(buffer.pendingTickCountForTest).toBe(0);

      // Finalizing normally through the real in-flight range afterward is
      // unaffected — pending never grew, and ordinary operation still works.
      for (let tick = 1; tick <= 5; tick++) {
        buffer.record(tick, "p1", snapshot({ mouseDX: tick }));
        const bundle = buffer.finalize(tick, ["p1"], 1 / 30);
        expect(bundle.inputs.p1).toEqual(snapshot({ mouseDX: tick }));
      }
      expect(buffer.pendingTickCountForTest).toBe(0);
    });

    it("accepts a tick exactly at the future edge of the window, drops one just past it", () => {
      const buffer = new InputDelayBuffer();
      buffer.finalize(100, [], 1 / 30); // establishes lastFinalizedTick = 100, nothing to record

      // The future edge (lastFinalizedTick + MAX_TICK_DRIFT_TICKS) must still
      // be accepted, since this is a DoS-prevention ceiling (see the
      // constant's own doc comment), not a tight per-packet-jitter tolerance —
      // it must survive a real stall/catch-up burst, not just ordinary network
      // timing. (The *past* edge is a different story: any tick <=
      // lastFinalizedTick is dropped by record()'s already-finalized guard,
      // regardless of drift — see the finding-M1 test below.)
      buffer.record(100 + MAX_TICK_DRIFT_TICKS, "p1", snapshot());
      expect(buffer.pendingTickCountForTest).toBe(1);

      // One tick further out — past the drift ceiling — dropped.
      buffer.record(100 + MAX_TICK_DRIFT_TICKS + 1, "p1", snapshot());
      expect(buffer.pendingTickCountForTest).toBe(1); // unchanged
    });

    it("survives a realistic catch-up burst after a stall (finding 5 regression: this used to be tied to INPUT_DELAY_TICKS, a ~9-tick/300ms window trivially exceeded by a real GC pause or CI resource contention)", () => {
      const buffer = new InputDelayBuffer();
      buffer.finalize(0, [], 1 / 30); // establishes lastFinalizedTick = 0

      // A real stall can make TickAccumulator.advance() post many due ticks
      // in one burst (its own doc comment) — the other peer's genuinely
      // still-useful, correctly-tagged input arriving for a tick well past
      // the old ~9-tick window, but comfortably inside a real stall/network
      // hiccup's timescale, must not be silently dropped.
      const burstTick = 150; // 5 real seconds of ticks at TICK_RATE_HZ — comfortably survives a real stall, still far inside MAX_TICK_DRIFT_TICKS
      buffer.record(burstTick, "p1", snapshot({ fireQueued: true }));
      const bundle = buffer.finalize(burstTick, ["p1"], 1 / 30);
      expect(bundle.inputs.p1).toEqual(snapshot({ fireQueued: true }));
      expect(bundle.heldInputFallback).toEqual([]);
    });

    it("drops a late/replayed packet for an already-finalized tick (<= lastFinalizedTick), even inside the drift window, while still buffering a genuine future tick (finding M1)", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(20, "p1", snapshot());
      buffer.finalize(20, ["p1"], 1 / 30); // establishes lastFinalizedTick = 20
      expect(buffer.pendingTickCountForTest).toBe(0);

      // Late delivery (one-way latency exceeded INPUT_DELAY_TICKS) or a replay
      // of a tick just behind the current one — both at/below lastFinalizedTick
      // and both comfortably inside the ±MAX_TICK_DRIFT_TICKS window, so the
      // far-drift bound alone would happily buffer them under a key finalize()
      // has already passed and will never sweep — an unbounded leak.
      buffer.record(20, "p1", snapshot({ fireQueued: true })); // exactly lastFinalizedTick
      buffer.record(15, "p1", snapshot({ fireQueued: true })); // 5 behind, still in-window
      expect(buffer.pendingTickCountForTest).toBe(0); // neither buffered

      // A legitimate future tick is still buffered as normal.
      buffer.record(21, "p1", snapshot({ mouseDX: 1 }));
      expect(buffer.pendingTickCountForTest).toBe(1);
      const bundle = buffer.finalize(21, ["p1"], 1 / 30);
      expect(bundle.inputs.p1).toEqual(snapshot({ mouseDX: 1 }));
      expect(buffer.pendingTickCountForTest).toBe(0);
    });

    it("never drops anything before the first finalize() call — the real in-flight window isn't known yet", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(3, "p1", snapshot({ fireQueued: true })); // bootstrap: input tagged INPUT_DELAY_TICKS ahead of tick 0
      const bundle = buffer.finalize(3, ["p1"], 1 / 30);
      expect(bundle.inputs.p1).toEqual(snapshot({ fireQueued: true }));
    });
  });

  describe("graceIds", () => {
    it("forces the neutral idle snapshot for a grace-period player, even when real input arrived", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(10, "p1", snapshot({ fireQueued: true }));
      const bundle = buffer.finalize(10, ["p1"], 1 / 30, new Set(["p1"]));
      expect(bundle.inputs.p1).toEqual(EMPTY_SNAPSHOT);
    });

    it("does not count a grace-period player as held-fallback", () => {
      const buffer = new InputDelayBuffer();
      const bundle = buffer.finalize(10, ["p1"], 1 / 30, new Set(["p1"]));
      expect(bundle.heldInputFallback).toEqual([]);
    });

    it("does not update lastKnown for a grace-period player, so a later non-grace tick doesn't resurrect stale real input", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(10, "p1", snapshot({ fireQueued: true })); // establishes lastKnown, pre-grace
      buffer.finalize(10, ["p1"], 1 / 30);

      buffer.record(11, "p1", snapshot({ mouseDX: 9 })); // real input arrives, but p1 is now in grace
      buffer.finalize(11, ["p1"], 1 / 30, new Set(["p1"]));

      const bundle = buffer.finalize(12, ["p1"], 1 / 30); // grace lifted, nothing recorded for tick 12
      expect(bundle.inputs.p1).toEqual(snapshot({ fireQueued: true })); // still tick-10's lastKnown, not tick-11's
    });

    it("leaves other roster players unaffected", () => {
      const buffer = new InputDelayBuffer();
      buffer.record(5, "p2", snapshot({ mouseDX: 3 }));
      const bundle = buffer.finalize(5, ["p1", "p2"], 1 / 30, new Set(["p1"]));
      expect(bundle.inputs.p1).toEqual(EMPTY_SNAPSHOT);
      expect(bundle.inputs.p2).toEqual(snapshot({ mouseDX: 3 }));
    });
  });
});

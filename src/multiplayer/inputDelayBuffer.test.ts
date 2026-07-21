// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { EMPTY_SNAPSHOT } from "../engine/replay";
import type { InputSnapshot } from "../engine/input";
import { InputDelayBuffer } from "./inputDelayBuffer";
import { INPUT_DELAY_TICKS } from "./netcodeConstants";

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

    it("accepts ticks exactly at the edges of the window, drops ones just past them", () => {
      const buffer = new InputDelayBuffer();
      buffer.finalize(100, [], 1 / 30); // establishes lastFinalizedTick = 100, nothing to record

      // Edges: lastFinalizedTick - INPUT_DELAY_TICKS (past), lastFinalizedTick
      // + INPUT_DELAY_TICKS + INPUT_DELAY_TICKS (future slack) — both must
      // still be accepted.
      buffer.record(100 - INPUT_DELAY_TICKS, "p1", snapshot());
      buffer.record(100 + INPUT_DELAY_TICKS + INPUT_DELAY_TICKS, "p1", snapshot());
      expect(buffer.pendingTickCountForTest).toBe(2);

      // One tick further out on either side — dropped.
      buffer.record(100 - INPUT_DELAY_TICKS - 1, "p1", snapshot());
      buffer.record(100 + INPUT_DELAY_TICKS + INPUT_DELAY_TICKS + 1, "p1", snapshot());
      expect(buffer.pendingTickCountForTest).toBe(2); // unchanged
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

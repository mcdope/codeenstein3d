// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { TickAccumulator } from "./tickAccumulator";

describe("TickAccumulator", () => {
  it("emits nothing when less than one full interval has elapsed", () => {
    const acc = new TickAccumulator(100, 0);
    expect(acc.advance(50)).toEqual([]);
    expect(acc.advance(99)).toEqual([]);
  });

  it("emits exactly one tick per call at a regular, exact cadence, with incrementing tick indices", () => {
    const acc = new TickAccumulator(100, 0);
    expect(acc.advance(100)).toEqual([0]);
    expect(acc.advance(200)).toEqual([1]);
    expect(acc.advance(300)).toEqual([2]);
  });

  it("emits a burst of every tick due at once after a large time jump, never skipping any", () => {
    const acc = new TickAccumulator(100, 0);
    expect(acc.advance(550)).toEqual([0, 1, 2, 3, 4]);
  });

  it("banks a sub-interval remainder across calls instead of discarding it", () => {
    const acc = new TickAccumulator(100, 0);
    // 60 + 60 = 120ms elapsed -> exactly one tick due once the second call
    // crosses the 100ms threshold, not zero (which discarding would give).
    expect(acc.advance(60)).toEqual([]);
    expect(acc.advance(120)).toEqual([0]);
  });

  it("never drifts long-run: many small irregular increments summing exactly to N intervals yield exactly N ticks total", () => {
    const acc = new TickAccumulator(100, 0);
    const steps = [30, 25, 45, 10, 40, 20, 60, 15, 15, 40]; // sums to 300
    let now = 0;
    let total = 0;
    for (const step of steps) {
      now += step;
      total += acc.advance(now).length;
    }
    expect(total).toBe(3);
  });

  it("doesn't drop a tick to floating-point rounding at a non-terminating-fraction interval (regression)", () => {
    // 1000/30 is a repeating binary fraction; naively subtracting it three
    // times from its own triple lands one ULP short of the interval due to
    // rounding, silently dropping tick #2 unless the implementation avoids
    // repeated subtraction (see TickAccumulator's own doc comment).
    const fixedDtMs = 1000 / 30;
    const acc = new TickAccumulator(fixedDtMs, 0);
    expect(acc.advance(fixedDtMs * 3)).toEqual([0, 1, 2]);
  });

  it("assigns strictly increasing, gap-free tick indices across separate advance() calls", () => {
    const acc = new TickAccumulator(50, 1000);
    const seen = [...acc.advance(1075), ...acc.advance(1300)];
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

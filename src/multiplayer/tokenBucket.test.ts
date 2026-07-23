// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { TokenBucket } from "./tokenBucket";

/** A controllable virtual clock (ms) for deterministic rate-limit tests. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("TokenBucket", () => {
  it("passes an initial burst up to capacity, then rate-limits", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 10, clock.now);
    // Full bucket: first 5 pass without any time passing.
    for (let i = 0; i < 5; i++) expect(bucket.tryRemove()).toBe(true);
    // 6th is over capacity with no refill yet.
    expect(bucket.tryRemove()).toBe(false);
  });

  it("refills at the configured rate over elapsed time", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 10, clock.now); // 10 tokens/sec
    for (let i = 0; i < 5; i++) bucket.tryRemove();
    expect(bucket.tryRemove()).toBe(false);
    // 100ms at 10/sec = exactly 1 token back.
    clock.advance(100);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it("never refills past capacity", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(3, 10, clock.now);
    for (let i = 0; i < 3; i++) bucket.tryRemove();
    // Let a long time pass — far more than enough to overfill.
    clock.advance(10_000);
    // Only `capacity` tokens are available, not the whole accrued amount.
    for (let i = 0; i < 3; i++) expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it("sustains the steady refill rate indefinitely", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 20, clock.now); // 20/sec => 1 per 50ms
    for (let i = 0; i < 2; i++) bucket.tryRemove(); // drain
    let passed = 0;
    for (let i = 0; i < 10; i++) {
      clock.advance(50);
      if (bucket.tryRemove()) passed++;
    }
    // Each 50ms window buys exactly one token back.
    expect(passed).toBe(10);
  });
});

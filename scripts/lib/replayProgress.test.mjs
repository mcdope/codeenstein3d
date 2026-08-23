// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { consumedFrames } from "./replayProgress.mjs";

/** The shipped board's third entry, which is what caught this: one level
 * holding 11618 of the run's 25527 frames, and a 7th segment for a 6-level
 * run. Only the recorded lengths matter here. */
const ENTRY_2 = [1294, 3309, 4696, 1775, 2238, 11618, 597].map((framesRecorded) => ({ framesRecorded }));

/** `state.levels` for the first `count` levels of `ENTRY_2`, played back
 * frame-exactly — which is what the real playback does. */
const finished = (count) => ENTRY_2.slice(0, count).map((level) => ({ framesConsumed: level.framesRecorded }));

describe("consumedFrames", () => {
  it("counts nothing before the first level has loaded", () => {
    expect(consumedFrames({ levels: [], probe: null }, ENTRY_2)).toBe(0);
  });

  it("adds the in-flight level's progress to the finished ones", () => {
    const state = { levels: finished(5), probe: { levelIndex: 6, frameIndex: 8000, framesRecorded: 11618 } };

    expect(consumedFrames(state, ENTRY_2)).toBe(13312 + 8000);
  });

  it("does not count the outgoing level twice while a transition is in flight", () => {
    // The probe mid-transition: `levelIndex` has advanced to 7, but
    // `frameIndex`/`framesRecorded` still describe level 6 — which is already
    // in `state.levels`. Counting it here reads 36548 of 25527 and fails a
    // frame-exact playback against its own budget.
    const state = { levels: finished(6), probe: { levelIndex: 7, frameIndex: 11618, framesRecorded: 11618 } };

    expect(consumedFrames(state, ENTRY_2)).toBe(24930);
  });

  it("never exceeds the recording once the last level is in flight", () => {
    const state = { levels: finished(6), probe: { levelIndex: 7, frameIndex: 597, framesRecorded: 597 } };

    expect(consumedFrames(state, ENTRY_2)).toBe(25527);
  });

  it("ignores a probe that has run past the recorded levels", () => {
    const state = { levels: finished(7), probe: { levelIndex: 8, frameIndex: 40, framesRecorded: 597 } };

    expect(consumedFrames(state, ENTRY_2)).toBe(25527);
  });

  it("ignores a probe whose level is already recorded as finished", () => {
    // The mirror of the transition case: the index has not moved yet while
    // the level it names has already ended.
    const state = { levels: finished(6), probe: { levelIndex: 6, frameIndex: 11618, framesRecorded: 11618 } };

    expect(consumedFrames(state, ENTRY_2)).toBe(24930);
  });

  it("treats a missing levels array as no finished levels", () => {
    expect(consumedFrames({ probe: { levelIndex: 1, frameIndex: 700, framesRecorded: 1294 } }, ENTRY_2)).toBe(700);
  });
});

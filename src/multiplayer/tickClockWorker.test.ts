// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `tickClockWorker.ts` runs its scheduling side effects at module-load time
 * (it's a Worker entry point, not a set of exported functions) — every test
 * here stubs `self`/the clock *before* dynamically importing the module,
 * and resets modules between tests so each gets its own fresh
 * `TickAccumulator` instance.
 *
 * `performance.now()` is mocked with a manually-driven `now` variable rather
 * than delegating to `Date.now()`: `Date.now()` truncates to whole
 * milliseconds, but `FIXED_DT_MS` (1000/30) is a repeating fractional value
 * — a `Date.now()`-backed mock would silently lose the fractional remainder
 * every tick and never actually cross the threshold `TickAccumulator`
 * checks against, making the interval appear to never fire. Advancing `now`
 * by the exact same amount passed to `vi.advanceTimersByTimeAsync()` keeps
 * the two in exact lockstep instead — the same "stub the clock" approach
 * `test/mocks/raf.ts` uses (there, `Date`/`performance.now` are also driven
 * by a manually-tracked counter, for the same reason).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_DT } from "./netcodeConstants";

const FIXED_DT_MS = FIXED_DT * 1000;

describe("tickClockWorker", () => {
  let postMessage: ReturnType<typeof vi.fn>;
  let now: number;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    postMessage = vi.fn();
    vi.stubGlobal("self", { postMessage });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts nothing before a full tick interval has elapsed", async () => {
    await import("./tickClockWorker");
    now += FIXED_DT_MS / 2;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS / 2);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts one tick message per interval at the fixed tick rate, with incrementing tick indices", async () => {
    await import("./tickClockWorker");
    now += FIXED_DT_MS;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS);
    expect(postMessage).toHaveBeenNthCalledWith(1, { type: "tick", tick: 0 });
    now += FIXED_DT_MS;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS);
    expect(postMessage).toHaveBeenNthCalledWith(2, { type: "tick", tick: 1 });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("posts a burst of every tick due at once when a single firing sees a large elapsed jump", async () => {
    // Simulates a stalled/backgrounded main thread: real elapsed time jumped
    // 3 tick intervals' worth before the worker's own timer next got to run
    // — advancing fake-timer time by only one interval (so the underlying
    // `setInterval` fires exactly once) while `now` independently jumped
    // further models that precisely, without depending on how many real
    // `setInterval` firings a bulk fake-timer jump happens to produce.
    await import("./tickClockWorker");
    now += FIXED_DT_MS * 3;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS);
    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: "tick", tick: 0 },
      { type: "tick", tick: 1 },
      { type: "tick", tick: 2 },
    ]);
  });
});

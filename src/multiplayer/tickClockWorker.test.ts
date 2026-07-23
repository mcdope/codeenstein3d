// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `tickClockWorker.ts` is a Worker entry point, not a set of exported
 * functions — every test here stubs `self`/the clock *before* dynamically
 * importing the module, and resets modules between tests so each gets its
 * own fresh module-level state. Since step 3's "no message before listener"
 * fix, the module no longer starts its `setInterval`/`TickAccumulator` at
 * import time: it waits for an inbound `{type: "start"}` message dispatched
 * via `self`'s (stubbed) `addEventListener("message", ...)` — every test
 * that expects ticks calls `sendStart()` after importing, mirroring
 * `main.ts`'s own "send start only after onmessage is assigned" sequencing.
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
  let messageListeners: Array<(event: MessageEvent) => void>;

  /** Dispatches the inbound `{type: "start"}` message the same way a real
   * `Worker`'s message event would — via whichever listener(s)
   * `self.addEventListener("message", ...)` registered, not by calling
   * anything module-internal directly (there's nothing exported to call). */
  function sendStart(): void {
    for (const listener of messageListeners) listener({ data: { type: "start" } } as MessageEvent);
  }

  /** Dispatches the inbound `{type: "stop"}` message the same way `sendStart`
   * does — the counterpart that tears the running clock back down. */
  function sendStop(): void {
    for (const listener of messageListeners) listener({ data: { type: "stop" } } as MessageEvent);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    postMessage = vi.fn();
    messageListeners = [];
    vi.stubGlobal("self", {
      postMessage,
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") messageListeners.push(listener);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts nothing at all before the start message is sent", async () => {
    await import("./tickClockWorker");
    now += FIXED_DT_MS * 5;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS * 5);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts nothing before a full tick interval has elapsed after starting", async () => {
    await import("./tickClockWorker");
    sendStart();
    now += FIXED_DT_MS / 2;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS / 2);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts one tick message per interval at the fixed tick rate, with incrementing tick indices, only once started", async () => {
    await import("./tickClockWorker");
    sendStart();
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
    sendStart();
    now += FIXED_DT_MS * 3;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS);
    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: "tick", tick: 0 },
      { type: "tick", tick: 1 },
      { type: "tick", tick: 2 },
    ]);
  });

  it("ignores a message with an unrecognized type instead of starting the interval", async () => {
    await import("./tickClockWorker");
    for (const listener of messageListeners) listener({ data: { type: "bogus" } } as MessageEvent);
    now += FIXED_DT_MS * 5;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS * 5);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ignores a second start message instead of spinning up a second concurrent clock", async () => {
    // Two `setInterval`-driven clocks racing on one Worker is exactly the
    // duplicated/corrupted tick stream the `started` guard exists to prevent —
    // assert the underlying `setInterval` was invoked exactly once no matter
    // how many `start` messages arrive.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    await import("./tickClockWorker");
    sendStart();
    sendStart();
    sendStart();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the interval on stop and allows a fresh start afterwards", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await import("./tickClockWorker");
    sendStart();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    sendStop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    // A legitimate restart after a stop must be able to build a fresh clock —
    // the guard resets, so this second start really does create a new interval.
    sendStart();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("does not throw or start on a null, non-object, or unknown-type message", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    await import("./tickClockWorker");
    for (const listener of messageListeners) {
      expect(() => listener({ data: null } as MessageEvent)).not.toThrow();
      expect(() => listener({ data: 42 } as unknown as MessageEvent)).not.toThrow();
      expect(() => listener({ data: "start" } as unknown as MessageEvent)).not.toThrow();
      expect(() => listener({ data: { type: "unknown" } } as MessageEvent)).not.toThrow();
    }
    now += FIXED_DT_MS * 5;
    await vi.advanceTimersByTimeAsync(FIXED_DT_MS * 5);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

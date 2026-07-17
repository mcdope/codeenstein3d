// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FramePerfLogger, type PerfContext } from "./perfDebug";

/** Queue up exact return values for successive `performance.now()` calls —
 * `FramePerfLogger` calls it once per `beginFrame`/`mark`, so a test can
 * fully control every phase duration by choosing the queue. The last queued
 * value repeats once exhausted, rather than throwing, so a test that doesn't
 * care about later precision doesn't need to over-provision the queue. */
function stubNow(...values: number[]): void {
  const queue = [...values];
  let last = 0;
  vi.spyOn(performance, "now").mockImplementation(() => {
    if (queue.length) last = queue.shift() as number;
    return last;
  });
}

function fakeContext(overrides: Partial<PerfContext> = {}): PerfContext {
  return {
    enemiesAlive: 3,
    enemiesTotal: 5,
    eliteEnemies: 1,
    edgeCaseEnemies: 2,
    mines: 1,
    enemyBolts: 0,
    rockets: 0,
    traces: 2,
    flameStreams: 0,
    blood: 4,
    explosions: 0,
    explosionParticles: 0,
    burnParticles: 0,
    ammo: { bullets: 10 },
    weaponName: "pistol",
    audioShotCount: 7,
    audioCtxState: "running",
    ...overrides,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every logged line must be a single plain string with no trailing
 * argument — `src/ui/consoleSidebar.ts`'s `appendLine` silently drops a
 * `console.log` call's message entirely unless `args[0]` is a string, and
 * drops any non-string arg after it (see `perfDebug.ts`'s header comment for
 * why this is load-bearing: the whole point is that these lines render in
 * the in-game console sidebar for a screen recording to pick up). */
function expectSingleStringArgLines(calls: unknown[][]): void {
  for (const call of calls) {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
  }
}

describe("FramePerfLogger construction", () => {
  it("logs a single-string environment line, falling back to '?' when deviceMemory is unsupported", () => {
    new FramePerfLogger();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expectSingleStringArgLines(logSpy.mock.calls);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("[perf] env:");
    expect(line).toContain("memGB=?");
    expect(line).toContain(`ua="${navigator.userAgent}"`);
  });

  it("reports navigator.deviceMemory when the browser exposes it", () => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    nav.deviceMemory = 32;
    try {
      new FramePerfLogger();
      const line = logSpy.mock.calls[0][0] as string;
      expect(line).toContain("memGB=32");
    } finally {
      delete nav.deviceMemory;
    }
  });
});

describe("FramePerfLogger.logLevelScale", () => {
  it("logs the map/enemy/canvas scale as a single string line", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    logger.logLevelScale(84, 84, 18, 1, 3, 2, 800, 600);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expectSingleStringArgLines(logSpy.mock.calls);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toBe("[perf] level: map=84x84 canvas=800x600 enemies=18 elite=1 edgeCase=3 mines=2");
  });
});

describe("FramePerfLogger.dispose", () => {
  it("removes its mousemove listener", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const logger = new FramePerfLogger();
    logger.dispose();
    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
  });
});

describe("FramePerfLogger frame timing", () => {
  it("always logs the very first frame as a periodic baseline, even at a healthy fps", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    stubNow(0, 4, 9); // beginFrame @0, mark("sim") @4, mark("render") @9
    logger.beginFrame(8); // ~125fps, well above the slow threshold
    logger.mark("sim");
    logger.mark("render");
    const context = vi.fn(fakeContext);
    logger.endFrame(context);

    expect(context).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(2); // timing line + state line
    expectSingleStringArgLines(logSpy.mock.calls);
    const [timingLine, stateLine] = logSpy.mock.calls.map((c) => c[0] as string);
    expect(timingLine).toContain("[perf] tick");
    expect(timingLine).toContain("sim=4.00");
    expect(timingLine).toContain("render=5.00");
    // rawFrameMs (8) minus summed phase time (9) is negative — clamped to 0.
    expect(timingLine).toContain("unacct=0.00ms");
    expect(stateLine).toContain("[perf] state:");
  });

  it("logs a SLOW frame immediately and clamps unaccounted time at zero when phases overrun the raw frame", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    // Phases sum to 40ms of "work" reported inside a 33ms raw frame — the
    // measured phases can exceed the raw delta slightly (timer granularity,
    // work spilling just past the frame boundary); unaccountedMs must never
    // go negative.
    stubNow(0, 25, 40);
    logger.beginFrame(33); // ~30fps -> below SLOW_FPS_THRESHOLD
    logger.mark("sim");
    logger.mark("render");
    logger.endFrame(() => fakeContext());

    expect(logSpy).toHaveBeenCalledTimes(2);
    const timingLine = logSpy.mock.calls[0][0] as string;
    expect(timingLine).toContain("[perf] SLOW");
    expect(timingLine).toContain("unacct=0.00ms");
  });

  it("suppresses a repeat slow-frame log inside the rate-limit window, then logs again once it elapses", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();

    stubNow(0, 10);
    logger.beginFrame(33);
    logger.mark("sim");
    const ctx1 = vi.fn(fakeContext);
    logger.endFrame(ctx1); // first slow frame: logs (periodic freebie + slow)
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(ctx1).toHaveBeenCalledTimes(1);

    stubNow(100, 110);
    logger.beginFrame(33); // only 33ms of wall-clock since the last log — well under the 250ms window
    logger.mark("sim");
    const ctx2 = vi.fn(fakeContext);
    logger.endFrame(ctx2);
    expect(logSpy).toHaveBeenCalledTimes(2); // suppressed
    expect(ctx2).not.toHaveBeenCalled(); // context must never be built for a frame that isn't logged

    // Feed enough additional slow frames to cross the 250ms rate-limit window.
    let lastLen = 2;
    for (let i = 0; i < 10; i++) {
      stubNow(0, 10);
      logger.beginFrame(33);
      logger.mark("sim");
      logger.endFrame(() => fakeContext());
      if (logSpy.mock.calls.length > lastLen) break;
      lastLen = logSpy.mock.calls.length;
    }
    expect(logSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it("logs a non-slow 'tick' baseline once the periodic interval elapses, without needing a slow frame", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();

    stubNow(0, 8);
    logger.beginFrame(8); // healthy fps, consumes the initial periodic freebie
    logger.mark("sim");
    logger.endFrame(() => fakeContext());
    expect(logSpy).toHaveBeenCalledTimes(2);

    stubNow(0, 8);
    logger.beginFrame(8);
    logger.mark("sim");
    logger.endFrame(() => fakeContext());
    expect(logSpy).toHaveBeenCalledTimes(2); // too soon — still under 2000ms

    // Accumulate wall-clock (via rawDtMs, independent of real time) past the
    // periodic interval with consistently healthy frame times.
    let logged = false;
    for (let i = 0; i < 260; i++) {
      stubNow(0, 8);
      logger.beginFrame(8);
      logger.mark("sim");
      logger.endFrame(() => fakeContext());
      if (logSpy.mock.calls.length > 2) {
        logged = true;
        break;
      }
    }
    expect(logged).toBe(true);
    const lastTimingLine = logSpy.mock.calls[logSpy.mock.calls.length - 2][0] as string;
    expect(lastTimingLine).toContain("[perf] tick");
  });

  it("handles a zero-length raw frame (instantFps === Infinity) without throwing", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    stubNow(0, 1);
    logger.beginFrame(0);
    logger.mark("sim");
    expect(() => logger.endFrame(() => fakeContext())).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("accumulates repeated marks under the same phase name instead of overwriting", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    stubNow(0, 3, 7); // two "sim" marks: 3ms then 4ms
    logger.beginFrame(8);
    logger.mark("sim");
    logger.mark("sim");
    logger.endFrame(() => fakeContext());
    const timingLine = logSpy.mock.calls[0][0] as string;
    expect(timingLine).toContain("sim=7.00");
    expect(timingLine.match(/sim=/g)).toHaveLength(1); // accumulated into one entry, not two
  });

  it("reports the mousemove event count captured since the previous read, then resets it", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();

    document.dispatchEvent(new MouseEvent("mousemove"));
    document.dispatchEvent(new MouseEvent("mousemove"));
    document.dispatchEvent(new MouseEvent("mousemove"));

    stubNow(0, 5);
    logger.beginFrame(8);
    logger.mark("sim");
    logger.endFrame(() => fakeContext());
    expect(logSpy.mock.calls[0][0] as string).toContain("mouse=3/f");

    // A second logged frame with no new mousemove events reads back to zero.
    let logged = false;
    for (let i = 0; i < 260; i++) {
      stubNow(0, 5);
      logger.beginFrame(8);
      logger.mark("sim");
      logger.endFrame(() => fakeContext());
      if (logSpy.mock.calls.length > 2) {
        logged = true;
        break;
      }
    }
    expect(logged).toBe(true);
    const lastTimingLine = logSpy.mock.calls[logSpy.mock.calls.length - 2][0] as string;
    expect(lastTimingLine).toContain("mouse=0/f");
  });

  it("reports heap usage when performance.memory is available (Chromium), and a fallback string otherwise", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();

    stubNow(0, 5);
    logger.beginFrame(8);
    logger.mark("sim");
    logger.endFrame(() => fakeContext());
    expect(logSpy.mock.calls[1][0] as string).toContain("heapMB=n/a");

    const withMemory = performance as Performance & { memory?: unknown };
    withMemory.memory = { usedJSHeapSize: 10 * 1048576, totalJSHeapSize: 20 * 1048576, jsHeapSizeLimit: 40 * 1048576 };
    try {
      let logged = false;
      for (let i = 0; i < 260; i++) {
        stubNow(0, 5);
        logger.beginFrame(8);
        logger.mark("sim");
        logger.endFrame(() => fakeContext());
        if (logSpy.mock.calls.length > 2) {
          logged = true;
          break;
        }
      }
      expect(logged).toBe(true);
      const lastStateLine = logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string;
      expect(lastStateLine).toContain("heapMB=10/20/40");
    } finally {
      delete withMemory.memory;
    }
  });

  it("includes entity counts, ammo, weapon, and audio state from the supplied context", () => {
    const logger = new FramePerfLogger();
    logSpy.mockClear();
    stubNow(0, 5);
    logger.beginFrame(8);
    logger.mark("sim");
    logger.endFrame(() =>
      fakeContext({ enemiesAlive: 40, enemiesTotal: 60, weaponName: "gdb", audioShotCount: 12, audioCtxState: "suspended" }),
    );
    const stateLine = logSpy.mock.calls[1][0] as string;
    expect(stateLine).toContain("enemies=40/60");
    expect(stateLine).toContain("weapon=gdb");
    expect(stateLine).toContain("audio shots=12 ctx=suspended");
  });
});

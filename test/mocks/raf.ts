// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A deterministic `requestAnimationFrame`/`cancelAnimationFrame` stub. Simpler
 * than the virtual-clock machinery `scripts/verify-campaign-playthrough.mjs`
 * builds for Playwright (`window.__pumpVirtualTime`) — that exists to drive a
 * real browser page from the outside; here Vitest runs the code directly in
 * the same Node process, so a plain callback queue plus a manual `flushRaf`
 * is enough.
 */
import { vi } from "vitest";

interface RafQueueEntry {
  id: number;
  callback: FrameRequestCallback;
}

export interface RafController {
  /** Invokes up to `n` queued callbacks (FIFO), advancing `now` by `stepMs`
   * before each. Returns the number of callbacks actually invoked. */
  flush(n?: number, stepMs?: number): number;
  /** Current mocked `performance.now()`/`Date.now()` value, in ms. */
  now(): number;
  restore(): void;
}

/** Stubs `requestAnimationFrame`/`cancelAnimationFrame` (and optionally
 * `performance.now`/`Date.now`) with a manually-driven queue. */
export function installRaf(options: { stubClock?: boolean } = {}): RafController {
  let queue: RafQueueEntry[] = [];
  let nextId = 1;
  let elapsedMs = 0;
  const startTime = Date.now();

  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      queue.push({ id, callback });
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      queue = queue.filter((entry) => entry.id !== id);
    }),
  );

  const restoreClock = options.stubClock
    ? (() => {
        const originalDateNow = Date.now;
        const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
        Date.now = () => startTime + elapsedMs;
        return () => {
          nowSpy.mockRestore();
          Date.now = originalDateNow;
        };
      })()
    : null;

  return {
    flush(n = 1, stepMs = 16) {
      let invoked = 0;
      for (let i = 0; i < n && queue.length > 0; i++) {
        const batch = queue;
        queue = [];
        elapsedMs += stepMs;
        for (const entry of batch) {
          entry.callback(elapsedMs);
          invoked++;
        }
      }
      return invoked;
    },
    now() {
      return elapsedMs;
    },
    restore() {
      vi.unstubAllGlobals();
      restoreClock?.();
    },
  };
}

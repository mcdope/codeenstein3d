// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * In-page frame-interval sampler for the performance benchmark harness
 * (`scripts/run-perf-benchmark.mjs`). Injected via `page.addInitScript`, so
 * it needs ZERO changes to game source: it runs its own rAF loop next to the
 * engine's — all rAF callbacks registered for the same vsync tick fire in the
 * same turn, so the deltas between our callbacks equal the real frame
 * intervals the game sees.
 *
 * Deliberately allocation-free per frame: deltas go into a preallocated
 * Float64Array ring so the sampler never perturbs the GC behavior it is
 * helping to measure. Heap samples (Chromium-only `performance.memory`) are
 * taken on a slow 5s interval — a handful of small objects per minute.
 *
 * NOTE: this measures on the REAL clock. It is useless under the balancing
 * harness's virtual clock (`scripts/lib/virtualClock.mjs`) — the bench
 * harness never installs that.
 */

/** Ring capacity: ~9 minutes at 120fps. Older deltas are overwritten; the
 * bench resets the ring after warmup anyway, so overflow only matters for
 * multi-minute soak runs, where the newest window is exactly what we want. */
const RING_CAPACITY = 65536;
const HEAP_SAMPLE_INTERVAL_MS = 5000;

/** Install `window.__perfBench` (rAF interval ring + heap sampler) on every
 * page of the context. Call before `page.goto`. */
export async function installPerfSampler(page) {
  await page.addInitScript(
    ({ capacity, heapIntervalMs }) => {
      const deltas = new Float64Array(capacity);
      let count = 0; // total deltas observed since last reset (may exceed capacity)
      let last = -1;
      const heapSamples = [];

      const tick = () => {
        const now = performance.now();
        if (last >= 0) {
          deltas[count % capacity] = now - last;
          count += 1;
        }
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      setInterval(() => {
        const mem = performance.memory;
        if (!mem) return;
        heapSamples.push({
          t: performance.now(),
          usedMB: mem.usedJSHeapSize / 1048576,
          totalMB: mem.totalJSHeapSize / 1048576,
        });
      }, heapIntervalMs);

      window.__perfBench = {
        /** Drop everything sampled so far — called after scenario setup and
         * again after the warmup window, so captures contain steady-state
         * frames only. `last` is kept so the delta chain stays contiguous. */
        reset() {
          count = 0;
          heapSamples.length = 0;
        },
        /** Newest-window copy of the ring, oldest-first, as a plain array
         * (structured-cloneable for page.evaluate). */
        getFrames() {
          const n = Math.min(count, capacity);
          const start = count - n;
          const out = new Array(n);
          for (let i = 0; i < n; i += 1) out[i] = deltas[(start + i) % capacity];
          return { total: count, deltas: out };
        },
        getHeapSamples() {
          return heapSamples.slice();
        },
      };
    },
    { capacity: RING_CAPACITY, heapIntervalMs: HEAP_SAMPLE_INTERVAL_MS },
  );
}

/** Convenience wrappers so the orchestrator reads as intent, not evaluate soup. */
export function resetSampler(page) {
  return page.evaluate(() => window.__perfBench.reset());
}

export function readSampler(page) {
  return page.evaluate(() => ({
    frames: window.__perfBench.getFrames(),
    heapSamples: window.__perfBench.getHeapSamples(),
  }));
}

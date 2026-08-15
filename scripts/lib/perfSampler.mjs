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
 * Deliberately allocation-free per frame: deltas and per-frame heap readings
 * go into preallocated Float64Array rings so the sampler never perturbs the
 * GC behavior it is helping to measure. Coarse heap samples (Chromium-only
 * `performance.memory`) are additionally taken on a slow 5s interval — a
 * handful of small objects per minute.
 *
 * Long-task visibility: a `PerformanceObserver` on `longtask` and
 * `long-animation-frame` (both Chromium-only; LoAF needs >=123). Entries are
 * >=50ms by definition, so they are rare and pushing one small object per
 * entry is fine. What this can and cannot see: LoAF `blockingDuration` shows
 * long frames *containing* GC without attributing them; a major GC shows as a
 * drop in the per-frame heap ring coincident with an interval spike;
 * minor/incremental GC pauses (<1-2ms) are not individually visible from
 * in-page JS at all — exact GC attribution needs CDP tracing, which is a
 * separate, deliberately-not-default spot-check mode.
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
      // Per-frame heap ring, index-aligned with `deltas`: heapRing[i] is the
      // used-JS-heap size (bytes) read in the same rAF turn that produced
      // deltas[i]. 0 where performance.memory is unavailable.
      const heapRing = new Float64Array(capacity);
      let count = 0; // total deltas observed since last reset (may exceed capacity)
      let last = -1;
      const heapSamples = [];
      const mem = performance.memory ?? null;

      const tick = () => {
        const now = performance.now();
        if (last >= 0) {
          deltas[count % capacity] = now - last;
          heapRing[count % capacity] = mem ? mem.usedJSHeapSize : 0;
          count += 1;
        }
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      // Long-task / long-animation-frame observers, feature-detected so a
      // firefox/webkit run records "unavailable" instead of silently missing
      // data. Entries are cleared on reset() like everything else.
      const supported = PerformanceObserver.supportedEntryTypes ?? [];
      const observed = { longtask: supported.includes("longtask"), longAnimationFrame: supported.includes("long-animation-frame") };
      let longTasks = [];
      let longAnimationFrames = [];
      if (observed.longtask) {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
        }).observe({ type: "longtask", buffered: false });
      }
      if (observed.longAnimationFrame) {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longAnimationFrames.push({
              start: e.startTime,
              duration: e.duration,
              blockingDuration: e.blockingDuration,
              styleAndLayoutDuration: e.styleAndLayoutDuration,
              // Attribution: longest script entry, if the browser provides one.
              script: e.scripts?.[0] ? { name: e.scripts[0].name, duration: e.scripts[0].duration } : null,
            });
          }
        }).observe({ type: "long-animation-frame", buffered: false });
      }

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
          longTasks = [];
          longAnimationFrames = [];
        },
        /** Newest-window copy of the rings, oldest-first, as plain arrays
         * (structured-cloneable for page.evaluate). */
        getFrames() {
          const n = Math.min(count, capacity);
          const start = count - n;
          const out = new Array(n);
          const heap = new Array(n);
          for (let i = 0; i < n; i += 1) {
            out[i] = deltas[(start + i) % capacity];
            heap[i] = heapRing[(start + i) % capacity];
          }
          return { total: count, deltas: out, heapBytes: heap };
        },
        getHeapSamples() {
          return heapSamples.slice();
        },
        getObservations() {
          return { observed, longTasks: longTasks.slice(), longAnimationFrames: longAnimationFrames.slice() };
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
    observations: window.__perfBench.getObservations(),
  }));
}

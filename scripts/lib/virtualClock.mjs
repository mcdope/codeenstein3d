// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Synchronous virtual clock for a headless Playwright page: monkeypatches
 * `performance.now`/`Date.now`/`requestAnimationFrame`/`cancelAnimationFrame`
 * (via `page.addInitScript`, so it's in place before any page script runs)
 * and exposes `window.__pumpVirtualTime(totalMs, stepMs)`, which synchronously
 * fires every pending rAF callback in fixed `stepMs` increments — letting a
 * bot fast-forward the engine's own render loop instead of waiting on real
 * wall-clock time. Previously duplicated byte-for-byte between
 * `run-balancing-telemetry.mjs` and `generate-default-highscore.mjs`.
 */
export async function installVirtualClock(page) {
  await page.addInitScript(() => {
    let vNow = 0;
    const epochStart = Date.now();
    let pending = [];
    let rafId = 0;
    // The real clock, captured before it is replaced below.
    //
    // Everything in the page that wants to know how long something *actually*
    // took loses the ability the moment `performance.now` becomes the virtual
    // clock — including `perfDebug.ts`, whose phase timings therefore read 0
    // under this harness. Without this line there is no way to measure, from
    // inside the page, how much of a `page.evaluate` is engine work and how
    // much is Playwright round trip.
    //
    // Inert by itself: nothing in `src/` reads it, and it does not affect a
    // single simulated millisecond.
    window.__realNow = window.performance.now.bind(window.performance);
    window.performance.now = () => vNow;
    Date.now = () => epochStart + vNow;
    window.requestAnimationFrame = (cb) => {
      const id = ++rafId;
      pending.push({ id, cb });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending = pending.filter((p) => p.id !== id);
    };
    // Advances exactly `totalMs`, in frames of at most `stepMs`, with the final
    // frame carrying whatever remainder is left.
    //
    // This used to be `ceil(totalMs / stepMs)` whole frames, which *rounds up*:
    // a 20ms request against a 16.67ms frame advanced 33.3ms, and a 17ms
    // request advanced 33.3ms — nearly double. That silently defeated the
    // bot's burst helpers, whose entire job is to hold a key for exactly long
    // enough to turn by a computed angle or travel a computed distance without
    // overshooting. A turn asking for 17ms of rotation got twice as much.
    //
    // It only bit callers that pass a `recordStepMs` smaller than their
    // decision step — i.e. `generate-default-highscore.mjs`, which records
    // replay frames at 60Hz while deciding at 50ms. `run-balancing-telemetry.mjs`
    // leaves them equal, so `ceil` was always exact there and the bug was
    // invisible to every balancing run. That asymmetry is why the same bot
    // wedged on a level under one harness and not the other, and is very likely
    // the "occasionally spinning far more than one decision's worth of turning"
    // that `Bot#checkRotationAnomaly` was added to watch for and never explained.
    window.__pumpVirtualTime = (totalMs, stepMs) => {
      let remaining = totalMs;
      while (remaining > 1e-9) {
        const dt = Math.min(stepMs, remaining);
        remaining -= dt;
        vNow += dt;
        const due = pending;
        pending = [];
        for (const { cb } of due) cb(vNow);
      }
    };
  });
}

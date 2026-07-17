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
    window.__pumpVirtualTime = (totalMs, stepMs) => {
      const steps = Math.ceil(totalMs / stepMs);
      for (let i = 0; i < steps; i++) {
        vNow += stepMs;
        const due = pending;
        pending = [];
        for (const { cb } of due) cb(vNow);
      }
    };
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Drops `window` event listeners registered during a test, so a module that
 * is imported many times in one file cannot pin every copy of itself in
 * memory.
 *
 * **The failure this exists to prevent.** `main.ts` registers listeners at
 * *import* time and never removes them (a real page imports it once, so
 * production has no reason to). `main.test.ts` re-imports it **245 times**
 * via `vi.resetModules()` + `import("./main")`. `resetModules` clears the
 * module *registry*, but it cannot collect a module graph that is still
 * reachable — and a live listener on `window` is exactly such a reference.
 * jsdom's `window` outlives every test in a file, so all 245 graphs (the
 * engine, the map generator, the parsers, their DOM references) stayed
 * pinned. The worker died of heap exhaustion about 91% of the way through
 * the file, taking ~27 tests with it, on roughly half of all runs.
 *
 * It was not worker contention: the file OOMs running on its own with the
 * other fifteen workers idle. Nor is it a heap-size problem —
 * `--max-old-space-size=8192` hid it, which is why it survived this long.
 *
 * **Why a shared helper rather than a fix inside `main.test.ts`.** Nothing
 * makes `main.ts` special except that it is imported the most times; any
 * module registering a `window` listener at import time leaks the same way
 * under the same idiom, and the next one will not announce itself. The cost
 * here is one `afterEach` and a wrapped method.
 *
 * Listeners are only *removed*, never suppressed — a test observes exactly
 * the behaviour it would without this — and only those added after
 * `trackWindowListeners()` runs. Anything the harness itself installed
 * beforehand is left alone.
 */
export function trackWindowListeners(): { restore: () => void; drop: () => void } {
  const added: [string, EventListenerOrEventListenerObject | null, unknown][] = [];
  const realAdd = window.addEventListener.bind(window);
  const patched = ((type: string, cb: EventListenerOrEventListenerObject | null, opts?: unknown) => {
    added.push([type, cb, opts]);
    realAdd(type, cb as EventListenerOrEventListenerObject, opts as never);
  }) as typeof window.addEventListener;
  window.addEventListener = patched;

  return {
    /** Remove everything registered since the last `drop()`. Call per test. */
    drop: () => {
      for (const [type, cb, opts] of added) {
        window.removeEventListener(type, cb as EventListenerOrEventListenerObject, opts as never);
      }
      added.length = 0;
    },
    /** Put the real `addEventListener` back — for a suite that needs it. */
    restore: () => {
      if (window.addEventListener === patched) window.addEventListener = realAdd;
      added.length = 0;
    },
  };
}

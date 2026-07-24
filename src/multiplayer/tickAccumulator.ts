// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Fixed-tick scheduler: banks real elapsed time and reports every simulation
 * tick that's newly due, at a constant interval, never skipping one even
 * across an irregular call cadence. Deliberately timer/Worker/DOM-free — the
 * host's tick clock (`tickClockWorker.ts`) drives one of these with real
 * `performance.now()` timestamps from inside a Web Worker (see
 * `doc/dev/multiplayer-netcode-spec.md`'s "Tick pacing must survive
 * background tabs"), but the accumulator logic itself is a pure function of
 * injected timestamps, so it's fully unit-testable without a Worker runtime.
 */
export class TickAccumulator {
  private nextTick = 0;
  /** Total real elapsed time ever passed to `advance()`, accumulated by
   * addition only — never decremented. Deliberately not "banked remainder,
   * subtracted down toward zero every tick": repeatedly subtracting
   * `fixedDtMs` (a non-terminating binary fraction at `TICK_RATE_HZ = 30`,
   * `1000/30 = 33.333...`) compounds floating-point rounding error tick
   * after tick, and can end up *just* under an exact multiple at a boundary
   * that should be exactly due — confirmed concretely: `100 - 33.333333333333336
   * - 33.333333333333336` evaluates to `33.33333333333332`, one ULP short of
   * `33.333333333333336`, silently dropping a due tick. Recomputing
   * `Math.floor(totalElapsedMs / fixedDtMs)` fresh from the two exact
   * accumulated numbers every call has no such compounding: each call only
   * ever divides the same growing numerator by the same constant
   * denominator, so no rounding error can carry forward between calls. */
  private totalElapsedMs = 0;

  constructor(
    private readonly fixedDtMs: number,
    private lastNowMs: number,
  ) {}

  /** Every tick index newly due since the last call (possibly more than one,
   * if real time jumped by more than one interval since the last call —
   * e.g. after a GC pause or main-thread stall) — ticks are never skipped
   * and never drift long-run even under irregular calling intervals. */
  advance(nowMs: number): number[] {
    this.totalElapsedMs += nowMs - this.lastNowMs;
    this.lastNowMs = nowMs;
    const dueUpTo = Math.floor(this.totalElapsedMs / this.fixedDtMs);
    const due: number[] = [];
    while (this.nextTick < dueUpTo) due.push(this.nextTick++);
    return due;
  }
}

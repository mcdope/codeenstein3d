// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * A minimal token-bucket rate limiter. Used host-side to bound how many
 * inbound `input`-channel messages a single guest can force the host to
 * `JSON.parse` + validate per second (see `multiplayerSessionHost.ts`): a
 * guest legitimately sends one `TickInput` per bundle it receives, but a
 * hostile one can flood thousands per second, each costing real CPU. Dropping
 * an over-rate message is safe-degrading — a guest's un-recorded input simply
 * becomes held-fallback in the finalized bundle, exactly as a genuinely
 * dropped packet would, so every peer still applies the same deterministic
 * bundle.
 *
 * `now` is injectable purely so the unit test can drive virtual time; real
 * callers let it default to `performance.now()`. Deliberately no wall-clock
 * dependency baked in beyond that one seam.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    /** Maximum tokens the bucket holds — the largest burst it will pass
     * before the steady refill rate takes over. */
    private readonly capacity: number,
    /** Tokens replenished per second once below capacity. */
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = this.now();
  }

  /** Refills for elapsed time, then removes one token if available. Returns
   * `true` (allowed) if a token was taken, `false` (rate-limited) otherwise. */
  tryRemove(): boolean {
    const nowMs = this.now();
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
    // Guard against a non-monotonic clock handing back a smaller value (never
    // add tokens for negative elapsed time); `performance.now()` is monotonic,
    // but the seam accepts any function.
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
      this.lastRefillMs = nowMs;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

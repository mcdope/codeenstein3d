// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Numeric helpers needed by more than one layer.
 *
 * Lives at the `src/` root, not under `map/` or `engine/`, for exactly the
 * reason `difficulty.ts` and `prng.ts` do (see
 * `doc/dev/architecture.md`'s "Why `difficulty.ts` and `prng.ts` live at `src/`
 * root"): both layers need it, and the map layer must never import the engine
 * layer. A dependency-free module at the root is layer-neutral by construction.
 *
 * These were seven separate, byte-identical private copies before —
 * `clamp` in `map/generation/util.ts`, `map/exportView.ts`, `map/debugView.ts`,
 * `engine/sprites.ts` and `engine/effects.ts`; `clamp01` in `engine/audio.ts`
 * and `engine/scoring.ts`.
 */

/** `value`, held within the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** `n`, held within the inclusive `[0, 1]` range — the shape volume levels and
 * normalized score fractions want. */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

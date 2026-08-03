// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Small shared helpers used across the generation modules. */
import type { Point } from "../types";

/** Re-exported so the thirteen `generation/*` modules that already import
 * `clamp` from here keep working unchanged — the implementation itself is
 * layer-neutral and lives at `src/mathUtil.ts` (see that module's own doc
 * comment for why). */
export { clamp } from "../../mathUtil";

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

/** Fisher-Yates shuffle using the level's seeded PRNG, for deterministic but
 * non-scan-order trap placement. */
export function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export function key(p: Point): string {
  return `${p.x},${p.y}`;
}

export function neighbors(p: Point): Point[] {
  return [
    { x: p.x + 1, y: p.y },
    { x: p.x - 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x, y: p.y - 1 },
  ];
}

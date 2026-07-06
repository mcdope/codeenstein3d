// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Small, fast, seedable PRNG (mulberry32) shared across layers. Lives at the
 * `src/` root, not under `map/` or `engine/`, for the same reason
 * `difficulty.ts` does (see its doc comment): both layers need it, and `map`
 * must never import from `engine`.
 *
 * `MapGenerator` has used a seed derived from the parsed AST's content since
 * before this module existed (see `seedFrom` in `mapGenerator.ts`) — the same
 * source always lays out the same rooms/corridors. This module extracts that
 * generator function so the engine layer can use the *identical* algorithm for
 * its own gameplay randomness (enemy AI timing/roam targets, loot rolls,
 * weapon spread) — the whole point being that a recorded gameplay seed plus a
 * recorded input sequence reproduces an *exact* run for the replay system
 * (see `src/engine/replay.ts`), which only holds if every simulation-relevant
 * random draw goes through one deterministic stream, not `Math.random()`.
 *
 * Deliberately *not* used for purely cosmetic/presentational randomness that
 * never feeds back into simulation state — blood-particle scatter
 * (`effects.ts`), SFX pitch variance (`audio.ts`), BGM shuffle order
 * (`bgm.ts`), and console hint selection (`consoleSidebar.ts`) all stay on
 * `Math.random()` on purpose: none of it affects score/survival/position, so
 * seeding it would only add complexity for a replay no one would notice
 * diverge.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fresh, non-deterministic 32-bit seed — the *one* place real randomness is
 * allowed to enter an otherwise fully-seeded run: picking which deterministic
 * universe this playthrough's combat/loot/AI timing will be (recorded for the
 * replay system so the same universe can be reproduced later).
 */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

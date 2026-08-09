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
  return createResumablePrng(seed).next;
}

/**
 * A `mulberry32` stream whose raw internal state can be read and resumed —
 * needed only by multiplayer reconciliation (`doc/dev/multiplayer-netcode-spec.md`
 * §3, "the PRNG state gap"): the host periodically broadcasts `getState()`'s
 * raw 32-bit counter so a guest can `setState()` its own stream back into
 * exact alignment, resuming the sequence rather than restarting it from a
 * fresh seed. `mulberry32()` above is defined in terms of this (`next`
 * detached and called standalone) so the two can never drift apart — every
 * other caller (map generation, single-player gameplay rng) keeps using the
 * plain closure form and never needs to know this exists.
 *
 * `next()` is safe to detach from the returned object (as `mulberry32` does)
 * because it closes over `a` directly, not `this`.
 */
export function createResumablePrng(seed: number): { next: () => number; getState: () => number; setState: (state: number) => void } {
  let a = seed >>> 0;
  return {
    next: () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState: () => a >>> 0,
    setState: (state: number) => {
      a = state >>> 0;
    },
  };
}

/**
 * A fresh, non-deterministic 32-bit seed — the *one* place real randomness is
 * allowed to enter an otherwise fully-seeded run: picking which deterministic
 * universe this playthrough's combat/loot/AI timing will be (recorded for the
 * replay system so the same universe can be reproduced later).
 *
 * **Unless `?seed=` pins it.** Map generation has always been deterministic
 * and content-addressed (`seedFrom` in `mapGenerator.ts`), so "same repo, same
 * commit, same version" already reproduced the same *level* — but not the same
 * *run*, because every loot roll, enemy fire cadence and weapon-spread draw
 * comes off this seed and nothing could supply one. That made the drop half of
 * the economy unreproducible between runs, which is a problem for balancing
 * specifically: an A/B that changes a drop constant cannot tell the change
 * apart from a different roll of the same dice. `?seed=` closes that. See
 * `doc/dev/balancing-telemetry.md`.
 *
 * Deliberately *not* persisted anywhere and not surfaced in the UI: it is a
 * debugging and balancing affordance, and a real player's run should keep
 * getting a fresh universe. An unparsable or out-of-range value is ignored
 * rather than treated as 0, so a typo cannot silently pin every run to the
 * same universe.
 */
export function randomSeed(): number {
  const pinned = pinnedSeed();
  if (pinned === null) return (Math.random() * 0xffffffff) >>> 0;
  // Successive calls must not all return the same number. A campaign asks for
  // one seed per level, and handing every level the identical seed would make
  // the first loot roll of every level draw the same value — a systematic
  // artifact across exactly the runs this exists to measure. Deriving each
  // seed from a `mulberry32` stream rooted at the pinned value keeps the whole
  // sequence reproducible while leaving the levels independent.
  pinnedStream ??= mulberry32(pinned);
  return (pinnedStream() * 0xffffffff) >>> 0;
}

/** Lazily created on the first pinned `randomSeed()` call, then reused for the
 * lifetime of the page — one page load is one campaign attempt, so restarting
 * the sequence per level is exactly what we are avoiding. */
let pinnedStream: (() => number) | null = null;

/** The `?seed=` override, or `null` when absent/unusable. Accepts decimal or
 * `0x`-prefixed hex, and only a finite non-negative integer inside the 32-bit
 * range. Exported for `main.ts`'s own startup log — a pinned run should say so
 * out loud, since every subsequent number in it is a consequence. */
export function pinnedSeed(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("seed");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

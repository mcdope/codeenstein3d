// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * How many recorded frames a replay in progress has actually consumed, from
 * one `__codeensteinReplayTestHooks.getState()` snapshot — the quantity
 * `verify-replay.mjs` budgets a playback against.
 *
 * The completed levels are the easy half: `state.levels` holds one entry per
 * level that has already ended, each with its own `framesConsumed`. The
 * in-flight level is the half worth a module. `state.probe` is a live closure
 * over the replay loop's own counters (`main.ts`), and `loadLevel` advances
 * `levelIndex` *before* the incoming level resets `frameIndex` and
 * `framesRecorded` — so during a transition the probe reports the outgoing
 * level's frame counters under the incoming level's index, while that
 * outgoing level has already been pushed onto `state.levels`. Adding
 * `probe.frameIndex` unconditionally therefore counts the level that just
 * ended twice.
 *
 * That is not cosmetic. It cost a red master: the shipped board's third entry
 * spends 11618 of its 25527 frames in level 6, so the double count read as
 * 36548 consumed the instant level 6 handed over to level 7 — past the
 * `1.05x + 5000` budget, on a playback that was in fact frame-exact. It went
 * unnoticed on the two long entries because the overshoot is bounded by one
 * level's frames, and those runs are twice as long with no level dominating
 * them.
 *
 * The probe is counted only when it is *coherent*: it must name a level that
 * is not already recorded as finished, and its `framesRecorded` must match
 * what that level actually recorded. A stale snapshot fails the second test
 * because it is still carrying the previous level's count. Two adjacent
 * levels with byte-identical recorded lengths would slip through, which
 * overstates by at most that one level — the pre-existing behaviour, and
 * still bounded.
 *
 * @param {{levels?: Array<{framesConsumed: number}>, probe?: {levelIndex: number, frameIndex: number, framesRecorded: number} | null}} state
 *   A snapshot from the replay test hooks.
 * @param {Array<{framesRecorded: number}>} expectedLevels
 *   The entry's recorded levels, in order — the board's own account of what
 *   playback should consume.
 * @returns {number} Frames consumed so far, completed levels plus a coherent
 *   in-flight one.
 */
export function consumedFrames(state, expectedLevels) {
  const finished = (state.levels ?? []).reduce((sum, level) => sum + level.framesConsumed, 0);
  const probe = state.probe;
  if (!probe) return finished;

  const claimed = expectedLevels[probe.levelIndex - 1];
  const coherent = claimed !== undefined && probe.levelIndex > (state.levels ?? []).length && probe.framesRecorded === claimed.framesRecorded;
  return coherent ? finished + probe.frameIndex : finished;
}

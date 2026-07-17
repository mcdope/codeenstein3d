// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Generalized "retry until N qualifying runs" loop, extracted from
 * `run-balancing-telemetry.mjs`'s `runCombo` (which called `runOneAttempt`
 * and treated `reachedExitForLevel[QUALIFY_LEVEL_INDEX]` as the fixed
 * qualifying condition for every profile). Here both "one attempt" and
 * "is this run qualifying" are caller-supplied, so the same retry-until-N
 * machinery can be reused with a per-profile qualifying level (e.g. the
 * default-highscore generator's Casual/Gamer/Pro → level 4/5/6 mapping)
 * instead of one fixed threshold for every caller.
 */

/**
 * @param {object} opts
 * @param {() => Promise<any>} opts.runAttempt - plays one attempt, returns a
 *   run-result object.
 * @param {(run: any) => boolean} opts.isQualifying - whether a run counts
 *   toward `requiredQualifyingRuns`.
 * @param {number} opts.requiredQualifyingRuns
 * @param {number} [opts.attemptCap=Infinity]
 * @param {number} [opts.concurrency=1] - attempts run per batch, via
 *   `Promise.all`.
 * @param {(attempts: number, qualifyingCount: number) => void} [opts.onProgress] -
 *   called once per batch with the running attempt/qualifying totals
 *   (`qualifyingCount` clamped to `requiredQualifyingRuns`, matching the
 *   final trimmed count).
 * @param {(run: any, attemptIndex: number) => void} [opts.onAttemptResult] -
 *   called once per individual attempt, in order, as results land.
 * @returns {Promise<{qualifyingRuns: any[], attemptsUsed: number,
 *   failureReasons: {attempt: number, reason: any, diedAtLevelIndex: any}[],
 *   trueQualifyingCount: number}>}
 */
export async function runQualifyLoop({
  runAttempt,
  isQualifying,
  requiredQualifyingRuns,
  attemptCap = Infinity,
  concurrency = 1,
  onProgress,
  onAttemptResult,
}) {
  const qualifyingRuns = [];
  const failureReasons = [];
  let attempts = 0;
  let consecutiveCrashedBatches = 0;

  while (qualifyingRuns.length < requiredQualifyingRuns && attempts < attemptCap) {
    const batchSize = Math.min(concurrency, attemptCap - attempts);
    const batch = await Promise.all(Array.from({ length: batchSize }, () => runAttempt()));

    const crashedInBatch = batch.filter((run) => run.reason?.startsWith("attemptCrashed")).length;
    // If literally every attempt in a batch crashed, the shared browser
    // instance itself is almost certainly dead, not just one flaky context —
    // don't spin forever re-crashing instantly; surface it as a hard failure.
    consecutiveCrashedBatches = crashedInBatch === batch.length ? consecutiveCrashedBatches + 1 : 0;
    if (consecutiveCrashedBatches >= 3) {
      throw new Error(`browser appears dead: ${consecutiveCrashedBatches} consecutive fully-crashed batches`);
    }

    for (const run of batch) {
      attempts += 1;
      if (isQualifying(run)) {
        qualifyingRuns.push(run);
      } else {
        failureReasons.push({ attempt: attempts, reason: run.reason, diedAtLevelIndex: run.diedAtLevelIndex });
      }
      onAttemptResult?.(run, attempts);
    }
    onProgress?.(attempts, Math.min(qualifyingRuns.length, requiredQualifyingRuns));
  }

  // A batch can overshoot (e.g. several concurrent attempts qualify at once)
  // — trim to exactly `requiredQualifyingRuns` samples so aggregation stays
  // consistent with a sequential run. IMPORTANT: capture the untrimmed count
  // first — when concurrency > requiredQualifyingRuns, the loop can exit
  // after a single batch once true per-attempt success is reasonably high,
  // which mechanically floors `qualifyingRuns.length`/`attemptsUsed` at
  // requiredQualifyingRuns/concurrency regardless of the real underlying
  // rate. `trueQualifyingCount` preserves the real number of successes in
  // the final batch so downstream rate calculations aren't silently
  // censored by the sample-size trim.
  const trueQualifyingCount = qualifyingRuns.length;
  qualifyingRuns.length = Math.min(qualifyingRuns.length, requiredQualifyingRuns);

  return { qualifyingRuns, attemptsUsed: attempts, failureReasons, trueQualifyingCount };
}

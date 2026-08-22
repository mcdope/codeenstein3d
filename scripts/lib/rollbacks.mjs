// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Turning the singleplayer rollback grant off for a scripted run, and
 * proving it took.
 *
 * Lives here rather than in `run-balancing-telemetry.mjs` beside its
 * `installDifficulty`/`installPlayerName` siblings because the scripts that
 * genuinely *need* it are elsewhere — pulling the whole telemetry harness in
 * as a dependency just to reach two three-line functions would be the tail
 * wagging the dog.
 */

/** The localStorage key `main.ts`'s `rollbacksDisabled()` reads. Only honoured
 * under `?testHooks=1`, so this is inert against a production build. */
export const ROLLBACKS_DISABLED_KEY = "codeenstein-rollbacks-disabled";

/**
 * Suppress the rollback grant before the page boots, the same way
 * `installDifficulty` presets difficulty.
 *
 * Which scripts need this, and why, is worth being precise about. The
 * balancing bot does **not**: `playRun` returns the instant the engine
 * reports `over` and closes the context without ever dismissing the Kernel
 * Panic overlay, so a bot cannot spend a rollback and per-level survival
 * telemetry is identical either way. It installs this anyway as a guard, so
 * that a future change to how a run ends cannot silently start handing the
 * bot extra lives and shift every captured `died[i]/reached[i]` against the
 * archived captures it is compared to.
 *
 * The scripts that break outright without it are the ones asserting on the
 * death path itself: `verify-campaign-playthrough.mjs` (which requires a
 * highscore written and the save cleared on death) and
 * `generate-default-highscore.mjs` (which waits for a highscore that a run
 * with rollbacks left no longer writes).
 */
export async function installRollbacksDisabled(page) {
  await page.addInitScript((key) => localStorage.setItem(key, "1"), ROLLBACKS_DISABLED_KEY);
}

/**
 * Throw unless rollbacks really are off for this page.
 *
 * Asserts the resolved *state* rather than that the install call returned. A
 * preset that is silently ignored — wrong key, storage unavailable, a build
 * without the hook — looks identical to one that worked, and the run's
 * numbers are then quietly incomparable to every archived capture with
 * nothing in the log saying so.
 *
 * `granted` is the field that carries the answer: `remaining: 0` on its own
 * cannot tell "disabled" apart from "already spent them all".
 */
export async function assertRollbacksDisabled(page) {
  const state = await page.evaluate(() => window.__codeensteinCampaignTestHooks?.getRollbackState?.() ?? null);
  if (state === null) {
    throw new Error("rollback state unavailable — is ?testHooks=1 set, and has the page finished booting?");
  }
  if (state.granted !== 0 || state.remaining !== 0) {
    throw new Error(`rollbacks not disabled: ${JSON.stringify(state)}`);
  }
  return state;
}

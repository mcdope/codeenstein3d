// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Versioning for everything this game persists in `localStorage`.
 *
 * **Why this exists.** Eight keys are written across `main.ts` and
 * `highscores.ts` (`codeenstein-player-name`, `-gore-level`, `-difficulty`,
 * `-master-volume`, `-sfx-volume`, `-bgm-volume`, `-campaign-save`,
 * `-highscores`) and none of them carried a version. A shape change to any of
 * them — a new field in the campaign save, a different highscore packing —
 * would have been indistinguishable from data written by the current build, so
 * the only safe migration would have been to guess from the contents. This
 * records *when* the data was written so a future change can decide.
 *
 * Nothing migrates yet, deliberately: there is no old shape to move off. What
 * ships is the stamp and the seam, so the first real migration is an entry in
 * one `switch` rather than an archaeology exercise.
 */

/** Every key this game owns. The prefix is the contract — anything outside it
 * belongs to another app on the same origin and must never be touched. */
export const STORAGE_KEY_PREFIX = "codeenstein-";

/** Where the schema version itself lives. Deliberately inside the prefix, so
 * `clearAll`-style tooling that walks the prefix picks it up too. */
export const SCHEMA_VERSION_KEY = `${STORAGE_KEY_PREFIX}schema-version`;

/**
 * Current schema version. **Bump this when the shape of any persisted value
 * changes**, and add the matching case to `migrateStorage`.
 *
 * 1 — the shape as of 2026-08-12: the eight keys listed above, unversioned
 *     until now.
 */
export const STORAGE_SCHEMA_VERSION = 1;

/** Storage written before versioning existed. Distinguishable from a genuine
 * first run only by whether *any* owned key is present — which is exactly what
 * `readSchemaState` reports. */
export const LEGACY_SCHEMA_VERSION = 0;

export type SchemaState =
  /** No owned key at all: nothing has ever been saved on this origin. */
  | { kind: "first-run" }
  /** Owned keys exist but no version stamp — written before this module. */
  | { kind: "legacy"; version: typeof LEGACY_SCHEMA_VERSION }
  /** Stamped, and the stamp is one this build understands. */
  | { kind: "current"; version: number }
  /** Stamped *newer* than this build. A different tab on a newer deploy, or a
   * downgrade. Never migrated downward — see `migrateStorage`. */
  | { kind: "future"; version: number };

/**
 * `localStorage` can throw on *every* interaction, not just on acquisition —
 * Safari's private mode and policy-disabled storage both throw from
 * `getItem`/`setItem`/`key`, and a disabled-storage browser can throw merely
 * on touching the global. So each accessor below is guarded individually
 * rather than the handle being fetched once and trusted; an earlier cut
 * guarded only the fetch and still died on the first read.
 *
 * Every caller here would rather see "no data" than take down module
 * initialization, so a throw reads as absence.
 */
function withStorage<T>(fallback: T, fn: (store: Storage) => T): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    return fn(localStorage);
  } catch {
    return fallback;
  }
}

/** Every `codeenstein-`-prefixed key currently present, version stamp
 * included. Order is whatever the browser reports; callers must not rely on
 * it. */
export function ownedKeys(): string[] {
  return withStorage<string[]>([], (store) => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  });
}

/**
 * What state this origin's storage is in, without changing it.
 *
 * The first-run test is "no owned key at all", not "no version stamp" — an
 * existing player has seven keys and no stamp, and treating them as a first
 * run would re-show the intro to someone with a campaign already in progress.
 */
export function readSchemaState(): SchemaState {
  const raw = withStorage<string | null>(null, (store) => store.getItem(SCHEMA_VERSION_KEY));
  if (raw === null) {
    // The stamp is itself an owned key, so exclude nothing here: if the only
    // key were the stamp we would not be in this branch at all.
    return ownedKeys().length === 0 ? { kind: "first-run" } : { kind: "legacy", version: LEGACY_SCHEMA_VERSION };
  }
  const version = Number.parseInt(raw, 10);
  // A stamp that is not a number is corrupt rather than old, and reading it as
  // 0 would run every future migration over data that may already be current.
  // Treating it as "future" is the conservative direction: migrations are
  // skipped and nothing is rewritten.
  if (!Number.isFinite(version)) return { kind: "future", version: Number.NaN };
  if (version > STORAGE_SCHEMA_VERSION) return { kind: "future", version };
  return { kind: "current", version };
}

/** True when nothing has ever been persisted on this origin — the condition
 * the first-run intro is gated on. */
export function isFirstRun(): boolean {
  return readSchemaState().kind === "first-run";
}

/**
 * Bring stored data up to `STORAGE_SCHEMA_VERSION` and stamp it, returning the
 * state found *before* any change so a caller can branch on it (the intro
 * needs to know it was a first run, and stamping would otherwise erase that).
 *
 * **Never migrates downward.** Storage stamped newer than this build was
 * written by a newer deploy — very likely in another tab, since the two share
 * an origin — and rewriting it to this build's shape would corrupt data the
 * other tab is still using. Leaving it alone is the only safe move: the newer
 * build can read its own data, and this one degrades to whatever it can parse.
 */
export function migrateStorage(): SchemaState {
  const before = readSchemaState();
  if (before.kind === "future") return before;

  // No migration bodies yet, and no empty `switch` pretending otherwise:
  // version 1 *is* the first stamped shape, and "legacy" data has the same
  // layout — it simply predates the stamp. When version 2 arrives, the
  // transform goes here, keyed off `before.version` for the `legacy`/`current`
  // cases, and runs before the stamp below.

  // Quota or a disabled store swallows here: the stamp is an optimization for
  // the *next* launch, never a correctness requirement for this one.
  withStorage(undefined, (store) => store.setItem(SCHEMA_VERSION_KEY, String(STORAGE_SCHEMA_VERSION)));
  return before;
}

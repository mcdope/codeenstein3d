// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The balancing **event log**: one record per occurrence, buffered in memory
 * and drained by the harness, alongside (never instead of) `telemetry.ts`'s
 * aggregate counters.
 *
 * **Why both.** Everything in `telemetry.ts` is a scalar accumulator —
 * `damageBySource.enemyMelee = 412` cannot be decomposed into which enemy,
 * when, or how much per bite. That makes a new metric a re-instrumentation
 * job, and it makes anything with a *timeline* (loot income against
 * expenditure, starvation windows, overkill on the killing blow)
 * uncomputable after the fact. The counters stay exactly as they are, because
 * every stored `balancing_runs/` dataset and every pre-registered A/B
 * threshold in `abReport.mjs` is calibrated against them; this is the raw
 * stream those numbers could have been derived from. See
 * `doc/dev/balancing-telemetry.md`'s "The balance model" for the schema and
 * the metric each field exists to serve.
 *
 * **Cost.** Recording is gated on `RaycasterEngine.telemetryEnabled`, which is
 * already computed once at construction (`PLAYER_STATS_ENABLED ||
 * isTestHooksActive()`), so this adds no new branch to shipped play and no new
 * gate to reason about. Every emission point is **event-rate, not
 * frame-rate**: `fire`, `damage`, `damageEnemy`, `pushLootDrop`, the two loot
 * collection branches, `killPlayer`, `endGame`. Nothing here is called from
 * `simulate()` or `render()`, which is deliberate and load-bearing —
 * `playerStats.ts` records that ~20 plain counter increments were enough to
 * measurably slow real play, so this path must not widen.
 *
 * Records are pushed as plain objects and serialised in Node, off the
 * browser's clock entirely.
 */

/** Bumped on any breaking field change, so a reader can refuse a log it does
 * not understand rather than silently misinterpreting a renamed field.
 *
 * 2 (2026-08-05) — `damageTaken` gained `by`: a per-attacker breakdown of who
 * dealt the damage (`{eid, arch, amt}[]`, `null` for trap/hazard/self
 * sources). Strictly additive, and `arch` is retained as an always-`null`
 * field, so a schema-1 reader still finds every key it knew; the bump is so a
 * *consumer* can tell a log that can answer "which archetype killed you" from
 * one that structurally cannot. Every capture before this date, including
 * `balancing_runs_overnight-2026-08-04/`, is schema 1 and cannot. */
export const BALANCE_EVENT_SCHEMA_VERSION = 2;

export type BalanceEventType =
  | "levelStart"
  | "shot"
  | "hit"
  | "damageDealt"
  | "kill"
  | "damageTaken"
  | "lootDropped"
  | "lootCollected"
  | "weaponSwitch"
  | "weaponGranted"
  | "playerDeath"
  | "levelEnd";

/** One recorded occurrence. `e` is the type and `t` is `levelTime` in seconds;
 * everything else is per-type and documented in the design doc. Deliberately
 * loose — the schema lives in the doc and in the reader, not in a type that
 * would have to be widened for every new field. */
export interface BalanceEvent {
  e: BalanceEventType;
  t: number;
  [field: string]: unknown;
}

/**
 * A hard ceiling on buffered events, so a pathological level cannot exhaust
 * the tab's memory before the next drain.
 *
 * Sized against the real worst case rather than guessed: the largest level the
 * corpus produces is ~430 enemies (ripgrep's `flags/defs.rs`), and a kill
 * costs on the order of ten events once shots, pellet hits, damage and drops
 * are counted. 200k leaves well over an order of magnitude of headroom while
 * staying a few tens of MB.
 *
 * On overflow the log **stops recording and counts what it dropped** rather
 * than evicting oldest-first. A ring buffer would silently hand the reader a
 * log whose early events are missing, which is indistinguishable from a level
 * that simply started late — and every economy metric here is cumulative, so a
 * missing prefix corrupts the total rather than truncating it. A truncated
 * tail with an explicit count is honest; `dropped > 0` means "do not trust the
 * totals from this level".
 */
export const MAX_BUFFERED_EVENTS = 200_000;

export interface EventLogState {
  events: BalanceEvent[];
  /** How many events were discarded after `MAX_BUFFERED_EVENTS` was hit. */
  dropped: number;
}

export function createEventLog(): EventLogState {
  return { events: [], dropped: 0 };
}

/**
 * Append one event. `fields` is spread over the envelope, so a field named
 * `e` or `t` would shadow it — no caller does, and the design doc's schema
 * reserves both names.
 */
export function recordEvent(
  log: EventLogState,
  type: BalanceEventType,
  levelTime: number,
  fields?: Record<string, unknown>,
): void {
  if (log.events.length >= MAX_BUFFERED_EVENTS) {
    log.dropped += 1;
    return;
  }
  log.events.push({ e: type, t: levelTime, ...fields });
}

/**
 * Hand the buffered events to the caller and reset.
 *
 * Returns the existing array rather than a copy and installs a fresh one — the
 * caller owns what it receives, and copying a six-figure array across the
 * Playwright boundary twice would be the one genuinely expensive thing in this
 * module.
 *
 * The harness drains at each level boundary and once at run end, which is what
 * bounds the buffer in practice and what decides how much a crashed browser
 * loses: everything up to the last drain is already on disk.
 */
export function drainEvents(log: EventLogState): { events: BalanceEvent[]; dropped: number } {
  const drained = { events: log.events, dropped: log.dropped };
  log.events = [];
  log.dropped = 0;
  return drained;
}

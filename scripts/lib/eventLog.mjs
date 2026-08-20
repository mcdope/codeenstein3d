// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Node side of the balancing event log: turns what
 * `__codeensteinTestHooks.drainEvents()` hands back into newline-delimited
 * JSON on disk, and reads it back.
 *
 * **Why NDJSON rather than one JSON document.** `balancing_telemetry.json` is
 * written by a single `JSON.stringify` at process end, so a killed campaign
 * loses it entirely — and the campaign orchestrator *does* SIGKILL
 * invocations, by design (`laneOrchestrator.mjs`'s watchdog). An append-only
 * log has to survive that. A truncated final line is discardable; a truncated
 * JSON array is unparseable. CSV was the other option and loses: a `shot` and
 * a `levelEnd` share almost no fields, so one file needs a wide sparse header
 * and one-file-per-type loses the interleaving every timeline metric reads.
 *
 * No dependency: `JSON.parse` per line, `fs.appendFileSync` to write.
 *
 * The **envelope** (`v`/`sid`/`rid`/`lvl`) is stamped here rather than in the
 * engine. Run identity is the harness's knowledge, not the simulation's, and
 * keeping it out of the browser means the per-event cost there stays a plain
 * object push. See `doc/dev/balancing-telemetry.md` for the full schema.
 */
import fs from "node:fs";
import path from "node:path";

/** Kept in step with `src/engine/events.ts`'s own constant. Asserted equal by
 * `eventLog.test.mjs`, so the two cannot drift the way a mirrored constant
 * silently can. */
export const BALANCE_EVENT_SCHEMA_VERSION = 3;

/**
 * Append one drained batch to `filePath`, stamping the envelope onto each
 * record. Creates the parent directory on first write.
 *
 * A batch that dropped events (the engine's buffer cap was hit) gets one extra
 * `bufferOverflow` record carrying the count, so a reader can refuse to trust
 * that level's cumulative totals instead of quietly reporting a short one.
 * Silence there would be the worst outcome: every economy metric in the log is
 * cumulative, so missing events understate a total rather than truncating it.
 */
export function appendEvents(filePath, envelope, drained) {
  if (!drained || (drained.events.length === 0 && !drained.dropped)) return 0;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const stamp = { v: BALANCE_EVENT_SCHEMA_VERSION, ...envelope };
  const lines = drained.events.map((event) => JSON.stringify({ ...stamp, ...event }));
  if (drained.dropped > 0) {
    lines.push(JSON.stringify({ ...stamp, e: "bufferOverflow", t: -1, dropped: drained.dropped }));
  }
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`);
  return lines.length;
}

/**
 * Read a whole log back.
 *
 * A malformed final line is dropped silently — that is exactly the kill-mid-write
 * case NDJSON was chosen for, and refusing the whole file because the process
 * died would throw away every complete record before it. A malformed line
 * anywhere *else* is a real corruption and is reported in `malformed`, since
 * nothing legitimate produces one.
 */
export function readEventLog(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const events = [];
  const malformed = [];
  let truncatedTail = false;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (index === lines.length - 1) truncatedTail = true;
      else malformed.push(index + 1);
    }
  }
  return { events, malformed, truncatedTail };
}

/** Groups a flat event stream by `rid` then `lvl`, preserving order within
 * each level — the shape every derived metric wants, since a run's levels are
 * a sequence and its economy carries across them. */
export function groupByRunAndLevel(events) {
  const runs = new Map();
  for (const event of events) {
    if (!runs.has(event.rid)) runs.set(event.rid, new Map());
    const levels = runs.get(event.rid);
    if (!levels.has(event.lvl)) levels.set(event.lvl, []);
    levels.get(event.lvl).push(event);
  }
  return runs;
}

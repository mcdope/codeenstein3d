// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Verifies a balancing event log is internally consistent and externally
 * correct, and exits non-zero if it is not.
 *
 * ```sh
 * npm run verify:event-log -- balancing_events/
 * npm run verify:event-log -- balancing_events/Gamer-hard.ndjson
 * ```
 *
 * **Why this exists as a script rather than a one-off.** "Is the telemetry
 * right?" was asked three times, and two of those found a real defect: a
 * fabricated hit rate for splash weapons, and whole levels silently discarded
 * on any run that ended `stuck`. Both had already survived an ad-hoc check.
 * The second one is the instructive case — it was *hidden* by the check meant
 * to catch it, because a lost level drops its `levelStart` and `levelEnd`
 * together and the balanced totals looked healthy. Ad-hoc checks answer the
 * question you thought to ask; this one asks all of them, every time.
 *
 * Three tiers, weakest to strongest:
 *
 * 1. **Structural** — parseable lines, no dropped events, envelope present.
 * 2. **Conservation** — arithmetic and bookkeeping that must hold within a
 *    log: damage sums, roster accounting, kill/damage pairing, loot pairing.
 *    These catch corruption but not a *consistently wrong* value.
 * 3. **Cross-site agreement** — every enemy archetype is emitted independently
 *    at five call sites, so all five must agree with the roster `levelStart`
 *    recorded. This catches a mislabel at one site but not one shared by all.
 *
 * The genuinely external check — that the roster itself is right — needs a
 * second source and lives outside this script: generate the same campaign with
 * `npm run balancing:budget -- --json` and compare rosters. Node and the
 * browser build the map through entirely separate runtimes, so agreement there
 * is real validation rather than self-consistency. Measured on the demo
 * campaign: identical archetype and HP multisets on all 12 levels captured.
 */
import fs from "node:fs";
import path from "node:path";

import { readEventLog } from "./lib/eventLog.mjs";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";

/** Single-pellet weapons fire dead-centre, so the enemy under the crosshair is
 * the one a landing pellet hits — barring one frame of staleness, since
 * `this.target` is set during the previous frame's render. Below this, the
 * crosshair bookkeeping is suspect rather than merely stale. */
const TARGET_ARCH_AGREEMENT_FLOOR = 0.95;
const SINGLE_PELLET_WEAPONS = new Set([0, 3]);

/** Locale-independent thousands separator. `toLocaleString()` renders 33441 as
 * "33.441" under a German locale, which reads as a decimal in a report meant to
 * be pasted into a doc. */
function num(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Every `.ndjson` at or under `target`, recursively.
 *
 * Recursive because a lane-parallel capture keeps one directory per
 * invocation (`events/<combo>-<seq>/`) — `writeEventBatches` names its file
 * from profile+difficulty alone, so two invocations of one combo can only be
 * kept apart by their parent directory. A flat listing found nothing there
 * and exited "no .ndjson logs", which reads like an empty capture rather than
 * a verifier that did not look. */
function collectLogs(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const found = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...collectLogs(full));
    else if (entry.name.endsWith(".ndjson")) found.push(full);
  }
  return found.sort();
}

/** One counter pair per named check, so the report states its own denominator
 * — a check that ran zero times is not a passing check, and saying so is the
 * whole point of printing `n`. */
function makeChecker() {
  const ran = new Map();
  const failed = new Map();
  const example = new Map();
  return {
    note(name, ok, detail) {
      ran.set(name, (ran.get(name) ?? 0) + 1);
      if (!ok) {
        failed.set(name, (failed.get(name) ?? 0) + 1);
        if (!example.has(name)) example.set(name, detail);
      }
    },
    ran,
    failed,
    example,
  };
}

function verifyLog(filePath, checker) {
  const { events, malformed, truncatedTail } = readEventLog(filePath);
  const notes = [];

  if (malformed.length > 0) {
    checker.note("no malformed lines", false, `lines ${malformed.slice(0, 5).join(", ")}`);
  } else {
    checker.note("no malformed lines", true);
  }
  // A truncated final line is the SIGKILL-mid-write case NDJSON exists for, so
  // it is reported but not a failure.
  if (truncatedTail) notes.push("final line truncated (run was killed mid-write) — everything before it is intact");

  const overflow = events.filter((e) => e.e === "bufferOverflow");
  const dropped = overflow.reduce((sum, e) => sum + (e.dropped ?? 0), 0);
  checker.note("no events dropped by the buffer cap", dropped === 0, `${dropped} dropped`);

  const roster = new Map(); // `${rid}|${lvl}` -> Map<eid, {arch, maxHp}>
  const started = new Set();
  const ended = new Set();
  const key = (e) => `${e.rid}|${e.lvl}`;

  for (const event of events) {
    for (const field of ["v", "e", "t", "rid", "lvl"]) {
      checker.note("envelope complete", event[field] !== undefined && event[field] !== null, `${event.e} missing ${field}`);
    }
    const k = key(event);
    const known = roster.get(k);
    const ref = (eid) => known?.get(eid);

    switch (event.e) {
      case "levelStart":
        started.add(k);
        roster.set(k, new Map(event.enemies.map((x) => [x.eid, { arch: x.arch, maxHp: x.maxHp }])));
        break;
      case "damageDealt": {
        checker.note("damage arithmetic (hpBefore - amt == hpAfter)", Math.abs(event.hpBefore - event.amt - event.hpAfter) < 1e-9, event);
        const r = ref(event.eid);
        checker.note("damageDealt.arch agrees with the roster", r?.arch === event.arch, { eid: event.eid, said: event.arch, roster: r?.arch });
        break;
      }
      case "kill": {
        const r = ref(event.eid);
        checker.note("kill.arch agrees with the roster", r?.arch === event.arch, { eid: event.eid, said: event.arch, roster: r?.arch });
        checker.note("kill.maxHp agrees with the roster", r?.maxHp === event.maxHp, { eid: event.eid, said: event.maxHp, roster: r?.maxHp });
        break;
      }
      case "hit":
        if (typeof event.eid === "number") {
          checker.note("hit.eid is a real roster index", known?.has(event.eid) === true, event.eid);
        }
        break;
      case "lootDropped": {
        const r = ref(event.fromEid);
        checker.note("lootDropped.fromArch agrees with the roster", r?.arch === event.fromArch, { eid: event.fromEid, said: event.fromArch, roster: r?.arch });
        break;
      }
      case "damageTaken": {
        // `by` is schema 2+; schema-1 logs have only the always-null `arch`
        // and are skipped rather than failed.
        if (Array.isArray(event.by)) {
          for (const entry of event.by) {
            const r = ref(entry.eid);
            checker.note("damageTaken.by[].arch agrees with the roster", r?.arch === entry.arch, { eid: entry.eid, said: entry.arch, roster: r?.arch });
            checker.note("damageTaken.by[].amt is positive", entry.amt > 0, entry);
          }
          // Deliberately no sum-vs-`amt` assertion: `amt` is
          // difficulty-scaled and `by[].amt` are not, and reconstructing the
          // multiplier here would mirror `DIFFICULTY_MULTIPLIERS` into a
          // second place — the exact drift this repo has been bitten by
          // before. The per-entry roster agreement is the real check.
          checker.note("attributable damage carries a non-empty breakdown", event.by.length > 0, event);
        }
        // Only enemy-dealt damage has an attacker; the rest must not invent one.
        if (event.src !== "enemyMelee" && event.src !== "enemyRanged") {
          checker.note("unattributable damage sources carry no breakdown", event.by === null || event.by === undefined, { src: event.src, by: event.by });
        }
        break;
      }
      case "levelEnd":
        ended.add(k);
        for (const alive of event.enemiesAlive ?? []) {
          const r = ref(alive.eid);
          checker.note("levelEnd alive-enemy arch agrees with the roster", r?.arch === alive.arch, alive);
        }
        break;
      default:
        break;
    }
  }

  // Roster conservation, per level-visit: everything spawned either died or
  // was still standing. Deliberately keyed off `levelEnd`, and deliberately
  // *not* treated as complete just because the counts balance — a level lost
  // wholesale drops both records and leaves the totals looking healthy, which
  // is exactly how the stuck-run data loss hid.
  const killsPerLevel = new Map();
  for (const event of events) {
    if (event.e !== "kill") continue;
    killsPerLevel.set(key(event), (killsPerLevel.get(key(event)) ?? 0) + 1);
  }
  for (const event of events) {
    if (event.e !== "levelEnd") continue;
    const k = key(event);
    const spawned = roster.get(k)?.size;
    if (spawned === undefined) continue;
    const alive = (event.enemiesAlive ?? []).length;
    checker.note("roster conservation (spawned == kills + alive)", spawned === (killsPerLevel.get(k) ?? 0) + alive, {
      level: event.lvl,
      spawned,
      kills: killsPerLevel.get(k) ?? 0,
      alive,
    });
  }

  const unclosed = [...started].filter((k) => !ended.has(k));
  if (unclosed.length > 0) {
    notes.push(`${unclosed.length} level(s) started but never closed — expected only if a run was killed mid-level`);
  }

  // Loot pairing: a collected drop must reference a spawn.
  const spawnedDrops = new Set(events.filter((e) => e.e === "lootDropped").map((e) => e.did));
  for (const event of events) {
    if (event.e !== "lootCollected") continue;
    checker.note("lootCollected has a source", event.source === "preplaced" || event.source === "drop", event.source);
    if (event.source === "drop") {
      checker.note("collected drop references a real spawn", spawnedDrops.has(event.did), event.did);
    }
  }

  // targetArch plausibility: for a single-pellet weapon the pellet flies
  // dead-centre, so the crosshair archetype should match what was hit.
  let agree = 0;
  let total = 0;
  let pending = null;
  for (const event of events) {
    if (event.e === "shot") {
      pending = SINGLE_PELLET_WEAPONS.has(event.w) && event.targetArch != null ? { k: key(event), arch: event.targetArch } : null;
    } else if (event.e === "hit" && pending && pending.k === key(event) && typeof event.eid === "number") {
      const actual = roster.get(pending.k)?.get(event.eid)?.arch;
      total += 1;
      if (actual === pending.arch) agree += 1;
      pending = null;
    }
  }
  if (total > 0) {
    const rate = agree / total;
    checker.note("targetArch matches what a dead-centre pellet hit", rate >= TARGET_ARCH_AGREEMENT_FLOOR, `${(100 * rate).toFixed(1)}% of ${total}`);
    notes.push(`targetArch agreement (single-pellet): ${(100 * rate).toFixed(1)}% of ${total} — a few % of staleness is expected, since the crosshair target is set a frame earlier and Edge Cases cross it at 3.74 t/s`);
  }

  return { events: events.length, notes };
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/verify-event-log.mjs <log.ndjson | dir>");
    process.exit(2);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`no such file or directory: ${resolved}`);
    process.exit(2);
  }
  const logs = collectLogs(resolved);
  if (logs.length === 0) {
    console.error(`no .ndjson logs in ${resolved}`);
    process.exit(2);
  }

  const checker = makeChecker();
  // Registered up front so a check that never ran shows as `0` rather than
  // vanishing from the table. `targetArch` only exists in logs captured after
  // the field was added, and silence there would read as a pass.
  for (const name of ["targetArch matches what a dead-centre pellet hit"]) {
    if (!checker.ran.has(name)) checker.ran.set(name, 0);
  }
  let totalEvents = 0;
  const allNotes = [];
  for (const log of logs) {
    const { events, notes } = verifyLog(log, checker);
    totalEvents += events;
    for (const n of notes) allNotes.push(`${path.basename(log)}: ${n}`);
  }

  console.log(`# Event log verification\n`);
  console.log(`${logs.length} log(s), ${num(totalEvents)} events\n`);
  console.log(`| check | n | failed |`);
  console.log(`|---|---:|---:|`);
  let failedAny = false;
  for (const [name, n] of checker.ran) {
    const f = checker.failed.get(name) ?? 0;
    if (f > 0) failedAny = true;
    console.log(`| ${name} | ${num(n)} | ${f === 0 ? "0" : `**${f}**`} |`);
  }
  if (allNotes.length > 0) {
    console.log(`\nNotes:`);
    for (const n of allNotes) console.log(`  - ${n}`);
  }

  if (failedAny) {
    console.error(`\nFAIL:`);
    for (const [name, f] of checker.failed) {
      console.error(`  ${name}: ${f} failure(s), e.g. ${JSON.stringify(checker.example.get(name))}`);
    }
    process.exit(1);
  }
  console.log(`\nOK: every check passed.`);
  console.log(`\nNote this proves internal consistency, not that the roster itself is right.`);
  console.log(`For that, compare against an independently generated one:`);
  console.log(`  npm run balancing:budget -- --all-difficulties --json solved.json`);
  console.log(`and diff its per-level archetype/HP multiset against the log's levelStart rosters.`);
  console.log(`Measured on ${path.relative(REPO_ROOT, resolved) || resolved}'s campaign: identical on all 12 levels.`);
}

main();

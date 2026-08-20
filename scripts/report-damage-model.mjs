// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Is `expectedDamagePerShot` calibrated, and if not, *why* not?
 *
 * The bot picks a weapon by scoring `time-to-kill` from
 * `expectedDamagePerShot` (`combatPolicy.mjs`). A 2026-08-06 capture measured
 * the shotgun delivering **79.6** damage per shot into an Elite where the model
 * predicted **175**, and ghidra **93** against **150**. Two very different
 * explanations fit that equally well, and they lead opposite ways:
 *
 *   (a) **The model is optimistic.** Its `hitFraction` credits a static,
 *       perfectly-centred target every pellet it can geometrically reach. If
 *       that is too generous, weapon *choice* is wrong everywhere, and fixing
 *       the model corrects it without overriding anything.
 *   (b) **The bot's aim is the story.** Real fights move; the model assumes the
 *       crosshair is on the target. Then the model is fine and the accuracy is
 *       the defect.
 *
 * Nobody knew which, so this settles it from data already on disk rather than
 * from a new capture.
 *
 * **The decomposition that separates them.** A `shot` event and every
 * `damageDealt` it caused share a timestamp, so a shot's total damage is
 * recoverable. Split the shots into those that dealt *nothing* and those that
 * connected:
 *
 *   - **many zero-damage shots, but connected shots ≈ predicted** ⇒ (b) aim.
 *     The model describes a hit correctly; the bot just misses.
 *   - **few zero-damage shots, but connected shots well below predicted** ⇒
 *     (a) model. The bot hits, and the shot simply does less than claimed.
 *
 * Reported per weapon per range bucket, because the shotgun's scatter — the
 * suspect term — grows with distance, so a single pooled ratio would average
 * the interesting part away.
 *
 * **What this deliberately cannot see.** Splash (`ghidra`) damages by radius
 * rather than by the pellet cone, and its rocket takes real flight time, so a
 * hit lands at a *later* timestamp than the shot; ghidra rows are reported but
 * flagged, not trusted. Damage dealt to a *second* enemy by one shot counts
 * toward that shot, which is correct for "what did this trigger-pull do" and
 * wrong for "did it hit what it aimed at". And a capture only contains fights
 * the bot chose to take, so this measures the model where the bot uses it, not
 * across its whole domain.
 *
 * **"Not trusted" is too soft, measured 2026-08-19: the ghidra rows carry no
 * information at all.** Run over every capture on disk (1,530 event files,
 * 2,187,968 ranged shots) they report **100% miss and 0.0 damage/shot** in
 * every range bucket, because the
 * timestamp join finds nothing to attribute — the flight time is seconds, not
 * a rounding error. Rockets also emit no `hit` event whatsoever (0 of
 * 3,248,140 in the archive), since `fire()` returns at `if (w.isRocket)`
 * before `resolveShot` runs.
 *
 * **Since 2026-08-20 there is somewhere else to look.** A `rocketDetonated`
 * event (schema 3) records each blast's `direct`, `dist`, `enemiesHit`, `dmg`
 * and an itemised `hits` array, so ghidra is measurable without this report.
 * These rows stay empty regardless — the timestamp join cannot be repaired
 * here, because a rocket's damage genuinely arrives seconds after its shot —
 * so keep ignoring them and read `rocketDetonated` instead. Captures predating
 * schema 3 remain unanswerable either way.
 *
 * **The "ghidra 93 against 150" figure quoted above does not
 * reproduce** from the 2026-08-06 captures or any other on disk — this script
 * prints 0.0 for all of them. It is left in the sentence rather than deleted
 * because whatever produced it is unaccounted for; the shotgun half of that
 * same sentence does roughly reproduce.
 *
 * Usage:
 *   node scripts/report-damage-model.mjs [captureDir ...]     # default: all
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import {
  DEFAULT_TUNING,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  PISTOL_WEAPON_INDEX,
  SHOTGUN_WEAPON_INDEX,
  WEAPON_STATS,
  expectedDamagePerShot,
} from "./lib/combatPolicy.mjs";

// Indices are NOT contiguous — 2 is the melee slot — so these come from the
// real constants rather than a guessed 0..n order. Getting this wrong silently
// relabels every row: gdb's numbers appear under ghidra's name and the table
// reads as a completely different finding.
const WEAPON_NAMES = {
  [PISTOL_WEAPON_INDEX]: "pistol",
  [SHOTGUN_WEAPON_INDEX]: "shotgun",
  [GDB_WEAPON_INDEX]: "gdb",
  [GHIDRA_WEAPON_INDEX]: "ghidra",
  [FRIDAY_HOTFIX_WEAPON_INDEX]: "fridayHotfix",
};
/** Upper bound of each range bucket, in tiles. */
const RANGE_BUCKETS = [2, 4, 6, 8, 12, Infinity];

function bucketOf(dist) {
  return RANGE_BUCKETS.findIndex((upper) => dist <= upper);
}

function bucketLabel(i) {
  const lo = i === 0 ? 0 : RANGE_BUCKETS[i - 1];
  const hi = RANGE_BUCKETS[i];
  return hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
}

function* ndjsonFiles(dirs) {
  for (const dir of dirs) {
    const eventsDir = path.join(dir, "events");
    if (!fs.existsSync(eventsDir)) continue;
    const stack = [eventsDir];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".ndjson")) yield full;
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const dirs = args.length
    ? args.map((a) => path.resolve(a))
    : fs
        .readdirSync(REPO_ROOT)
        .filter((d) => d.startsWith("balancing_capture_"))
        .map((d) => path.join(REPO_ROOT, d));

  // key: `${weapon}|${bucket}` -> accumulator
  const cells = new Map();
  let shotsSeen = 0;
  let filesSeen = 0;

  for (const file of ndjsonFiles(dirs)) {
    filesSeen += 1;
    // A run's events are per-file; damage is joined to a shot by timestamp
    // within the same run id, which is what makes the join safe across a file
    // holding several runs.
    const damageByKey = new Map();
    const shots = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // a truncated tail line — the rest of the file is still good
      }
      if (ev.e === "damageDealt") {
        const key = `${ev.rid}|${ev.t}|${ev.w}`;
        damageByKey.set(key, (damageByKey.get(key) ?? 0) + (ev.amt ?? 0));
      } else if (ev.e === "shot" && !ev.forcedMelee) {
        shots.push(ev);
      }
    }

    for (const shot of shots) {
      if (typeof shot.dist !== "number" || !WEAPON_STATS[shot.w]) continue;
      shotsSeen += 1;
      const dealt = damageByKey.get(`${shot.rid}|${shot.t}|${shot.w}`) ?? 0;
      const target = { elite: shot.targetArch === "elite", edgeCase: shot.targetArch === "edgeCase" };
      const predicted = expectedDamagePerShot(shot.w, shot.dist, DEFAULT_TUNING, target);
      const key = `${shot.w}|${bucketOf(shot.dist)}`;
      const cell = cells.get(key) ?? { n: 0, zero: 0, dealt: 0, dealtWhenHit: 0, predicted: 0 };
      cell.n += 1;
      cell.dealt += dealt;
      cell.predicted += predicted;
      if (dealt <= 0) cell.zero += 1;
      else cell.dealtWhenHit += dealt;
      cells.set(key, cell);
    }
  }

  console.log(`${shotsSeen} ranged shots across ${filesSeen} event file(s)\n`);
  console.log(
    "weapon        range   shots   miss%   dmg/shot   dmg/hit   predicted   hit÷pred   shot÷pred",
  );
  const rows = [...cells.entries()].sort((a, b) => {
    const [aw, ab] = a[0].split("|").map(Number);
    const [bw, bb] = b[0].split("|").map(Number);
    return aw - bw || ab - bb;
  });
  for (const [key, c] of rows) {
    if (c.n < 20) continue; // too few to read anything into
    const [w, b] = key.split("|").map(Number);
    const hits = c.n - c.zero;
    const dmgPerShot = c.dealt / c.n;
    const dmgPerHit = hits > 0 ? c.dealtWhenHit / hits : 0;
    const pred = c.predicted / c.n;
    const flag = Number(w) === GHIDRA_WEAPON_INDEX ? "  (splash/flight — see doc)" : "";
    console.log(
      `${WEAPON_NAMES[w].padEnd(13)} ${bucketLabel(b).padEnd(7)} ${String(c.n).padStart(5)}   ` +
        `${((100 * c.zero) / c.n).toFixed(0).padStart(4)}%   ${dmgPerShot.toFixed(1).padStart(8)}   ` +
        `${dmgPerHit.toFixed(1).padStart(7)}   ${pred.toFixed(1).padStart(9)}   ` +
        `${(pred > 0 ? dmgPerHit / pred : 0).toFixed(2).padStart(8)}   ` +
        `${(pred > 0 ? dmgPerShot / pred : 0).toFixed(2).padStart(9)}${flag}`,
    );
  }
  console.log(
    "\nhit÷pred is the model's own claim tested on shots that connected — near 1.0 means the\n" +
      "model describes a hit correctly. shot÷pred additionally carries the misses. A low\n" +
      "shot÷pred with hit÷pred near 1.0 is an aim problem; both low is a model problem.",
  );
}

main();

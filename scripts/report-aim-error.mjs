// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Why does the bot miss ~30% of its ranged shots?
 *
 * `report-damage-model.mjs` established that a single-pellet weapon deals
 * *exactly* its rated damage on every shot that connects, so its entire
 * shortfall against `expectedDamagePerShot` is the shots that connect with
 * nothing at all. That miss rate applies to every weapon rather than to the two
 * with a broken `hitFraction`, which is what makes it worth a tool of its own.
 *
 * The obvious first guess — the bot's aim is simply imprecise, so it misses
 * small far-away things — turns out to be **wrong**, and the tables below are
 * ordered to show why rather than to assert a conclusion.
 *
 * ## What the data says
 *
 * The bot fires once its heading error is inside `profile.fireAngleEps`
 * (0.08/0.05/0.03 rad for Casual/Gamer/Pro). That is a *constant*, while the
 * angle a target subtends falls off as `1/dist` — so past roughly 6 tiles the
 * gate permits shots the geometry cannot land. Real, and worth fixing, but not
 * the main story: bucketing shots by `angularHalfWidth / fireAngleEps` (table
 * 2) normalises distance, sprite size and profile away, and the hit rate
 * *still* splits hard by archetype inside a single band — Elite 86%, normal
 * 75%, Edge Case 48%. Something archetype-specific survives all the geometry.
 *
 * That something is **target motion between aim and impact**. The bot samples
 * enemy positions at the end of one pump, `decide()` runs on that snapshot, and
 * the fire key is then held across the *next* `VIRTUAL_STEP_MS` (50ms) pump —
 * so a shot resolves 0-50ms after the positions it was aimed at, while the
 * target keeps moving. Crucially the size of that error *relative to the
 * target* is distance-free: displacement and sprite half-width are both world
 * quantities divided by the same `dist` when projected, so the effect reduces
 * to
 *
 *     motion-to-size  =  speedMultiplier / spriteScale
 *
 * which is 2.2/0.55 = **4.0** for an Edge Case, 1.0 for a normal and
 * 1/1.5 = **0.67** for an Elite (`speedFor` scales only Edge Cases, so an Elite
 * chases at exactly a normal enemy's speed — only its sprite differs). That
 * predicts the observed ordering, and it predicts the *shape*: a motion-driven
 * miss rate must be flat across range, which is exactly what Edge Cases do
 * (48-51% in every distance bucket, table 1) and what an aim problem could not
 * produce.
 *
 * In absolute terms an Edge Case covers up to 97% of its own sprite half-width
 * inside one 50ms window — mean ~49%, since the shot can land anywhere in it —
 * against 24%/12% for a normal and an Elite. The bot is aiming at where an Edge
 * Case *was*, roughly one sprite ago. Edge Cases take ~40% of all ranged shots,
 * so this single effect is the largest contributor to the headline number.
 *
 * ## What this deliberately cannot separate
 *
 * The engine adds its own random cone deviation growing as `(range/FOG_FAR)³`,
 * so a long-range miss may be the engine's spread rather than anything the bot
 * did; that term is negligible close in, which is why the range breakdown is
 * kept rather than pooled. And `min(1, ratio)` in table 2 assumes the heading
 * error is spread evenly across the permitted window — the low-ratio rows beat
 * it, showing that it is not and that the bot aims better than its own gate
 * requires, so read that column as the gate's *permission*, never as a fit.
 *
 * Usage:
 *   node scripts/report-aim-error.mjs [captureDir ...]     # default: all
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { DEFAULT_TUNING, GDB_WEAPON_INDEX, PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX } from "./lib/combatPolicy.mjs";
import { PROFILES } from "./lib/profiles.mjs";

/**
 * Camera constants, mirrored from the engine (`SCENE_WIDTH` in `engine.ts`,
 * `FOV_PLANE` in `player.ts`). Duplicated by value rather than imported because
 * both are `const`s private to modules the scripts layer never loads — the same
 * by-value convention `combatPolicy.mjs` already uses for the weapon table.
 */
const SCENE_WIDTH_PX = 640;
const FOV_PLANE = 0.66;

/** Single-pellet, zero-spread weapons: the ones whose hit/miss is a clean read
 * on aim, with no pellet cone of their own to forgive it. */
const SINGLE_PELLET = new Set([PISTOL_WEAPON_INDEX, GDB_WEAPON_INDEX]);
/** Upper bound of each range bucket, in tiles. */
const RANGE_BUCKETS = [2, 4, 6, 8, 12, Infinity];
/** Upper bounds on `angularHalfWidth / fireAngleEps`. 1.0 is the crossover:
 * below it the bot's own gate lets it shoot while pointing off the target. */
const RATIO_BANDS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, Infinity];
/** Sprite scales from `sprites.ts` (`ELITE_SCALE`, `EDGE_CASE_SCALE`). */
const SCALE_BY_ARCH = { elite: 1.5, edgeCase: 0.55 };

const bucketOf = (dist) => RANGE_BUCKETS.findIndex((upper) => dist <= upper);
const bucketLabel = (i) => {
  const lo = i === 0 ? 0 : RANGE_BUCKETS[i - 1];
  return RANGE_BUCKETS[i] === Infinity ? `${lo}+` : `${lo}-${RANGE_BUCKETS[i]}`;
};
const ratioLabel = (i) => {
  const lo = i === 0 ? 0 : RATIO_BANDS[i - 1];
  return RATIO_BANDS[i] === Infinity ? `${lo}+` : `${lo}-${RATIO_BANDS[i]}`;
};
const chaseSpeed = (arch) =>
  arch === "edgeCase" ? DEFAULT_TUNING.EDGE_CASE_CHASE_SPEED : DEFAULT_TUNING.ENEMY_CHASE_SPEED;

/** The target's projected half-width in px — `projectPoint`'s own formula. */
function halfWidthPx(dist, arch) {
  const scale = SCALE_BY_ARCH[arch] ?? 1;
  return (DEFAULT_TUNING.SCENE_HEIGHT_PX * DEFAULT_TUNING.ENEMY_SPRITE_SIZE * scale) / (2 * Math.max(0.1, dist));
}

/**
 * The target's **angular** half-width in radians: the largest heading error
 * that can still land a centre-column shot, and therefore the quantity the fire
 * gate ought to be compared against — and is not.
 *
 * `projectPoint` maps a screen offset back to an angle through
 * `screenX - W/2 = (W/2) * tan(theta) / FOV_PLANE`.
 */
function angularHalfWidth(dist, arch) {
  return Math.atan((halfWidthPx(dist, arch) * FOV_PLANE) / (SCENE_WIDTH_PX / 2));
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

/** Accumulate one shot into `map` under `key`, carrying a running total of
 * `extra` (a half-width or a ratio, depending on the table). */
function bump(map, key, hit, extra = 0) {
  const cell = map.get(key) ?? { n: 0, hits: 0, extra: 0 };
  cell.n += 1;
  cell.extra += extra;
  if (hit) cell.hits += 1;
  map.set(key, cell);
}

function main() {
  const args = process.argv.slice(2);
  const dirs = args.length
    ? args.map((a) => path.resolve(a))
    : fs
        .readdirSync(REPO_ROOT)
        .filter((d) => d.startsWith("balancing_capture_"))
        .map((d) => path.join(REPO_ROOT, d));

  const byArch = new Map(); // `${arch}|${bucket}`   — is the miss rate range-dependent?
  const byRatio = new Map(); // `${band}|${arch}`     — with geometry normalised, what is left?
  const byWeapon = new Map(); // `${weapon}|${bucket}` — normals only, so the mix cannot skew it
  let shotsSeen = 0;

  for (const file of ndjsonFiles(dirs)) {
    // A shot and the damage it caused share a run id and a timestamp; the join
    // is scoped per file so several runs in one file cannot cross-contaminate.
    const damaged = new Set();
    const shots = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // a truncated tail line — the rest of the file is still good
      }
      if (ev.e === "damageDealt") damaged.add(`${ev.rid}|${ev.t}|${ev.w}`);
      else if (ev.e === "shot" && !ev.forcedMelee) shots.push(ev);
    }

    for (const shot of shots) {
      if (typeof shot.dist !== "number") continue;
      shotsSeen += 1;
      const hit = damaged.has(`${shot.rid}|${shot.t}|${shot.w}`);
      const bucket = bucketOf(shot.dist);
      const arch = shot.targetArch ?? "normal";

      if (SINGLE_PELLET.has(shot.w)) {
        bump(byArch, `${arch}|${bucket}`, hit, halfWidthPx(shot.dist, arch));
        const eps = PROFILES[shot.profile]?.fireAngleEps;
        if (eps) {
          const ratio = angularHalfWidth(shot.dist, arch) / eps;
          bump(byRatio, `${RATIO_BANDS.findIndex((upper) => ratio <= upper)}|${arch}`, hit, ratio);
        }
      }
      // Normals only: the pistol and the shotgun are not aimed at the same mix
      // of archetypes, and Edge Cases alone would swing this by tens of points.
      if (arch === "normal" && (shot.w === PISTOL_WEAPON_INDEX || shot.w === SHOTGUN_WEAPON_INDEX)) {
        bump(byWeapon, `${shot.w}|${bucket}`, hit);
      }
    }
  }

  console.log(`${shotsSeen} ranged shots\n\n`);

  console.log("1. Is the miss rate range-dependent?\n");
  console.log("An aim problem worsens with distance: the bot's heading error is an angle, and");
  console.log("the target shrinks. A motion problem does not, because displacement and sprite");
  console.log("width are both world quantities and their ratio survives projection.\n");
  console.log("target      range     shots   halfWidth(px)   hit%");
  const archRows = [...byArch.entries()].sort((a, b) => {
    const [aa, ab] = a[0].split("|");
    const [ba, bb] = b[0].split("|");
    return aa.localeCompare(ba) || Number(ab) - Number(bb);
  });
  for (const [key, c] of archRows) {
    if (c.n < 100) continue;
    const [arch, b] = key.split("|");
    console.log(
      `${arch.padEnd(11)} ${bucketLabel(Number(b)).padEnd(7)} ${String(c.n).padStart(7)}   ` +
        `${(c.extra / c.n).toFixed(1).padStart(13)}   ${((100 * c.hits) / c.n).toFixed(0).padStart(4)}%`,
    );
  }

  console.log("\n\n2. With the geometry normalised away, what is left?\n");
  console.log("`ratio` is the target's angular half-width over the profile's fireAngleEps, so a");
  console.log("band holds shots of equal difficulty whatever the range, sprite or profile.");
  console.log("Below 1.0 the gate permits a shot the aim cannot land, and `gate` = min(1, ratio)");
  console.log("is what that permission alone would give. A split *within* a band is therefore");
  console.log("not geometry — and the archetype ordering there is the finding.\n");
  console.log("ratio band   target        shots   mean ratio   gate   actual   gap");
  const ratioRows = [...byRatio.entries()].sort((a, b) => {
    const [ab, aa] = a[0].split("|");
    const [bb, ba] = b[0].split("|");
    return aa.localeCompare(ba) || Number(ab) - Number(bb);
  });
  for (const [key, c] of ratioRows) {
    if (c.n < 200) continue;
    const [band, arch] = key.split("|");
    const meanRatio = c.extra / c.n;
    const gate = 100 * Math.min(1, meanRatio);
    const actual = (100 * c.hits) / c.n;
    console.log(
      `${ratioLabel(Number(band)).padEnd(12)} ${arch.padEnd(11)} ${String(c.n).padStart(7)}   ` +
        `${meanRatio.toFixed(2).padStart(10)}   ${gate.toFixed(0).padStart(3)}%   ` +
        `${actual.toFixed(0).padStart(5)}%   ${(actual - gate).toFixed(0).padStart(4)}pp`,
    );
  }

  console.log("\n\n3. How far does each archetype move while the bot's aim goes stale?\n");
  console.log("Straight from the constants, not from the capture: the ground a target covers");
  console.log("during the 0-50ms between the snapshot the bot aimed at and the shot resolving,");
  console.log("as a share of its own sprite half-width. Distance cancels out of the last two.\n");
  console.log("target       speed(t/s)   halfWidth(t)   moves/window   of halfWidth   motion-to-size");
  for (const arch of ["elite", "normal", "edgeCase"]) {
    const scale = SCALE_BY_ARCH[arch] ?? 1;
    const speed = chaseSpeed(arch);
    const halfWidthTiles = (DEFAULT_TUNING.ENEMY_SPRITE_SIZE * scale) / 2;
    const moves = (speed * DEFAULT_TUNING.VIRTUAL_STEP_MS) / 1000;
    console.log(
      `${arch.padEnd(12)} ${speed.toFixed(2).padStart(10)}   ${halfWidthTiles.toFixed(3).padStart(12)}   ` +
        `${moves.toFixed(3).padStart(12)}   ${((100 * moves) / halfWidthTiles).toFixed(0).padStart(12)}%   ` +
        `${(speed / DEFAULT_TUNING.ENEMY_CHASE_SPEED / scale).toFixed(2).padStart(14)}`,
    );
  }

  console.log("\n\n4. Cross-check: same aim, more forgiveness (normal targets only)\n");
  console.log("The shotgun sprays 7 pellets across 70px. If these misses were a heading error");
  console.log("much larger than that, spreading the pellets could not rescue them.\n");
  console.log("range     pistol hit%   shotgun hit%   gap");
  for (let b = 0; b < RANGE_BUCKETS.length; b++) {
    const p = byWeapon.get(`${PISTOL_WEAPON_INDEX}|${b}`);
    const s = byWeapon.get(`${SHOTGUN_WEAPON_INDEX}|${b}`);
    if (!p || !s || p.n < 100 || s.n < 100) continue;
    const ph = (100 * p.hits) / p.n;
    const sh = (100 * s.hits) / s.n;
    console.log(
      `${bucketLabel(b).padEnd(9)} ${ph.toFixed(0).padStart(10)}%   ${sh.toFixed(0).padStart(11)}%   ` +
        `${(sh - ph).toFixed(0).padStart(3)}pp`,
    );
  }
}

main();

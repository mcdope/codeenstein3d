// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * How steppy is the bot's aim? Decodes a recorded highscore board and reports,
 * per entry, how often the view *starts or stops* rotating.
 *
 * ```
 * node scripts/report-turn-cadence.mjs                 # the shipped board
 * node scripts/report-turn-cadence.mjs <file|dir>...   # boards dumped by a run
 * ```
 *
 * **Why this metric and not "smoothness".** A replay stores one input snapshot
 * per simulated frame, so whether the view rotated on a given frame is exactly
 * recoverable: a turn key held, a non-zero `gpTurn`, or a non-zero `mouseDX`.
 * What a viewer reads as
 * jitter is the *alternation* between rotating and frozen frames, which is
 * `startStops/sec` here, and the share of rotations too short to read as
 * motion at all, which is `1-frame`. Both are counted against the same
 * definition of "turning" whichever input path produced it, so two arms that
 * turn by different means stay directly comparable — that is the whole point,
 * and a metric that only understood keys would score a stick or mouse arm as
 * "never turns" rather than as smoother.
 *
 * **The definition of "turning" has to cover every path the engine rotates on,
 * or the metric scores a new one as "never turns".** That is not hypothetical:
 * this script was first written understanding turn keys and `gpTurn` only, and
 * scored the mouse-look arm at 0% turn duty across two complete runs. Any
 * future rotation source has to be added here at the same time as it is added
 * to the bot.
 *
 * `turnDuty` is the control: a change that merely turns *less* would improve
 * `startStops/sec` while making the bot worse, and is visible here as duty
 * falling with it. Compare arms at similar duty or not at all.
 *
 * Boards for a non-default arm come from `run-balancing-telemetry.mjs` with
 * `CODEENSTEIN_TELEMETRY_BOARD_DUMP=<dir>` set — a short real run is enough,
 * and nothing here needs a campaign or a board regeneration.
 *
 * **Set `RECORD_STEP_MS` when you do.** That harness passes no `recordStepMs`,
 * so `Bot` falls back to `stepMs` and simulates one 50ms frame per decision —
 * per-frame smoothness cannot exist there, and every arm comes back with the
 * same `stepP90`. Add `{"RECORD_STEP_MS":16.6667}` to
 * `CODEENSTEIN_TELEMETRY_TUNING` to record at the rate the shipped board (and
 * a real player) actually runs at. This is not a hypothetical: a whole round
 * of measurements was taken on the 50ms substrate before anyone noticed, and
 * had to be thrown away. See `decisions.md` under *Playtest-Bot Behaviour:
 * Approaches Measured and Rejected*.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";
import { DEFAULT_TUNING } from "./lib/combatPolicy.mjs";

const { ENGINE_ROT_SPEED: ROT_SPEED, ENGINE_MOUSE_SENSITIVITY: MOUSE_SENSITIVITY } = DEFAULT_TUNING;

const DEFAULT_BOARD_SOURCE = path.join(REPO_ROOT, "src/engine/defaultHighscore.ts");
/** The two keys the engine turns on (`engine.ts`: `KeyQ` negative, `KeyE`
 * positive). Rotation also arrives as `gpTurn` (stick) and `mouseDX` (mouse
 * look), both read straight off the snapshot. Movement keys are deliberately
 * not counted — strafing is not rotation, and the camera does not move for it. */
const TURN_KEYS = new Set(["KeyQ", "KeyE"]);

/** Every `.board` file under `target`, or `target` itself if it is a file. */
function boardFilesIn(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".board"))
    .map((f) => path.join(target, f))
    .sort();
}

/** Board strings to analyse, each tagged with where it came from. */
function boardsFrom(args) {
  if (args.length === 0) {
    const source = fs.readFileSync(DEFAULT_BOARD_SOURCE, "utf8");
    const match = source.match(/DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED = "([^"]+)"/);
    if (!match) throw new Error(`No DEFAULT_HIGHSCORE_ENTRIES_COMPRESSED found in ${DEFAULT_BOARD_SOURCE}`);
    return [{ label: "defaultHighscore.ts", raw: match[1] }];
  }
  return args.flatMap((arg) =>
    boardFilesIn(arg).map((file) => ({ label: path.basename(file), raw: fs.readFileSync(file, "utf8").trim() })),
  );
}

/**
 * Walk one entry's frames and count rotation runs.
 *
 * A frame counts as turning when a turn key is held, `gpTurn` is non-zero, or
 * `mouseDX` is non-zero. The latter two are absent on a board recorded before
 * those paths existed, which reads as 0 and therefore as "keyboard only" — the
 * correct answer for those, not a gap.
 *
 * **Also reconstructs how far the view moved on each frame**, because cadence
 * alone ranks a tiny step and a huge one identically. One pixel of mouse is
 * 0.0025 rad while one frame of held key at Pro's multiplier is 0.216 — an
 * 86x difference the `1-frame` column cannot see. `stepP90`/`stepMax` are what
 * say whether a rotation reads as motion or as a jump.
 */
function cadenceOf(entry) {
  let frames = 0;
  let turningFrames = 0;
  let edges = 0;
  let seconds = 0;
  let analogFrames = 0;
  let mouseFrames = 0;
  const runs = [];
  const steps = [];
  for (const segment of entry.replay?.levels ?? []) {
    // Recorded per segment precisely so playback can reproduce the rotation —
    // see `ReplayLevelSegment.rotSpeedMultiplier`. Absent means a production
    // build, i.e. 1.
    const mul = segment.rotSpeedMultiplier ?? 1;
    let prev = false;
    let run = 0;
    for (const frame of segment.frames) {
      const keyed = frame.input.keys.some((k) => TURN_KEYS.has(k));
      const analog = (frame.input.gpTurn ?? 0) !== 0;
      const mouse = (frame.input.mouseDX ?? 0) !== 0;
      const turning = keyed || analog || mouse;
      // Exactly `handleMovement`'s own arithmetic, so this is the rotation the
      // engine really applied rather than an estimate of it.
      if (turning) {
        const rot = ROT_SPEED * mul * frame.dt;
        const keyPart = keyed ? rot : 0;
        const axisPart = rot * (frame.input.gpTurn ?? 0);
        const mousePart = (frame.input.mouseDX ?? 0) * MOUSE_SENSITIVITY;
        steps.push(Math.abs(keyPart + axisPart + mousePart));
      }
      frames++;
      seconds += frame.dt;
      if (turning) turningFrames++;
      if (analog) analogFrames++;
      if (mouse) mouseFrames++;
      if (turning !== prev) {
        edges++;
        if (prev && run > 0) runs.push(run);
        run = 0;
      }
      if (turning) run++;
      prev = turning;
    }
    // A segment ending mid-turn still contributes that run; dropping it would
    // bias the distribution toward whatever length happens to fit inside a level.
    if (prev && run > 0) runs.push(run);
  }
  runs.sort((a, b) => a - b);
  steps.sort((a, b) => a - b);
  const stepQuantile = (p) => (steps.length === 0 ? 0 : steps[Math.floor((steps.length - 1) * p)]);
  const quantile = (p) => (runs.length === 0 ? 0 : runs[Math.floor((runs.length - 1) * p)]);
  return {
    frames,
    seconds,
    levels: entry.replay?.levels?.length ?? 0,
    turnDuty: frames === 0 ? 0 : turningFrames / frames,
    analogShare: turningFrames === 0 ? 0 : analogFrames / turningFrames,
    mouseShare: turningFrames === 0 ? 0 : mouseFrames / turningFrames,
    startStopsPerSec: seconds === 0 ? 0 : edges / seconds,
    medianRun: quantile(0.5),
    p90Run: quantile(0.9),
    oneFrameShare: runs.length === 0 ? 0 : runs.filter((r) => r === 1).length / runs.length,
    stepP90: stepQuantile(0.9),
    stepMax: steps.length === 0 ? 0 : steps[steps.length - 1],
  };
}

const COLUMNS = [
  ["entry", 22, (r) => r.name],
  ["lvls", 5, (r) => r.levels],
  ["frames", 8, (r) => r.frames],
  ["minutes", 8, (r) => (r.seconds / 60).toFixed(1)],
  ["turnDuty", 9, (r) => `${(100 * r.turnDuty).toFixed(0)}%`],
  ["analog", 7, (r) => `${(100 * r.analogShare).toFixed(0)}%`],
  ["mouse", 6, (r) => `${(100 * r.mouseShare).toFixed(0)}%`],
  ["startStops/s", 13, (r) => r.startStopsPerSec.toFixed(1)],
  ["runP50", 7, (r) => r.medianRun],
  ["runP90", 7, (r) => r.p90Run],
  ["1-frame", 8, (r) => `${(100 * r.oneFrameShare).toFixed(0)}%`],
  ["stepP90", 8, (r) => r.stepP90.toFixed(3)],
  ["stepMax", 8, (r) => r.stepMax.toFixed(2)],
];

const { unpackBoardFromStorage, isBinaryBoard } = await loadEngineModules();

for (const { label, raw } of boardsFrom(process.argv.slice(2))) {
  if (!isBinaryBoard(raw)) {
    // Older `gz1:`/plain-JSON boards decode through a different reader that is
    // not exported here. Say so instead of throwing a codec error three frames
    // deep, which reads as a corrupt file rather than an old one.
    console.log(`${label}: not a bin1: board — re-record it, or decode it with the legacy reader first\n`);
    continue;
  }
  const entries = await unpackBoardFromStorage(raw);
  const rows = entries
    .map((entry) => ({ name: entry.playerName ?? "(unnamed)", ...cadenceOf(entry) }))
    .filter((row) => row.frames > 0);
  console.log(label);
  if (rows.length === 0) {
    console.log("  no entry carries replay frames — nothing to measure\n");
    continue;
  }
  console.log("  " + COLUMNS.map(([h, w]) => h.padEnd(w)).join(""));
  for (const row of rows) console.log("  " + COLUMNS.map(([, w, get]) => String(get(row)).padEnd(w)).join(""));
  console.log();
}

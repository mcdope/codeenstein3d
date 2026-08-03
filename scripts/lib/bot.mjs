// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Reusable automated-playtest bot: navigation, combat, hazard/mine handling,
 * and loot-collection decision-making, driving the real game exclusively
 * through a Playwright `page` + `window.__codeensteinTestHooks` + synthetic
 * `KeyboardEvent`s — the same engine-agnostic boundary the original
 * (`scripts/run-balancing-telemetry.mjs`) always used, kept intact here so a
 * future non-Playwright control surface (e.g. a multiplayer bot) stays
 * swappable without touching decision logic. Extracted verbatim from that
 * script (and, before it, `scripts/generate-default-highscore.mjs`'s smaller
 * bot) — every doc comment below still describes the original bug/fix it was
 * written for; only the parameter-passing mechanism changed (explicit
 * `page`/`profile`/`map`/`mineMemory` args became `this.*`).
 *
 * Per-run state (`page`, `profile`, harness mode) is fixed for the lifetime
 * of one `Bot` instance — construct a fresh one per campaign attempt, same as
 * the original script's per-attempt scope. Per-level state (`map`,
 * `mineMemory`, `visitedPickups`) resets via `startLevel(map)`.
 */
import { bfsPath, pathToWaypoints } from "./pathfind.mjs";
import {
  angleDelta,
  decide,
  DEFAULT_TUNING,
  hasLineOfSight,
  HAZARD_TILE,
  pickThreat,
  segmentsFor,
  SPIKE_TRAP_TILE,
  numberKeyCodeFor,
  turnBurstMs,
  uniformIntent,
} from "./combatPolicy.mjs";

// The decision core moved to `combatPolicy.mjs` (see its doc comment for why:
// testability, and a shape that can be lifted into `src/engine/` for a real
// deathmatch opponent). Everything it owns is re-exported from here so no
// consumer had to change an import — `run-balancing-telemetry.mjs` takes the
// weapon indices, and the rest is surface that tests and future callers reach
// for. New code should prefer importing from `combatPolicy.mjs` directly.
export {
  activeSpikeAt,
  angleDelta,
  AUTO_RANGED_WEAPON_INDICES,
  decide,
  DEFAULT_TUNING,
  diagonalStrafeKey,
  findDangerousMine,
  findDisarmableMine,
  forwardScanTiles,
  FRIDAY_HOTFIX_WEAPON_INDEX,
  GDB_WEAPON_INDEX,
  GHIDRA_WEAPON_INDEX,
  hasAmmoFor,
  hasLineOfSight,
  HAZARD_TILE,
  isHazardAt,
  isWallTile,
  KNIFE_WEAPON_INDEX,
  moveBurstMs,
  nearestRocketDetonationDistance,
  pickRangedWeapon,
  pickThreat,
  PISTOL_WEAPON_INDEX,
  rocketAimUnsafe,
  segmentBlocked,
  segmentsFor,
  SHOTGUN_WEAPON_INDEX,
  SPIKE_TRAP_TILE,
  STARTING_WEAPONS,
  TOOLCHAIN_WEAPON_INDEX,
  turnBurstMs,
  uniformIntent,
} from "./combatPolicy.mjs";

// Door tile values, needed locally by the opened-door bookkeeping in
// `#noteDoorUnderFoot`/`#allDoorTiles` (the decision core has no use for them).
export const LOCKED_DOOR_TILE = 3; // src/map/types.ts's Tile enum
export const BRANCH_DOOR_TILE = 8; // src/map/types.ts's Tile enum

/**
 * Tiles a *loot detour* refuses to route through. Mirrors `routePlanner.mjs`'s
 * own `SOFT_AVOID_TILES`, but applied as a hard avoid rather than a cost:
 * the main route sometimes genuinely has to cross a hazard to reach the exit,
 * whereas a pickup is by definition optional, so taking damage for one is
 * never the right trade. `bfsPath` still allows the *target* tile itself to be
 * a hazard, so a pickup sitting on acid stays collectable — it just won't be
 * approached through more of it. */
const LOOT_DETOUR_AVOID_TILES = new Set([HAZARD_TILE, SPIKE_TRAP_TILE]);

/** How many "stand on the exit, then go kill whatever is keeping it inert"
 * rounds `driveToExit` will run before giving up. More than one because
 * `exitRoomHasAliveEnemy()` is satisfied by *any* living exit-room enemy and
 * a room can hold several; bounded because an unreachable blocker must still
 * terminate. */
const EXIT_CLEAR_ROUNDS = 6;
// Position-unchanged-for-this-many-consecutive-ticks threshold before
// `detectAnomalies` calls it a "stall".
const STALL_TICKS_THRESHOLD = 20;
// Any run of >=2 consecutive same-position ticks where health is also
// dropping is worth flagging immediately, regardless of the stall
// threshold above.
const HP_DRAIN_FROZEN_TICKS_THRESHOLD = 2;
/**
 * Fraction of a run's ticks that must be spike-blocked before the run counts
 * as "waiting for a trap" rather than a defect.
 *
 * This used to be `.every()`, and that one word produced the single largest
 * class of false findings in the scan: **68 of 175 stalls** — every "idle"
 * stall, i.e. every stall with no threat in range. `waitingOnSpike` is
 * computed from a probe 0.6 tiles ahead *along the bot's current facing*
 * (`combatPolicy.mjs`), so it drops out for a tick or two whenever the bot
 * adjusts heading while it waits. One such tick was enough to bill an
 * entirely correct 34-tick wait as a freeze.
 *
 * Measured 2026-07-31: 13 of the 14 repeat stall clusters sat on a tile
 * directly adjacent to a spike trap; 9 of 9 traced runs were 88-98%
 * spike-blocked with ~95% of ticks holding no movement key at all; and the
 * durations (median 34, p90 47, max 55 ticks) land exactly inside the
 * blocked-phase range of the campaign's traps (36-55 ticks — a trap is up for
 * half of a 3.6-5.5s period). The bot waits one phase and never longer.
 *
 * 0.8 rather than the 0.5 used by the `mostlyFiring`/`mostlyEngaged` guards
 * beside it, and that gap is deliberate: a bot genuinely *wedged* next to a
 * trap would measure ~50%, because the trap keeps cycling underneath it while
 * it fails to move. A real one-phase wait ends the moment the spikes drop, so
 * it never dilutes below ~0.88. Keeping the bar high is what preserves the
 * detector's ability to catch a wedge that happens to be next to a spike.
 */
const SPIKE_WAIT_DOMINANCE = 0.8;
/** Share of a run's ticks that were blocked by an active spike trap. */
function spikeFraction(slice) {
  if (slice.length === 0) return 0;
  return slice.filter((r) => r.waitingOnSpike).length / slice.length;
}
const TRACE_POS_EPS = 0.05;
// Lower than STALL_TICKS_THRESHOLD (20) on purpose — `detectHeldKeyNoMovement`
// is a much more precise signal, so it doesn't need as long a run to be
// confident it's a real freeze rather than incidental noise.
const HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD = 10;
// Movement keys that actually translate the player — KeyQ/KeyE only rotate.
// `KeyS` included so a wedged *backpedal* is visible to
// `detectHeldKeyNoMovement` — the mine retreat reverses without turning, and a
// backpedal jammed against geometry would otherwise be silently undetectable.
const TRANSLATING_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD"]);

// --- Oscillation (`detectOscillation`) -------------------------------------
// A bot that is genuinely wedged does not necessarily stop. It can pace,
// circle, or ping-pong between two waypoints indefinitely, covering real
// ground while getting nowhere — and `detectAnomalies`/`detectHeldKeyNoMovement`
// are both blind to that, because both are ultimately "did the position stay
// the same". `stage10_kernel_module.rs` wedges roughly 70% of full-campaign
// attempts and produced *zero* findings from either.
//
// The signature is a large travelled path with a small net displacement,
// sustained. Each threshold below exists to separate that from something the
// bot is supposed to do.
// A position jump larger than any decision could physically produce, so
// `summarizeActivityDistance` can drop teleports instead of charging them to
// an activity. Worst legitimate case is the multiplayer bot: `stepMs = 400` at
// the 6.4 t/s sprint speed = 2.56 tiles; this leaves comfortable headroom
// while staying far under a teleporter's cross-map hop.
const TELEPORT_JUMP_TILES = 4;

// Branches that only ever run because something is threatening the bot, so
// motion under them is combat cost no matter what errand it interrupted.
// `main` is deliberately absent — it covers both plain navigation and an
// active firefight, and `threatDist` is what tells those apart.
const ENGAGED_BRANCHES = new Set(["criticalHealth", "mineRetreat"]);

const OSCILLATION_TICKS_THRESHOLD = 30;
// Positions must stay inside this radius of the run's anchor. Wider than a
// combat sidestep's amplitude (~1.3 tiles at the flip period) so a firefight
// isn't the dominant finding, but far under a corridor's length.
const OSCILLATION_RADIUS_TILES = 2.0;
// Ground actually covered. Below this the bot is loitering, not thrashing —
// `stall` already owns "not moving", and double-reporting it would just make
// both findings noise.
const OSCILLATION_MIN_PATH_TILES = 2.0;
// How much less net progress than path length counts as "getting nowhere". A
// bot walking a corridor and back once has a ratio near 2; sustained
// ping-ponging climbs well past this.
const OSCILLATION_MIN_PATH_RATIO = 4;
// How close to its nav target the bot has to get for that target to count as
// *reached*. A hair above `ARRIVE_EPS` (0.15) and `TIGHT_ARRIVE_EPS` (0.05),
// so a genuine arrival registers while merely passing nearby does not.
const OSCILLATION_ARRIVAL_DIST = 0.35;
// Reaching this many nav targets inside one run means the bot was working
// through its route, not thrashing — see `reachedTargets`.
const OSCILLATION_ARRIVALS_EXEMPT = 2;

/**
 * BFS to `tile`, preferring a hazard-free route but accepting one through
 * spikes/acid rather than reporting the target unreachable.
 *
 * Refusing to plan is only correct when a *better* plan exists. The strict
 * avoid-set is right for an optional loot detour — "the only way there crosses
 * a spike" genuinely means "don't bother". It is wrong for reaching the exit,
 * which is not optional, and the difference is not hypothetical: on `main.c`
 * the exit is 95 tiles from (60,57) by plain BFS but **unreachable** once
 * spikes and acid are excluded, because every route crosses one.
 *
 * `driveToExit` does not treat that failure as fatal (a `reason: "stuck"` still
 * carries `state: "playing"`), so it fell through to `driveToward` — which
 * steers a straight line with no pathfinding — and sprinted into a wall for the
 * whole 80-tick budget, six rounds running. Measured at n=16 Pro/normal
 * attempts: 4 stalls of ~440 decisions (~22s each) without this fallback, 0
 * with it, longest stall 441 -> 61 ticks.
 *
 * Returns `{ path, viaHazard }` — `viaHazard` is what the caller logs, and is
 * the trigger that proves this path ran at all.
 */
export function pathAvoidingHazardsIfPossible(map, from, to, avoidTiles, openDoors, allowHazardFallback = true) {
  const strict = bfsPath(map, from, to, avoidTiles, openDoors);
  if (strict) return { path: strict, viaHazard: false };
  if (!allowHazardFallback) return { path: null, viaHazard: false };
  const loose = bfsPath(map, from, to, new Set(), openDoors);
  return { path: loose, viaHazard: Boolean(loose) };
}

/**
 * Exit-room blockers, nearest *by walking distance* first.
 *
 * `driveToExit` hunts the first of these, and used to pick by straight-line
 * `Math.hypot`. That measure is wrong for the decision being made: an enemy 5
 * tiles away through a wall can be 20 tiles by corridor, so the bot would
 * commit its bounded per-round budget to the one that merely *looks* closest
 * and could report `stuck` having never reached it. What matters here is "how
 * far must I actually walk", which is what a BFS over the live grid answers.
 *
 * Uses the same avoid-set `#walkPathTo` walks with, so the ranking matches the
 * route the bot will really take rather than an idealised one. Unreachable
 * candidates sort last instead of being dropped: the exit stays inert while
 * any of them lives, so discarding one would just turn a hunt into a silent
 * `stuck`. Sorted by index as a final tiebreak, so the order is total and
 * never depends on sort stability.
 */
export function rankExitBlockers(candidates, player, map, openedDoors) {
  const from = { x: Math.floor(player.x), y: Math.floor(player.y) };
  return candidates
    .map((e) => {
      const path = bfsPath(map, from, { x: Math.floor(e.x), y: Math.floor(e.y) }, LOOT_DETOUR_AVOID_TILES, openedDoors);
      return { ...e, walkTiles: path ? path.length : Infinity };
    })
    .sort((a, b) => a.walkTiles - b.walkTiles || a.i - b.i);
}

/**
 * Attribute one level's travelled distance to what the bot was *trying to do*
 * while it covered it — the `activity` label `Bot#tick` stamps onto every
 * trace record (see `Bot#withActivity`).
 *
 * Why this exists: `routeEfficiencyScore` compares distance travelled against
 * `map.shortestPathTiles` (a bare spawn->exit BFS) and sat at **0.34** on the
 * demo campaign, i.e. ~3x the theoretical minimum. Splitting that measured
 * 3.0x showed it is two roughly equal factors, and only one of them is a bot
 * defect:
 * - **1.68x route design** — the planned route itself. Concentrated *entirely*
 *   in the two key/locked-door levels (demo levels 3 and 7, 3.7x and 3.5x,
 *   13 and 15 legs); on the other six the plan is within 5% of the shortest
 *   path. Not a defect: a player who must fetch a key walks further too.
 * - **1.72x execution** — the bot walking further than *its own* plan, on
 *   every level (worst 3.3x). That is the part worth attacking, and a single
 *   aggregate number cannot say which errand spends it.
 *
 * Distance between consecutive records is charged to the *earlier* record's
 * activity: position is sampled before the action, so a record's motion is
 * what the decision it describes caused. Motion outside `tick` (door pushes
 * via `holdForwardFine`, teleports) records nothing and lands in the caller's
 * residual — compare `total` against the engine's own `distanceTraveled`.
 *
 * Each row also splits its distance by whether the bot was *engaged* at the
 * time — a threat present, or one of the threat/mine-driven escape branches.
 * Navigation and combat overlap rather than alternate (`tick()` lets a threat
 * preempt the route mid-waypoint), so "distance walked while fighting during
 * the route leg" is a distinct cost from "distance walked to reach the exit",
 * and the errand label alone cannot separate them.
 *
 * Returns `{ activity, tiles, engagedTiles, ticks, share }[]`, descending by
 * `tiles`, plus a `total`. Pure — takes a trace, returns numbers, no I/O.
 */
export function summarizeActivityDistance(trace) {
  const byActivity = new Map();
  let total = 0;
  if (!trace || trace.length === 0) return { rows: [], total: 0 };
  for (let i = 0; i < trace.length; i++) {
    const label = trace[i].activity ?? "unlabelled";
    let row = byActivity.get(label);
    if (!row) byActivity.set(label, (row = { activity: label, tiles: 0, engagedTiles: 0, ticks: 0 }));
    row.ticks += 1;
    // The last record has no successor to measure against; its own motion is
    // unobservable here rather than zero, so it contributes ticks only.
    const next = trace[i + 1];
    if (!next) continue;
    const d = Math.hypot(next.x - trace[i].x, next.y - trace[i].y);
    // A teleport is not travel. `driveLegs`/`#walkPathTo` abandon their route
    // on `reason === "teleported"` precisely because the bot is no longer
    // where the plan assumed, and charging that jump to an activity would
    // swamp every real figure.
    if (d > TELEPORT_JUMP_TILES) continue;
    row.tiles += d;
    if (ENGAGED_BRANCHES.has(trace[i].branch) || trace[i].threatDist != null) row.engagedTiles += d;
    total += d;
  }
  const rows = [...byActivity.values()]
    .map((r) => ({ ...r, share: total > 0 ? r.tiles / total : 0 }))
    .sort((a, b) => b.tiles - a.tiles || a.activity.localeCompare(b.activity));
  return { rows, total };
}

/**
 * Scans one level's worth of per-decision trace records (see `Bot#tick`'s
 * `#recordTrace` calls) for two "erratic-looking" patterns:
 * - `stall`: position hasn't moved for STALL_TICKS_THRESHOLD+ consecutive
 *   ticks (excluding legitimate spike-wait/mostly-engaged runs).
 * - `healthDrainFrozen`: position unchanged while health is also dropping,
 *   for as few as 2 consecutive ticks.
 * Both exclude a run where a majority of its ticks have `fire: true` or
 * `fireOnCooldown: true` — a bot holding ground, aimed and ready, while a
 * threat closes distance is correct behavior, not a freeze. `fireOnCooldown`
 * matters here specifically because of `profile.fireCooldownMs` (semi-auto
 * ranged weapons are now human-paced, not "fire every tick") — most ticks in
 * a real, correctly-fought firefight don't actually pull the trigger anymore,
 * so `fire: true` alone would under-count how much of the run was genuinely
 * "locked on and engaged" rather than stuck.
 *
 * Returns `{type, startTick, endTick, ticks, detail}[]`.
 */
export function detectAnomalies(trace) {
  const findings = [];
  if (!trace || trace.length === 0) return findings;
  let runStart = 0;
  // Compared against the *anchor* (the run's own starting position), not the
  // immediately preceding tick — anchoring to the run's start correctly lets
  // slow-but-genuine drift eventually exceed the threshold and close the run
  // out as real movement instead of misreporting it as one giant stall.
  let anchor = trace[0];
  for (let i = 1; i <= trace.length; i++) {
    const cur = i < trace.length ? trace[i] : null;
    const samePos = cur && Math.abs(cur.x - anchor.x) < TRACE_POS_EPS && Math.abs(cur.y - anchor.y) < TRACE_POS_EPS;
    if (!samePos) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= 2) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const runSlice = trace.slice(runStart, runEnd);
        const mostlyWaitingOnSpike = spikeFraction(runSlice) >= SPIKE_WAIT_DOMINANCE;
        const engagedTicks = runSlice.filter((r) => r.fire || r.fireOnCooldown).length;
        const mostlyFiring = engagedTicks / runLen > 0.5;
        if (runLen >= STALL_TICKS_THRESHOLD && !mostlyWaitingOnSpike && !mostlyFiring) {
          findings.push({
            type: "stall",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} activity=${first.activity ?? "?"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)} threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"}`,
          });
        }
        if (runLen >= HP_DRAIN_FROZEN_TICKS_THRESHOLD && last.hpFrac < first.hpFrac - 0.001 && !mostlyFiring) {
          findings.push({
            type: "healthDrainFrozen",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} activity=${first.activity ?? "?"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
          });
        }
      }
      runStart = i;
      anchor = cur;
    }
  }
  return findings;
}

/**
 * Heading-error summary for one oscillation run, for the trace's `delta`
 * (bearing error to `navTarget`) and `navDist` fields.
 *
 * Exists to separate two very different failure shapes that look identical in
 * the position data alone:
 * - `|delta|` shrinking while the sign alternates — the bot *is* converging,
 *   just noisily, and the wobble is the cost of convergence rather than a
 *   defect. Both attempted fixes so far assumed the opposite.
 * - `|delta|` flat or growing across the run — genuinely not converging, which
 *   is the only case where damping the sign could help.
 *
 * `navDist` comes along because the bearing to a waypoint swings faster the
 * closer you stand to it, so a run spent hovering near its target explains a
 * large `|delta|` without anything being wrong with the turn itself.
 */
function describeHeadingError(trace, runStart, runEnd) {
  const deltas = [];
  const dists = [];
  for (let i = runStart; i < runEnd; i++) {
    if (typeof trace[i].delta === "number") deltas.push(trace[i].delta);
    if (typeof trace[i].navDist === "number") dists.push(trace[i].navDist);
  }
  if (deltas.length === 0) return "delta=n/a";
  const abs = deltas.map(Math.abs);
  const flips = deltas.slice(1).filter((d, i) => Math.sign(d) !== Math.sign(deltas[i])).length;
  const firstHalf = abs.slice(0, Math.ceil(abs.length / 2));
  const secondHalf = abs.slice(Math.ceil(abs.length / 2));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanDist = dists.length > 0 ? mean(dists) : null;
  return (
    `|delta| ${mean(firstHalf).toFixed(3)}->${mean(secondHalf).toFixed(3)} ` +
    `(min ${Math.min(...abs).toFixed(3)} max ${Math.max(...abs).toFixed(3)}) ` +
    `signFlips=${flips}/${deltas.length - 1} ` +
    `navDist=${meanDist === null ? "n/a" : meanDist.toFixed(2)}t`
  );
}

/**
 * How many distinct nav targets the bot actually *reached* during a run.
 *
 * This is what separates a wedge from the bot's ordinary gait, and getting it
 * wrong is why this detector produced ~700 findings that were mostly nothing.
 * `planRoute` emits one waypoint per tile, so a winding corridor gives a new
 * target — often 1.5-2.7 rad off the current heading — every single tile.
 * Above `MAX_WALK_WHILE_TURNING_RAD` the bot may not hold `KeyW`, so it stops,
 * turns in place for 3-6 decisions, sprints one tile, and repeats. Measured on
 * a real dump: 28% of ticks inside flagged runs were frozen mid-turn, and the
 * turns themselves were textbook (-0.455 rad per decision, dead on target, no
 * overshoot and no sign flip). Spatially that gait never leaves a 2-tile
 * radius and its path/net ratio is 4-6x — it trips every other test here while
 * being exactly what the bot is supposed to do.
 *
 * Counting arrivals fixes it without blinding the detector: a bot working
 * through a route ticks targets off, while one circling something it cannot
 * reach never closes on anything. Counted as falling *edges* past the
 * threshold, so hovering around a single target can't inflate the count.
 */
function reachedTargets(slice) {
  let reached = 0;
  let inside = false;
  for (const row of slice) {
    if (typeof row.navDist !== "number") continue;
    if (!inside && row.navDist <= OSCILLATION_ARRIVAL_DIST) {
      reached += 1;
      inside = true;
    } else if (inside && row.navDist > OSCILLATION_ARRIVAL_DIST) {
      inside = false;
    }
  }
  return reached;
}

/**
 * Scans a level's trace for *oscillation*: the bot moving continuously while
 * making no net progress.
 *
 * This is the gap the other two detectors leave. `detectAnomalies` flags a
 * frozen position and `detectHeldKeyNoMovement` flags a held key that produced
 * no displacement — both answer "did it stop?". A bot ping-ponging between two
 * waypoints, or circling a target it can never quite reach, never stops, so
 * neither fires. That failure mode is real and currently invisible: the demo
 * campaign has a level that wedges most full-campaign attempts and yields no
 * finding at all from the existing passes.
 *
 * A run qualifies when, over at least `OSCILLATION_TICKS_THRESHOLD` decisions,
 * every position stays within `OSCILLATION_RADIUS_TILES` of the run's anchor,
 * the bot covered at least `OSCILLATION_MIN_PATH_TILES` of ground, and the
 * path was at least `OSCILLATION_MIN_PATH_RATIO`x its net displacement.
 *
 * A run in which the bot *reached* `OSCILLATION_ARRIVALS_EXEMPT` or more nav
 * targets is excluded as route progress rather than thrashing — without that,
 * the bot's normal stop-turn-sprint gait through a winding corridor dominates
 * the findings (see `reachedTargets`).
 *
 * Engaged combat is excluded rather than filtered afterwards. Circling and
 * sidestepping while fighting is deliberate behaviour (see the combat strafe
 * and bolt dodging in `combatPolicy.mjs`), so counting it here would bury the
 * real findings under the bot doing its job — the same reasoning behind
 * `detectAnomalies`' own `mostlyFiring` exclusion.
 *
 * Returns `{type, startTick, endTick, ticks, detail}[]`, the same shape the
 * other detectors use so `reportAnomalies` can print them uniformly.
 */
export function detectOscillation(trace) {
  const findings = [];
  if (!trace || trace.length < OSCILLATION_TICKS_THRESHOLD) return findings;

  let runStart = 0;
  let anchor = trace[0];
  for (let i = 1; i <= trace.length; i++) {
    const cur = i < trace.length ? trace[i] : null;
    // Anchored to the run's own start, like `detectAnomalies` — a genuine
    // traverse eventually leaves the radius and closes the run, while a bot
    // thrashing in place keeps extending it.
    if (cur && Math.hypot(cur.x - anchor.x, cur.y - anchor.y) <= OSCILLATION_RADIUS_TILES) continue;

    const runEnd = i; // exclusive
    const runLen = runEnd - runStart;
    if (runLen >= OSCILLATION_TICKS_THRESHOLD) {
      const slice = trace.slice(runStart, runEnd);
      const engagedTicks = slice.filter((r) => r.threatDist !== null && r.threatDist !== undefined).length;
      const mostlyEngaged = engagedTicks / runLen > 0.5;
      const allWaitingOnSpike = spikeFraction(slice) >= SPIKE_WAIT_DOMINANCE;
      // Working through the route, not stuck on it — see `reachedTargets`.
      const makingRouteProgress = reachedTargets(slice) >= OSCILLATION_ARRIVALS_EXEMPT;

      let pathLength = 0;
      for (let j = 1; j < slice.length; j++) pathLength += Math.hypot(slice[j].x - slice[j - 1].x, slice[j].y - slice[j - 1].y);
      const first = slice[0];
      const last = slice[slice.length - 1];
      const netDisplacement = Math.hypot(last.x - first.x, last.y - first.y);
      // Guard the divide: a run with no net displacement at all is maximally
      // oscillatory, not undefined.
      const ratio = netDisplacement > 0.01 ? pathLength / netDisplacement : Infinity;

      if (!mostlyEngaged && !allWaitingOnSpike && !makingRouteProgress && pathLength >= OSCILLATION_MIN_PATH_TILES && ratio >= OSCILLATION_MIN_PATH_RATIO) {
        findings.push({
          type: "oscillation",
          startTick: runStart,
          endTick: runEnd - 1,
          ticks: runLen,
          detail:
            `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} activity=${first.activity ?? "?"} ` +
            `travelled=${pathLength.toFixed(1)}t net=${netDisplacement.toFixed(2)}t ratio=${ratio === Infinity ? "inf" : ratio.toFixed(1)}x ` +
            `hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)} ` +
            describeHeadingError(trace, runStart, runEnd),
        });
      }
    }
    runStart = i;
    anchor = cur;
  }
  return findings;
}

/**
 * A tick-by-tick pass over the same trace `detectAnomalies` uses, but
 * checking each tick against the *immediately preceding* one and
 * correlating it directly with which keys were actually held. Flags a run
 * where a translating key was held yet real displacement since the previous
 * tick was under TRACE_POS_EPS — i.e. the engine's own collision resolution
 * rejected the translation outright, every single tick, for the whole run.
 */
export function detectHeldKeyNoMovement(trace) {
  const findings = [];
  if (!trace || trace.length < 2) return findings;
  let runStart = null;
  for (let i = 1; i <= trace.length; i++) {
    const prev = trace[i - 1];
    const cur = i < trace.length ? trace[i] : null;
    const heldTranslatingKey = prev.moveKeys?.some((k) => TRANSLATING_KEYS.has(k));
    const noRealMovement = cur && Math.abs(cur.x - prev.x) < TRACE_POS_EPS && Math.abs(cur.y - prev.y) < TRACE_POS_EPS;
    if (heldTranslatingKey && noRealMovement) {
      if (runStart === null) runStart = i - 1;
      continue;
    }
    if (runStart !== null) {
      const runEnd = i; // exclusive
      const runLen = runEnd - runStart;
      if (runLen >= HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD) {
        const first = trace[runStart];
        const last = trace[runEnd - 1];
        const heldKeys = new Set(trace.slice(runStart, runEnd).flatMap((r) => r.moveKeys ?? []));
        findings.push({
          type: "heldKeyNoMovement",
          startTick: runStart,
          endTick: runEnd - 1,
          ticks: runLen,
          detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} activity=${first.activity ?? "?"} keysDuringRun=[${[...heldKeys].join(",")}] threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
        });
      }
      runStart = null;
    }
  }
  return findings;
}

/**
 * One automated-playtest bot instance, bound to a single Playwright `page`
 * and skill `profile` for its whole lifetime — construct a fresh `Bot` per
 * campaign attempt (fresh browser context), same scope as the original
 * script's per-attempt bot behavior. Per-level state (`map`, `mineMemory`,
 * `visitedPickups`) resets via `startLevel(map)`.
 */
export class Bot {
  /**
   * @param {import("playwright").Page} page
   * @param {object} profile one of PROFILES's shape (fireAngleEps,
   *   engageRadius, weaponPriority, healthDetourThreshold,
   *   proactiveMineDisarm, rocketForDistantClusters, rotSpeedMultiplier)
   * @param {object} [opts]
   * @param {boolean} [opts.realtime=false] false = virtual-clock pump
   *   (window.__pumpVirtualTime), true = real page.waitForTimeout.
   * @param {number} [opts.stepMs] standard per-decision step duration;
   *   defaults to WATCH_STEP_MS (realtime) or VIRTUAL_STEP_MS (virtual).
   * @param {number} [opts.recordStepMs] sub-step granularity passed as
   *   `window.__pumpVirtualTime`'s own `stepMs` (virtual-clock mode only) —
   *   defaults to `stepMs` itself, i.e. one `ReplayFrame` per bot decision,
   *   matching every existing caller's behavior. A caller that ships the
   *   resulting replay for real playback (unlike a telemetry-only run) needs
   *   this set to a real-frame-sized value (e.g. `1000/60`) instead: replay
   *   playback (`src/main.ts`'s `step()`) consumes exactly one recorded
   *   frame per real render tick regardless of that frame's own `dt`, so
   *   fewer-but-coarser frames covering the same virtual duration play back
   *   proportionally faster than real speed — see
   *   `scripts/generate-default-highscore.mjs`'s history of this exact bug.
   * @param {object} [opts.tuning] deep-merged over DEFAULT_TUNING.
   * @param {object} [opts.logger] {debugNav, wpDebug, driftDebug}: optional
   *   `(msg: string) => void` sinks, no-ops by default. {trace, navDiag}:
   *   booleans — `trace: true` enables per-decision trace collection +
   *   `reportAnomalies`' basic findings (stall, health-drain-frozen, and
   *   oscillation); `navDiag: true` (implies `trace`) additionally enables the
   *   finer held-key-no-movement pass.
   * @param {boolean} [opts.ignoreThreats=false] never engage, flee from, or
   *   even acknowledge an enemy as a threat — `tick()` goes straight to plain
   *   navigation regardless of what's nearby. For a bot driving a genuinely
   *   invulnerable player (e.g. `scripts/verify-multiplayer-transition.mjs`'s
   *   god-mode host): taking damage was never the actual risk once
   *   invulnerable, but stopping to fight still was — a tanky enemy can pin
   *   the bot in a long, slow melee grind (each successful hit resets the
   *   existing `combatStallTicks` anti-stall counter, since landing a hit
   *   counts as "progress," so that counter alone never fires) that eats
   *   real wall-clock time without the bot ever getting closer to its actual
   *   destination — confirmed directly via a real CI run's own anomaly trace
   *   (a 600+-tick stall pinned at `threatDist` well inside melee range,
   *   health never dropping). The engine's own collision only checks map
   *   geometry (`collidesWithWall`), never other entities, so a bot that
   *   simply never stops to fight can walk straight past/through an enemy
   *   with no risk of getting physically blocked by it either.
   */
  constructor(page, profile, opts = {}) {
    this.page = page;
    this.profile = profile;
    this.realtime = opts.realtime ?? false;
    this.ignoreThreats = opts.ignoreThreats ?? false;
    // A profile may own tuning constants that would otherwise be global, which
    // is how a skill tier expresses *competence* (how well it avoids damage)
    // rather than only *pace* (how fast it moves and shoots) — see
    // `scripts/lib/profiles.mjs`.
    //
    // Merged here rather than at the call sites deliberately: there are six
    // `Bot` constructions and five pass no `tuning` at all, including
    // `generate-default-highscore.mjs`'s — so per-call-site plumbing would
    // silently have generated the shipped highscore from profiles whose own
    // tuning never applied. One line here makes that class of bug impossible,
    // and `MultiplayerBot` inherits it through `super()`.
    //
    // `opts.tuning` stays last so `CODEENSTEIN_TELEMETRY_TUNING` still wins —
    // it is the single-variable switch every A/B in `doc/dev/balancing-telemetry.md`
    // depends on.
    this.tuning = { ...DEFAULT_TUNING, ...(profile?.tuning ?? {}), ...opts.tuning };
    this.stepMs = opts.stepMs ?? (this.realtime ? this.tuning.WATCH_STEP_MS : this.tuning.VIRTUAL_STEP_MS);
    this.recordStepMs = opts.recordStepMs ?? this.stepMs;
    this.logger = {
      debugNav: opts.logger?.debugNav,
      wpDebug: opts.logger?.wpDebug,
      driftDebug: opts.logger?.driftDebug,
      trace: opts.logger?.trace ?? false,
      navDiag: opts.logger?.navDiag ?? false,
      traceDump: opts.logger?.traceDump ?? false,
    };
    this.map = null;
    this.mineMemory = null;
    this.visitedPickups = new Set();
    // Cumulative in-game (simulated) time this Bot instance has driven,
    // and the value it last held at the moment a semi-auto ranged shot was
    // fired — see `#applyAction`'s increment and `tick()`'s fire-cooldown
    // gate, `profile.fireCooldownMs`'s doc comment. Persists across levels
    // within one run/attempt (a human trigger finger doesn't reset at a
    // level transition), reset only by constructing a fresh `Bot`.
    this.simTimeMs = 0;
    this.lastFireSimTimeMs = -Infinity;
    // Anomaly findings accumulated across every level this Bot plays, as
    // `{ [type]: { findings, ticks } }`. Exists because `detectOscillation`
    // counts *events*, and an A/B judged on event count is unreadable: a
    // change that makes the bot cover less ground can produce *more*
    // qualifying windows while behaving better. `ticks` is the time-weighted
    // figure to judge on. Console output alone couldn't answer that, which is
    // how the first oscillation fix got graded on the wrong number.
    this.anomalyTally = {};
    // Denominator for `anomalyTally` — see `#tallyDecisions`.
    this.anomalyDecisions = 0;
    // What errand the bot is currently on, stamped onto every trace record so
    // travelled distance can be attributed to intent rather than only to a
    // combat branch — see `summarizeActivityDistance` and `#withActivity`.
    // Purely observational: nothing reads it to make a decision.
    this.activity = "route";
  }

  /**
   * Run `fn` with `this.activity` set to `label`, restoring the previous label
   * afterwards. Save/restore rather than plain assignment because these
   * errands nest (`driveToExit` -> `#huntEnemy` -> `#walkPathTo` ->
   * `driveToward`) and an inner errand finishing must not silently relabel the
   * outer one's remaining decisions.
   */
  async #withActivity(label, fn) {
    const previous = this.activity;
    this.activity = label;
    try {
      return await fn();
    } finally {
      this.activity = previous;
    }
  }

  /**
   * Run `fn` with combat re-enabled, restoring the caller's setting afterwards
   * — the same save/restore shape as `#withActivity`, and for the same reason:
   * these scopes nest.
   *
   * A no-op for any bot that was already fighting, which is every
   * single-player caller (`ignoreThreats` defaults to `false`). It exists for
   * `driveToExit`'s blocker hunt, which is otherwise dead code under
   * `ignoreThreats: true`: `#huntEnemy` walks at the enemy expecting the
   * ordinary combat branches to kill it once proximity aggros it, and those
   * branches never run when `pickThreat` is suppressed. Measured directly —
   * `driveToExit` with `ignoreThreats` spends its whole `exitHunt` errand
   * (79.6 tiles across all six `EXIT_CLEAR_ROUNDS`) walking at a blocker it
   * never shoots, and still reports `stuck`; the same run with combat enabled
   * clears the level.
   *
   * Scoped to the hunt alone rather than the whole drive on purpose. The route
   * stays threat-free, so the melee-grind this option was added for (see the
   * `ignoreThreats` doc comment above) cannot come back where it happened.
   * Fighting starts only once the exit has been *proven* inert and a specific
   * living enemy has been identified as the thing gating it.
   */
  async #withCombat(fn) {
    const previous = this.ignoreThreats;
    this.ignoreThreats = false;
    try {
      return await fn();
    } finally {
      this.ignoreThreats = previous;
    }
  }

  /**
   * Whether the level has already accepted a player standing on the exit.
   *
   * Single-player needs no such test, so this is `false` here and
   * `driveToExit` behaves exactly as it always has: `checkExit()` calls
   * `endGame("won")` the moment the exit is touched, which `driveToward`
   * already reports as `state !== "playing"`.
   *
   * Multiplayer cannot use that signal. Touching the exit there starts a
   * `COUNTDOWN_TICKS` countdown and leaves every player `"alive"`, so
   * `getBotPlayerState` keeps reporting `"playing"` — without an explicit
   * predicate `driveToExit` walks onto the exit, finds no live blocker, and
   * returns `stuck` on a run that actually succeeded.
   */
  async exitAccepted() {
    return false;
  }

  /**
   * Resets all per-level state — call once at the start of each campaign
   * level. `mineMemory` mirrors the original script's per-level object
   * exactly (see its doc comment there for why retreat/shoot tracking are
   * kept in separate slots, and why `abandoned` is scoped per-level).
   */
  startLevel(map) {
    this.map = map;
    this.mineMemory = {
      retreatKey: null,
      retreatTicks: 0,
      shootKey: null,
      shootTicks: 0,
      abandoned: new Set(),
      trace: this.logger.trace ? [] : undefined,
    };
    this.visitedPickups = new Set();
    // Last `gridVersion` seen from the engine — see `#refreshGridIfChanged`.
    // Reset per level, because the engine's counter is per level too.
    this.lastGridVersion = null;
    // Doors this run has pushed open, as "x,y" tile keys. Lives on the
    // instance rather than inside `driveLegs` because `driveToExit` runs
    // *after* the legs are done and still has to path back through them.
    this.openedDoors = new Set();
    // Lazily built by `#allDoorTiles()` — every door tile on this level, for
    // the "route through doors" re-plan fallback.
    this.allDoorTilesCache = null;
  }

  /**
   * Shortest decision this bot may issue, in ms. Zero here: under the virtual
   * clock there is no transport between deciding and the engine seeing it, so
   * a 5ms burst lands exactly as 5ms of movement, and short bursts are the
   * whole anti-overshoot mechanism.
   *
   * `MultiplayerBot` overrides it, and the reason is load-bearing rather than
   * defensive — see its own doc comment. Every input there is delayed
   * `INPUT_DELAY_TICKS` (~100ms) before it reaches the shared simulation, and
   * a bot whose decision window is not comfortably longer than that delay
   * re-issues a fresh command before the previous one has finished arriving.
   * That was confirmed directly, twice, and is why `DEFAULT_STEP_MS` is 400
   * rather than `WATCH_STEP_MS`'s 130.
   *
   * The trap this guards is that a *speed* change silently becomes a *timing*
   * change: `#moveBurstMs` caps the hold at however long the move needs, so
   * doubling the speed halves the decision window for the same distance. That
   * turned a single-player-only sprint into a multiplayer navigation failure
   * (`verify:multiplayer-transition`, the one CI-wired bot script, went from
   * pass to "host got stuck on the final approach") with no multiplayer code
   * changed at all.
   */
  get minDecisionMs() {
    return 0;
  }

  /**
   * Defensive net for an intermittent, not-fully-root-caused report: the
   * bot occasionally spinning far more than one decision's worth of turning
   * should ever produce. Doesn't try to prevent the underlying cause
   * (unknown) — only makes any recurrence immediately visible in the log.
   */
  /**
   * Stamp provenance onto the `pendingTurnCheck` that `turnBurstMs` just
   * recorded, so a later `#checkRotationAnomaly` can say *where* the turn came
   * from and how long the key was really held — not just the burst that was
   * computed for it. Pure diagnostics; never read back by decision logic.
   */
  #attributeTurnCheck({ origin, branch, turnKey, holds, durationMs }) {
    const pending = this.mineMemory?.pendingTurnCheck;
    if (!pending) return;
    pending.origin = origin;
    pending.branch = branch;
    pending.turnKey = turnKey;
    pending.actualHoldMs = turnKey && holds ? (holds.get(turnKey) ?? null) : (durationMs ?? null);
    pending.durationMs = durationMs;
    pending.setAtSimTimeMs = this.simTimeMs;
  }

  #checkRotationAnomaly(player, currentAngle) {
    const pending = this.mineMemory?.pendingTurnCheck;
    if (!pending) return;
    this.mineMemory.pendingTurnCheck = null;
    const actual = Math.abs(angleDelta(pending.beforeDir, currentAngle));
    const expectedMax = this.tuning.ENGINE_ROT_SPEED * pending.rotSpeedMultiplier * (pending.turnBurstMs / 1000) * this.tuning.ROTATION_ANOMALY_SLACK;
    if (actual > Math.max(expectedMax, 0.3)) {
      console.log(
        `[nav-warn] implausible rotation: turned ${actual.toFixed(2)}rad in one decision ` +
          `(computed turn ${pending.turnBurstMs.toFixed(1)}ms, key actually held ${pending.actualHoldMs == null ? "?" : pending.actualHoldMs.toFixed(1) + "ms"}, ` +
          `expected <=${expectedMax.toFixed(2)}rad) ` +
          `[origin=${pending.origin ?? "?"} branch=${pending.branch ?? "?"} turnKey=${pending.turnKey ?? "-"} ` +
          `decision=${pending.durationMs == null ? "?" : pending.durationMs.toFixed(0) + "ms"} ` +
          `elapsedSim=${(this.simTimeMs - (pending.setAtSimTimeMs ?? this.simTimeMs)).toFixed(0)}ms] ` +
          `at (${player.x.toFixed(2)},${player.y.toFixed(2)}) — not a stuck state, self-corrects next tick, logged for diagnosis.`,
      );
    }
  }

  /** No-op unless trace collection is enabled (see `startLevel`). Appends
   * one lightweight per-decision record to `this.mineMemory.trace`. */
  #recordTrace(entry) {
    if (!this.mineMemory?.trace) return;
    this.mineMemory.trace.push(entry);
  }

  /** Adds one finding to `anomalyTally`, keeping both the event count and the
   * time-weighted tick total — see the field's own comment for why the tick
   * total is the one to grade a behaviour change on. */
  #tallyAnomaly(finding) {
    const row = (this.anomalyTally[finding.type] ??= { findings: 0, ticks: 0 });
    row.findings += 1;
    row.ticks += finding.ticks ?? 0;
  }

  /** Total decisions this Bot has recorded, accumulated per level so the
   * anomaly tallies can be expressed as a *share of decisions*. Neither raw
   * findings nor raw ticks are exposure-independent: a change that makes the
   * bot finish levels faster lowers both without the behaviour improving at
   * all. Measured on a real comparison — oscillation ticks/run fell 11.7%
   * while level time fell 7.7%, so most of the apparent win was simply less
   * time on the level. */
  #tallyDecisions() {
    this.anomalyDecisions = (this.anomalyDecisions ?? 0) + (this.mineMemory?.trace?.length ?? 0);
  }

  /** No-op unless trace collection is enabled. Runs `detectAnomalies` (and,
   * if `this.logger.navDiag` is also on, `detectHeldKeyNoMovement`) against
   * this level's accumulated trace and logs any findings, tagged with
   * `label` and the 1-based level number. */
  reportAnomalies(label, levelIndex) {
    if (!this.mineMemory?.trace) return;
    this.#tallyDecisions();
    if (this.logger.navDiag) {
      for (const f of detectHeldKeyNoMovement(this.mineMemory.trace)) {
        this.#tallyAnomaly(f);
        console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
      }
    }
    for (const f of detectAnomalies(this.mineMemory.trace)) {
      this.#tallyAnomaly(f);
      console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
    }
    // Deliberately not `navDiag`-gated: a bot that paces instead of freezing is
    // exactly the case `balancing:scan` used to miss entirely, so it has to fire
    // on the default scan rather than only when someone already suspects it.
    const oscillations = detectOscillation(this.mineMemory.trace);
    for (const f of oscillations) {
      this.#tallyAnomaly(f);
      console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
    }
    // Raw per-decision rows for the level's *longest* oscillation run.
    // Aggregates over these runs have now produced two wrong diagnoses in a
    // row — the documented "the sign flips every decision" came from a
    // hand-picked five-line excerpt and measures 14% across whole runs — so
    // the next attempt should read one run end to end before naming a
    // mechanism. One run per level keeps that readable; run with
    // CONCURRENCY=1 or concurrent attempts interleave into nonsense.
    // Every detector's findings, not just oscillation — the longest run on a
    // level is as often a `stall` (the Pro/normal level-1 wedge is a 440-tick
    // stall, which an oscillation-only dump captured nothing of).
    // The longest run of *each* type, not the longest overall: one dump per
    // level meant a level whose worst run was an oscillation never showed a
    // single stall row, and vice versa. Classifying the scan's idle stalls
    // needed exactly those rows — 14 clusters of them sat next to spike traps
    // and only one happened to overlap an oscillation window that got dumped.
    const dumpable = [...detectAnomalies(this.mineMemory.trace), ...oscillations];
    const longestByType = new Map();
    for (const f of dumpable) {
      const cur = longestByType.get(f.type);
      if (!cur || f.ticks > cur.ticks) longestByType.set(f.type, f);
    }
    for (const longest of longestByType.values()) {
      if (!this.logger.traceDump) break;
      console.log(`  [trace] ${label} level ${levelIndex + 1}: longest ${longest.type}, decisions ${longest.startTick}-${longest.endTick} (${longest.ticks} ticks)`);
      for (let i = longest.startTick; i <= longest.endTick; i++) {
        const t = this.mineMemory.trace[i];
        console.log(
          `    #${String(i).padStart(4)} pos=(${t.x.toFixed(2)},${t.y.toFixed(2)}) ` +
            `delta=${t.delta === null || t.delta === undefined ? "  n/a" : (t.delta >= 0 ? "+" : "") + t.delta.toFixed(3)} ` +
            `navDist=${t.navDist === null || t.navDist === undefined ? "n/a" : t.navDist.toFixed(2)} ` +
            `burst=${t.turnBurst === undefined || t.turnBurst === null ? "  -" : t.turnBurst.toFixed(0).padStart(3)} ` +
            `keys=[${t.moveKeys.join(",")}]`.padEnd(34) +
            ` threat=${t.threatDist === null ? "  -" : t.threatDist.toFixed(1)}` +
            ` mine=${t.mineDist === null || t.mineDist === undefined ? "  -" : t.mineDist.toFixed(1)}` +
            ` br=${(t.branch ?? "?").padEnd(9)} fire=${t.fire ? 1 : 0} spike=${t.waitingOnSpike ? 1 : 0} hp=${t.hpFrac.toFixed(2)}`,
        );
      }
    }
    // Not an anomaly — a standing breakdown of where the level's walking went,
    // so `routeEfficiencyScore` regressions can be attributed instead of only
    // observed. `navDiag`-gated because it prints unconditionally (every level
    // has one) and would otherwise bury the actual findings above.
    if (this.logger.navDiag) {
      const { rows, total } = summarizeActivityDistance(this.mineMemory.trace);
      const parts = rows.map((r) => `${r.activity} ${r.tiles.toFixed(1)}t (${(r.share * 100).toFixed(0)}%, ${(r.engagedTiles / (r.tiles || 1) * 100).toFixed(0)}% engaged)`);
      console.log(`  [activity] ${label} level ${levelIndex + 1}: ${total.toFixed(1)} tiles attributed — ${parts.join(", ")}`);
    }
  }

  /**
   * Detour to collect an uncollected static AmmoPickup — any kind, not just
   * health. Below `profile.healthDetourThreshold`, prioritizes the nearest
   * *health* pickup specifically even if farther away; otherwise grabs
   * whichever uncollected pickup is nearest, of any kind. Ranks by actual
   * walking distance (a real BFS path), not straight-line. Capped at
   * `this.tuning.MAX_LOOT_DETOUR_TILES` — a pickup beyond the cap is left
   * uncollected for a later check to pick up once the route naturally
   * passes closer.
   */
  async maybeDetourForLoot(openedDoors) {
    const player = await this.readState();
    if (player.state !== "playing") return { state: player.state };

    // Static, pre-placed pickups need our own "already visited" bookkeeping
    // — `map.ammoPickups` never shrinks. Dynamic kill-drop loot and keys
    // need a live query — neither exists in the static map data.
    const staticUncollected = this.map.ammoPickups.filter((p) => !this.visitedPickups.has(`${p.x},${p.y}`));
    const dynamicDrops = await this.page.evaluate(() => window.__codeensteinTestHooks.getDrops());
    const dynamicKeys = (await this.page.evaluate(() => window.__codeensteinTestHooks.getKeys())).map((k) => ({ ...k, kind: "key" }));
    const uncollected = [...staticUncollected, ...dynamicDrops, ...dynamicKeys];
    if (uncollected.length === 0) return { state: "playing" };

    const urgent = player.healthFraction < this.profile.healthDetourThreshold;
    const healthOnly = uncollected.filter((p) => p.kind === "health");
    const pool = urgent && healthOnly.length > 0 ? healthOnly : uncollected;

    let best = null;
    let bestPath = null;
    for (const p of pool) {
      if (Math.hypot(p.x - player.x, p.y - player.y) > this.tuning.MAX_LOOT_DETOUR_TILES) continue;
      const path = bfsPath(
        this.map,
        { x: Math.floor(player.x), y: Math.floor(player.y) },
        { x: Math.floor(p.x), y: Math.floor(p.y) },
        LOOT_DETOUR_AVOID_TILES,
        openedDoors,
      );
      if (!path || path.length - 1 > this.tuning.MAX_LOOT_DETOUR_TILES) continue;
      if (!bestPath || path.length < bestPath.length) {
        best = p;
        bestPath = path;
      }
    }
    // Leave it uncollected rather than mark it visited — a later check, once
    // the route naturally passes closer, can still pick it up.
    if (!best) return { state: "playing" };
    if (staticUncollected.includes(best)) this.visitedPickups.add(`${best.x},${best.y}`);

    const path = bestPath;
    // `hp` and `urgent` are logged because loot detours turned out to be 24% of
    // all distance walked (see `summarizeActivityDistance`), and whether a given
    // detour was *worth* walking depends on the resource level at the time —
    // health caps at `MAX_HEALTH`, so a health detour at `hp=1.00` is walking
    // for nothing.
    this.logger.wpDebug?.(
      `[wpdebug] loot-detour from (${player.x.toFixed(1)},${player.y.toFixed(1)}) to best=(${best.x},${best.y}) kind=${best.kind} pathLen=${path.length} hp=${player.healthFraction.toFixed(2)} urgent=${urgent}`,
    );
    return this.#withActivity("loot", async () => {
      for (const wp of pathToWaypoints(path)) {
        this.logger.wpDebug?.(`[wpdebug]   loot wp=(${wp.x},${wp.y})`);
        // Re-planning, the same as a route leg — see `driveTowardWithReplan`.
        // This call site kept the bare straight-line `driveToward` after the
        // route legs moved off it, and inherited the exact failure that change
        // was made to fix: shoved off the line mid-detour, the bot aims into a
        // wall for the whole budget instead of routing around.
        //
        // It is the *dominant* wedge the anomaly scan sees. Tagging findings
        // with the errand they occurred on showed 9 of 13 idle stalls are
        // `activity=loot`, including both clusters previously mistaken for a
        // door-opening bug: on `stage03_legacy_api.php` the bot sits in the
        // throat of the doorway at y=70.5 with the door at y=71 — not opening
        // it, just walking past it toward a pickup — and a heading up to
        // `TURN_MOVE_EPS` (0.2 rad) off-axis clips the frame. The engine
        // rejects the blocked axis and slides the free one, so y stays pinned
        // while x crawls 23.53 -> 23.69 across 254 decisions.
        const result = await this.driveTowardWithReplan(wp, openedDoors, this.tuning.ARRIVE_EPS);
        this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
        if (result.state !== "playing") return result;
        // See `driveLegs`'s own doc comment on its identical check — every
        // waypoint after a mid-route teleport was planned from a position this
        // bot is no longer at.
        if (result.reason === "teleported") return result;
      }
      return { state: "playing" };
    });
  }

  /**
   * Drive toward a single planned waypoint, but re-BFS a detour-safe path
   * to it first if the bot has drifted `this.tuning.LEG_REPLAN_DRIFT_TILES`
   * or more away from where it's expected to be — *or* the straight line to
   * it is blocked by a wall regardless of distance (a short straight-line
   * gap can still have a wall in it if the true walkable path bends around
   * a corner).
   */
  async driveTowardWithReplan(wp, openedDoors, eps = this.tuning.ARRIVE_EPS) {
    // Re-plan whenever a drive reports `stuck`, not only on entry.
    //
    // The displacement check below used to run once and then hand off to
    // `driveToward`, which steers in a straight line for its whole budget with
    // no further path checks. Anything that moves the bot mid-drive — combat is
    // the usual culprit, since `tick()` lets a threat preempt navigation
    // entirely — can carry it around a wall, after which the straight line aims
    // into that wall for the rest of the budget and the attempt is discarded.
    //
    // Captured on `stage06_pipeline.py`, reproducibly and at identical
    // coordinates across runs: the bot stood at (40.5,57.5) with its waypoint
    // one tile north at (40.5,56.5), got pushed west during a firefight, and
    // ended at (38.8,56.3) — the far side of the wall at (39,56), where "east"
    // is that wall. Re-planning from where it actually ended up routes around.
    //
    // The retry has to cover the re-planned walk too, not just the direct
    // drive: that captured failure was a `replan-walk` waypoint going stuck,
    // which an entry-only check by definition cannot catch.
    outer: for (let replan = 0; ; replan++) {
      const lastTry = replan >= this.tuning.WAYPOINT_REPLAN_ATTEMPTS;
      // Ground covered on a *retry* was already covered by the attempt that
      // went stuck, so it is charged to a distinct `<errand>+replan` activity
      // (see `summarizeActivityDistance`). Iteration 0 keeps the caller's own
      // label even when `displaced` fires: routing around a corner the moment
      // line of sight is lost is the plan working, not a retry.
      const activity = replan > 0 ? `${this.activity}+replan` : this.activity;
      const player = await this.readState();
      if (player.state !== "playing") return { state: player.state };
      const displaced =
        Math.hypot(player.x - wp.x, player.y - wp.y) > this.tuning.LEG_REPLAN_DRIFT_TILES ||
        (this.map && !hasLineOfSight(this.map, player.x, player.y, wp.x, wp.y));

      if (displaced) {
        const from = { x: Math.floor(player.x), y: Math.floor(player.y) };
        const to = { x: Math.floor(wp.x), y: Math.floor(wp.y) };
        // Strict first; then, if that fails, assume every door can be gotten
        // through. `this.map` is a static copy the engine never mutates, so a
        // door opened outside `#noteDoorUnderFoot`'s view still reads as a wall.
        let path = bfsPath(this.map, from, to, new Set(), openedDoors);
        this.logger.driftDebug?.(
          `[driftdebug] drift from (${player.x.toFixed(2)},${player.y.toFixed(2)}) wp=(${wp.x},${wp.y}) openedDoors=${JSON.stringify([...openedDoors])} path=${path ? `${path.length} tiles` : "NULL"}`,
        );
        if (!path) {
          path = bfsPath(this.map, from, to, new Set(), this.#allDoorTiles());
          if (path) this.logger.driftDebug?.(`[driftdebug]   strict BFS failed, routing through doors (${path.length} tiles)`);
        }
        if (path) {
          for (const rwp of pathToWaypoints(path)) {
            this.logger.wpDebug?.(`[wpdebug] replan-walk wp=(${rwp.x},${rwp.y})`);
            const result = await this.#withActivity(activity, () => this.driveToward(rwp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT));
            this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
            // See `driveLegs`'s own doc comment on its identical check — a
            // mid-route teleport invalidates every remaining replanned
            // waypoint too, same as it would the original plan.
            if (result.state !== "playing" || result.reason === "teleported") return result;
            if (result.reason === "stuck") {
              if (lastTry) return result;
              this.logger.driftDebug?.(`[driftdebug] replan-walk stuck — re-planning (attempt ${replan + 1})`);
              continue outer;
            }
          }
          return { state: "playing", reason: "arrived" };
        }
        // Genuinely unreachable in the model. A straight line to a target BFS
        // can't reach is almost always a wall, and at the full per-waypoint
        // budget that costs the whole budget before reporting the failure it
        // already knew about — cap it so a hopeless case is cheap.
        this.logger.driftDebug?.(`[driftdebug]   no path even through doors — bounded straight-line attempt`);
        const bounded = await this.#withActivity(activity, () => this.driveToward(wp, eps, Math.ceil(this.tuning.MAX_TICKS_PER_WAYPOINT / 6)));
        if (bounded.state !== "playing" || bounded.reason !== "stuck" || lastTry) return bounded;
        continue outer;
      }

      const direct = await this.#withActivity(activity, () => this.driveToward(wp, eps, this.tuning.MAX_TICKS_PER_WAYPOINT));
      if (direct.state !== "playing" || direct.reason !== "stuck" || lastTry) return direct;
      this.logger.driftDebug?.(`[driftdebug] straight-line stuck — re-planning (attempt ${replan + 1})`);
    }
  }

  /** Walks a full route-leg list (walk/openDoor legs), threading a
   * per-call `openedDoors` set so a BFS re-plan mid-run knows which doors
   * this run has already opened.
   *
   * A `reason: "teleported"` result from any waypoint stops this walk
   * immediately and propagates that result as-is, the same way `"stuck"`
   * already does — every waypoint after a teleport was planned against
   * wherever the bot *used to be*, not where it landed. `routePlanner.mjs`
   * hard-blocks real map teleporters from ever being planned as a waypoint
   * (`HARD_BLOCK_TILES`), so in practice this only ever fires from an
   * incidental touch, or — multiplayer-only — a teammate reaching the exit
   * mid-route: `checkExit()`'s own `.some()` semantics mean any single alive
   * player touching the exit carries the *whole* roster to the next level
   * once the countdown elapses ("exit touch is a shared simulation event"),
   * repositioning a still-driving bot without warning. Confirmed directly:
   * without this check, the leg-walk loop kept walking the old, now-
   * meaningless waypoint list against a live position that had moved to an
   * entirely different level, producing a real ~600-tick stall (the bot
   * grinding against `MAX_TICKS_PER_WAYPOINT` trying to reach a target its
   * own stale `this.map` can no longer even BFS a path to). */
  async driveLegs(legs) {
    const openedDoors = this.openedDoors;

    for (const leg of legs) {
      const detour = await this.maybeDetourForLoot(openedDoors);
      if (detour.state !== "playing") return detour;
      if (detour.reason === "teleported") return detour;

      if (leg.kind === "walk") {
        // Re-check for loot before every waypoint, not just once per leg —
        // a leg can be dozens of waypoints long.
        for (const wp of leg.waypoints) {
          const wpDetour = await this.maybeDetourForLoot(openedDoors);
          if (wpDetour.state !== "playing") return wpDetour;
          if (wpDetour.reason === "teleported") return wpDetour;
          this.logger.wpDebug?.(`[wpdebug] leg-walk wp=(${wp.x},${wp.y})`);
          const result = await this.#withActivity("route", () => this.driveTowardWithReplan(wp, openedDoors));
          this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
          if (result.state !== "playing") return result;
          // `state: "stuck"` is what every caller branches on
          // (`run-balancing-telemetry.mjs`, `generate-default-highscore.mjs`,
          // `diagnose-level-wedge.mjs`); `reason` is carried alongside it so a
          // caller that checks the *reason* — as
          // `verify-multiplayer-transition.mjs` did — isn't silently told the
          // route succeeded. That mismatch is why every route-phase failure in
          // that script was misreported as a final-approach failure.
          if (result.reason === "stuck") return { state: "stuck", reason: "stuck" };
          if (result.reason === "teleported") return result;
        }
      } else if (leg.kind === "openDoor") {
        // `openDoorAhead()` (engine.ts) only detects the door tile within a
        // short reach straight ahead of the player's *exact* position — walk
        // to a staging point centered on the door tile's cross-axis first,
        // with a tight arrival tolerance, before facing/pushing.
        const stagingPoint = {
          x: leg.doorTile.x + 0.5 - leg.approachDir.dx,
          y: leg.doorTile.y + 0.5 - leg.approachDir.dy,
        };
        const staged = await this.#withActivity("door", () => this.driveTowardWithReplan(stagingPoint, openedDoors, this.tuning.TIGHT_ARRIVE_EPS));
        if (staged.state !== "playing") return staged;
        if (staged.reason === "teleported") return staged;
        const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
        const faced = await this.#withActivity("door", () => this.faceAngle(targetAngle, this.tuning.MAX_TICKS_PER_WAYPOINT));
        if (faced.state !== "playing") return faced;
        const held = await this.holdForwardFine(this.tuning.DOOR_OPEN_TICKS * this.tuning.VIRTUAL_STEP_MS, this.tuning.DOOR_OPEN_FINE_STEP_MS);
        if (held.state !== "playing") return held;
        openedDoors.add(`${leg.doorTile.x},${leg.doorTile.y}`);
      }
    }
    return { state: "playing" };
  }

  /**
   * Walk onto the exit tile and, if the level refuses to end, clear whatever
   * the exit is waiting on.
   *
   * `checkExit()` (`engine.ts`) ends the level only when a living player
   * stands on `map.exit` **and** `exitRoomHasAliveEnemy()` is false — an
   * enemy whose `home` rectangle contains the exit keeps the exit inert no
   * matter how precisely the player is standing on it.
   *
   * `pickThreat` only ever considers `aggroed` enemies, so an exit-room enemy
   * that the route never provoked is invisible to the bot forever. The bot
   * would then stand on the exit until its caller gave up and recorded the
   * attempt as "stuck" — which is what made `generate:default-highscore` fail
   * ~58% of Casual attempts on demo-campaign level 10
   * (`stage10_kernel_module.rs`) while every waypoint on the way there
   * arrived cleanly in <=15 ticks against a 600-tick cap. It reproduced only
   * under the highscore generator because the A/B protocol runs telemetry
   * with `LEVEL_LIMIT=8` and so never reaches level 10 at all — not because
   * the two harnesses drive the bot differently.
   *
   * Walking at the blocker is all the "combat" this needs: closing to within
   * `AGGRO_RADIUS` with line of sight aggros it, at which point `pickThreat`
   * starts seeing it and the normal combat branches fight it. So this is a
   * navigation fix, and deliberately not a new combat policy.
   *
   * That last step is why the hunt runs under `#withCombat`: a caller driving
   * with `ignoreThreats` suppresses `pickThreat` entirely, so "the normal
   * combat branches fight it" never happens and the hunt walks circles around
   * a blocker it will not shoot. Only the hunt is scoped that way — see
   * `#withCombat`.
   */
  async driveToExit(exitCenter, finalApproachTicks, openedDoors = this.openedDoors) {
    let last = { state: "playing", reason: "stuck" };
    for (let round = 0; round < EXIT_CLEAR_ROUNDS; round++) {
      // BFS back to the exit tile before the tight final nudge. `driveToward`
      // walks a straight line with no pathfinding, and after a hunt the bot
      // can be most of a room away with walls in between — an earlier version
      // of this method cleared the exit room correctly and then failed anyway,
      // burning all `finalApproachTicks` straight-lining into a wall. Round 0
      // is normally a no-op (the caller's legs just ended at the exit).
      if (round > 0) {
        const back = await this.#withActivity("exitBacktrack", () => this.#walkPathTo({ x: this.map.exit.x, y: this.map.exit.y }, openedDoors));
        if (back.state !== "playing") return back;
        if (back.reason === "teleported") return back;
      }
      last = await this.#withActivity("exit", () => this.driveToward(exitCenter, this.tuning.TIGHT_ARRIVE_EPS, finalApproachTicks));
      // "won" (exit accepted) or "over" (died on the way) — either way, done.
      if (last.state !== "playing") return last;
      // Multiplayer never produces that signal: the exit starts a countdown
      // and leaves everyone alive. See `exitAccepted`'s own doc comment.
      if (await this.exitAccepted()) return { state: "playing", reason: "arrived" };

      const { player, enemies } = await this.readFull();
      // Exactly `exitRoomHasAliveEnemy()`'s predicate, not a proxy for it.
      // `Enemy.home` is not in the enemy snapshot, but it doesn't need to be:
      // the engine takes its roster straight from the generated map
      // (`this.enemies = map.enemies`, engine.ts), so `this.map.enemies[i]`
      // *is* the same record and indices line up exactly.
      //
      // Proximity to the exit was tried first and is not a usable stand-in —
      // it sent the bot after enemies 23 tiles away that could not possibly
      // be homed to the exit's room, burning every round without touching the
      // actual blocker.
      const blockers = this.tuning.BOT_WALKING_DISTANCE_BLOCKERS
        ? rankExitBlockers(
            enemies.map((e, i) => ({ ...e, i })).filter((e) => e.alive && this.#homesOnExitRoom(e.i)),
            player,
            this.map,
            openedDoors,
          )
        : enemies
            .map((e, i) => ({ ...e, i }))
            .filter((e) => e.alive && this.#homesOnExitRoom(e.i))
            .sort((a, b) => {
              const da = Math.hypot(a.x - player.x, a.y - player.y);
              const db = Math.hypot(b.x - player.x, b.y - player.y);
              return da - db || a.i - b.i; // total order — no reliance on sort stability
            });
      // Exit inert with nothing homed to its room left alive means the gate is
      // something this method doesn't model — report stuck rather than loop.
      if (blockers.length === 0) return { state: "playing", reason: "stuck" };
      this.logger.wpDebug?.(`[wpdebug] exit inert — ${blockers.length} exit-room blocker(s) alive; hunting #${blockers[0].i} at (${blockers[0].x.toFixed(1)},${blockers[0].y.toFixed(1)})`);
      const hunted = await this.#withCombat(() => this.#withActivity("exitHunt", () => this.#huntEnemy(blockers[0], openedDoors)));
      if (hunted.state !== "playing") return hunted;
      if (hunted.reason === "teleported") return hunted;
    }
    return { state: "playing", reason: "stuck" };
  }

  /**
   * Whether enemy `i` is one the exit is waiting on — the bot-side mirror of
   * `Engine#enemyBelongsToExitRoom`, evaluated against the same `Enemy`
   * records the engine itself runs on (see `driveToExit`).
   */
  #homesOnExitRoom(i) {
    const home = this.map?.enemies?.[i]?.home;
    if (!home) return false;
    const { x: ex, y: ey } = this.map.exit;
    return ex >= home.x && ex < home.x + home.w && ey >= home.y && ey < home.y + home.h;
  }

  /**
   * Path to `target`'s tile and walk it until the enemy dies. Returns as soon
   * as it does — the kill itself is done by the ordinary combat branches once
   * proximity aggros it, not here.
   *
   * The enemy's index is stable for a whole level (the same guarantee
   * `pickThreat` relies on to recognise "same enemy as last tick"), so it is
   * safe to re-check liveness by index against a fresh snapshot.
   */
  async #huntEnemy(target, openedDoors) {
    return this.#walkPathTo({ x: Math.floor(target.x), y: Math.floor(target.y) }, openedDoors, async () => {
      const { enemies } = await this.readFull();
      return !enemies[target.i]?.alive;
    });
  }

  /**
   * BFS a walkable path to `tile` and walk it waypoint by waypoint, stopping
   * early when `stopWhen` (if given) reports the errand is already done.
   *
   * This is the piece `driveToward` is not: `driveToward` steers in a straight
   * line and gives up when a wall is in the way, which is correct for a single
   * BFS waypoint one tile away but useless for "get from here to somewhere
   * across the room".
   */
  async #walkPathTo(tile, openedDoors, stopWhen = null) {
    const player = await this.readState();
    if (player.state !== "playing") return { state: player.state };
    const from = { x: Math.floor(player.x), y: Math.floor(player.y) };
    // Strict first, then again allowing hazard terrain — the same two-tier
    // shape `driveTowardWithReplan` uses for doors, and for the same reason:
    // refusing to plan a route is only correct when a *better* route exists.
    //
    // `LOOT_DETOUR_AVOID_TILES` (spikes + acid) is right for an optional loot
    // detour, where the answer to "the only way there crosses a spike" is
    // "then don't bother". It is wrong for getting to the exit, which is not
    // optional. Captured on `main.c`: from (60,57) the exit is 95 tiles away
    // by plain BFS but **NULL** once spikes and acid are excluded — every
    // route crosses one. `driveToExit` does not treat that null as fatal
    // (a `reason: "stuck"` still has `state: "playing"`), so it fell through
    // to `driveToward`, which steers a straight line with no pathfinding, and
    // sprinted into a wall for the whole 80-tick budget — six rounds, ~22
    // seconds frozen, in roughly 2 of 5 Pro/normal attempts.
    //
    // Crossing a spike costs a few HP; the drive loop still waits out an
    // *active* spike cycle via `activeSpikeAt`. Standing still for 22 seconds
    // costs the level.
    const { path, viaHazard } = pathAvoidingHazardsIfPossible(
      this.map, from, tile, LOOT_DETOUR_AVOID_TILES, openedDoors, this.tuning.BOT_HAZARD_ROUTE_FALLBACK,
    );
    if (viaHazard) this.logger.wpDebug?.(`[wpdebug] walkPathTo: no hazard-free route to (${tile.x},${tile.y}), routing through hazard terrain instead (${path.length} tiles)`);
    // Genuinely unreachable even through hazards — the caller reports "stuck".
    if (!path) return { state: "playing", reason: "stuck" };
    for (const wp of pathToWaypoints(path)) {
      const result = await this.driveToward(wp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
      if (result.state !== "playing") return result;
      // See `driveLegs`'s doc comment — waypoints after a teleport were
      // planned against a position this bot is no longer at.
      if (result.reason === "teleported") return result;
      if (stopWhen && (await stopWhen())) return { state: "playing", reason: "arrived" };
    }
    return { state: "playing", reason: "arrived" };
  }

  /**
   * One decision, dispatched. The decision itself lives in
   * `combatPolicy.mjs`'s `decide()` — this method is the I/O half: read the
   * rotation-anomaly check, hand the world to the policy, record the trace it
   * produces, and dispatch the intent it returns.
   *
   * `map` is an explicit parameter, not always `this.map`: `faceAngle`
   * deliberately calls `tick(..., undefined)` when a threat is present, so
   * the hazard/spike-avoidance branches (which need a real `map`) are
   * skipped during a bare "face this angle" maneuver — preserved exactly
   * from the original script's call site rather than folded into `this.map`
   * implicitly.
   */
  async tick(player, enemies, mines, navTarget, map, projectiles = []) {
    this.#checkRotationAnomaly(player, Math.atan2(player.dirY, player.dirX));
    const intent = decide(
      { player, enemies, mines, navTarget, map, projectiles },
      this.mineMemory,
      {
        profile: this.profile,
        tuning: this.tuning,
        stepMs: this.stepMs,
        ignoreThreats: this.ignoreThreats,
        simTimeMs: this.simTimeMs,
        lastFireSimTimeMs: this.lastFireSimTimeMs,
        minDecisionMs: this.minDecisionMs,
        logger: this.logger,
        // Only `MultiplayerBot` has a roster id. A bolt is locked to one
        // target for its whole life, so multiplayer must ignore shots aimed at
        // a team-mate; single-player has one player and passes null.
        selfId: this.playerId ?? null,
      },
    );
    // The semi-auto fire clock is per-`Bot`, not per-decision, so the policy
    // reports that it pulled the trigger and the bot owns the timestamp — see
    // `profile.fireCooldownMs`. It must be stamped before `applyAction`
    // advances `simTimeMs`, so the cooldown measures from the decision that
    // fired, exactly as it did when this was all one method.
    // Attribute the rotation check to the decision that produced it. Without
    // this the "[nav-warn] implausible rotation" line reports only the burst
    // `turnBurstMs` *recorded*, which is not the hold actually dispatched —
    // several branches widen `turnBurst` afterwards (see the stall-strafe note
    // in `combatPolicy.mjs`), so the message read as physically impossible
    // ("turned 0.45rad, requested 0ms") and cost real time to explain twice.
    this.#attributeTurnCheck({
      origin: "tick",
      branch: intent.branch ?? intent.trace?.branch ?? "?",
      turnKey: intent.holds?.has("KeyE") ? "KeyE" : intent.holds?.has("KeyQ") ? "KeyQ" : null,
      holds: intent.holds,
      durationMs: intent.durationMs ?? null,
    });
    if (intent.firedSemiAuto) this.lastFireSimTimeMs = this.simTimeMs;
    // Stamped here rather than inside `decide()` on purpose: the errand is the
    // *caller's* context, and `combatPolicy.mjs` must stay free of bot-driving
    // state (see its module doc comment's purity rules).
    if (intent.trace) intent.trace.activity = this.activity;
    this.#recordTrace(intent.trace);
    return this.applyAction(intent);
  }

  /**
   * Every door tile on the level, as `bfsPath`-style `"x,y"` keys — i.e. the
   * `openDoors` set meaning "assume every door can be gotten through". Built
   * once per level; the planned grid is static so it never changes.
   */
  #allDoorTiles() {
    if (this.allDoorTilesCache) return this.allDoorTilesCache;
    const keys = new Set();
    const grid = this.map?.grid ?? [];
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const t = grid[y][x];
        if (t === LOCKED_DOOR_TILE || t === BRANCH_DOOR_TILE) keys.add(`${x},${y}`);
      }
    }
    this.allDoorTilesCache = keys;
    return keys;
  }

  /**
   * Record any door the player is *standing on* as open.
   *
   * `this.map` is a Node-side copy generated before the run; the engine opens
   * a door by mutating its *own* grid to floor (`this.map.grid[y][x] = 0`), so
   * the bot's copy calls that tile a door forever and every later `bfsPath`
   * treats it as a wall. `openedDoors` is the documented compensation for that
   * (see `bfsPath`'s doc comment), but `driveLegs` only ever added doors it
   * opened via an explicit `openDoor` leg — never one the bot simply pushed
   * through while walking a leg or a loot detour.
   *
   * Occupancy is a sound test: `isWall()` rejects a step into a closed door, so
   * standing on a tile the planned map calls a door means that door is open.
   *
   * A key-locked doorway (3) opens as a whole contiguous run — the engine
   * flood-fills it via `doorwayTiles` because a corridor flush along a room
   * wall makes every boundary tile its own door — so mirror that by flooding
   * same-valued neighbours. A branch door (8) is always a single tile.
   */
  #noteDoorUnderFoot(player) {
    const x = Math.floor(player.x);
    const y = Math.floor(player.y);
    const tile = this.map?.grid?.[y]?.[x];
    if (tile !== LOCKED_DOOR_TILE && tile !== BRANCH_DOOR_TILE) return;
    if (this.openedDoors.has(`${x},${y}`)) return;
    const stack = [{ x, y }];
    while (stack.length > 0) {
      const c = stack.pop();
      const k = `${c.x},${c.y}`;
      if (this.openedDoors.has(k)) continue;
      if (this.map.grid[c.y]?.[c.x] !== tile) continue;
      this.openedDoors.add(k);
      if (tile !== LOCKED_DOOR_TILE) continue; // branch doors are single-tile
      stack.push({ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 });
    }
    this.logger.wpDebug?.(`[wpdebug] learned open door run at (${x},${y}) tile=${tile}`);
  }

  // `this.tuning` is passed explicitly to every `combatPolicy` helper, including
  // where the default would have been fine. `this.tuning` is a *new* object
  // (`{ ...DEFAULT_TUNING, ...opts.tuning }`), so an omitted argument silently
  // falls back to the unmodified defaults — which is invisible until an A/B
  // overrides the one key that call site reads, at which point the baseline
  // quietly runs candidate behaviour and the comparison is worthless. Caught
  // exactly there, on Stage 6's `PREEMPTIVE_ENGAGE` switch.
  async driveToward(point, eps, maxTicks) {
    let { player, enemies, mines, projectiles } = await this.readFull();
    // `maxTicks` is a budget for *navigation*, not for wall-clock. A decision
    // spent fighting isn't a decision spent failing to walk somewhere: combat
    // preempts navigation entirely in `tick()`, so a long firefight beside a
    // waypoint would otherwise burn the whole budget and report `stuck`.
    //
    // Observed on `stage06_pipeline.py`: the bot stood near one waypoint for
    // all 600 ticks (30 simulated seconds) killing **12 enemies** — 34 down to
    // 22 remaining, at 100% health with 291 bullets — and the attempt was
    // discarded as stuck. It had walked onto that exact tile moments earlier,
    // so nothing was unreachable.
    //
    // Same principle `detectAnomalies` already applies when it refuses to call
    // a mostly-firing run a stall. `HARD` bounds it so a genuinely endless
    // fight still terminates, and because the relaxation only applies while a
    // threat is actually engaged, a true navigation wedge (no threat — e.g.
    // the door-model and exit-gate wedges) still fails on the original budget.
    let combatTicks = 0;
    const hardCap = maxTicks * this.tuning.COMBAT_TICK_BUDGET_MULTIPLIER;
    for (let t = 0; t < hardCap; t++) {
      if (t - combatTicks >= maxTicks) break;
      if (player.state !== "playing") {
        await this.applyAction(this.#releaseIntent());
        return { state: player.state, reason: player.state };
      }
      if (Math.hypot(point.x - player.x, point.y - player.y) < eps) {
        // Deliberately no stop-and-release here — this fires at every
        // waypoint arrival (BFS waypoints are only 1 tile apart), and
        // releasing every held key here turned ordinary corridor walking
        // into a visible stutter. The next call recomputes its own fresh
        // key set regardless.
        return { state: "playing", reason: "arrived" };
      }
      this.#noteDoorUnderFoot(player);
      // Engaged means `tick()` will fight rather than navigate this decision —
      // exactly `pickThreat`'s own gate, so the two can't disagree.
      if (!this.ignoreThreats && pickThreat(enemies, player, this.profile, this.map, this.tuning)) combatTicks++;
      const prevX = player.x;
      const prevY = player.y;
      ({ player, enemies, mines, projectiles } = await this.tick(player, enemies, mines, point, this.map, projectiles));
      // A BFS-derived waypoint can end up targeting a teleporter pad's exact
      // tile-center; stepping onto it always warps the player away before
      // this loop's own arrival check is satisfied. Detect a jump far
      // larger than any legitimate single tick of movement and treat it the
      // same as arriving.
      if (Math.hypot(player.x - prevX, player.y - prevY) > this.tuning.TELEPORT_JUMP_DETECT_TILES) {
        await this.applyAction(this.#releaseIntent());
        return { state: "playing", reason: "teleported" };
      }
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing", reason: "stuck" };
  }

  async faceAngle(targetAngle, maxTicks) {
    let { player, enemies, mines, projectiles } = await this.readFull();
    for (let t = 0; t < maxTicks; t++) {
      if (player.state !== "playing") return { state: player.state };
      const threat = pickThreat(enemies, player, this.profile, this.map, this.tuning);
      if (!threat) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const delta = angleDelta(currentAngle, targetAngle);
        if (Math.abs(delta) < this.tuning.TURN_MOVE_EPS) {
          await this.applyAction(this.#releaseIntent());
          return { state: "playing" };
        }
        // `tick()` only ever turns the player toward a threat, a mine, or
        // navTarget — none of which apply here (a bare "face this angle"
        // request, used only to square up to a door) — issue the turn
        // directly instead of routing through tick().
        //
        // Pin the turn direction once whenever the needed turn is very
        // close to exactly 180° — tiny floating-point noise in the
        // recomputed angle can otherwise land the result on either side of
        // atan2's branch cut, flipping delta's sign tick to tick and never
        // converging.
        const NEAR_PI_TURN_EPS = 0.05;
        const turnPositive = Math.abs(Math.abs(delta) - Math.PI) < NEAR_PI_TURN_EPS ? true : delta > 0;
        const moveKeys = new Set([turnPositive ? "KeyE" : "KeyQ"]);
        const turnBurst = turnBurstMs(delta, this.profile.rotSpeedMultiplier, currentAngle, {
          tuning: this.tuning,
          stepMs: this.stepMs,
          memory: this.mineMemory,
        });
        // `faceAngle` drives `applyAction` directly in a loop and never calls
        // `#checkRotationAnomaly`, so a check it records survives until some
        // later `tick()` — which is why an elapsed-time field matters here.
        this.#attributeTurnCheck({ origin: "faceAngle", branch: "faceAngle", turnKey: [...moveKeys][0] ?? null, holds: null, durationMs: turnBurst });
        ({ player, enemies, mines } = await this.applyAction(uniformIntent(moveKeys, turnBurst, this.stepMs, {})));
        continue;
      }
      // `map` explicitly omitted here — see `tick`'s doc comment.
      ({ player, enemies, mines, projectiles } = await this.tick(player, enemies, mines, null, undefined, projectiles));
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing" };
  }

  /**
   * Holds KeyW in much smaller steps than the bot's normal movement grain —
   * for the final push against a door. Wall collision rejects an entire
   * tick's movement outright if its destination would overlap the still-
   * solid door (no clamp/slide), so at the bot's normal step size the
   * player can get rejected while still short of the door's reach threshold
   * and never take a smaller partial step to close that last bit of
   * distance. Much finer steps let the player converge tile-by-tile closer
   * to the true collision boundary before a step gets rejected.
   */
  async holdForwardFine(totalMs, stepMs) {
    const steps = Math.ceil(totalMs / stepMs);
    for (let t = 0; t < steps; t++) {
      const { player } = await this.applyAction(uniformIntent(["KeyW"], stepMs, this.stepMs, {}));
      if (player.state !== "playing") return { state: player.state };
    }
    await this.applyAction(this.#releaseIntent());
    return { state: "playing" };
  }

  async readFull() {
    const read = await this.page.evaluate(() => {
      const hooks = window.__codeensteinTestHooks;
      return {
        player: hooks.getPlayerState(),
        enemies: hooks.getEnemies(),
        mines: hooks.getMines(),
        projectiles: hooks.getProjectiles?.() ?? [],
        // One integer, folded into the read the bot already makes — see
        // `#refreshGridIfChanged`. Optional so an older engine build degrades
        // to the previous behaviour instead of throwing.
        gridVersion: hooks.getGridVersion?.() ?? null,
      };
    });
    await this.#refreshGridIfChanged(read.gridVersion);
    return read;
  }

  /**
   * Re-read the engine's wall grid when it has actually changed.
   *
   * The engine mutates its own grid mid-level — a door opens, a secret wall
   * floods away — and bumps `gridVersion` each time. The bot plans against a
   * *copy* taken at level start, so without this an opened door stays a wall
   * in every BFS it runs, forever. That is a recorded wedge: the bot walked
   * through a door and then refused to path back through it
   * (`stage03_legacy_api.php`), and `#noteDoorUnderFoot` exists as a partial
   * workaround — it can only learn about a door the player is personally
   * standing on, never one a *teammate* opened or one that opened as a
   * side effect.
   *
   * Cheap by construction: the version is one integer on a read the bot
   * already performs, and the full grid is refetched only on the handful of
   * decisions where it actually changed.
   */
  async #refreshGridIfChanged(gridVersion) {
    if (!this.tuning.BOT_LIVE_GRID) return;
    if (gridVersion === null || gridVersion === undefined) return;
    if (this.lastGridVersion === gridVersion) return;
    // First observation just records the baseline — the map copy is already
    // correct at level start, so there is nothing to refetch yet.
    const isFirst = this.lastGridVersion === null;
    this.lastGridVersion = gridVersion;
    if (isFirst || !this.map) return;
    const grid = await this.page.evaluate(() => window.__codeensteinTestHooks.getGrid?.() ?? null);
    if (grid) {
      this.map.grid = grid;
      this.gridRefreshes = (this.gridRefreshes ?? 0) + 1;
      this.logger.wpDebug?.(`[wpdebug] grid refreshed (version ${gridVersion}, refresh #${this.gridRefreshes})`);
    }
  }

  async readState() {
    return this.page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
  }
  /**
   * Dispatch one decision's intent.
   *
   * Split in two on purpose. This half is pure bookkeeping — resolve the
   * decision's duration, advance the simulated clock, and turn the intent's
   * per-key holds into the sequence of dispatch phases that realises them.
   * `dispatchSegment` below is the only part that touches the page, and it is
   * the single method `MultiplayerBot` overrides: keeping the segmentation
   * here rather than duplicating it is what stops the two bots' timing from
   * drifting apart again.
   *
   * `intent.durationMs` of `undefined` means "the caller's whole step", which
   * is distinct from any particular number — several branches hold keys without
   * setting a burst at all, and those run for the full window.
   *
   * Today `segmentsFor` always yields exactly one phase, because every branch
   * gives all of its keys the same hold. The plumbing is here so that stops
   * being true without another change to this method.
   */
  async applyAction(intent, { maxDurationMs = this.stepMs } = {}) {
    const durationMs = intent.durationMs ?? maxDurationMs;
    this.simTimeMs += durationMs;
    const phases = segmentsFor(intent.holds, durationMs, this.minPhaseMs);
    let result;
    for (let i = 0; i < phases.length; i++) {
      result = await this.dispatchSegment(phases[i].keys, phases[i].ms, {
        fire: intent.fire,
        useMelee: intent.useMelee,
        weaponSwitchIndex: intent.weaponSwitchIndex,
        isFirst: i === 0,
        isLast: i === phases.length - 1,
      });
    }
    return result;
  }

  /**
   * "Let go of everything and stand still for one full step." An empty holds
   * map releases every key through `dispatchSegment`'s diff, which is how the
   * drive loops stop cleanly at a waypoint or on level end.
   */
  #releaseIntent() {
    return uniformIntent([], undefined, this.stepMs, {});
  }

  /**
   * Shortest phase this bot will dispatch as its own step. Zero here: under the
   * virtual clock a phase boundary costs nothing and lands exactly.
   * `MultiplayerBot` raises it, for the same reason it raises
   * `minDecisionMs` — a phase shorter than the lockstep input delay never
   * arrives before the next one is issued.
   */
  get minPhaseMs() {
    return 0;
  }

  /**
   * The sole Node↔browser control boundary: dispatches real synthetic
   * KeyboardEvents on the canvas element (never the mouse — see the
   * original `generate-default-highscore.mjs` module doc comment for why),
   * with an edge-triggered weapon-switch (`Digit{n+1}`) and a melee-vs-
   * ranged fire key choice (`Space` for quick-melee, `Backquote`
   * otherwise). In realtime mode, skips the virtual-clock pump and instead
   * waits `ms` of *real* time so a human watching a visible browser
   * window can actually follow the action.
   *
   * Movement keys are a *diff* against `window.__botHeldKeys`, so a key that
   * appears in consecutive phases is never released and re-pressed — the
   * engine sees one continuous hold. That is what makes a key simply dropping
   * out of a later phase the correct way to end its hold.
   *
   * The weapon switch fires on the first phase and the fire key is held from
   * the first phase to the last, so a multi-phase decision still reads as one
   * trigger pull rather than several.
   */
  async dispatchSegment(keys, ms, { fire, useMelee, weaponSwitchIndex, isFirst, isLast }) {
    const headed = this.realtime;
    // Capped at `ms` itself: a short precision burst (e.g. `turnBurstMs`
    // rounding a near-complete turn down to a few ms to avoid overshoot)
    // must still land in exactly one sub-step of its own requested size, not
    // get rounded up to a full `recordStepMs` — `__pumpVirtualTime` always
    // advances by at least one whole sub-step, so a sub-step larger than the
    // requested burst would overshoot the very precision these bursts exist
    // to protect. Only a full-length decision (the common case) actually
    // gets subdivided into multiple `recordStepMs`-sized replay frames.
    const subStepMs = Math.min(this.recordStepMs, ms);
    const dispatched = await this.page.evaluate(
      ({ desiredKeys, fire, weaponSwitchCode, useMelee, stepMs, subStepMs, headed, isFirst, isLast }) => {
        const canvas = document.querySelector("canvas");
        const hooks = window.__codeensteinTestHooks;
        const desired = new Set(desiredKeys);
        const held = (window.__botHeldKeys ??= new Set());
        for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        window.__botHeldKeys = desired;
        if (isFirst && weaponSwitchCode) {
          canvas.dispatchEvent(new KeyboardEvent("keydown", { code: weaponSwitchCode }));
          canvas.dispatchEvent(new KeyboardEvent("keyup", { code: weaponSwitchCode }));
        }
        // Fire is held for the *whole* tick, not pressed-and-released before
        // any frame runs — an `auto: true` weapon checks isFireHeld() every
        // frame, so releasing before the pump even starts meant it never
        // fired at all. Fixed by moving the keyup to the end of the tick.
        const fireCode = fire ? (useMelee ? "Space" : "Backquote") : null;
        if (fireCode && isFirst) canvas.dispatchEvent(new KeyboardEvent("keydown", { code: fireCode }));
        if (headed) return { fireCode: isLast ? fireCode : null };
        window.__pumpVirtualTime(stepMs, subStepMs);
        if (fireCode && isLast) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
        return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines(), projectiles: hooks.getProjectiles?.() ?? [] };
      },
      // Resolved here in Node: a digit indexes `NUMBER_KEY_WEAPONS`, not
      // `WEAPONS` — see `numberKeyCodeFor`.
      { desiredKeys: [...keys], fire, weaponSwitchCode: weaponSwitchIndex == null ? null : numberKeyCodeFor(weaponSwitchIndex), useMelee, stepMs: ms, subStepMs, headed, isFirst, isLast },
    );
    if (!headed) return dispatched;
    await this.page.waitForTimeout(ms);
    return this.page.evaluate((fireCode) => {
      const canvas = document.querySelector("canvas");
      if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
      const hooks = window.__codeensteinTestHooks;
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines(), projectiles: hooks.getProjectiles?.() ?? [] };
    }, dispatched.fireCode);
  }
}

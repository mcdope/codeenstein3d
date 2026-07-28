// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The playtest bot's decision core: given a snapshot of the world, decide which
 * keys to hold, for how long, and whether to fire. Extracted from `bot.mjs`,
 * which keeps everything this deliberately has none of — the Playwright page,
 * the drive loops, trace recording, anomaly reporting.
 *
 * ## Why this is a separate module
 *
 * Two reasons, and the second is the one that constrains how it's written.
 *
 * 1. It makes the decision logic testable. `scripts/lib/` had no automated
 *    coverage at all for ~1400 lines of movement and combat behaviour; a pure
 *    function that returns an intent object can be asserted directly, without a
 *    browser. See `combatPolicy.test.mjs`.
 * 2. It is shaped to be liftable into `src/engine/combatPolicy.ts` later, as
 *    the basis of a real in-game deathmatch opponent. `src/` cannot import from
 *    `scripts/`, so the move has to be a copy — and a copy is only mechanical if
 *    this file never acquires a dependency that `src/engine/` couldn't satisfy.
 *
 * ## Rules this file must keep (they exist to keep rule 2 true)
 *
 * - No `page`, no `async`/`await`, no Node builtins, no DOM. Nothing here does
 *   I/O; it takes a snapshot and returns an intent.
 * - **All tuning is injected.** Every function that reads a tuning value takes
 *   it as a parameter rather than closing over `DEFAULT_TUNING`. This also
 *   fixes a real latent bug: `pickThreat`, `pickRangedWeapon`, `rocketAimUnsafe`,
 *   `findDisarmableMine` and `findDangerousMine` previously read
 *   `DEFAULT_TUNING` directly, so a caller's `opts.tuning` override silently did
 *   not reach them. The parameters default to `DEFAULT_TUNING`, so this is
 *   behaviour-neutral today — nothing overrides those particular keys — but it
 *   stops being a trap.
 * - No `Math.random()`, no `Date.now()`, no iteration over unordered
 *   collections, and every `sort` must be total. The bot backs
 *   `generate:default-highscore` and a replayable balancing campaign, so a
 *   decision sequence has to be reproducible from the same inputs. (A deathmatch
 *   opponent wants the opposite, which is why the non-determinism belongs in the
 *   *caller* above `decide()`, not in here.)
 * - Inputs are exactly the shapes the engine's own test hooks already return
 *   (`getBotPlayerState`, `getEnemiesSnapshot`, `getMinesSnapshot`,
 *   `getProjectilesSnapshot`), so the `src/` version needs no adapter layer.
 *
 * ## The intent object
 *
 * `decide()` returns what the bot *wants*, not what it did:
 *
 *   holds        Map of key code -> how many ms that key stays held
 *   durationMs   how long the whole decision lasts; `undefined` means "the
 *                caller's full step"
 *   fire         pull the trigger this decision
 *   useMelee     the trigger is a melee swing (Space) rather than ranged
 *   weaponSwitchIndex  weapon to tap-switch to first, or null
 *   firedSemiAuto      caller should advance its semi-auto fire cooldown
 *   branch, trace      diagnostics for `#recordTrace`
 *
 * `holds` being per-key is the whole point of the shape, but note that **today
 * every key in a given intent carries the same duration**. That is deliberate:
 * this extraction is meant to be exactly behaviour-neutral, so the dispatch it
 * produces is byte-identical to the single-`turnBurst` call it replaced. Letting
 * keys carry *different* durations is the next change, and it is what fixes the
 * bot standing still while shooting — see `segmentsFor`.
 */

// Mirrors src/engine/weapons.ts's WEAPONS array indices — plain literals
// rather than importing that TS module (this is a plain Node script, not
// bundled like the map/parser layer in loadEngineModules.mjs).
export const PISTOL_WEAPON_INDEX = 0;
export const SHOTGUN_WEAPON_INDEX = 1;
export const KNIFE_WEAPON_INDEX = 2;
export const GDB_WEAPON_INDEX = 3;
export const GHIDRA_WEAPON_INDEX = 4;
export const FRIDAY_HOTFIX_WEAPON_INDEX = 5;
export const TOOLCHAIN_WEAPON_INDEX = 6;
export const STARTING_WEAPONS = [PISTOL_WEAPON_INDEX, SHOTGUN_WEAPON_INDEX, KNIFE_WEAPON_INDEX];
// The two ranged weapons WEAPONS.auto=true (mirrors weapons.ts) — fired via
// isFireHeld() and engine-side rate-limited by their own fireIntervalSec
// regardless of how the key is dispatched, unlike the semi-auto ranged
// weapons (pistol/shotgun/ghidra), which have no such cooldown and fire
// exactly once per keydown — see `profile.fireCooldownMs`'s doc comment.
export const AUTO_RANGED_WEAPON_INDICES = new Set([GDB_WEAPON_INDEX, FRIDAY_HOTFIX_WEAPON_INDEX]);
export const HAZARD_TILE = 2; // src/map/types.ts's Tile enum
export const SPIKE_TRAP_TILE = 5; // src/map/types.ts's Tile enum

// Floor for `forwardScanTiles` — the fixed look-ahead the forward hazard/
// spike checks used before sprinting made one decision's travel variable.
// Kept as the minimum so short decision windows behave exactly as before.
const FORWARD_SCAN_MIN_TILES = 0.6;
// Spacing for `segmentBlocked`'s samples along a movement segment. Comfortably
// under one tile, so no single-tile acid strip or spike can fall between two
// samples.
const SEGMENT_SAMPLE_TILES = 0.25;

/**
 * Movement/combat tuning defaults — mirrors of various src/engine/*.ts
 * constants (this is a plain Node script, can't import the bundled TS
 * modules for these particular runtime values) plus a large set of
 * empirically-tuned thresholds, each with its own hard-won bug-fix history
 * (see the functions that read them below). Overridable per-`Bot` instance
 * via the constructor's `opts.tuning` (deep-merged over this object) — a
 * future consumer (e.g. a different harness or a multiplayer bot) can tune
 * without forking this file.
 */
export const DEFAULT_TUNING = {
  VIRTUAL_STEP_MS: 50,
  WATCH_STEP_MS: 130,
  MAX_TICKS_PER_WAYPOINT: 600,
  TURN_MOVE_EPS: 0.2,
  ARRIVE_EPS: 0.15,
  TIGHT_ARRIVE_EPS: 0.05,
  // Any single-tick position jump larger than this is physically impossible
  // via normal movement (max sprint is ~0.32 tiles/tick at VIRTUAL_STEP_MS)
  // and can only mean a teleporter pad fired — see `driveToward`'s doc
  // comment on the jump-detection check that uses this.
  TELEPORT_JUMP_DETECT_TILES: 1.0,
  // See `maybeDetourForLoot`'s doc comment — caps how far (straight-line)
  // the bot will detour for a single uncollected pickup.
  MAX_LOOT_DETOUR_TILES: 20,
  // How far (in tiles) the bot's actual position may be from an upcoming
  // waypoint before it's considered "displaced" and worth a fresh BFS
  // re-plan — see `driveTowardWithReplan`'s doc comment.
  LEG_REPLAN_DRIFT_TILES: 2.5,
  // Mirrors src/engine/engine.ts's ROT_SPEED (rad/sec).
  ENGINE_ROT_SPEED: 2.6,
  // Mirrors src/engine/engine.ts's MOVE_SPEED/SPRINT_MULTIPLIER.
  ENGINE_MOVE_SPEED: 3.2,
  ENGINE_SPRINT_MULTIPLIER: 2.0,
  // How much more rotation than `turnBurstMs`'s own math predicts still
  // counts as "plausible" before `#checkRotationAnomaly` flags it — see that
  // method's doc comment.
  ROTATION_ANOMALY_SLACK: 4,
  DOOR_OPEN_TICKS: 10,
  // Same total push duration as DOOR_OPEN_TICKS * VIRTUAL_STEP_MS (500ms),
  // just in much finer steps — see `holdForwardFine`'s doc comment.
  DOOR_OPEN_FINE_STEP_MS: 5,
  MINE_BLAST_RADIUS: 2.4,
  // Proactive-disarm search radius — see `findDisarmableMine`'s doc comment.
  MINE_DISARM_RANGE: 4.2,
  // Give up on a proactive mine-disarm shot after this many consecutive
  // ticks targeting the *same* mine with no hit — see `decide`'s mine-handling
  // doc comment.
  MINE_TARGET_GIVEUP_TICKS: 40,
  // Once stuck realigning on the same mine this many ticks, force a shot at
  // the current best-effort alignment instead of freezing until the much
  // later full give-up — see `decide`'s mine-realignment comment.
  MINE_REALIGN_STALL_TICKS: 15,
  CRITICAL_HEALTH_FRACTION: 0.2,
  MELEE_RANGE: 1.5,
  // Below this distance, stop trying to close the last bit of distance
  // during an in-progress melee engagement — see `decide`'s melee branch,
  // which actually gates on `max(this, ENGINE_MOVE_SPEED * stepMs/1000)`,
  // not this raw value alone — see that branch's own doc comment for why.
  MELEE_CLOSE_MIN_DISTANCE: 0.4,
  // Below this distance, stop advancing while turning to line up a ranged
  // shot — see `decide`'s ranged-aim branch.
  MIN_RANGED_APPROACH_DISTANCE: 3,
  // Above this angular error, walking forward while still turning toward a
  // route waypoint would move the bot away from where it actually needs to
  // go — see `decide`'s plain-navigation branch.
  MAX_WALK_WHILE_TURNING_RAD: 0.35,
  // Combat can deadlock against wall geometry — once a threat engagement has
  // produced no actual attack for this many consecutive ticks with position
  // frozen, nudge sideways instead of just re-aiming in place.
  COMBAT_STALL_TICKS_THRESHOLD: 40,
  COMBAT_STALL_STRAFE_FLIP_TICKS: 20,
  CRITICAL_STALL_TICKS_THRESHOLD: 15,
  CRITICAL_STALL_STRAFE_FLIP_TICKS: 10,
  // How close two aggroed enemies have to be to each other to count as
  // "clustered" — see `pickRangedWeapon`.
  CLUSTER_RADIUS: 3,
  // Rockets splash the shooter too — never select ghidra within this
  // distance regardless of profile. See `rocketAimUnsafe`.
  ROCKET_SAFE_DISTANCE: 4,
  // Mirrors src/engine/rockets.ts's ROCKET_ENEMY_TRIGGER_RADIUS.
  ROCKET_ENEMY_TRIGGER_RADIUS: 0.4,
  // Matches Friday Hotfix's real maxRange (weapons.ts).
  FRIDAY_HOTFIX_MAX_RANGE: 3.5,
  // How far a clustered threat needs to be before rocket splash is worth
  // preferring — see `pickRangedWeapon`.
  ROCKET_CLUSTER_MIN_DIST: 5, // ROCKET_SAFE_DISTANCE + 1
  // MINE_REALIGN_EPS assumes precise per-tick rotation, only exact under a
  // virtual clock — see `decide`'s mine-realignment comment for why this
  // matters more in headless mode.
  MINE_REALIGN_EPS: 0.01,
  // A mine has to be somewhere in the forward hemisphere (90° either side of
  // the intended heading) to be worth a proactive detour — see
  // `findDisarmableMine`.
  MINE_DISARM_MAX_ANGLE_FROM_PATH: Math.PI / 2,
  // How many consecutive engaged decisions the combat strafe runs before
  // reversing. This is also what bounds the manoeuvre: at walking speed a
  // half-period covers `ENGINE_MOVE_SPEED * FLIP_TICKS * stepMs/1000` tiles
  // (~1.3 at the headless step), so the bot oscillates around its position
  // instead of drifting off the route — no separate displacement cap needed.
  COMBAT_STRAFE_FLIP_TICKS: 8,
  // Don't dance inside melee range: at knife distance the useful move is to
  // close and swing, and sidestepping there just walks circles around a target
  // the bot is trying to hit.
  COMBAT_STRAFE_MIN_DISTANCE: 1.5,
  // How far ahead the strafe safety check looks, regardless of how little
  // ground one decision actually covers. A single lateral step is only
  // ~0.16 tiles at the headless window — far less than the half-tile to the
  // near edge of the neighbouring tile — so a check scoped to the step alone
  // would never see acid until the bot was already standing in it, and would
  // never see a wall at all. Blocking on a wall this early is deliberate too:
  // a strafe into geometry is rejected wholesale by collision, so it buys no
  // dodge and shows up as a `heldKeyNoMovement` anomaly for free.
  COMBAT_STRAFE_LOOKAHEAD_TILES: 0.6,
};

/** Tiles a lateral step must never cross. Mirrors `pathfind.mjs`'s own
 * `BLOCKED_TILES` (wall / locked door / unopened secret / lore / branch door) —
 * deliberately wider than `isWallTile`'s `{1,6,7}`, since a closed door is not
 * something to strafe into even though a bullet ignores it. */
const STRAFE_BLOCKED_TILES = new Set([1, 3, 6, 7, 8]);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function angleDelta(current, target) {
  const d = target - current;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * The strafe key ("KeyD"/right or "KeyA"/left) that moves the player toward
 * a target requiring `delta` radians of turn to face — lets the bot move
 * diagonally instead of straight-ahead-only while turning.
 *
 * **Confirmed regression if used more widely.** An A/B test found
 * Casual/normal's level-2 death rate jumped from 0% to 72% once diagonal
 * movement was added to every turn-and-move branch. Reverted from every other
 * branch and kept only in plain navigation. The likely mechanism is
 * `engine.ts`'s `diagonalScale = Math.SQRT1_2`: holding a strafe key next to
 * a forward key keeps total speed constant but cuts the *forward* component by
 * 29%, and in the hazard-crossing and critical-health branches the forward
 * axis is the survival axis.
 */
export function diagonalStrafeKey(delta) {
  return delta > 0 ? "KeyD" : "KeyA";
}

export function isHazardAt(map, x, y) {
  return map.grid[Math.floor(y)]?.[Math.floor(x)] === HAZARD_TILE;
}

/** Mirrors src/engine/traps.ts's isSpikeActive — whether the spike trap (if
 * any) at (x,y) is in its damaging half of the cycle at `levelTime`. */
export function activeSpikeAt(map, x, y, levelTime) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const trap = map.spikeTraps.find((t) => t.x === cx && t.y === cy);
  if (!trap) return false;
  const cyclePos = (levelTime + trap.phase) % trap.period;
  return cyclePos >= trap.period / 2;
}

/** Mirrors the engine's own hasLineOfSight (src/engine/enemyAi.ts): samples
 * every ~0.1 tiles along the line and fails if any sample lands on a
 * wall/unopened-secret/lore tile. */
export function hasLineOfSight(map, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.1);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallTile(map, x0 + dx * t, y0 + dy * t)) return false;
  }
  return true;
}

export function isWallTile(map, x, y) {
  const tile = map.grid[Math.floor(y)]?.[Math.floor(x)];
  return tile === undefined || tile === 1 || tile === 6 || tile === 7;
}

// ---------------------------------------------------------------------------
// Burst timing
// ---------------------------------------------------------------------------

/**
 * How long to hold a turn key for a *pure* turn so it lands as close as
 * possible to `deltaAngle` without overshooting past it — see the original
 * module's doc comment for the oscillation bug this fixes.
 *
 * Records `pendingTurnCheck` on `memory` for `Bot#checkRotationAnomaly` to
 * compare against on the next call. That side effect has to survive the move
 * out of the `Bot` class: the anomaly detector goes silently blind without it.
 */
export function turnBurstMs(deltaAngle, rotSpeedMultiplier, currentAngle, { tuning, stepMs, memory }) {
  const rate = tuning.ENGINE_ROT_SPEED * rotSpeedMultiplier; // rad/sec
  const neededMs = (Math.abs(deltaAngle) / rate) * 1000;
  if (memory) {
    memory.pendingTurnCheck = { beforeDir: currentAngle, turnBurstMs: Math.min(stepMs, neededMs), rotSpeedMultiplier };
  }
  return Math.max(1, Math.min(stepMs, neededMs));
}

/** Straight-line-movement counterpart to `turnBurstMs` — caps how long a
 * movement key is held so it doesn't overshoot past a small arrival
 * tolerance (see the original module's doc comment for the hazard-tile
 * oscillation bug this fixes). */
export function moveBurstMs(dist, sprinting, { tuning, stepMs }) {
  const speed = tuning.ENGINE_MOVE_SPEED * (sprinting ? tuning.ENGINE_SPRINT_MULTIPLIER : 1); // tiles/sec
  const neededMs = (dist / speed) * 1000;
  return Math.max(1, Math.min(stepMs, neededMs));
}

/**
 * How far ahead a forward-safety check has to look, in tiles: one whole
 * decision's worth of real travel, floored at the historical fixed 0.6.
 *
 * The fixed value was safe only while the bot walked. Sprinting doubles the
 * distance a single decision covers, and the decision window itself varies by
 * an order of magnitude — ~0.32 tiles of sprint at `VIRTUAL_STEP_MS` (50ms, so
 * the floor still governs), 0.83 headed at `WATCH_STEP_MS`, and 2.56 at
 * `MultiplayerBot`'s 400ms window. Past the floor, a fixed 0.6-tile probe would
 * clear a spike the bot then sprints straight onto within the same decision.
 */
export function forwardScanTiles(sprinting, { tuning, stepMs }) {
  const speed = tuning.ENGINE_MOVE_SPEED * (sprinting ? tuning.ENGINE_SPRINT_MULTIPLIER : 1);
  return Math.max(FORWARD_SCAN_MIN_TILES, speed * (stepMs / 1000));
}

/**
 * Whether the straight segment from `from` along unit vector `dir` for `dist`
 * tiles crosses anything the bot must not walk into.
 *
 * Samples the whole segment rather than only its endpoint. A 1-tile acid strip
 * or a single spike tile is narrower than a sprint step, so an endpoint-only
 * check happily steps *through* it and takes the damage anyway.
 *
 * Spikes are tested at both `levelTime` and the time the bot would arrive: a
 * trap's damaging half is a timed cycle, so "safe right now" and "safe when I
 * get there" are different questions and only the second one matters.
 *
 * `hazard` is opt-out because acid is not categorically a thing to avoid.
 * `planRoute` already prices a hazard tile at 25x a floor tile, so a route that
 * crosses acid crosses it because every alternative was worse — and once you
 * are committed to crossing, moving *faster* is strictly better, which is why
 * the hazard-crossing branch sprints. Callers making an optional move (a dodge,
 * a loot detour) treat acid as blocking; callers following a committed route
 * pass `hazard: false`.
 */
export function segmentBlocked(map, from, dir, dist, levelTime, { tuning, hazard = true }) {
  if (!map || dist <= 0) return false;
  const arriveSec = dist / (tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER);
  const steps = Math.max(1, Math.ceil(dist / SEGMENT_SAMPLE_TILES));
  for (let i = 1; i <= steps; i++) {
    const t = (dist * i) / steps;
    const sx = from.x + dir.x * t;
    const sy = from.y + dir.y * t;
    if (hazard && isHazardAt(map, sx, sy)) return true;
    if (activeSpikeAt(map, sx, sy, levelTime)) return true;
    if (activeSpikeAt(map, sx, sy, levelTime + arriveSec)) return true;
  }
  return false;
}

/**
 * Whether a lateral step of `travelDist` tiles in `key`'s direction is safe to
 * take.
 *
 * A strafe is optional movement — unlike a committed route leg, there is never
 * a reason to accept damage for one — so this treats acid as blocking, the
 * opposite of the sprint gate's `hazard: false`.
 *
 * Checks the whole segment rather than the endpoint (a one-tile acid strip is
 * narrower than a step), and spikes at both now and arrival time, exactly as
 * `segmentBlocked` does. Walls are checked separately against
 * `STRAFE_BLOCKED_TILES`, which `segmentBlocked` doesn't cover because the
 * callers it was written for could never walk into one.
 *
 * With no map (the shape `faceAngle` decides with) there is nothing to test
 * against, so this reports unsafe rather than guessing — an unchecked strafe is
 * exactly the kind of thing that walks into acid.
 */
export function strafeIsSafe(map, player, key, travelDist, levelTime, { tuning }) {
  if (!map || travelDist <= 0) return false;
  // Right vector, mirroring `Player.strafe`: KeyD is +right, KeyA is -right.
  const sign = key === "KeyD" ? 1 : -1;
  const dir = { x: -player.dirY * sign, y: player.dirX * sign };
  if (segmentBlocked(map, player, dir, travelDist, levelTime, { tuning })) return false;
  const steps = Math.max(1, Math.ceil(travelDist / SEGMENT_SAMPLE_TILES));
  for (let i = 1; i <= steps; i++) {
    const t = (travelDist * i) / steps;
    const tile = map.grid[Math.floor(player.y + dir.y * t)]?.[Math.floor(player.x + dir.x * t)];
    if (tile === undefined || STRAFE_BLOCKED_TILES.has(tile)) return false;
  }
  return true;
}

/**
 * Which way to sidestep while shooting, or `null` to stand still.
 *
 * Enemy bolts are aimed at wherever the target stood when the trigger was
 * pulled and never re-aim (`projectiles.ts`), so *any* sustained lateral motion
 * converts a hit into a miss — the bot doesn't need to see the bolt to benefit,
 * which is why this is worth doing before real projectile-aware dodging.
 *
 * The direction comes from a tick counter rather than a random draw, both
 * because this module must stay deterministic and because a coin flip would
 * average out to standing still. Flipping on a fixed period also bounds the
 * excursion by construction — see `COMBAT_STRAFE_FLIP_TICKS`.
 *
 * Tries the preferred side, then the other, then gives up: a bot pressed
 * against a wall should shoot rather than grind into it.
 */
export function combatStrafeKey(ticks, map, player, travelDist, levelTime, { tuning }) {
  const preferred = Math.floor(ticks / tuning.COMBAT_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA";
  const other = preferred === "KeyD" ? "KeyA" : "KeyD";
  if (strafeIsSafe(map, player, preferred, travelDist, levelTime, { tuning })) return preferred;
  if (strafeIsSafe(map, player, other, travelDist, levelTime, { tuning })) return other;
  return null;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Aggressive targeting: prioritize whichever aggroed enemy can be finished
 * off fastest (already in melee range, or an Edge Case) over strictly
 * whoever's nearest — thins numerous, individually weak attackers first
 * rather than spending 3-6s locked onto one tankier enemy while a swarm
 * lands free chip damage. Falls back to nearest-first among equally "quick"
 * (or equally "not quick") candidates, with a visible-enemy tiebreak
 * (occluded ones can't be engaged immediately regardless of distance).
 *
 * `map` is optional (some callers don't have one on hand) — when omitted,
 * every candidate is treated as visible, i.e. the original distance/quick-
 * kill-only ranking, unchanged.
 *
 * The final `a.i - b.i` tiebreak makes the ordering *total* rather than
 * relying on `Array.prototype.sort` stability. Determinism here is a hard
 * requirement (see this module's doc comment), and leaning on an
 * implementation's stability guarantee for it is the kind of thing that
 * silently stops being true.
 */
export function pickThreat(enemies, player, profile, map, tuning = DEFAULT_TUNING) {
  // `i` is the enemy's index in the engine's own `this.enemies` array
  // (stable for a whole level) — used by `decide` to recognize "same
  // enemy as last tick" for the last-visible-position freeze.
  const candidates = enemies
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.alive && e.aggroed)
    .map((e) => ({
      ...e,
      dist: Math.hypot(e.x - player.x, e.y - player.y),
      visible: !map || hasLineOfSight(map, player.x, player.y, e.x, e.y),
    }))
    .filter((e) => e.dist < profile.engageRadius);
  candidates.sort((a, b) => {
    const aQuick = a.dist <= tuning.MELEE_RANGE || a.edgeCase;
    const bQuick = b.dist <= tuning.MELEE_RANGE || b.edgeCase;
    if (aQuick !== bQuick) return aQuick ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.i - b.i;
  });
  return candidates[0];
}

/**
 * A mine only counts as "disarmable from here" if there's a clear shot —
 * `visible` only means the mine has been spotted, not that it's actually
 * hittable from the player's current position. Also excludes mines well off
 * to the side of or behind `navTarget`'s direction (see
 * MINE_DISARM_MAX_ANGLE_FROM_PATH) — a mine this far off-path isn't a real
 * threat to the route.
 *
 * `reactionBufferTiles` (default 0) shifts *both* ends of the eligible
 * distance window outward by the same amount as `findDangerousMine`'s own
 * buffer, rather than just raising the lower bound alone — the designed
 * "disarm zone" width (`MINE_DISARM_RANGE - MINE_BLAST_RADIUS`) stays the
 * same, just moved farther out. Widening only the lower bound would shrink
 * that zone every time the buffer grows, and at a real decision window long
 * enough (`MultiplayerBot`'s own `DEFAULT_STEP_MS`), it can collapse to
 * nothing — confirmed directly: `findDangerousMine`'s own widened-but-
 * unshifted-here buffer first fix made every mine reachable from a real
 * multiplayer decision window count as "dangerous," so the bot never
 * disarmed one again and got stuck retreating from a mine the route
 * genuinely needed it to clear.
 */
export function findDisarmableMine(mines, player, abandoned, map, navTarget, reactionBufferTiles = 0, tuning = DEFAULT_TUNING) {
  const navAngle = navTarget ? Math.atan2(navTarget.y - player.y, navTarget.x - player.x) : null;
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist > tuning.MINE_BLAST_RADIUS + reactionBufferTiles && m.dist <= tuning.MINE_DISARM_RANGE + reactionBufferTiles)
    .filter((m) => hasLineOfSight(map, player.x, player.y, m.x, m.y))
    .filter((m) => {
      if (navAngle === null) return true;
      const mineAngle = Math.atan2(m.y - player.y, m.x - player.x);
      return Math.abs(angleDelta(navAngle, mineAngle)) <= tuning.MINE_DISARM_MAX_ANGLE_FROM_PATH;
    })
    .sort((a, b) => a.dist - b.dist)[0];
}

/**
 * A visible mine close enough to be actively dangerous (inside its own blast
 * radius, plus `reactionBufferTiles`) rather than just a target to line up a
 * shot on — "stop, back up" comes before "shoot" (see `decide`'s
 * mine-handling doc comment).
 *
 * `reactionBufferTiles` (default 0, i.e. exactly `MINE_BLAST_RADIUS`) exists
 * because a mine's own fuse (`MINE_FUSE_SECONDS`, `traps.ts`) ticks in real
 * time regardless of how often this function gets called — a decision-window
 * long enough to cover more real ground than the gap between "just outside
 * blast radius" and "already caught in it" leaves the bot with no chance to
 * react between one decision seeing "safe" and a mine detonating mid-window.
 * Confirmed directly against `MultiplayerBot`'s much longer real decision
 * window (`DEFAULT_STEP_MS`, 400ms vs. single-player's own realtime
 * `WATCH_STEP_MS`, 130ms): a bot standing 3-4 tiles from its own *disarm*
 * target (correctly beyond `MINE_BLAST_RADIUS` from that one) still took real
 * splash damage from a *different*, closer mine in the same cluster that had
 * already been armed and went off entirely within one held decision, with no
 * chance to retreat from it first. Callers pass their own real
 * `ENGINE_MOVE_SPEED * ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000)` — at
 * single-player's own short decision windows this rounds to well under a
 * tile, a harmless no-op widening; only a caller with a long real decision
 * window (multiplayer) gets a buffer that actually matters.
 */
export function findDangerousMine(mines, player, abandoned, reactionBufferTiles = 0, tuning = DEFAULT_TUNING) {
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist <= tuning.MINE_BLAST_RADIUS + reactionBufferTiles)
    .sort((a, b) => a.dist - b.dist)[0];
}

// ---------------------------------------------------------------------------
// Weapon selection
// ---------------------------------------------------------------------------

export function hasAmmoFor(player, weaponIndex) {
  if (weaponIndex === 0 || weaponIndex === 1) return player.ammo.bullets > 0;
  if (weaponIndex === GDB_WEAPON_INDEX) return player.ammo.smg > 0;
  if (weaponIndex === GHIDRA_WEAPON_INDEX) return player.ammo.rockets > 0;
  if (weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX) return player.ammo.gas > 0;
  return true;
}

/**
 * Distance along the player's current firing ray to the nearest point where
 * an in-flight rocket would actually detonate against a living enemy — not
 * just the intended target's own distance (a rocket explodes on the FIRST
 * living enemy it comes within ROCKET_ENEMY_TRIGGER_RADIUS of, tracked or
 * not). Deliberately doesn't account for walls between the player and an
 * in-path enemy — a rare enough edge case not worth the added complexity.
 */
export function nearestRocketDetonationDistance(player, enemies, tuning = DEFAULT_TUNING) {
  let nearest = Infinity;
  const dirX = player.dirX;
  const dirY = player.dirY;
  const triggerSq = tuning.ROCKET_ENEMY_TRIGGER_RADIUS * tuning.ROCKET_ENEMY_TRIGGER_RADIUS;
  for (const e of enemies) {
    if (!e.alive) continue;
    const ex = e.x - player.x;
    const ey = e.y - player.y;
    const t = ex * dirX + ey * dirY; // distance along the firing ray to closest approach
    if (t < 0 || t >= nearest) continue; // behind the player, or already not the closest
    const perpSq = ex * ex + ey * ey - t * t;
    if (perpSq <= triggerSq) nearest = t;
  }
  return nearest;
}

/**
 * True if firing a rocket right now is unsafe: (1) a rocket has zero
 * interaction with mines — never fire one at a mine target, at any
 * distance; (2) the intended target or some other untracked living enemy
 * sits close enough to the flight path to trigger an earlier, closer
 * detonation than expected.
 */
export function rocketAimUnsafe(player, enemies, aimDist, isMineTarget, tuning = DEFAULT_TUNING) {
  if (isMineTarget) return true;
  if (aimDist !== null && aimDist < tuning.ROCKET_SAFE_DISTANCE) return true;
  return nearestRocketDetonationDistance(player, enemies, tuning) < tuning.ROCKET_SAFE_DISTANCE;
}

/**
 * Best ranged weapon for the current situation, not just a fixed
 * per-profile preference order. Once 2+ aggroed enemies are clustered near
 * the current threat, picks a weapon suited to the cluster's distance:
 * close → Friday Hotfix (falling back to shotgun), distant (and only for
 * profiles confident enough to use rockets this way) → Ghidra, everything
 * else → shotgun. Falls back to `profile.weaponPriority` otherwise. Never
 * selects ghidra within ROCKET_SAFE_DISTANCE regardless of source. Never
 * returns a melee index.
 */
export function pickRangedWeapon(player, profile, enemies, threat, mineTarget, tuning = DEFAULT_TUNING) {
  if (threat) {
    const clusterCount = enemies.filter((e) => e.alive && e.aggroed && Math.hypot(e.x - threat.x, e.y - threat.y) <= tuning.CLUSTER_RADIUS).length;
    if (clusterCount >= 2) {
      if (threat.dist <= tuning.FRIDAY_HOTFIX_MAX_RANGE) {
        if (player.ownedWeapons.includes(FRIDAY_HOTFIX_WEAPON_INDEX) && hasAmmoFor(player, FRIDAY_HOTFIX_WEAPON_INDEX)) {
          return player.weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX ? null : FRIDAY_HOTFIX_WEAPON_INDEX;
        }
      } else if (
        threat.dist >= tuning.ROCKET_CLUSTER_MIN_DIST &&
        profile.rocketForDistantClusters &&
        player.ownedWeapons.includes(GHIDRA_WEAPON_INDEX) &&
        hasAmmoFor(player, GHIDRA_WEAPON_INDEX) &&
        !rocketAimUnsafe(player, enemies, threat.dist, false, tuning)
      ) {
        return player.weaponIndex === GHIDRA_WEAPON_INDEX ? null : GHIDRA_WEAPON_INDEX;
      }
      if (player.ownedWeapons.includes(1) && hasAmmoFor(player, 1)) {
        return player.weaponIndex === 1 ? null : 1; // Regex Shotgun
      }
    }
  }
  // Ghidra is excluded outright whenever the aim source is a mine, not just
  // when it's judged "too close" (a rocket flies straight through a mine to
  // an unaccounted-for wall — see `rocketAimUnsafe`'s doc comment).
  const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
  for (const idx of profile.weaponPriority) {
    if (idx === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget), tuning)) continue;
    if (!player.ownedWeapons.includes(idx)) continue;
    if (!hasAmmoFor(player, idx)) continue;
    return player.weaponIndex === idx ? null : idx;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intent construction and segmentation
// ---------------------------------------------------------------------------

/**
 * Build an intent from a key set that all shares one duration — the shape every
 * branch produces today, and the reason this extraction is behaviour-neutral.
 *
 * `durationMs === undefined` means "hold for the caller's whole step", which is
 * distinct from any specific number: several branches leave the burst unset
 * while still holding keys (the ranged approach with no turn key, for one), and
 * those hold for the entire window.
 */
export function uniformIntent(keys, durationMs, stepMs, rest) {
  const hold = durationMs ?? stepMs;
  const holds = new Map();
  for (const key of keys) holds.set(key, hold);
  return { holds, durationMs, fire: false, useMelee: false, weaponSwitchIndex: null, firedSemiAuto: false, ...rest };
}

/**
 * Split an intent's per-key holds into the sequence of dispatch phases that
 * realises them, given the decision's total duration.
 *
 * A key whose hold is shorter than the decision simply stops appearing in later
 * phases; the caller's held-key diff then releases it for free. This is what
 * lets a turn key finish early while a movement key keeps going — the thing that
 * makes "turn and move at once" expressible at all.
 *
 * **Today this always returns exactly one phase**, because every branch still
 * gives all its keys the same duration. That is the point: the mechanism lands
 * without changing a single dispatch, so a later behaviour change is measured
 * on its own.
 *
 * `minPhaseMs` is a floor, not a nicety. In multiplayer a phase shorter than the
 * lockstep input delay never lands before the next one is issued — the
 * documented "spin in place, compounding stale turns" failure. Rather than
 * risk it, a decision that would produce any phase under the floor collapses
 * back to a single phase holding every key for the *shortest* hold, which is
 * exactly the pre-existing behaviour. So multiplayer can never be made worse
 * than it already is by this mechanism, only left alone.
 */
export function segmentsFor(holds, durationMs, minPhaseMs = 0) {
  if (!holds || holds.size === 0) return [{ keys: [], ms: durationMs }];
  const allKeys = [...holds.keys()];
  const cuts = [...new Set([...holds.values()].filter((v) => v > 0 && v < durationMs))].sort((a, b) => a - b);
  if (cuts.length === 0) return [{ keys: allKeys, ms: durationMs }];

  const phases = [];
  let prev = 0;
  for (const cut of [...cuts, durationMs]) {
    const ms = cut - prev;
    if (ms <= 0) continue;
    phases.push({ keys: [...holds.entries()].filter(([, v]) => v > prev).map(([k]) => k), ms });
    prev = cut;
  }
  if (minPhaseMs > 0 && phases.some((p) => p.ms < minPhaseMs)) {
    return [{ keys: allKeys, ms: Math.min(durationMs, ...holds.values()) }];
  }
  return phases;
}

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

/**
 * One decision: combat (or proactive mine-disarm) always preempts navigation.
 * Hazard-crossing suppresses combat entirely rather than detouring to a "safe
 * tile" (the nearest safe edge tile is often not on the way to the real
 * destination).
 *
 * `world.map` may be absent: `Bot#faceAngle` deliberately decides with no map
 * when a threat is present, so the hazard/spike-avoidance branches (which need
 * a real map) are skipped during a bare "face this angle" maneuver.
 *
 * `memory` is the caller's per-level scratch object, mutated in place — mine
 * give-up bookkeeping, the last-visible-threat freeze, the stall counters, and
 * `turnBurstMs`'s rotation-anomaly handoff all live there.
 */
export function decide(world, memory, config) {
  const { player, enemies, mines, navTarget, map } = world;
  const { profile, tuning, stepMs, ignoreThreats, simTimeMs, lastFireSimTimeMs, minDecisionMs = 0, logger } = config;
  const burstCtx = { tuning, stepMs, memory };
  const moveCtx = { tuning, stepMs };

  // Currently standing on a damaging ground tile: don't stop to fight —
  // just keep marching toward wherever the bot was already headed.
  if (map && navTarget && (isHazardAt(map, player.x, player.y) || activeSpikeAt(map, player.x, player.y, player.levelTime))) {
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const dist = Math.hypot(navTarget.x - player.x, navTarget.y - player.y);
    const moveKeys = new Set(["KeyW", "ShiftLeft"]);
    let turnBurst;
    if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      // Deliberately no `diagonalStrafeKey` here — see its doc comment's
      // "confirmed regression" note. Reverted from every branch except
      // plain navigation.
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
    } else {
      turnBurst = moveBurstMs(dist, true, moveCtx);
    }
    return uniformIntent(moveKeys, turnBurst, stepMs, {
      branch: "hazard",
      trace: { branch: "hazard", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
    });
  }

  const threat = ignoreThreats ? null : pickThreat(enemies, player, profile, map, tuning);

  // Critical health: break contact instead of trading hits.
  if (threat && player.healthFraction < tuning.CRITICAL_HEALTH_FRACTION) {
    const currentAngle = Math.atan2(player.dirY, player.dirX);
    const awayAngle = Math.atan2(player.y - threat.y, player.x - threat.x);
    const delta = angleDelta(currentAngle, awayAngle);
    const moveKeys = new Set(["KeyW", "ShiftLeft"]);
    if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
    }
    // A blocked "away" vector (cornered retreat) still won't move the
    // player — this branch returns before the shared end-of-decision
    // combatStallTicks bookkeeping ever runs, so it needs its own
    // same-position tracking.
    if (memory) {
      const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
      if (memory.criticalStallPos === posKey) {
        memory.criticalStallTicks = (memory.criticalStallTicks ?? 0) + 1;
      } else {
        memory.criticalStallPos = posKey;
        memory.criticalStallTicks = 0;
      }
      if (memory.criticalStallTicks >= tuning.CRITICAL_STALL_TICKS_THRESHOLD) {
        moveKeys.delete("KeyD");
        moveKeys.delete("KeyA");
        moveKeys.add(Math.floor(memory.criticalStallTicks / tuning.CRITICAL_STALL_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA");
      }
    }
    // Deliberately not `turnBurstMs` here — fleeing has no narrow
    // hit-window to protect against overshoot; a full sprint step every
    // tick converges toward genuinely-away without stalling.
    const turnBurst = moveBurstMs(10, true, moveCtx);
    return uniformIntent(moveKeys, turnBurst, stepMs, {
      branch: "criticalHealth",
      trace: { branch: "criticalHealth", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: threat.dist, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
    });
  }

  // See `findDangerousMine`'s own doc comment for why this buffer exists —
  // a real, decision-window-scaled reaction margin, not a fixed tile count.
  // Shared by both mine checks below so the same shift applies to each end
  // of `findDisarmableMine`'s own eligible-distance window too (see its own
  // doc comment on why only widening one side of that window is wrong).
  const mineReactionBufferTiles = tuning.ENGINE_MOVE_SPEED * tuning.ENGINE_SPRINT_MULTIPLIER * (stepMs / 1000);

  // Proper mine handling: stop, back up out of blast range, shoot it, then
  // continue. Backing away takes priority over shooting (below) since you
  // can't line up a safe shot from inside your own target's blast radius.
  if (!threat && profile.proactiveMineDisarm) {
    const dangerMine = findDangerousMine(mines, player, memory?.abandoned, mineReactionBufferTiles, tuning);
    if (dangerMine) {
      const key = `${dangerMine.x},${dangerMine.y}`;
      let gaveUp = false;
      if (memory) {
        memory.retreatTicks = memory.retreatKey === key ? memory.retreatTicks + 1 : 1;
        memory.retreatKey = key;
        gaveUp = memory.retreatTicks > tuning.MINE_TARGET_GIVEUP_TICKS;
        if (gaveUp) memory.abandoned.add(key); // e.g. wedged against a wall — stop trying, in either mode, for the rest of the level
      }
      if (!gaveUp) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const awayAngle = Math.atan2(player.y - dangerMine.y, player.x - dangerMine.x);
        const delta = angleDelta(currentAngle, awayAngle);
        const moveKeys = new Set(["KeyW"]);
        let turnBurst;
        if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
        } else {
          turnBurst = moveBurstMs(10, false, moveCtx);
        }
        return uniformIntent(moveKeys, turnBurst, stepMs, {
          branch: "mineRetreat",
          trace: { branch: "mineRetreat", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: dangerMine.dist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false },
        });
      }
      // else: gave up retreating — fall through to normal navigation below.
    }
  }

  let mineTarget =
    !threat && profile.proactiveMineDisarm && map
      ? findDisarmableMine(mines, player, memory?.abandoned, map, navTarget, mineReactionBufferTiles, tuning)
      : null;
  if (mineTarget && memory) {
    const key = `${mineTarget.x},${mineTarget.y}`;
    memory.shootTicks = memory.shootKey === key ? memory.shootTicks + 1 : 1;
    memory.shootKey = key;
    if (memory.shootTicks > tuning.MINE_TARGET_GIVEUP_TICKS) {
      memory.abandoned.add(key); // e.g. a wall blocks line of fire — stop trying, in either mode, for the rest of the level
      mineTarget = null;
    }
  }
  // A threat's aggro is sticky, but `threat.x/y` is live even while
  // occluded — freeze the aim at wherever the threat was last actually
  // seen while occluded, only resuming live tracking once visible again.
  let threatAim = threat;
  if (threat && memory) {
    if (threat.visible) {
      memory.lastVisibleThreat = { i: threat.i, x: threat.x, y: threat.y };
    } else if (memory.lastVisibleThreat?.i === threat.i) {
      threatAim = memory.lastVisibleThreat;
    }
    // else: aggroed without this specific enemy ever having been seen yet
    // — no memory to fall back on, aim at the live position.
  }
  const aimTarget = threatAim ?? mineTarget;
  // Read the stall counter as last decision left it (updated at the bottom of
  // this function, after `fire` is known).
  const stallStrafeKey =
    threat && memory && (memory.combatStallTicks ?? 0) >= tuning.COMBAT_STALL_TICKS_THRESHOLD
      ? Math.floor(memory.combatStallTicks / tuning.COMBAT_STALL_STRAFE_FLIP_TICKS) % 2 === 0
        ? "KeyD"
        : "KeyA"
      : null;

  // Read as last decision left it, same as `stallStrafeKey` above — the
  // counter is advanced at the bottom of this function.
  const combatStrafeTicks = memory?.combatStrafeTicks ?? 0;

  const currentAngle = Math.atan2(player.dirY, player.dirX);
  const moveKeys = new Set();
  let turnBurst;
  let fire = false;
  // True when the bot was aimed, aligned, and otherwise ready to fire, but
  // held back purely by `profile.fireCooldownMs` — a legitimate reason to
  // sit still, distinct from being stuck (see `detectAnomalies`'s
  // `mostlyFiring`/`mostlyEngaged` exclusion, which needs this since a
  // human-paced fire rate now means most ticks in a real firefight don't
  // actually pull the trigger).
  let fireOnCooldown = false;
  let weaponSwitch = null;
  let firedSemiAuto = false;
  logger?.debugNav?.(
    `[nav] pos=(${player.x.toFixed(2)},${player.y.toFixed(2)}) dir=${currentAngle.toFixed(2)} hpFrac=${player.healthFraction.toFixed(2)} ` +
      `threat=${threat ? `(${threat.x.toFixed(1)},${threat.y.toFixed(1)},dist=${threat.dist.toFixed(1)})` : "none"} ` +
      `mineTarget=${mineTarget ? `(${mineTarget.x},${mineTarget.y})` : "none"} navTarget=${navTarget ? `(${navTarget.x.toFixed(2)},${navTarget.y.toFixed(2)})` : "none"} ` +
      `weaponIndex=${player.weaponIndex} ammo=${JSON.stringify(player.ammo)} owned=${JSON.stringify(player.ownedWeapons)}`,
  );
  let useMelee = false;
  let waitingOnSpike = false;

  if (aimTarget) {
    const targetAngle = Math.atan2(aimTarget.y - player.y, aimTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    // Melee-in-range is a universal tactical choice for every profile:
    // free, and lifesteal is the single biggest survivability lever there
    // is. Gated on `player.meleeWouldHit` (the engine's own hit test)
    // rather than a fixed angle tolerance, since a melee swing's on-screen
    // hit window shrinks with distance/enemy size.
    if (threat && threat.dist <= tuning.MELEE_RANGE) {
      if (!player.meleeWouldHit) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
        // Also keep closing the last bit of distance, not just re-aiming
        // in place — the enemy's own chase AI is still walking between
        // MELEE_CLOSE_MIN_DISTANCE and MELEE_RANGE. Never closer than one
        // decision's own real forward-movement distance, though — holding
        // "keep closing" *and* a turn command together for a whole decision
        // that's long enough to cover that much ground traces a real arc
        // around the target instead of settling on it (confirmed directly
        // against a caller using a much longer real decision window than
        // this project's own single-player defaults —
        // `scripts/lib/multiplayerBot.mjs` — which spun in place
        // indefinitely at melee range with the tuning-only default alone).
        // `MELEE_CLOSE_MIN_DISTANCE` on its own already works out to almost
        // exactly this same distance at single-player's own realtime
        // `WATCH_STEP_MS` (0.4 tiles vs. 3.2 tiles/sec × 0.13s ≈ 0.42) —
        // this is a no-op there; it only widens the gate for a caller
        // using a longer decision window than that.
        const closeMinDistance = Math.max(tuning.MELEE_CLOSE_MIN_DISTANCE, tuning.ENGINE_MOVE_SPEED * (stepMs / 1000));
        if (map && threat.dist > closeMinDistance) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
            moveKeys.add("KeyW");
          }
        }
        if (stallStrafeKey) {
          moveKeys.add(stallStrafeKey);
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false, moveCtx));
        }
      } else {
        fire = true;
        useMelee = true;
      }
    } else {
      // Don't fire at an aggroed-but-currently-occluded threat — aggro is
      // sticky, so an aligned angle doesn't guarantee a clear shot.
      const hasLos = !threat || !map || hasLineOfSight(map, player.x, player.y, threat.x, threat.y);
      // A stationary mine's on-screen width at typical disarm range is
      // narrower than any fixed fireAngleEps tolerance — gate on the
      // engine's own conservative `player.wouldMineHit` test instead,
      // unless realignment has stalled long enough to just take the shot.
      const mineRealignStalled = Boolean(memory) && memory.shootTicks > tuning.MINE_REALIGN_STALL_TICKS;
      const mineNotReady = !threat && !player.wouldMineHit && !mineRealignStalled;
      if (Math.abs(delta) > profile.fireAngleEps || !hasLos || mineNotReady) {
        if (Math.abs(delta) > (mineNotReady ? tuning.MINE_REALIGN_EPS : profile.fireAngleEps)) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
        }
        // Keep closing distance while lining up a ranged shot (threat-only,
        // not while aiming at a mine, and only outside melee range).
        if (threat && (threat.dist > tuning.MIN_RANGED_APPROACH_DISTANCE || !hasLos) && map) {
          const aheadX = player.x + player.dirX * 0.6;
          const aheadY = player.y + player.dirY * 0.6;
          if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
            moveKeys.add("KeyW");
          }
        }
        if (stallStrafeKey) {
          moveKeys.delete("KeyD");
          moveKeys.delete("KeyA");
          moveKeys.add(stallStrafeKey);
          turnBurst = Math.max(turnBurst ?? 0, moveBurstMs(10, false, moveCtx));
        }
      } else {
        weaponSwitch = pickRangedWeapon(player, profile, enemies, threat, mineTarget, tuning);
        // Re-check the *effective* weapon (the switch target, or whatever's
        // already equipped) against the same rocket-safety check right
        // before actually firing, not just at selection time — an already-
        // equipped Ghidra with nothing better in inventory would otherwise
        // still fire unsafely.
        const effectiveWeapon = weaponSwitch ?? player.weaponIndex;
        const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
        const rocketUnsafe = effectiveWeapon === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget), tuning);
        // Semi-auto ranged weapons (pistol/shotgun/ghidra) have no engine-
        // side fire-rate cap — see `profile.fireCooldownMs`'s doc comment —
        // so a fresh Backquote keydown dispatched every single decision
        // tick fired as fast as the tick loop allowed (~20/sec headless),
        // far beyond any human trigger-pull rate. Auto weapons (gdb/Friday
        // Hotfix) are exempt: their realistic sustained rate is already
        // enforced by the engine's own `weaponCooldown`/`fireIntervalSec`
        // while the key is held, so throttling the bot's dispatch here
        // would only starve them of frames to actually hold the key down.
        const isAutoRanged = AUTO_RANGED_WEAPON_INDICES.has(effectiveWeapon);
        const fireReady = isAutoRanged || simTimeMs - lastFireSimTimeMs >= profile.fireCooldownMs;
        fire = !rocketUnsafe && fireReady;
        fireOnCooldown = !rocketUnsafe && !fireReady;
        firedSemiAuto = fire && !isAutoRanged;
        // Keep moving while shooting. This branch used to hold no keys at all
        // for a whole decision, which is why `enemyAccuracy` — nominally an
        // "are enemies too dangerous" stat — was really measuring how easy it
        // is to hit a target that stands perfectly still while returning fire.
        //
        // Lateral only, deliberately: adding `KeyW` here would engage
        // `engine.ts`'s `diagonalScale` and cut the forward component by 29%,
        // which is the mechanism behind the recorded 0%->72% diagonal-strafe
        // regression. No sprint either — one variable at a time, and a walking
        // step already displaces far more than a bolt's 0.35-tile hit box over
        // a bolt's flight time.
        //
        // Note this changes *which* keys are held, not how long the decision
        // runs: the branch already ran a full-length step. That matters
        // because committing to longer decisions is exactly what made the
        // per-key-duration attempt fail.
        if (threat && threat.dist > tuning.COMBAT_STRAFE_MIN_DISTANCE && map) {
          const strafeDist = Math.max(tuning.ENGINE_MOVE_SPEED * (stepMs / 1000), tuning.COMBAT_STRAFE_LOOKAHEAD_TILES);
          const strafeKey = combatStrafeKey(combatStrafeTicks, map, player, strafeDist, player.levelTime, { tuning });
          if (strafeKey) moveKeys.add(strafeKey);
        }
      }
    }
  } else if (navTarget) {
    const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
    const delta = angleDelta(currentAngle, targetAngle);
    const aheadX = player.x + player.dirX * 0.6;
    const aheadY = player.y + player.dirY * 0.6;
    const blockedAhead = map && activeSpikeAt(map, aheadX, aheadY, player.levelTime);
    waitingOnSpike = Boolean(blockedAhead);
    if (Math.abs(delta) > tuning.TURN_MOVE_EPS) {
      moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      turnBurst = turnBurstMs(delta, profile.rotSpeedMultiplier, currentAngle, burstCtx);
      // Walk while still correcting heading, capped to angular errors
      // under MAX_WALK_WHILE_TURNING_RAD so a sharp corridor doubling-back
      // doesn't send the bot walking the wrong way while it turns around.
      if (Math.abs(delta) < tuning.MAX_WALK_WHILE_TURNING_RAD && !blockedAhead) {
        moveKeys.add("KeyW");
        moveKeys.add(diagonalStrafeKey(delta));
      }
    } else if (!blockedAhead) {
      // Don't step onto an active spike trap — wait out its cycle instead.
      moveKeys.add("KeyW");
      // Sprint the straight legs. The engine's SPRINT_MULTIPLIER (2.0) is
      // free and unconditional, and the bot had simply never used it
      // outside the two emergency branches — it walked whole campaigns at
      // half speed, which inflates time-on-level, exposure, damage taken
      // and ammo spent, and is what pushed one demo-campaign level past
      // MAX_REPLAY_FRAMES_PER_LEVEL.
      //
      // Scoped to this sub-branch on purpose: here the heading is already
      // converged (|delta| <= TURN_MOVE_EPS), so there is no turn key and
      // therefore no interaction with the turn/move burst coupling — the
      // single variable being changed is speed.
      //
      // The burst must flip to `sprinting = true` in the same breath: it is
      // what caps the hold so the bot stops at the waypoint, and leaving it
      // at the walking speed would overshoot by exactly 2x.
      const dist = Math.hypot(navTarget.x - player.x, navTarget.y - player.y);
      // Sprinting halves how long the hold needs to be, and the hold *is*
      // the decision window — so on a short leg, sprinting can shrink the
      // window below what the transport can carry. Walking the same leg
      // gives twice the window, so falling back to a walk is what keeps the
      // window safe, not stopping. Always true under the virtual clock
      // (`minDecisionMs` 0), so single-player behaviour is unaffected.
      const windowSafe = moveBurstMs(dist, true, moveCtx) >= minDecisionMs;
      const sprintDist = forwardScanTiles(true, moveCtx);
      // Gate the sprint, not the movement. Stopping dead for a spike two
      // and a half tiles away would cost more level time than the damage it
      // avoids; walking simply shortens the look-ahead until the existing
      // `blockedAhead` check can make the call at close range.
      // `hazard: false` — this is a committed route leg, and sprinting
      // across acid the planner already decided was worth crossing spends
      // less time in it, not more.
      const sprinting =
        windowSafe && !segmentBlocked(map, player, { x: player.dirX, y: player.dirY }, sprintDist, player.levelTime, { tuning, hazard: false });
      if (sprinting) moveKeys.add("ShiftLeft");
      turnBurst = moveBurstMs(dist, sprinting, moveCtx);
    }
  }

  logger?.debugNav?.(
    `      -> moveKeys=[${[...moveKeys].join(",")}] fire=${fire} useMelee=${useMelee} weaponSwitch=${weaponSwitch} turnBurst=${turnBurst?.toFixed(0)}`,
  );

  // A real attack attempt counts as progress even if position doesn't
  // change, so only an unchanging position with no attack counts toward
  // the stall.
  if (threat && memory) {
    const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
    if (!fire && memory.combatStallPos === posKey) {
      memory.combatStallTicks = (memory.combatStallTicks ?? 0) + 1;
    } else {
      memory.combatStallPos = posKey;
      memory.combatStallTicks = 0;
    }
    // Advances whenever a threat is engaged, so the flip period is measured in
    // decisions spent in combat rather than wall-clock — a slower profile
    // dances at the same spatial amplitude, not a wider one.
    memory.combatStrafeTicks = (memory.combatStrafeTicks ?? 0) + 1;
  } else if (memory) {
    memory.combatStallTicks = 0;
    memory.combatStallPos = null;
    memory.combatStrafeTicks = 0;
  }

  return uniformIntent(moveKeys, turnBurst, stepMs, {
    fire,
    useMelee,
    weaponSwitchIndex: weaponSwitch,
    firedSemiAuto,
    branch: "main",
    trace: {
      branch: "main",
      x: player.x,
      y: player.y,
      hpFrac: player.healthFraction,
      threatDist: threat?.dist ?? null,
      mineDist: mineTarget?.dist ?? null,
      waitingOnSpike,
      moveKeys: [...moveKeys],
      turnBurst,
      fire: fire || useMelee,
      fireOnCooldown,
    },
  });
}

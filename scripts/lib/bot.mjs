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
  // How much more rotation than `#turnBurstMs`'s own math predicts still
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
  // ticks targeting the *same* mine with no hit — see `tick`'s mine-handling
  // doc comment.
  MINE_TARGET_GIVEUP_TICKS: 40,
  // Once stuck realigning on the same mine this many ticks, force a shot at
  // the current best-effort alignment instead of freezing until the much
  // later full give-up — see `tick`'s mine-realignment comment.
  MINE_REALIGN_STALL_TICKS: 15,
  CRITICAL_HEALTH_FRACTION: 0.2,
  MELEE_RANGE: 1.5,
  // Below this distance, stop trying to close the last bit of distance
  // during an in-progress melee engagement — see `tick`'s melee branch,
  // which actually gates on `max(this, ENGINE_MOVE_SPEED * stepMs/1000)`,
  // not this raw value alone — see that branch's own doc comment for why.
  MELEE_CLOSE_MIN_DISTANCE: 0.4,
  // Below this distance, stop advancing while turning to line up a ranged
  // shot — see `tick`'s ranged-aim branch.
  MIN_RANGED_APPROACH_DISTANCE: 3,
  // Above this angular error, walking forward while still turning toward a
  // route waypoint would move the bot away from where it actually needs to
  // go — see `tick`'s plain-navigation branch.
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
  // virtual clock — see `tick`'s mine-realignment comment for why this
  // matters more in headless mode.
  MINE_REALIGN_EPS: 0.01,
  // A mine has to be somewhere in the forward hemisphere (90° either side of
  // the intended heading) to be worth a proactive detour — see
  // `findDisarmableMine`.
  MINE_DISARM_MAX_ANGLE_FROM_PATH: Math.PI / 2,
};

export function angleDelta(current, target) {
  const d = target - current;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * The strafe key ("KeyD"/right or "KeyA"/left) that moves the player toward
 * a target requiring `delta` radians of turn to face — lets the bot move
 * diagonally instead of straight-ahead-only while turning.
 *
 * CONFIRMED REGRESSION, only used in the plain-navigation branch: an A/B
 * test found Casual/normal's level-2 death rate jumped from 0% to 72% once
 * diagonal movement was added to every turn-and-move branch. Reverted from
 * every other branch (hazard/critical-health/mine-retreat/ranged-aim); kept
 * only in plain navigation, where the same methodology found no comparable
 * survival cost.
 */
export function diagonalStrafeKey(delta) {
  return delta > 0 ? "KeyD" : "KeyA";
}

// Position-unchanged-for-this-many-consecutive-ticks threshold before
// `detectAnomalies` calls it a "stall".
const STALL_TICKS_THRESHOLD = 20;
// Any run of >=2 consecutive same-position ticks where health is also
// dropping is worth flagging immediately, regardless of the stall
// threshold above.
const HP_DRAIN_FROZEN_TICKS_THRESHOLD = 2;
const TRACE_POS_EPS = 0.05;
// Lower than STALL_TICKS_THRESHOLD (20) on purpose — `detectHeldKeyNoMovement`
// is a much more precise signal, so it doesn't need as long a run to be
// confident it's a real freeze rather than incidental noise.
const HELD_KEY_NO_MOVEMENT_TICKS_THRESHOLD = 10;
// Movement keys that actually translate the player — KeyQ/KeyE only rotate.
const TRANSLATING_KEYS = new Set(["KeyW", "KeyA", "KeyD"]);

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
        const allWaitingOnSpike = runSlice.every((r) => r.waitingOnSpike);
        const engagedTicks = runSlice.filter((r) => r.fire || r.fireOnCooldown).length;
        const mostlyFiring = engagedTicks / runLen > 0.5;
        if (runLen >= STALL_TICKS_THRESHOLD && !allWaitingOnSpike && !mostlyFiring) {
          findings.push({
            type: "stall",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)} threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"}`,
          });
        }
        if (runLen >= HP_DRAIN_FROZEN_TICKS_THRESHOLD && last.hpFrac < first.hpFrac - 0.001 && !mostlyFiring) {
          findings.push({
            type: "healthDrainFrozen",
            startTick: runStart,
            endTick: runEnd - 1,
            ticks: runLen,
            detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
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
          detail: `pos=(${first.x.toFixed(2)},${first.y.toFixed(2)}) branch=${first.branch} heldKeys=[${[...heldKeys].join(",")}] threatDist=${first.threatDist ?? "none"} mineDist=${first.mineDist ?? "none"} hpFrac ${first.hpFrac.toFixed(2)}->${last.hpFrac.toFixed(2)}`,
        });
      }
      runStart = null;
    }
  }
  return findings;
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
 */
export function pickThreat(enemies, player, profile, map) {
  // `i` is the enemy's index in the engine's own `this.enemies` array
  // (stable for a whole level) — used by `Bot#tick` to recognize "same
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
    const aQuick = a.dist <= DEFAULT_TUNING.MELEE_RANGE || a.edgeCase;
    const bQuick = b.dist <= DEFAULT_TUNING.MELEE_RANGE || b.edgeCase;
    if (aQuick !== bQuick) return aQuick ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.dist - b.dist;
  });
  return candidates[0];
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

/**
 * A mine only counts as "disarmable from here" if there's a clear shot —
 * `visible` only means the mine has been spotted, not that it's actually
 * hittable from the player's current position. Also excludes mines well off
 * to the side of or behind `navTarget`'s direction (see
 * DEFAULT_TUNING.MINE_DISARM_MAX_ANGLE_FROM_PATH) — a mine this far
 * off-path isn't a real threat to the route.
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
export function findDisarmableMine(mines, player, abandoned, map, navTarget, reactionBufferTiles = 0) {
  const navAngle = navTarget ? Math.atan2(navTarget.y - player.y, navTarget.x - player.x) : null;
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist > DEFAULT_TUNING.MINE_BLAST_RADIUS + reactionBufferTiles && m.dist <= DEFAULT_TUNING.MINE_DISARM_RANGE + reactionBufferTiles)
    .filter((m) => hasLineOfSight(map, player.x, player.y, m.x, m.y))
    .filter((m) => {
      if (navAngle === null) return true;
      const mineAngle = Math.atan2(m.y - player.y, m.x - player.x);
      return Math.abs(angleDelta(navAngle, mineAngle)) <= DEFAULT_TUNING.MINE_DISARM_MAX_ANGLE_FROM_PATH;
    })
    .sort((a, b) => a.dist - b.dist)[0];
}

/**
 * A visible mine close enough to be actively dangerous (inside its own blast
 * radius, plus `reactionBufferTiles`) rather than just a target to line up a
 * shot on — "stop, back up" comes before "shoot" (see `Bot#tick`'s
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
export function findDangerousMine(mines, player, abandoned, reactionBufferTiles = 0) {
  return mines
    .filter((m) => m.alive && m.visible && !abandoned?.has(`${m.x},${m.y}`))
    .map((m) => ({ ...m, dist: Math.hypot(m.x - player.x, m.y - player.y) }))
    .filter((m) => m.dist <= DEFAULT_TUNING.MINE_BLAST_RADIUS + reactionBufferTiles)
    .sort((a, b) => a.dist - b.dist)[0];
}

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
export function nearestRocketDetonationDistance(player, enemies) {
  let nearest = Infinity;
  const dirX = player.dirX;
  const dirY = player.dirY;
  const triggerSq = DEFAULT_TUNING.ROCKET_ENEMY_TRIGGER_RADIUS * DEFAULT_TUNING.ROCKET_ENEMY_TRIGGER_RADIUS;
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
export function rocketAimUnsafe(player, enemies, aimDist, isMineTarget) {
  if (isMineTarget) return true;
  if (aimDist !== null && aimDist < DEFAULT_TUNING.ROCKET_SAFE_DISTANCE) return true;
  return nearestRocketDetonationDistance(player, enemies) < DEFAULT_TUNING.ROCKET_SAFE_DISTANCE;
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
export function pickRangedWeapon(player, profile, enemies, threat, mineTarget) {
  if (threat) {
    const clusterCount = enemies.filter(
      (e) => e.alive && e.aggroed && Math.hypot(e.x - threat.x, e.y - threat.y) <= DEFAULT_TUNING.CLUSTER_RADIUS,
    ).length;
    if (clusterCount >= 2) {
      if (threat.dist <= DEFAULT_TUNING.FRIDAY_HOTFIX_MAX_RANGE) {
        if (player.ownedWeapons.includes(FRIDAY_HOTFIX_WEAPON_INDEX) && hasAmmoFor(player, FRIDAY_HOTFIX_WEAPON_INDEX)) {
          return player.weaponIndex === FRIDAY_HOTFIX_WEAPON_INDEX ? null : FRIDAY_HOTFIX_WEAPON_INDEX;
        }
      } else if (
        threat.dist >= DEFAULT_TUNING.ROCKET_CLUSTER_MIN_DIST &&
        profile.rocketForDistantClusters &&
        player.ownedWeapons.includes(GHIDRA_WEAPON_INDEX) &&
        hasAmmoFor(player, GHIDRA_WEAPON_INDEX) &&
        !rocketAimUnsafe(player, enemies, threat.dist, false)
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
    if (idx === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget))) continue;
    if (!player.ownedWeapons.includes(idx)) continue;
    if (!hasAmmoFor(player, idx)) continue;
    return player.weaponIndex === idx ? null : idx;
  }
  return null;
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
   *   engageRadius, coverageMode, weaponPriority, healthDetourThreshold,
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
   *   `reportAnomalies`' basic findings; `navDiag: true` (implies `trace`)
   *   additionally enables the finer held-key-no-movement pass.
   */
  constructor(page, profile, opts = {}) {
    this.page = page;
    this.profile = profile;
    this.realtime = opts.realtime ?? false;
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    this.stepMs = opts.stepMs ?? (this.realtime ? this.tuning.WATCH_STEP_MS : this.tuning.VIRTUAL_STEP_MS);
    this.recordStepMs = opts.recordStepMs ?? this.stepMs;
    this.logger = {
      debugNav: opts.logger?.debugNav,
      wpDebug: opts.logger?.wpDebug,
      driftDebug: opts.logger?.driftDebug,
      trace: opts.logger?.trace ?? false,
      navDiag: opts.logger?.navDiag ?? false,
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
  }

  /**
   * How long to hold a turn key for a *pure* turn so it lands as close as
   * possible to `deltaAngle` without overshooting past it — see the
   * original module's doc comment for the oscillation bug this fixes.
   * Records `pendingTurnCheck` for `#checkRotationAnomaly` to compare
   * against on the next call.
   */
  #turnBurstMs(deltaAngle, rotSpeedMultiplier, player, currentAngle) {
    const standardStepMs = this.stepMs;
    const rate = this.tuning.ENGINE_ROT_SPEED * rotSpeedMultiplier; // rad/sec
    const neededMs = (Math.abs(deltaAngle) / rate) * 1000;
    if (this.mineMemory) {
      this.mineMemory.pendingTurnCheck = { beforeDir: currentAngle, turnBurstMs: Math.min(standardStepMs, neededMs), rotSpeedMultiplier };
    }
    return Math.max(1, Math.min(standardStepMs, neededMs));
  }

  /** Straight-line-movement counterpart to `#turnBurstMs` — caps how long a
   * movement key is held so it doesn't overshoot past a small arrival
   * tolerance (see the original module's doc comment for the hazard-tile
   * oscillation bug this fixes). */
  #moveBurstMs(dist, sprinting) {
    const standardStepMs = this.stepMs;
    const speed = this.tuning.ENGINE_MOVE_SPEED * (sprinting ? this.tuning.ENGINE_SPRINT_MULTIPLIER : 1); // tiles/sec
    const neededMs = (dist / speed) * 1000;
    return Math.max(1, Math.min(standardStepMs, neededMs));
  }

  /**
   * Defensive net for an intermittent, not-fully-root-caused report: the
   * bot occasionally spinning far more than one decision's worth of turning
   * should ever produce. Doesn't try to prevent the underlying cause
   * (unknown) — only makes any recurrence immediately visible in the log.
   */
  #checkRotationAnomaly(player, currentAngle) {
    const pending = this.mineMemory?.pendingTurnCheck;
    if (!pending) return;
    this.mineMemory.pendingTurnCheck = null;
    const actual = Math.abs(angleDelta(pending.beforeDir, currentAngle));
    const expectedMax = this.tuning.ENGINE_ROT_SPEED * pending.rotSpeedMultiplier * (pending.turnBurstMs / 1000) * this.tuning.ROTATION_ANOMALY_SLACK;
    if (actual > Math.max(expectedMax, 0.3)) {
      console.log(
        `[nav-warn] implausible rotation: turned ${actual.toFixed(2)}rad in one decision ` +
          `(requested turnBurst=${pending.turnBurstMs.toFixed(0)}ms, expected <=${expectedMax.toFixed(2)}rad) ` +
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

  /** No-op unless trace collection is enabled. Runs `detectAnomalies` (and,
   * if `this.logger.navDiag` is also on, `detectHeldKeyNoMovement`) against
   * this level's accumulated trace and logs any findings, tagged with
   * `label` and the 1-based level number. */
  reportAnomalies(label, levelIndex) {
    if (!this.mineMemory?.trace) return;
    if (this.logger.navDiag) {
      for (const f of detectHeldKeyNoMovement(this.mineMemory.trace)) {
        console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
      }
    }
    for (const f of detectAnomalies(this.mineMemory.trace)) {
      console.log(`  [anomaly] ${label} level ${levelIndex + 1}: ${f.type} (${f.ticks} ticks, decisions ${f.startTick}-${f.endTick}) ${f.detail}`);
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
        new Set(),
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
    this.logger.wpDebug?.(`[wpdebug] loot-detour from (${player.x.toFixed(1)},${player.y.toFixed(1)}) to best=(${best.x},${best.y}) kind=${best.kind} pathLen=${path.length}`);
    for (const wp of pathToWaypoints(path)) {
      this.logger.wpDebug?.(`[wpdebug]   loot wp=(${wp.x},${wp.y})`);
      const result = await this.driveToward(wp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
      this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
      if (result.state !== "playing") return result;
      // See `driveLegs`'s own doc comment on its identical check — every
      // waypoint after a mid-route teleport was planned from a position this
      // bot is no longer at.
      if (result.reason === "teleported") return result;
    }
    return { state: "playing" };
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
    const player = await this.readState();
    const displaced =
      Math.hypot(player.x - wp.x, player.y - wp.y) > this.tuning.LEG_REPLAN_DRIFT_TILES ||
      (this.map && !hasLineOfSight(this.map, player.x, player.y, wp.x, wp.y));
    if (displaced) {
      const path = bfsPath(
        this.map,
        { x: Math.floor(player.x), y: Math.floor(player.y) },
        { x: Math.floor(wp.x), y: Math.floor(wp.y) },
        new Set(),
        openedDoors,
      );
      this.logger.driftDebug?.(
        `[driftdebug] drift from (${player.x.toFixed(2)},${player.y.toFixed(2)}) wp=(${wp.x},${wp.y}) openedDoors=${JSON.stringify([...openedDoors])} path=${path ? `${path.length} tiles` : "NULL"}`,
      );
      if (path) {
        for (const rwp of pathToWaypoints(path)) {
          this.logger.wpDebug?.(`[wpdebug] replan-walk wp=(${rwp.x},${rwp.y})`);
          const result = await this.driveToward(rwp, this.tuning.ARRIVE_EPS, this.tuning.MAX_TICKS_PER_WAYPOINT);
          this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
          // See `driveLegs`'s own doc comment on its identical check — a
          // mid-route teleport invalidates every remaining replanned
          // waypoint too, same as it would the original plan.
          if (result.state !== "playing" || result.reason === "stuck" || result.reason === "teleported") return result;
        }
        return { state: "playing", reason: "arrived" };
      }
    }
    return this.driveToward(wp, eps, this.tuning.MAX_TICKS_PER_WAYPOINT);
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
    const openedDoors = new Set();

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
          const result = await this.driveTowardWithReplan(wp, openedDoors);
          this.logger.wpDebug?.(`[wpdebug]   -> result=${JSON.stringify(result)}`);
          if (result.state !== "playing") return result;
          if (result.reason === "stuck") return { state: "stuck" };
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
        const staged = await this.driveTowardWithReplan(stagingPoint, openedDoors, this.tuning.TIGHT_ARRIVE_EPS);
        if (staged.state !== "playing") return staged;
        if (staged.reason === "teleported") return staged;
        const targetAngle = Math.atan2(leg.approachDir.dy, leg.approachDir.dx);
        const faced = await this.faceAngle(targetAngle, this.tuning.MAX_TICKS_PER_WAYPOINT);
        if (faced.state !== "playing") return faced;
        const held = await this.holdForwardFine(this.tuning.DOOR_OPEN_TICKS * this.tuning.VIRTUAL_STEP_MS, this.tuning.DOOR_OPEN_FINE_STEP_MS);
        if (held.state !== "playing") return held;
        openedDoors.add(`${leg.doorTile.x},${leg.doorTile.y}`);
      }
    }
    return { state: "playing" };
  }

  /**
   * One tick: combat (or proactive mine-disarm) always preempts navigation.
   * Hazard-crossing suppresses combat entirely rather than detouring to a
   * "safe tile" (the nearest safe edge tile is often not on the way to the
   * real destination).
   *
   * `map` is an explicit parameter, not always `this.map`: `faceAngle`
   * deliberately calls `tick(..., undefined)` when a threat is present, so
   * the hazard/spike-avoidance branches (which need a real `map`) are
   * skipped during a bare "face this angle" maneuver — preserved exactly
   * from the original script's call site rather than folded into `this.map`
   * implicitly.
   */
  async tick(player, enemies, mines, navTarget, map) {
    this.#checkRotationAnomaly(player, Math.atan2(player.dirY, player.dirX));
    // Currently standing on a damaging ground tile: don't stop to fight —
    // just keep marching toward wherever the bot was already headed.
    if (map && navTarget && (isHazardAt(map, player.x, player.y) || activeSpikeAt(map, player.x, player.y, player.levelTime))) {
      const currentAngle = Math.atan2(player.dirY, player.dirX);
      const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
      const delta = angleDelta(currentAngle, targetAngle);
      const dist = Math.hypot(navTarget.x - player.x, navTarget.y - player.y);
      const moveKeys = new Set(["KeyW", "ShiftLeft"]);
      let turnBurst;
      if (Math.abs(delta) > this.tuning.TURN_MOVE_EPS) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        // Deliberately no `diagonalStrafeKey` here — see its doc comment's
        // "confirmed regression" note. Reverted from every branch except
        // plain navigation.
        turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
      } else {
        turnBurst = this.#moveBurstMs(dist, true);
      }
      this.#recordTrace({ branch: "hazard", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
      return this.applyAction(moveKeys, false, null, false, turnBurst);
    }

    const threat = pickThreat(enemies, player, this.profile, map);

    // Critical health: break contact instead of trading hits.
    if (threat && player.healthFraction < this.tuning.CRITICAL_HEALTH_FRACTION) {
      const currentAngle = Math.atan2(player.dirY, player.dirX);
      const awayAngle = Math.atan2(player.y - threat.y, player.x - threat.x);
      const delta = angleDelta(currentAngle, awayAngle);
      const moveKeys = new Set(["KeyW", "ShiftLeft"]);
      if (Math.abs(delta) > this.tuning.TURN_MOVE_EPS) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
      }
      // A blocked "away" vector (cornered retreat) still won't move the
      // player — this branch returns before the shared end-of-tick
      // combatStallTicks bookkeeping ever runs, so it needs its own
      // same-position tracking.
      if (this.mineMemory) {
        const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
        if (this.mineMemory.criticalStallPos === posKey) {
          this.mineMemory.criticalStallTicks = (this.mineMemory.criticalStallTicks ?? 0) + 1;
        } else {
          this.mineMemory.criticalStallPos = posKey;
          this.mineMemory.criticalStallTicks = 0;
        }
        if (this.mineMemory.criticalStallTicks >= this.tuning.CRITICAL_STALL_TICKS_THRESHOLD) {
          moveKeys.delete("KeyD");
          moveKeys.delete("KeyA");
          moveKeys.add(
            Math.floor(this.mineMemory.criticalStallTicks / this.tuning.CRITICAL_STALL_STRAFE_FLIP_TICKS) % 2 === 0 ? "KeyD" : "KeyA",
          );
        }
      }
      // Deliberately not `#turnBurstMs` here — fleeing has no narrow
      // hit-window to protect against overshoot; a full sprint step every
      // tick converges toward genuinely-away without stalling.
      const turnBurst = this.#moveBurstMs(10, true);
      this.#recordTrace({ branch: "criticalHealth", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: threat.dist, mineDist: null, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
      return this.applyAction(moveKeys, false, null, false, turnBurst);
    }

    // See `findDangerousMine`'s own doc comment for why this buffer exists —
    // a real, decision-window-scaled reaction margin, not a fixed tile count.
    // Shared by both mine checks below so the same shift applies to each end
    // of `findDisarmableMine`'s own eligible-distance window too (see its own
    // doc comment on why only widening one side of that window is wrong).
    const mineReactionBufferTiles = this.tuning.ENGINE_MOVE_SPEED * this.tuning.ENGINE_SPRINT_MULTIPLIER * (this.stepMs / 1000);

    // Proper mine handling: stop, back up out of blast range, shoot it, then
    // continue. Backing away takes priority over shooting (below) since you
    // can't line up a safe shot from inside your own target's blast radius.
    if (!threat && this.profile.proactiveMineDisarm) {
      const dangerMine = findDangerousMine(mines, player, this.mineMemory?.abandoned, mineReactionBufferTiles);
      if (dangerMine) {
        const key = `${dangerMine.x},${dangerMine.y}`;
        let gaveUp = false;
        if (this.mineMemory) {
          this.mineMemory.retreatTicks = this.mineMemory.retreatKey === key ? this.mineMemory.retreatTicks + 1 : 1;
          this.mineMemory.retreatKey = key;
          gaveUp = this.mineMemory.retreatTicks > this.tuning.MINE_TARGET_GIVEUP_TICKS;
          if (gaveUp) this.mineMemory.abandoned.add(key); // e.g. wedged against a wall — stop trying, in either mode, for the rest of the level
        }
        if (!gaveUp) {
          const currentAngle = Math.atan2(player.dirY, player.dirX);
          const awayAngle = Math.atan2(player.y - dangerMine.y, player.x - dangerMine.x);
          const delta = angleDelta(currentAngle, awayAngle);
          const moveKeys = new Set(["KeyW"]);
          let turnBurst;
          if (Math.abs(delta) > this.tuning.TURN_MOVE_EPS) {
            moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
            turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
          } else {
            turnBurst = this.#moveBurstMs(10, false);
          }
          this.#recordTrace({ branch: "mineRetreat", x: player.x, y: player.y, hpFrac: player.healthFraction, threatDist: null, mineDist: dangerMine.dist, waitingOnSpike: false, moveKeys: [...moveKeys], turnBurst, fire: false });
          return this.applyAction(moveKeys, false, null, false, turnBurst);
        }
        // else: gave up retreating — fall through to normal navigation below.
      }
    }

    let mineTarget =
      !threat && this.profile.proactiveMineDisarm && map
        ? findDisarmableMine(mines, player, this.mineMemory?.abandoned, map, navTarget, mineReactionBufferTiles)
        : null;
    if (mineTarget && this.mineMemory) {
      const key = `${mineTarget.x},${mineTarget.y}`;
      this.mineMemory.shootTicks = this.mineMemory.shootKey === key ? this.mineMemory.shootTicks + 1 : 1;
      this.mineMemory.shootKey = key;
      if (this.mineMemory.shootTicks > this.tuning.MINE_TARGET_GIVEUP_TICKS) {
        this.mineMemory.abandoned.add(key); // e.g. a wall blocks line of fire — stop trying, in either mode, for the rest of the level
        mineTarget = null;
      }
    }
    // A threat's aggro is sticky, but `threat.x/y` is live even while
    // occluded — freeze the aim at wherever the threat was last actually
    // seen while occluded, only resuming live tracking once visible again.
    let threatAim = threat;
    if (threat && this.mineMemory) {
      if (threat.visible) {
        this.mineMemory.lastVisibleThreat = { i: threat.i, x: threat.x, y: threat.y };
      } else if (this.mineMemory.lastVisibleThreat?.i === threat.i) {
        threatAim = this.mineMemory.lastVisibleThreat;
      }
      // else: aggroed without this specific enemy ever having been seen yet
      // — no memory to fall back on, aim at the live position.
    }
    const aimTarget = threatAim ?? mineTarget;
    // Read the stall counter as last tick left it (updated at the bottom of
    // this function, after `fire` is known).
    const stallStrafeKey =
      threat && this.mineMemory && (this.mineMemory.combatStallTicks ?? 0) >= this.tuning.COMBAT_STALL_TICKS_THRESHOLD
        ? Math.floor(this.mineMemory.combatStallTicks / this.tuning.COMBAT_STALL_STRAFE_FLIP_TICKS) % 2 === 0
          ? "KeyD"
          : "KeyA"
        : null;

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
    this.logger.debugNav?.(
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
      if (threat && threat.dist <= this.tuning.MELEE_RANGE) {
        if (!player.meleeWouldHit) {
          moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
          turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
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
          const closeMinDistance = Math.max(this.tuning.MELEE_CLOSE_MIN_DISTANCE, this.tuning.ENGINE_MOVE_SPEED * (this.stepMs / 1000));
          if (map && threat.dist > closeMinDistance) {
            const aheadX = player.x + player.dirX * 0.6;
            const aheadY = player.y + player.dirY * 0.6;
            if (!isHazardAt(map, aheadX, aheadY) && !activeSpikeAt(map, aheadX, aheadY, player.levelTime)) {
              moveKeys.add("KeyW");
            }
          }
          if (stallStrafeKey) {
            moveKeys.add(stallStrafeKey);
            turnBurst = Math.max(turnBurst ?? 0, this.#moveBurstMs(10, false));
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
        const mineRealignStalled = Boolean(this.mineMemory) && this.mineMemory.shootTicks > this.tuning.MINE_REALIGN_STALL_TICKS;
        const mineNotReady = !threat && !player.wouldMineHit && !mineRealignStalled;
        if (Math.abs(delta) > this.profile.fireAngleEps || !hasLos || mineNotReady) {
          if (Math.abs(delta) > (mineNotReady ? this.tuning.MINE_REALIGN_EPS : this.profile.fireAngleEps)) {
            moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
            turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
          }
          // Keep closing distance while lining up a ranged shot (threat-only,
          // not while aiming at a mine, and only outside melee range).
          if (threat && (threat.dist > this.tuning.MIN_RANGED_APPROACH_DISTANCE || !hasLos) && map) {
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
            turnBurst = Math.max(turnBurst ?? 0, this.#moveBurstMs(10, false));
          }
        } else {
          weaponSwitch = pickRangedWeapon(player, this.profile, enemies, threat, mineTarget);
          // Re-check the *effective* weapon (the switch target, or whatever's
          // already equipped) against the same rocket-safety check right
          // before actually firing, not just at selection time — an already-
          // equipped Ghidra with nothing better in inventory would otherwise
          // still fire unsafely.
          const effectiveWeapon = weaponSwitch ?? player.weaponIndex;
          const aimDist = threat ? threat.dist : mineTarget ? mineTarget.dist : null;
          const rocketUnsafe = effectiveWeapon === GHIDRA_WEAPON_INDEX && rocketAimUnsafe(player, enemies, aimDist, Boolean(mineTarget));
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
          const fireReady = isAutoRanged || this.simTimeMs - this.lastFireSimTimeMs >= this.profile.fireCooldownMs;
          fire = !rocketUnsafe && fireReady;
          fireOnCooldown = !rocketUnsafe && !fireReady;
          if (fire && !isAutoRanged) this.lastFireSimTimeMs = this.simTimeMs;
        }
      }
    } else if (navTarget) {
      const targetAngle = Math.atan2(navTarget.y - player.y, navTarget.x - player.x);
      const delta = angleDelta(currentAngle, targetAngle);
      const aheadX = player.x + player.dirX * 0.6;
      const aheadY = player.y + player.dirY * 0.6;
      const blockedAhead = map && activeSpikeAt(map, aheadX, aheadY, player.levelTime);
      waitingOnSpike = Boolean(blockedAhead);
      if (Math.abs(delta) > this.tuning.TURN_MOVE_EPS) {
        moveKeys.add(delta > 0 ? "KeyE" : "KeyQ");
        turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
        // Walk while still correcting heading, capped to angular errors
        // under MAX_WALK_WHILE_TURNING_RAD so a sharp corridor doubling-back
        // doesn't send the bot walking the wrong way while it turns around.
        if (Math.abs(delta) < this.tuning.MAX_WALK_WHILE_TURNING_RAD && !blockedAhead) {
          moveKeys.add("KeyW");
          moveKeys.add(diagonalStrafeKey(delta));
        }
      } else if (!blockedAhead) {
        // Don't step onto an active spike trap — wait out its cycle instead.
        moveKeys.add("KeyW");
        turnBurst = this.#moveBurstMs(Math.hypot(navTarget.x - player.x, navTarget.y - player.y), false);
      }
    }

    this.logger.debugNav?.(`      -> moveKeys=[${[...moveKeys].join(",")}] fire=${fire} useMelee=${useMelee} weaponSwitch=${weaponSwitch} turnBurst=${turnBurst?.toFixed(0)}`);

    // A real attack attempt counts as progress even if position doesn't
    // change, so only an unchanging position with no attack counts toward
    // the stall.
    if (threat && this.mineMemory) {
      const posKey = `${player.x.toFixed(2)},${player.y.toFixed(2)}`;
      if (!fire && this.mineMemory.combatStallPos === posKey) {
        this.mineMemory.combatStallTicks = (this.mineMemory.combatStallTicks ?? 0) + 1;
      } else {
        this.mineMemory.combatStallPos = posKey;
        this.mineMemory.combatStallTicks = 0;
      }
    } else if (this.mineMemory) {
      this.mineMemory.combatStallTicks = 0;
      this.mineMemory.combatStallPos = null;
    }
    this.#recordTrace({
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
    });
    return this.applyAction(moveKeys, fire, weaponSwitch, useMelee, turnBurst);
  }

  async driveToward(point, eps, maxTicks) {
    let { player, enemies, mines } = await this.readFull();
    for (let t = 0; t < maxTicks; t++) {
      if (player.state !== "playing") {
        await this.applyAction(new Set(), false, null, false);
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
      const prevX = player.x;
      const prevY = player.y;
      ({ player, enemies, mines } = await this.tick(player, enemies, mines, point, this.map));
      // A BFS-derived waypoint can end up targeting a teleporter pad's exact
      // tile-center; stepping onto it always warps the player away before
      // this loop's own arrival check is satisfied. Detect a jump far
      // larger than any legitimate single tick of movement and treat it the
      // same as arriving.
      if (Math.hypot(player.x - prevX, player.y - prevY) > this.tuning.TELEPORT_JUMP_DETECT_TILES) {
        await this.applyAction(new Set(), false, null, false);
        return { state: "playing", reason: "teleported" };
      }
    }
    await this.applyAction(new Set(), false, null, false);
    return { state: "playing", reason: "stuck" };
  }

  async faceAngle(targetAngle, maxTicks) {
    let { player, enemies, mines } = await this.readFull();
    for (let t = 0; t < maxTicks; t++) {
      if (player.state !== "playing") return { state: player.state };
      const threat = pickThreat(enemies, player, this.profile, this.map);
      if (!threat) {
        const currentAngle = Math.atan2(player.dirY, player.dirX);
        const delta = angleDelta(currentAngle, targetAngle);
        if (Math.abs(delta) < this.tuning.TURN_MOVE_EPS) {
          await this.applyAction(new Set(), false, null, false);
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
        const turnBurst = this.#turnBurstMs(delta, this.profile.rotSpeedMultiplier, player, currentAngle);
        ({ player, enemies, mines } = await this.applyAction(moveKeys, false, null, false, turnBurst));
        continue;
      }
      // `map` explicitly omitted here — see `tick`'s doc comment.
      ({ player, enemies, mines } = await this.tick(player, enemies, mines, null, undefined));
    }
    await this.applyAction(new Set(), false, null, false);
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
      const { player } = await this.applyAction(new Set(["KeyW"]), false, null, false, stepMs);
      if (player.state !== "playing") return { state: player.state };
    }
    await this.applyAction(new Set(), false, null, false);
    return { state: "playing" };
  }

  async readFull() {
    return this.page.evaluate(() => {
      const hooks = window.__codeensteinTestHooks;
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
    });
  }

  async readState() {
    return this.page.evaluate(() => window.__codeensteinTestHooks.getPlayerState());
  }

  /**
   * The sole Node↔browser control boundary: dispatches real synthetic
   * KeyboardEvents on the canvas element (never the mouse — see the
   * original `generate-default-highscore.mjs` module doc comment for why),
   * with an edge-triggered weapon-switch (`Digit{n+1}`) and a melee-vs-
   * ranged fire key choice (`Space` for quick-melee, `Backquote`
   * otherwise). In realtime mode, skips the virtual-clock pump and instead
   * waits `stepMs` of *real* time so a human watching a visible browser
   * window can actually follow the action.
   */
  async applyAction(desiredMoveKeys, fire, weaponSwitchIndex, useMelee, stepMsOverride) {
    const stepMs = stepMsOverride ?? this.stepMs;
    this.simTimeMs += stepMs;
    const headed = this.realtime;
    // Capped at `stepMs` itself: a short precision burst (e.g. `#turnBurstMs`
    // rounding a near-complete turn down to a few ms to avoid overshoot)
    // must still land in exactly one sub-step of its own requested size, not
    // get rounded up to a full `recordStepMs` — `__pumpVirtualTime` always
    // advances by at least one whole sub-step, so a sub-step larger than the
    // requested burst would overshoot the very precision these bursts exist
    // to protect. Only a full-length decision (the common case) actually
    // gets subdivided into multiple `recordStepMs`-sized replay frames.
    const subStepMs = Math.min(this.recordStepMs, stepMs);
    const dispatched = await this.page.evaluate(
      ({ desiredKeys, fire, weaponSwitchIndex, useMelee, stepMs, subStepMs, headed }) => {
        const canvas = document.querySelector("canvas");
        const hooks = window.__codeensteinTestHooks;
        const desired = new Set(desiredKeys);
        const held = (window.__botHeldKeys ??= new Set());
        for (const code of held) if (!desired.has(code)) canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        for (const code of desired) if (!held.has(code)) canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
        window.__botHeldKeys = desired;
        if (weaponSwitchIndex !== null && weaponSwitchIndex !== undefined) {
          const code = `Digit${weaponSwitchIndex + 1}`;
          canvas.dispatchEvent(new KeyboardEvent("keydown", { code }));
          canvas.dispatchEvent(new KeyboardEvent("keyup", { code }));
        }
        // Fire is held for the *whole* tick, not pressed-and-released before
        // any frame runs — an `auto: true` weapon checks isFireHeld() every
        // frame, so releasing before the pump even starts meant it never
        // fired at all. Fixed by moving the keyup to the end of the tick.
        const fireCode = fire ? (useMelee ? "Space" : "Backquote") : null;
        if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keydown", { code: fireCode }));
        if (headed) return { fireCode };
        window.__pumpVirtualTime(stepMs, subStepMs);
        if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
        return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
      },
      { desiredKeys: [...desiredMoveKeys], fire, weaponSwitchIndex, useMelee, stepMs, subStepMs, headed },
    );
    if (!headed) return dispatched;
    await this.page.waitForTimeout(stepMs);
    return this.page.evaluate((fireCode) => {
      const canvas = document.querySelector("canvas");
      if (fireCode) canvas.dispatchEvent(new KeyboardEvent("keyup", { code: fireCode }));
      const hooks = window.__codeensteinTestHooks;
      return { player: hooks.getPlayerState(), enemies: hooks.getEnemies(), mines: hooks.getMines() };
    }, dispatched.fireCode);
  }
}

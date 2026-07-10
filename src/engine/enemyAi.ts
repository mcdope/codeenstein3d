// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Enemy AI: the per-frame behaviour that turns the otherwise inert `Enemy`
 * billboards into active threats. Two states:
 *
 * - **Roam** (idle): wander to random points inside the origin room, never
 *   leaving it, so a room feels alive without monsters spilling into corridors.
 * - **Chase**: home in on the player, rounding walls, and melee on a cooldown.
 *
 * An enemy flips to chase when the player enters its (enlarged) aggro radius
 * *and* there's a clear line of sight to them, or the instant it is shot
 * ("damage aggro" — bypasses the line-of-sight check entirely, since being
 * shot at all proves the enemy has been found), and stays aggroed thereafter.
 * This lives in the engine layer rather than as a method on the `Enemy` data
 * (which is plain, serializable map state) so the map never depends on the
 * player.
 */
import { collidesWithWall, isWall, type Player } from "./player";
import type { PathField } from "./pathField";
import { spawnProjectile, type Projectile } from "./projectiles";
import type { Enemy, GameMap } from "../map/types";

/** Distance (tiles) within which an enemy notices and chases the player. */
const AGGRO_RADIUS = 7.5;
/** Enemy chase speed in tiles per second (slower than the player's 3.2). */
const MOVEMENT_SPEED = 1.7;
/** Max distance (tiles) at which a chasing enemy will take a ranged shot. */
const RANGED_RANGE = 8;
/** Min / max seconds between an enemy's ranged shots (randomized each time). */
const FIRE_COOLDOWN_MIN = 1.2;
const FIRE_COOLDOWN_MAX = 2.6;
/** Enemy roam (idle wander) speed — a relaxed stroll. */
const ROAM_SPEED = 0.8;
/** Distance (tiles) from a roam target at which the enemy picks a new one. */
const ROAM_ARRIVE = 0.25;
/** Distance (tiles) at which an enemy stops chasing and melees instead. */
const ATTACK_RADIUS = 0.5;
/** Seconds between successive melee bites from a single enemy. */
const ATTACK_COOLDOWN = 0.8;
/** Stability (health) the player loses per melee bite. */
const ATTACK_DAMAGE = 10;
/** Half-width of an enemy's collision box, in tiles. */
const ENEMY_RADIUS = 0.3;
/** Melee/ranged damage multiplier for an Elite (boss-tier) enemy — see
 * `Enemy.elite`. Its HP scaling already lives in `mapGenerator.ts`; this is
 * the "high damage" half of the spec. */
const ELITE_DAMAGE_MULTIPLIER = 2;
/** Chase/roam speed multiplier for an Edge Case enemy — see `Enemy.edgeCase`.
 * "Very high movement speed": noticeably faster than the player can react to. */
const EDGE_CASE_SPEED_MULTIPLIER = 2.2;
/** Melee/ranged damage multiplier for an Edge Case enemy — "low melee
 * damage": a nuisance, not a threat. */
const EDGE_CASE_DAMAGE_MULTIPLIER = 0.4;
/** Average per-second chance an Edge Case enemy abandons its current roam
 * target early (before arriving) — the core of its erratic roaming. */
const EDGE_CASE_RETARGET_RATE = 2.0;
/** Random heading wobble (radians) applied to an Edge Case enemy's roam step,
 * on top of its retargeting — reads as visibly twitchy/darting rather than a
 * smooth glide even between retargets. */
const EDGE_CASE_ROAM_JITTER_RAD = 0.9;

/**
 * Advance every living enemy by `dt` seconds and return the total stability
 * damage the player should take from melee bites this frame. Call once per
 * frame, before rendering.
 *
 * `rng` defaults to `Math.random` but `RaycasterEngine` always passes its own
 * seeded stream instead — roam-target picking and ranged fire-cooldown
 * jitter both change enemy behavior/timing, which the replay system's
 * deterministic-simulation guarantee depends on (see `src/prng.ts`'s doc
 * comment for the full seeded/cosmetic split).
 */
export function updateEnemies(
  enemies: Enemy[],
  player: Player,
  map: GameMap,
  dt: number,
  projectiles: Projectile[],
  pathField: PathField,
  rng: () => number = Math.random,
): number {
  let damage = 0;
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    damage += updateEnemy(enemy, player, map, dt, projectiles, pathField, rng);
  }
  return damage;
}

/** Update a single enemy; returns the melee damage it deals the player. */
function updateEnemy(
  enemy: Enemy,
  player: Player,
  map: GameMap,
  dt: number,
  projectiles: Projectile[],
  pathField: PathField,
  rng: () => number,
): number {
  // Cool down toward the next melee bite and the next ranged shot.
  if (enemy.attackCooldown > 0) enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
  if (enemy.fireCooldown > 0) enemy.fireCooldown = Math.max(0, enemy.fireCooldown - dt);

  const dx = player.posX - enemy.x;
  const dy = player.posY - enemy.y;
  const dist = Math.hypot(dx, dy);

  // Line of sight, lazily memoized for this frame: neither the enemy nor the
  // player moves between the aggro check and the ranged-shot check below, so
  // the second reachable call would just ray-march the identical answer again.
  let losMemo: boolean | undefined;
  const los = (): boolean => (losMemo ??= hasLineOfSight(map, enemy.x, enemy.y, player.posX, player.posY));

  // Wake up once the player is within (enlarged) aggro range AND actually
  // visible (no wall in between) — a roaming enemy shouldn't sense the player
  // through solid geometry. Damage aggro is applied separately by the engine
  // when the enemy is shot, and skips this check entirely. Sticky thereafter —
  // which is why an already-aggroed enemy skips the ray-march entirely (the
  // write was idempotent; re-checking was pure wasted work every frame).
  if (!enemy.aggroed && dist < AGGRO_RADIUS && los()) {
    enemy.aggroed = true;
  }

  if (!enemy.aggroed) {
    roam(enemy, map, dt, rng);
    return 0;
  }

  // Chasing. In melee range: hold and bite whenever the cooldown has elapsed.
  if (dist <= ATTACK_RADIUS) {
    if (enemy.attackCooldown === 0) {
      enemy.attackCooldown = ATTACK_COOLDOWN;
      return ATTACK_DAMAGE * damageMultiplier(enemy);
    }
    return 0;
  }

  // At range: occasionally lob a bolt at the player if there's a clear shot.
  if (enemy.fireCooldown === 0 && dist <= RANGED_RANGE && los()) {
    spawnProjectile(projectiles, enemy.x, enemy.y, player.posX, player.posY, damageMultiplier(enemy));
    enemy.fireCooldown = FIRE_COOLDOWN_MIN + rng() * (FIRE_COOLDOWN_MAX - FIRE_COOLDOWN_MIN);
  }

  // Home in on the player, steering toward the next cell of a wall-aware path
  // (rounding corners) and falling back to a straight line.
  if (dist > 0) {
    const step = speedFor(MOVEMENT_SPEED, enemy) * dt;
    const waypoint = nextWaypoint(enemy, player, map, pathField);
    chaseToward(enemy, waypoint?.x ?? player.posX, waypoint?.y ?? player.posY, step, map);
  }
  return 0;
}

/** Melee/ranged damage multiplier for `enemy` — the one elite/edgeCase ladder
 * shared by both attack paths (an Elite hits harder, an Edge Case softer). */
function damageMultiplier(enemy: Enemy): number {
  return enemy.elite ? ELITE_DAMAGE_MULTIPLIER : enemy.edgeCase ? EDGE_CASE_DAMAGE_MULTIPLIER : 1;
}

/** `base` movement speed scaled for an Edge Case enemy's much faster darting. */
function speedFor(base: number, enemy: Enemy): number {
  return enemy.edgeCase ? base * EDGE_CASE_SPEED_MULTIPLIER : base;
}

/** True if a straight line from (x0,y0) to (x1,y1) crosses no wall tile. */
function hasLineOfSight(map: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.1); // sample every ~0.1 tiles
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(map, Math.floor(x0 + dx * t), Math.floor(y0 + dy * t))) return false;
  }
  return true;
}

/**
 * Idle wandering, confined to the enemy's origin room: stroll toward the
 * current roam target, and when it's reached (or the path is blocked) pick a
 * fresh random point inside the room. Movement is clamped so the enemy's box
 * never crosses the room bounds — it can't drift out through a doorway.
 *
 * An Edge Case enemy (see `Enemy.edgeCase`) roams erratically instead: it may
 * abandon its current target before arriving (`EDGE_CASE_RETARGET_RATE`), on
 * top of a much higher base speed and a per-step heading wobble
 * (`EDGE_CASE_ROAM_JITTER_RAD`) — reads as darting/glitchy rather than a
 * relaxed stroll-and-pause. For a non-`edgeCase` enemy every added branch is
 * gated strictly behind `enemy.edgeCase`, so this is byte-for-byte the same
 * behavior (and draws the same `rng()` sequence) as before.
 */
function roam(enemy: Enemy, map: GameMap, dt: number, rng: () => number): void {
  if (enemy.edgeCase && rng() < EDGE_CASE_RETARGET_RATE * dt) {
    pickRoamTarget(enemy, rng);
  }

  const dx = enemy.roamX - enemy.x;
  const dy = enemy.roamY - enemy.y;
  const dist = Math.hypot(dx, dy);
  if (dist < ROAM_ARRIVE) {
    pickRoamTarget(enemy, rng);
    return;
  }

  const step = speedFor(ROAM_SPEED, enemy) * dt;
  let heading = Math.atan2(dy, dx);
  if (enemy.edgeCase) heading += (rng() * 2 - 1) * EDGE_CASE_ROAM_JITTER_RAD;

  const beforeX = enemy.x;
  const beforeY = enemy.y;
  moveWithinHome(enemy, Math.cos(heading) * step, Math.sin(heading) * step, map);
  // If a wall blocked the stroll, wander somewhere else instead of pushing.
  if (Math.hypot(enemy.x - beforeX, enemy.y - beforeY) < step * 0.25) {
    pickRoamTarget(enemy, rng);
  }
}

/**
 * Choose a new random roam destination inside the enemy's home room, snapped
 * to the center of whichever tile it falls in. For a labyrinth room (deeply
 * nested functions), most of `home`'s bounding rectangle is actually wall,
 * not floor — a raw continuous coordinate can land close enough to one that
 * even a tile the enemy *can* reach leaves it hugging a wall face rather than
 * settling in the middle of the passage. Movement itself is always
 * collision-checked (`moveWithinHome`), so this was never a real "walks
 * through walls" bug, just an unreachable-or-awkward target in maze rooms.
 */
function pickRoamTarget(enemy: Enemy, rng: () => number): void {
  const h = enemy.home;
  const x = h.x + 0.5 + rng() * Math.max(0, h.w - 1);
  const y = h.y + 0.5 + rng() * Math.max(0, h.h - 1);
  enemy.roamX = Math.floor(x) + 0.5;
  enemy.roamY = Math.floor(y) + 0.5;
}

/**
 * Per-axis AABB slide against the wall grid: X first, then Y against the
 * already-slid X — the identical collision model the player uses. `allow`
 * optionally vetoes a slid position on top of the wall check (room
 * confinement for a roaming enemy — see `moveWithinHome`).
 */
function slideAxes(
  x: number,
  y: number,
  dx: number,
  dy: number,
  map: GameMap,
  allow: (x: number, y: number) => boolean = () => true,
): { x: number; y: number } {
  const nextX = x + dx;
  if (!collidesWithWall(map, nextX, y, ENEMY_RADIUS) && allow(nextX, y)) x = nextX;
  const nextY = y + dy;
  if (!collidesWithWall(map, x, nextY, ENEMY_RADIUS) && allow(x, nextY)) y = nextY;
  return { x, y };
}

/** Per-axis slide that also refuses to leave the enemy's home room bounds. */
function moveWithinHome(enemy: Enemy, dx: number, dy: number, map: GameMap): void {
  const pos = slideAxes(enemy.x, enemy.y, dx, dy, map, (x, y) => withinHome(x, y, enemy.home));
  enemy.x = pos.x;
  enemy.y = pos.y;
}

/** True if a box of half-width `ENEMY_RADIUS` at (x,y) fits inside the room. */
function withinHome(x: number, y: number, home: Enemy["home"]): boolean {
  return (
    x - ENEMY_RADIUS >= home.x &&
    x + ENEMY_RADIUS <= home.x + home.w &&
    y - ENEMY_RADIUS >= home.y &&
    y + ENEMY_RADIUS <= home.y + home.h
  );
}

/** How far beyond the aggro radius a chasing enemy still gets waypoint
 * pathing rather than plain straight-at-the-player steering, in tiles —
 * keeps a sticky-aggroed enemy far across the map from gaining perfect
 * cross-map navigation just because the shared field happens to reach it. */
const PATH_MARGIN = 2;

/**
 * Next steering target for a chasing enemy: the center of the walkable cell
 * adjacent to the enemy that lies on the shortest path to the player.
 *
 * Read off the shared player-rooted BFS distance field (see `pathField.ts`)
 * — one flood, recomputed only when the player changes tile or the grid
 * mutates, serves every enemy, instead of the per-enemy per-frame windowed
 * flood this used to run. Returns `null` when the player's tile is
 * unwalkable, beyond the pathing window, or unreachable — the caller then
 * steers straight at the player. This is what lets enemies round convex
 * corners and finite wall segments instead of hanging on them.
 */
function nextWaypoint(
  enemy: Enemy,
  player: Player,
  map: GameMap,
  pathField: PathField,
): { x: number; y: number } | null {
  const ex = Math.floor(enemy.x);
  const ey = Math.floor(enemy.y);
  const px = Math.floor(player.posX);
  const py = Math.floor(player.posY);
  if (ex === px && ey === py) return null; // same tile — just go straight in

  const reach = AGGRO_RADIUS + PATH_MARGIN;
  const minX = ex - reach;
  const maxX = ex + reach;
  const minY = ey - reach;
  const maxY = ey + reach;
  if (px < minX || px > maxX || py < minY || py > maxY) return null;
  if (isWall(map, px, py)) return null;

  // Descend the distance field: pick the enemy's walkable neighbor closest to
  // the player. Requires a strict decrease so we always make progress inward.
  let best: { x: number; y: number } | null = null;
  const own = pathField.distAt(ex, ey);
  let bestDist = own === -1 ? Infinity : own;
  for (const [nx, ny] of neighbors4(ex, ey)) {
    if (isWall(map, nx, ny)) continue;
    const d = pathField.distAt(nx, ny);
    if (d === -1 || d >= bestDist) continue;
    bestDist = d;
    best = { x: nx + 0.5, y: ny + 0.5 };
  }
  return best;
}

/** The four orthogonal neighbors of a tile. */
function neighbors4(x: number, y: number): [number, number][] {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

/**
 * Candidate heading offsets (radians), tried in order: straight at the player
 * first, then progressively wider slides. The wider ones let a chasing enemy
 * wall-follow around a corner instead of walking into a wall face and hanging
 * (greedy steering has no tangential component to slide on when it points
 * straight at a wall).
 */
const STEER_OFFSETS = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

/** A heading must actually advance the enemy this fraction of a step to count
 * as progress — filters out headings that merely graze a wall. */
const MIN_PROGRESS = 0.25;

/**
 * Step the enemy up to `step` tiles toward (tx,ty) while avoiding walls. Each
 * candidate heading is resolved with the same per-axis AABB slide the player
 * uses; among the headings that make real progress, the one ending closest to
 * the target wins. This rounds convex wall corners instead of hanging on them.
 */
function chaseToward(enemy: Enemy, tx: number, ty: number, step: number, map: GameMap): void {
  const desired = Math.atan2(ty - enemy.y, tx - enemy.x);
  let bestX = enemy.x;
  let bestY = enemy.y;
  let bestDist = Infinity;
  let moved = false;

  for (const offset of STEER_OFFSETS) {
    const angle = desired + offset;
    const { x, y } = slideAxes(enemy.x, enemy.y, Math.cos(angle) * step, Math.sin(angle) * step, map);
    if (Math.hypot(x - enemy.x, y - enemy.y) < step * MIN_PROGRESS) continue;
    const d = Math.hypot(tx - x, ty - y);
    if (d < bestDist) {
      bestDist = d;
      bestX = x;
      bestY = y;
      moved = true;
    }
  }

  if (moved) {
    enemy.x = bestX;
    enemy.y = bestY;
  }
}


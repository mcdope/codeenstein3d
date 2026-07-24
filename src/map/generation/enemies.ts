// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Enemy spawn placement: complexity-scaled packs, Elites, and the Edge Case
 * enemies that populate corridor-breakup rooms. */
import type { CodeEntity } from "../../parser/types";
import type { Enemy, Point, Rect, Room, Tile } from "../types";
import { neighbors } from "./util";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

/** Extra enemies spawned per this many complexity points, beyond the first. */
const COMPLEXITY_PER_EXTRA_ENEMY = 10;
/**
 * Complexity at/above which a function spawns as a single Elite enemy instead
 * of a pack — this is exactly the complexity a pack would hit 5 members at
 * (`1 + floor(40/10)`), so "extreme complexity" means "would otherwise be the
 * biggest kind of pack, so make it one boss-tier threat instead."
 */
const ELITE_COMPLEXITY_THRESHOLD = 40;
/** An Elite's HP is this multiple of what a *single* (non-pack) enemy would
 * have at the same complexity — not the pack's already-split-down HP. */
const ELITE_HP_MULTIPLIER = 4;

/** Enemies spawned per breakup room, range [min, max]. */
const EDGE_CASE_MIN_PER_ROOM = 1;
const EDGE_CASE_MAX_PER_ROOM = 3;
/** An Edge Case enemy's HP, range [min, max] — a "literal bug in the system"
 * dies almost instantly, on purpose. */
const EDGE_CASE_HP_MIN = 10;
const EDGE_CASE_HP_MAX = 15;

/**
 * Populate rooms with enemies. Classes, interfaces, and traits get rooms but no
 * enemy — only callable entities are "monsters". A room's total HP scales with
 * the entity's cyclomatic complexity; highly complex functions split that into
 * a pack (one extra enemy per 10 complexity points) rather than a single boss
 * — unless complexity crosses `ELITE_COMPLEXITY_THRESHOLD`, in which case it's
 * a single Elite instead of the biggest packs (see `Enemy.elite`). Placements
 * avoid the exit tile so the 'return' marker stays visible, and — for a
 * multiplayer session — every point in `multiplayerSpawns` too, since a pack's
 * first member always anchors exactly on its room's center (see
 * `enemyPositions`), the same point `pickMultiplayerSpawns` draws from.
 */
export function spawnEnemies(
  rooms: Room[],
  exit: Point,
  rng: () => number,
  multiplayerSpawns: readonly Point[] = [],
): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of rooms) {
    if (room.entity.kind !== "function" && room.entity.kind !== "method") continue;

    const complexity = Math.max(1, room.entity.complexityScore);
    const elite = complexity >= ELITE_COMPLEXITY_THRESHOLD;
    const count = elite ? 1 : 1 + Math.floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY);
    // Split the room's HP budget across the pack so total toughness is stable
    // — an Elite instead gets a flat multiple of a single enemy's HP at this
    // complexity, since it's replacing the pack entirely, not just its first
    // member.
    const hp = elite
      ? complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER
      : Math.max(HP_PER_COMPLEXITY, Math.round((complexity * HP_PER_COMPLEXITY) / count));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };

    for (const pos of enemyPositions(room, count, exit, rng, multiplayerSpawns)) {
      enemies.push({
        x: pos.x,
        y: pos.y,
        hp,
        maxHp: hp,
        alive: true,
        attackCooldown: 0,
        hitFlash: 0,
        home,
        aggroed: false,
        discovered: false,
        roamX: pos.x,
        roamY: pos.y,
        fireCooldown: rng() * 2, // stagger initial shots across the pack
        entity: room.entity,
        elite,
        edgeCase: false,
      });
    }
  }
  return enemies;
}

/**
 * `p`, snapped to the nearest actual floor tile within `rect` (BFS outward
 * from `p`'s own tile, never leaving `rect`'s bounds). Unlike a normal
 * rectangular room, a breakup room's interior isn't fully open floor — it
 * has an internal baffle wall (see `breakUpRoomSightline`) — so `enemyPositions`'
 * raw geometric picks (in particular, its first-enemy-at-room-center pick,
 * which for a small odd-dimensioned room often lands exactly on the baffle)
 * can land on a wall tile. Returning `p` unsnapped there and letting
 * `clearCriticalTiles` force-floor it later would punch a hole straight
 * through the baffle at that exact spot, defeating the whole point of it.
 */
function nearestFloorInRect(grid: Tile[][], rect: Rect, p: Point): Point {
  const startX = Math.floor(p.x);
  const startY = Math.floor(p.y);
  if (grid[startY]?.[startX] === 0) return p;

  const seen = new Set<string>([`${startX},${startY}`]);
  const queue: Point[] = [{ x: startX, y: startY }];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of neighbors(cur)) {
      if (n.x < rect.x || n.x >= rect.x + rect.w || n.y < rect.y || n.y >= rect.y + rect.h) continue;
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (grid[n.y][n.x] === 0) return { x: n.x + 0.5, y: n.y + 0.5 };
      queue.push(n);
    }
  }
  return p;
}

/**
 * Populate every corridor-breakup room (see `breakUpLongCorridors`) with 1-3
 * "Edge Case" enemies — small, fast, low-HP nuisances that break up the
 * "endless walk" feeling of a long corridor stretch. Modeled directly on
 * `placeTodoEncounter`'s enemy branch: a synthetic `CodeEntity` stands in for
 * the (nonexistent) parsed entity a breakup room would otherwise need. Never
 * spawns in a normal AST-derived room, and normal enemies never spawn here —
 * both are guaranteed structurally, since `spawnEnemies` only ever iterates
 * `rooms: Room[]` and this only ever iterates `breakupRooms: Rect[]`.
 *
 * No `multiplayerSpawns` avoid-list needed here, unlike `spawnEnemies`: a
 * breakup room is only ever injected where it doesn't overlap any real room
 * (`roomsOverlap(..., roomMargin)` in `breakup.ts`), and a multiplayer spawn
 * is always a real room's center — so one can never land inside a breakup
 * room's rect in the first place.
 */
export function spawnEdgeCaseEnemies(grid: Tile[][], breakupRooms: Rect[], exit: Point, rng: () => number): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of breakupRooms) {
    const count =
      EDGE_CASE_MIN_PER_ROOM + Math.floor(rng() * (EDGE_CASE_MAX_PER_ROOM - EDGE_CASE_MIN_PER_ROOM + 1));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };
    const entity: CodeEntity = {
      name: "EdgeCase",
      kind: "class",
      startLine: 0,
      endLine: 0,
      complexityScore: 1,
      nestingDepth: 0,
    };

    for (const rawPos of enemyPositions(room, count, exit, rng)) {
      const pos = nearestFloorInRect(grid, room, rawPos);
      const hp = EDGE_CASE_HP_MIN + Math.floor(rng() * (EDGE_CASE_HP_MAX - EDGE_CASE_HP_MIN + 1));
      enemies.push({
        x: pos.x,
        y: pos.y,
        hp,
        maxHp: hp,
        alive: true,
        attackCooldown: 0,
        hitFlash: 0,
        home,
        aggroed: false,
        discovered: false,
        roamX: pos.x,
        roamY: pos.y,
        fireCooldown: rng() * 2,
        entity,
        elite: false,
        edgeCase: true,
      });
    }
  }
  return enemies;
}

/**
 * Fractional spawn points for a room's enemy pack: the first at the room center,
 * the rest scattered randomly inside it. Any point landing on the exit tile, or
 * (for a multiplayer session) a point in `avoidSpawns`, is re-rolled (then
 * nudged to a corner as a last resort) so nothing hides it or spawns a player
 * on top of a monster.
 *
 * Every candidate is snapped to the center of whichever tile it falls in
 * before being returned — not left at its raw continuous (or, for the room
 * center, possibly boundary-straddling) coordinate. Two things otherwise leave
 * an enemy's collision box (`ENEMY_RADIUS` in `enemyAi.ts`) overlapping a
 * neighboring wall tile, which visually looks like it's embedded in the wall:
 * a room center calculated as `room.x + room.w / 2` lands exactly *on* a grid
 * line whenever `room.w`/`room.h` is even, straddling up to four tiles instead
 * of centering in one; and for a labyrinth room (deeply nested functions —
 * most of its bounding rectangle is actually wall, not floor), a fully
 * continuous random point can land close enough to an internal maze wall for
 * the same overlap even without hitting a boundary exactly. `clearCriticalTiles`
 * already force-clears the one tile under each enemy's *position* to
 * guarantee it's floor — snapping to that tile's center is what makes the
 * enemy's full collision box actually fit inside it, on every side.
 */
function enemyPositions(
  room: Rect,
  count: number,
  exit: Point,
  rng: () => number,
  avoidSpawns: readonly Point[] = [],
): Point[] {
  const spots: Point[] = [];
  const blocked = (p: Point): boolean => {
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);
    if (tx === exit.x && ty === exit.y) return true;
    return avoidSpawns.some((s) => tx === s.x && ty === s.y);
  };
  const randomInRoom = (): Point => ({
    x: room.x + 0.5 + rng() * (room.w - 1),
    y: room.y + 0.5 + rng() * (room.h - 1),
  });
  const tileCenter = (p: Point): Point => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 });

  for (let i = 0; i < count; i++) {
    // First enemy anchors at the room center; the rest scatter randomly.
    let p = tileCenter(i === 0 ? { x: room.x + room.w / 2, y: room.y + room.h / 2 } : randomInRoom());
    for (let guard = 0; blocked(p) && guard < 8; guard++) p = tileCenter(randomInRoom());
    if (blocked(p)) p = { x: room.x + 1.5, y: room.y + 1.5 }; // last-resort corner
    spots.push(p);
  }
  return spots;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Corridor carving between rooms, plus shared corridor-tile predicates. */
import type { Point, Rect, Room, Tile } from "../types";
import { doorwayRunCount, isLockableRoom } from "./geometry";
import { clamp, shuffle } from "./util";

/** Manhattan distance beyond which a corridor gets 1-2 jogs instead of a
 * single straight L-turn, so long hallways don't offer one full sightline. */
const CORRIDOR_JOG_THRESHOLD = 10;
/** Perpendicular jitter applied to each corridor jog waypoint, in tiles. */
const CORRIDOR_JOG_JITTER = 3;

/**
 * Chain the rooms together with corridors (room i ↔ room i-1), guaranteeing
 * the whole level is reachable from the spawn.
 */
export function connectRooms(rooms: Room[], grid: Tile[][], rng: () => number): void {
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(grid, rooms[i - 1].center, rooms[i].center, rng);
  }
}

/** Extra corridors carved per room, on top of the parse-order chain. 0.4 puts
 * 2 shortcuts on a typical 6-room level — enough that a level has junctions
 * and a way round, few enough that it doesn't dissolve into open space.
 * Best-effort: a level whose rooms are all locked, or all far apart, simply
 * gets fewer or none. */
const LOOP_EDGE_RATIO = 0.4;
/** How far apart (manhattan, center to center) two rooms may be and still be
 * worth joining with a shortcut. Beyond this the "shortcut" is longer than
 * the chain route it bypasses, which is just another long corridor. */
const LOOP_MAX_DISTANCE = 30;
/** How far apart two rooms must be *along the chain* before a shortcut
 * between them means anything. Adjacent rooms are already connected. */
const LOOP_MIN_CHAIN_GAP = 2;

/**
 * Carve a handful of extra corridors between rooms that are physically close
 * but far apart along the parse-order chain, turning the level from a pure
 * tree into something with junctions, alternate routes and loops. Returns the
 * room-index pairs actually joined.
 *
 * The chain stays the spine — progression still follows the source file's
 * reading order, and `connectRooms` alone is still what guarantees every room
 * is reachable. These are additions on top, so they can only ever *add*
 * connectivity; `assertAllRoomsReachable` cannot start failing because of one.
 *
 * **A shortcut must never cost the player a key.** `placeDoors` turns every
 * corridor mouth of a private/protected method room into a door and
 * `placeKeys` bills one key per doorway, so a shortcut that opens a new way
 * into a locked room doesn't shorten the route — it lengthens it by another
 * key-fetch, silently, while still looking like a shortcut on the map. Locked
 * rooms are excluded as endpoints, and every carve is then *verified*: each
 * locked room's doorway count is taken before and after, and a shortcut that
 * moved any of them is undone tile by tile (`carved`). Verifying rather than
 * predicting is the point — a corridor's exact path depends on jittered
 * waypoints, so any geometric test would have to be conservative enough to
 * reject most of the candidates that are in fact fine.
 */
export function connectLoops(rooms: Room[], grid: Tile[][], rng: () => number): [number, number][] {
  const budget = Math.floor(rooms.length * LOOP_EDGE_RATIO);
  if (budget < 1) return [];

  const locked = rooms.filter((room, index) => isLockableRoom(room, index));
  const candidates: [number, number][] = [];
  for (let i = 0; i < rooms.length; i++) {
    if (isLockableRoom(rooms[i], i)) continue;
    for (let j = i + LOOP_MIN_CHAIN_GAP; j < rooms.length; j++) {
      if (isLockableRoom(rooms[j], j)) continue;
      const a = rooms[i].center;
      const b = rooms[j].center;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > LOOP_MAX_DISTANCE) continue;
      candidates.push([i, j]);
    }
  }

  shuffle(candidates, rng);
  const joined: [number, number][] = [];
  const used = new Set<number>();
  for (const [i, j] of candidates) {
    if (joined.length >= budget) break;
    // One shortcut per room keeps them spread across the level instead of
    // clustering every extra edge onto whichever room happens to sit in the
    // middle of the cluster.
    if (used.has(i) || used.has(j)) continue;

    const before = locked.map((room) => doorwayRunCount(room, grid));
    const carved: Point[] = [];
    carveCorridor(grid, rooms[i].center, rooms[j].center, rng, carved);
    if (locked.some((room, k) => doorwayRunCount(room, grid) !== before[k])) {
      for (const tile of carved) grid[tile.y][tile.x] = 1;
      continue;
    }

    used.add(i);
    used.add(j);
    joined.push([i, j]);
  }
  return joined;
}

/**
 * Carve a corridor between two points. Short hops stay a single L-turn; long
 * ones (see `corridorWaypoints`) pick up 1-2 jittered intermediate waypoints so
 * the path bends instead of offering one long straight sightline. Each leg
 * alternates which axis goes first, so consecutive jogs don't all bend the
 * same way.
 */
function carveCorridor(grid: Tile[][], from: Point, to: Point, rng: () => number, carved?: Point[]): void {
  const waypoints = corridorWaypoints(from, to, grid.length, rng);
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (i % 2 === 1) {
      carveHLine(grid, a.x, b.x, a.y, carved);
      carveVLine(grid, a.y, b.y, b.x, carved);
    } else {
      carveVLine(grid, a.y, b.y, a.x, carved);
      carveHLine(grid, a.x, b.x, b.y, carved);
    }
  }
}

/**
 * Intermediate turn points between two room centers. Distances at/under
 * `CORRIDOR_JOG_THRESHOLD` stay a plain two-point (single L-turn) path; longer
 * ones get 1-2 waypoints placed along the line and jittered perpendicular to
 * it, clamped inside the map border.
 */
function corridorWaypoints(from: Point, to: Point, size: number, rng: () => number): Point[] {
  const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (manhattan <= CORRIDOR_JOG_THRESHOLD) return [from, to];

  const jogs = Math.min(2, Math.floor(manhattan / CORRIDOR_JOG_THRESHOLD));
  const points: Point[] = [from];
  for (let i = 1; i <= jogs; i++) {
    const t = i / (jogs + 1);
    const bx = from.x + (to.x - from.x) * t;
    const by = from.y + (to.y - from.y) * t;
    const jx = clamp(Math.round(bx + (rng() * 2 - 1) * CORRIDOR_JOG_JITTER), 1, size - 2);
    const jy = clamp(Math.round(by + (rng() * 2 - 1) * CORRIDOR_JOG_JITTER), 1, size - 2);
    points.push({ x: jx, y: jy });
  }
  points.push(to);
  return points;
}

/** Carve a horizontal run to floor. `carved`, when given, collects every tile
 * this actually turned from rock into floor — enough to undo the carve, which
 * is what lets `connectLoops` try a shortcut and take it back. */
export function carveHLine(grid: Tile[][], x1: number, x2: number, y: number, carved?: Point[]): void {
  const [lo, hi] = x1 <= x2 ? [x1, x2] : [x2, x1];
  for (let x = lo; x <= hi; x++) {
    if (carved && grid[y][x] === 1) carved.push({ x, y });
    grid[y][x] = 0;
  }
}

/** Carve a vertical run to floor — see `carveHLine` for `carved`. */
export function carveVLine(grid: Tile[][], y1: number, y2: number, x: number, carved?: Point[]): void {
  const [lo, hi] = y1 <= y2 ? [y1, y2] : [y2, y1];
  for (let y = lo; y <= hi; y++) {
    if (carved && grid[y][x] === 1) carved.push({ x, y });
    grid[y][x] = 0;
  }
}

/** A floor tile that belongs to no room and no breakup room — i.e. part of a
 * plain corridor. */
export function isCorridorFloor(x: number, y: number, grid: Tile[][], rooms: Room[], breakupRooms: Rect[]): boolean {
  if (grid[y][x] !== 0) return false;
  for (const room of rooms) {
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return false;
  }
  for (const room of breakupRooms) {
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return false;
  }
  return true;
}

/**
 * A "choke point": a corridor tile exactly one tile wide in cross-section —
 * open on both sides along one axis, blocked on both sides along the other.
 * Traps are placed only here, never in open room floor, so they read as a
 * deliberate hazard blocking a passage rather than random floor clutter.
 */
export function isChokePoint(x: number, y: number, grid: Tile[][]): boolean {
  const blocked = (cx: number, cy: number): boolean =>
    cy < 0 || cy >= grid.length || cx < 0 || cx >= grid[cy].length || grid[cy][cx] === 1;
  const openL = !blocked(x - 1, y);
  const openR = !blocked(x + 1, y);
  const openU = !blocked(x, y - 1);
  const openD = !blocked(x, y + 1);
  return (openL && openR && !openU && !openD) || (openU && openD && !openL && !openR);
}

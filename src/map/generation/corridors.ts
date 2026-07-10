// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Corridor carving between rooms, plus shared corridor-tile predicates. */
import type { Point, Rect, Room, Tile } from "../types";
import { clamp } from "./util";

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

/**
 * Carve a corridor between two points. Short hops stay a single L-turn; long
 * ones (see `corridorWaypoints`) pick up 1-2 jittered intermediate waypoints so
 * the path bends instead of offering one long straight sightline. Each leg
 * alternates which axis goes first, so consecutive jogs don't all bend the
 * same way.
 */
function carveCorridor(grid: Tile[][], from: Point, to: Point, rng: () => number): void {
  const waypoints = corridorWaypoints(from, to, grid.length, rng);
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (i % 2 === 1) {
      carveHLine(grid, a.x, b.x, a.y);
      carveVLine(grid, a.y, b.y, b.x);
    } else {
      carveVLine(grid, a.y, b.y, a.x);
      carveHLine(grid, a.x, b.x, b.y);
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

export function carveHLine(grid: Tile[][], x1: number, x2: number, y: number): void {
  const [lo, hi] = x1 <= x2 ? [x1, x2] : [x2, x1];
  for (let x = lo; x <= hi; x++) grid[y][x] = 0;
}

export function carveVLine(grid: Tile[][], y1: number, y2: number, x: number): void {
  const [lo, hi] = y1 <= y2 ? [y1, y2] : [y2, y1];
  for (let y = lo; y <= hi; y++) grid[y][x] = 0;
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

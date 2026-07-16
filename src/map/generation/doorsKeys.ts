// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Door placement on private/protected method rooms, and the matching
 * solvable-in-key-order key scatter. */
import { DOOR_TILE, type Enemy, type KeyItem, type Point, type Rect, type Room, type Tile } from "../types";
import { breakupTileKeys } from "./breakup";
import { reachableTiles } from "./pathing";
import { key, neighbors } from "./util";

/**
 * Lock each private/protected-method room by turning its corridor mouths (the
 * open floor tiles just outside the room that lead into it) into door tiles.
 * The spawn room is never locked. Returns the door tiles placed.
 */
export function placeDoors(rooms: Room[], grid: Tile[][]): Point[] {
  const doors: Point[] = [];
  rooms.forEach((room, index) => {
    if (index === 0) return; // never lock the spawn room
    const vis = room.entity.visibility;
    if (room.entity.kind !== "method" || (vis !== "private" && vis !== "protected")) {
      return;
    }
    for (const mouth of roomMouths(room, grid)) {
      grid[mouth.y][mouth.x] = DOOR_TILE;
      doors.push(mouth);
    }
  });
  return doors;
}

/** Floor tiles just outside `room` that connect into it (corridor mouths). */
function roomMouths(room: Room, grid: Tile[][]): Point[] {
  const mouths: Point[] = [];
  const consider = (ox: number, oy: number, ix: number, iy: number): void => {
    if (grid[oy]?.[ox] === 0 && grid[iy]?.[ix] === 0) mouths.push({ x: ox, y: oy });
  };
  for (let x = room.x; x < room.x + room.w; x++) {
    consider(x, room.y - 1, x, room.y); // top
    consider(x, room.y + room.h, x, room.y + room.h - 1); // bottom
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    consider(room.x - 1, y, room.x, y); // left
    consider(room.x + room.w, y, room.x + room.w - 1, y); // right
  }
  return mouths;
}

/**
 * Scatter one "dependency key" per door, each in an area reachable *before* its
 * door opens. Simulates unlocking: repeatedly find a door on the frontier of
 * the currently-reachable region, drop a key on reachable public floor, then
 * open that door and expand. This keeps every level solvable in key order.
 */
export function placeKeys(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
  doors: Point[],
  breakupRooms: Rect[],
  rng: () => number,
): KeyItem[] {
  if (doors.length === 0) return [];

  const keys: KeyItem[] = [];
  const opened = new Set<string>();
  const used = new Set<string>([
    key(spawn),
    key(exit),
    ...enemies.map((e) => key({ x: Math.floor(e.x), y: Math.floor(e.y) })),
    ...breakupTileKeys(breakupRooms),
  ]);
  // Reachable set from the previous iteration, so each key can be confined
  // to the room its own door just unlocked (see `newlyReachable` below)
  // instead of the ever-growing cumulative reachable set, which would let
  // the (usually largest) initial public area dominate every pick.
  let previousReachable = new Set<string>();

  while (opened.size < doors.length) {
    const reachable = reachableTiles(grid, spawn, opened);
    const frontier = doors.find(
      (d) => !opened.has(key(d)) && neighbors(d).some((n) => reachable.has(key(n))),
    );
    if (!frontier) break; // remaining doors are unreachable dead-ends

    const newlyReachable = new Set([...reachable].filter((k) => !previousReachable.has(k)));
    // Fall back to the full reachable set only when the newly-opened area
    // has no usable tile left (e.g. a door that loops back into already-
    // explored floor) — better than silently dropping the key.
    const spot = pickKeySpot(newlyReachable, grid, used, rng) ?? pickKeySpot(reachable, grid, used, rng);
    if (spot) {
      used.add(key(spot));
      keys.push({ x: spot.x + 0.5, y: spot.y + 0.5, collected: false });
    }
    opened.add(key(frontier));
    previousReachable = reachable;
  }
  return keys;
}

/** Pick a random reachable open-floor tile for a key (not already used). */
function pickKeySpot(
  reachable: Set<string>,
  grid: Tile[][],
  used: Set<string>,
  rng: () => number,
): Point | null {
  const candidates: Point[] = [];
  for (const k of reachable) {
    if (used.has(k)) continue;
    const [x, y] = k.split(",").map(Number);
    if (grid[y][x] === 0) candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

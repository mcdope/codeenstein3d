// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Grid reachability / shortest-path helpers over the finished tile grid. */
import { DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, type Point, type Room, type Tile } from "../types";
import { key, neighbors } from "./util";

/** BFS of tiles reachable from spawn; walls and unopened doors block. */
export function reachableTiles(grid: Tile[][], spawn: Point, opened: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: Point[] = [spawn];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const k = key(p);
    if (seen.has(k)) continue;
    const tile = grid[p.y]?.[p.x];
    if (tile === undefined || tile === 1) continue; // wall / out of bounds
    if (tile === DOOR_TILE && !opened.has(k)) continue; // still-locked door
    seen.add(k);
    for (const n of neighbors(p)) stack.push(n);
  }
  return seen;
}

/**
 * BFS-shortest tile distance from `spawn` to `exit` over the finished grid.
 * Walls, secret walls, and lore terminals block; a locked door doesn't — a
 * perfect run always ends up opening every door along its route anyway, so
 * the "ideal" path ignores key-gating and just measures raw geometry (see
 * `GameMap.shortestPathTiles`'s doc comment). Falls back to 0 (no path bonus,
 * rather than a crash) in the unreachable case, which generation shouldn't
 * actually produce given corridors always connect every room.
 */
export function shortestPath(grid: Tile[][], spawn: Point, exit: Point): number {
  const start = key(spawn);
  const target = key(exit);
  if (start === target) return 0;

  const dist = new Map<string, number>([[start, 0]]);
  const queue: Point[] = [spawn];
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const d = dist.get(key(p))!;
    if (key(p) === target) return d;
    for (const n of neighbors(p)) {
      const nk = key(n);
      if (dist.has(nk)) continue;
      const tile = grid[n.y]?.[n.x];
      if (tile === undefined || tile === 1 || tile === SECRET_WALL_TILE || tile === LORE_TILE) continue;
      dist.set(nk, d + 1);
      queue.push(n);
    }
  }
  return dist.get(target) ?? 0;
}

/**
 * Dev-time safety net: every room's center should be reachable from spawn
 * under the *real* key-gated unlock model — collect any reachable key, spend
 * one to open a reachable still-locked door, repeat — not "if every door
 * were already open." That looser check used to be this function's whole
 * strategy (doors counted as opened regardless of key state), on the
 * assumption that generation always guarantees every door is eventually
 * openable — but `placeKeys` has one accepted fallback path (see its own
 * doc comment: "skips placing a key... when every reachable tile is already
 * used") that could in principle leave a door with no matching key anywhere
 * in `keys`. A real-world sweep of 600+ diverse third-party files across 11
 * languages found zero cases of this actually stranding a room, so it's
 * evidently rare — but "evidently rare" isn't the same as "structurally
 * impossible," which is what this function exists to catch. Should never
 * actually fire; logs a spoiler-free count (no coordinates) if it does, so a
 * future generation regression is loud instead of silently shipping an
 * unreachable (or truly unsolvable) room.
 */
export function assertAllRoomsReachable(grid: Tile[][], spawn: Point, rooms: Room[], doors: Point[], keys: readonly Point[]): void {
  const opened = new Set<string>();
  const collectedKeys = new Set<string>();
  let keysHeld = 0;
  for (let i = 0; i <= doors.length; i++) {
    const reachable = reachableTiles(grid, spawn, opened);
    for (const k of keys) {
      const tileKey = key({ x: Math.floor(k.x), y: Math.floor(k.y) });
      if (!collectedKeys.has(tileKey) && reachable.has(tileKey)) {
        collectedKeys.add(tileKey);
        keysHeld++;
      }
    }
    const frontierDoor = doors.find((d) => !opened.has(key(d)) && neighbors(d).some((n) => reachable.has(key(n))));
    if (!frontierDoor || keysHeld <= 0) break;
    opened.add(key(frontierDoor));
    keysHeld--;
  }
  const reachable = reachableTiles(grid, spawn, opened);
  const unreachable = rooms.filter((r) => !reachable.has(key(r.center))).length;
  if (unreachable > 0) {
    console.error(`[map] ${unreachable} room(s) unreachable from spawn — this should never happen`);
  }
}

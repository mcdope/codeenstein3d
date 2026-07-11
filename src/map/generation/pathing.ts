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
 * Dev-time safety net: every room's center should be reachable from spawn.
 * Doors count as opened regardless of key state — same reasoning as
 * `shortestPath`'s doc comment: generation guarantees every door is
 * eventually openable, so this checks raw structural connectivity, not
 * lock state. Should never actually fire; logs a spoiler-free count (no
 * coordinates) if it does, so a future generation regression is loud
 * instead of silently shipping an unreachable room.
 */
export function assertAllRoomsReachable(grid: Tile[][], spawn: Point, rooms: Room[], doors: Point[]): void {
  const opened = new Set(doors.map(key));
  const reachable = reachableTiles(grid, spawn, opened);
  const unreachable = rooms.filter((r) => !reachable.has(key(r.center))).length;
  if (unreachable > 0) {
    console.error(`[map] ${unreachable} room(s) unreachable from spawn — this should never happen`);
  }
}

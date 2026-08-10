// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Grid reachability / shortest-path helpers over the finished tile grid. */
import { DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, type Gate, type KeyItem, type Point, type Room, type Tile } from "../types";
import { doorwayTiles } from "./geometry";
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
    // A branch door (8) is deliberately NOT gated here: it costs no key, so
    // anything behind one is reachable the moment the player walks into it.
    // Treating it as blocking would make `assertAllRoomsReachable` report a
    // false isolation for a Switchboard hub whose only mouth is a spoke.
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
 * Runs on every `generate()` call, in production builds too — deliberately,
 * and not gated behind `import.meta.env.DEV`. This is the map layer's one hard
 * invariant (see `decisions.md`'s "Room Connectivity Is a Hard Guarantee,
 * Corridor Length Isn't"), and a shipped build is exactly where nothing else
 * would catch a violation: an unreachable room is unwinnable, and silently so.
 * The cost is one BFS per door on top of a generation pass that already does
 * far more work than that, paid once per level load rather than per frame.
 *
 * Every room's center should be reachable from spawn under the *real*
 * key-gated unlock model — collect any reachable key, open any gate whose key
 * you now hold, repeat — not "if every door were already open." That looser
 * check used to be this function's whole strategy, on the assumption that
 * generation always guarantees every door is eventually openable.
 *
 * **Stricter since keys became per-gate (2026-08-10).** The old simulation
 * counted keys as fungible: a surplus key from one gate paid for another whose
 * own key was never found, so a mis-assigned or missing key was invisible here.
 * A gate now opens only when *its* key has been collected, which is exactly the
 * generator bug this function exists to catch. `placeKeys` guarantees one key
 * per gate (un-gating a room rather than shipping a keyless door), so this
 * should never fire — it logs a spoiler-free count, no coordinates, so a future
 * generation regression is loud instead of silently shipping an unreachable
 * room.
 */
export function assertAllRoomsReachable(
  grid: Tile[][],
  spawn: Point,
  rooms: Room[],
  gates: readonly Gate[],
  keys: readonly KeyItem[],
): void {
  const opened = new Set<string>();
  const held = new Set<number>();
  const openedGates = new Set<number>();
  for (let i = 0; i <= gates.length; i++) {
    const reachable = reachableTiles(grid, spawn, opened);
    for (const k of keys) {
      if (reachable.has(key({ x: Math.floor(k.x), y: Math.floor(k.y) }))) held.add(k.gateId);
    }
    // Skip an unpayable gate and try the next, rather than stopping at the
    // first one on the frontier. With fungible keys any frontier door was
    // payable, so taking the first was safe; now it would report a level
    // unreachable that the player can finish by opening a different gate.
    const frontier = gates.find(
      (g) => !openedGates.has(g.id) && held.has(g.id) && g.doors.some((d) => neighbors(d).some((n) => reachable.has(key(n)))),
    );
    if (!frontier) break;
    // A key is never spent and opens every door of its own gate, so opening the
    // whole set here is the fixpoint of the player pushing each mouth in turn.
    openedGates.add(frontier.id);
    for (const door of frontier.doors) for (const tile of doorwayTiles(grid, door)) opened.add(key(tile));
  }
  const reachable = reachableTiles(grid, spawn, opened);
  const unreachable = rooms.filter((r) => !reachable.has(key(r.center))).length;
  if (unreachable > 0) {
    console.error(`[map] ${unreachable} room(s) unreachable from spawn — this should never happen`);
  }
}

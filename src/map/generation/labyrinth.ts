// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Labyrinth carving for deeply nested entities (recursive division). */
import type { Point, Room, Tile } from "../types";
import { key, neighbors } from "./util";

/** Nesting depth at/above which an entity's room becomes a labyrinth. */
export const MAZE_THRESHOLD = 2;

/**
 * Turn an already-carved room into a labyrinth by recursive division: split the
 * region with a wall (value `1`, native to the raycaster) that has a single
 * 1-tile gap, then recurse into each half. The recursion budget scales with
 * `nestingDepth`, so deeper code yields a denser maze. Every passage stays ≥1
 * tile wide.
 *
 * Each individual split keeps exactly one connecting gap, but that alone
 * doesn't guarantee the *whole* room ends up one connected region: a child's
 * own later wall can happen to cross the exact cell its parent's gap relies
 * on to reach it, sealing that child off even though every split "kept a
 * gap" (notes:155 — this, not a room-count bug, turned out to be the actual
 * cause of the originally-reported exit-less spawn room). `repairConnectivity`
 * cleans this up unconditionally afterward, so this function's connectivity
 * guarantee holds regardless of how the recursive split happens to fall.
 */
export function carveLabyrinth(grid: Tile[][], room: Room, nestingDepth: number, rng: () => number): void {
  const budget = Math.min(nestingDepth, 6);
  divide(grid, room.x, room.y, room.x + room.w - 1, room.y + room.h - 1, budget, rng);
  repairConnectivity(grid, room);
}

function divide(
  grid: Tile[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  budget: number,
  rng: () => number,
): void {
  if (budget <= 0) return;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  // A region needs ≥3 tiles along an axis to hold a wall plus a floor either
  // side (keeping passages ≥1 wide).
  const canHorizontal = h >= 3;
  const canVertical = w >= 3;
  if (!canHorizontal && !canVertical) return;

  const horizontal =
    canHorizontal && canVertical ? h > w || (h === w && rng() < 0.5) : canHorizontal;

  if (horizontal) {
    const wallY = y0 + 1 + Math.floor(rng() * (h - 2)); // interior row
    for (let x = x0; x <= x1; x++) grid[wallY][x] = 1;
    grid[wallY][x0 + Math.floor(rng() * w)] = 0; // one 1-wide passage
    divide(grid, x0, y0, x1, wallY - 1, budget - 1, rng);
    divide(grid, x0, wallY + 1, x1, y1, budget - 1, rng);
  } else {
    const wallX = x0 + 1 + Math.floor(rng() * (w - 2)); // interior column
    for (let y = y0; y <= y1; y++) grid[y][wallX] = 1;
    grid[y0 + Math.floor(rng() * h)][wallX] = 0; // one 1-wide passage
    divide(grid, x0, y0, wallX - 1, y1, budget - 1, rng);
    divide(grid, wallX + 1, y0, x1, y1, budget - 1, rng);
  }
}

/** Every disconnected floor component within `room`, as sets of `"x,y"`
 * keys (see `key`). Empty rooms (shouldn't happen post-`carveRoom`) yield
 * an empty array. */
function floorComponents(grid: Tile[][], room: Room): Set<string>[] {
  const assigned = new Set<string>();
  const components: Set<string>[] = [];
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      const start = { x, y };
      const startKey = key(start);
      if (grid[y][x] !== 0 || assigned.has(startKey)) continue;

      const component = new Set<string>();
      const stack: Point[] = [start];
      while (stack.length > 0) {
        const p = stack.pop()!;
        const k = key(p);
        if (component.has(k)) continue;
        if (p.x < room.x || p.x >= room.x + room.w || p.y < room.y || p.y >= room.y + room.h) continue;
        if (grid[p.y][p.x] !== 0) continue;
        component.add(k);
        assigned.add(k);
        for (const n of neighbors(p)) stack.push(n);
      }
      components.push(component);
    }
  }
  return components;
}

/**
 * Carves the shortest possible connector (fewest wall tiles crossed, via a
 * 0-1 BFS — floor-to-floor moves cost 0, crossing a wall costs 1) between
 * any cell of `a` and any cell of `b`, confined to `room`. Small enough
 * regions (a room is at most 18×18 tiles) that a straightforward
 * multi-source search is plenty fast.
 */
function bridgeComponents(grid: Tile[][], room: Room, a: Set<string>, b: Set<string>): void {
  const dist = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const deque: string[] = [];
  for (const k of a) {
    dist.set(k, 0);
    parent.set(k, null);
    deque.push(k);
  }

  while (deque.length > 0) {
    const k = deque.shift()!;
    if (b.has(k)) {
      for (let cur: string | null = k; cur !== null; cur = parent.get(cur) ?? null) {
        const [x, y] = cur.split(",").map(Number);
        grid[y][x] = 0;
      }
      return;
    }
    const [x, y] = k.split(",").map(Number);
    const d = dist.get(k)!;
    for (const n of neighbors({ x, y })) {
      if (n.x < room.x || n.x >= room.x + room.w || n.y < room.y || n.y >= room.y + room.h) continue;
      const nk = key(n);
      const cost = grid[n.y][n.x] === 1 ? 1 : 0;
      const nd = d + cost;
      if (dist.has(nk) && dist.get(nk)! <= nd) continue;
      dist.set(nk, nd);
      parent.set(nk, k);
      if (cost === 0) deque.unshift(nk);
      else deque.push(nk);
    }
  }
}

/** Merges every disconnected floor component `divide()` may have left
 * behind — see `carveLabyrinth`'s doc comment — until the room is one
 * connected region again. */
function repairConnectivity(grid: Tile[][], room: Room): void {
  for (;;) {
    const components = floorComponents(grid, room);
    if (components.length <= 1) return;
    bridgeComponents(grid, room, components[0], components[1]);
  }
}

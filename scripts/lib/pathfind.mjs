// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * 4-directional BFS over a generated `GameMap`'s grid, for the headless
 * campaign-playthrough verifier (scripts/verify-campaign-playthrough.mjs) to
 * walk the real player from spawn to a target tile without any maze-solving
 * logic living in the browser itself.
 *
 * Blocked tiles mirror `isWall()` in src/engine/player.ts: wall (1), locked
 * door (3), unopened secret wall (6), lore terminal (7). Hazard (2), floor
 * (0), teleporter (4), and spike trap (5) are all walkable.
 */
const BLOCKED_TILES = new Set([1, 3, 6, 7]);

/** Shortest tile path from `start` to `target` (inclusive of both ends), or
 * `null` if unreachable. Each returned point is an integer tile coordinate.
 *
 * `avoidTiles` (default none) additionally treats the given tile values as
 * impassable *except* at `target` itself — used to route a "safe" path (e.g.
 * to an exit) around damage sources like hazard(2)/spike-trap(5) tiles that
 * are structurally walkable but would hurt the player en route, while still
 * letting a *different* call deliberately target one of those tile types as
 * its destination (see `stage02`'s hazard-seeking path in
 * scripts/verify-campaign-playthrough.mjs). */
export function bfsPath(map, start, target, avoidTiles = new Set()) {
  const { width, height, grid } = map;
  const key = (x, y) => y * width + x;
  const visited = new Set([key(start.x, start.y)]);
  const parent = new Map();
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.x === target.x && cur.y === target.y) {
      const path = [cur];
      let k = key(cur.x, cur.y);
      while (parent.has(k)) {
        const p = parent.get(k);
        path.push(p);
        k = key(p.x, p.y);
      }
      return path.reverse();
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const tile = grid[ny][nx];
      const isTarget = nx === target.x && ny === target.y;
      if (BLOCKED_TILES.has(tile)) continue;
      if (!isTarget && avoidTiles.has(tile)) continue;
      const nk = key(nx, ny);
      if (visited.has(nk)) continue;
      visited.add(nk);
      parent.set(nk, cur);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

/** Tile-path -> waypoints at each tile's center (fractional world coords),
 * the coordinate space `PlayerState.x/y` (from the engine's test hook) uses. */
export function pathToWaypoints(path) {
  return path.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
}

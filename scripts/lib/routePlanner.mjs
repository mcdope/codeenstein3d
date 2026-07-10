// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Plans a spawn-to-exit route for `scripts/generate-default-highscore.mjs`,
 * on top of `pathfind.mjs`'s BFS: try a direct path to the exit; if the
 * locked-door graph blocks it, detour to the nearest reachable uncollected
 * key, then to the nearest locked door bordering the now-reachable region,
 * "open" it (see below), and retry. `mapGenerator.ts`'s own doc comment
 * guarantees every key is scattered somewhere reachable before its door, so
 * this terminates successfully unless the only route needs a teleporter or a
 * secret room — neither is ever modeled here (a teleporter mid-route would
 * warp the player somewhere the planned waypoint sequence doesn't account
 * for, so `TELEPORTER_TILE` stays a hard block always) — surfacing as a
 * planning failure, which the generation script treats as an expected,
 * non-fatal skip for that level.
 *
 * Hazard/spike tiles are handled with a two-tier preference instead of a
 * hard block: `planRoute` first tries a route that avoids them entirely, and
 * only if *no* such route exists anywhere in the plan, retries once more
 * allowing the bot to walk across them. A spike trap only damages during its
 * active phase (see the `Tile` doc comment in `src/map/types.ts`) and a
 * hazard pool's damage is a per-tick tick, not instant death — some levels
 * (confirmed empirically, e.g. `main.c`) only have a route across one, which
 * is exactly the situation `mapGenerator.ts`'s design already expects a real
 * player to handle, not a genuinely unsolvable layout.
 *
 * Runs entirely against a plain `GameMap` object (Node-side, no browser) —
 * "opening" a door here just means mutating a cloned copy of `map.grid` to
 * floor (`0`), exactly what the real `openDoorAhead()` does in-engine, so
 * every subsequent BFS call in the same plan sees it as already open.
 */
import { bfsPath, pathToWaypoints, reachableTiles } from "./pathfind.mjs";

const HAZARD_TILE = 2;
const DOOR_TILE = 3;
const TELEPORTER_TILE = 4;
const SPIKE_TRAP_TILE = 5;

/** Never deliberately routed through — a mid-route warp would invalidate the
 * rest of the planned waypoint sequence, which `bfsPath`'s plain tile-graph
 * model has no way to account for. */
const HARD_BLOCK_TILES = new Set([TELEPORTER_TILE]);
/** Preferred-avoid: walkable but damaging. See module doc comment for why
 * this is a soft preference (tried first, not a hard requirement). */
const SOFT_AVOID_TILES = new Set([HAZARD_TILE, SPIKE_TRAP_TILE]);

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function tileOf(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y) };
}

/** First locked-door tile adjacent to `reachable`, plus the reachable tile
 * it's approached from (so the caller can BFS a walk leg right up to it). */
function findReachableDoor(grid, reachable) {
  for (const key of reachable) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) continue;
      if (grid[ny][nx] === DOOR_TILE) return { door: { x: nx, y: ny }, from: { x, y } };
    }
  }
  return null;
}

function planRouteWithAvoidSet(map, avoidTiles) {
  const grid = map.grid.map((row) => [...row]);
  const workingMap = { width: map.width, height: map.height, grid };
  const collectedKeyIndices = new Set();
  let openedDoorCount = 0;
  const legs = [];
  let pos = { x: map.spawn.x, y: map.spawn.y };

  const MAX_ITERATIONS = 200; // generous — real levels resolve in well under 10
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const start = tileOf(pos);

    const pathToExit = bfsPath(workingMap, start, map.exit, avoidTiles);
    if (pathToExit) {
      legs.push({ kind: "walk", waypoints: pathToWaypoints(pathToExit) });
      return { ok: true, legs };
    }

    const reachable = reachableTiles(workingMap, start, avoidTiles);

    const keyIndex = map.keys.findIndex((k, idx) => {
      if (collectedKeyIndices.has(idx)) return false;
      return reachable.has(`${Math.floor(k.x)},${Math.floor(k.y)}`);
    });
    if (keyIndex !== -1) {
      const key = map.keys[keyIndex];
      const target = { x: Math.floor(key.x), y: Math.floor(key.y) };
      const path = bfsPath(workingMap, start, target, avoidTiles);
      if (!path) return { ok: false, reason: "key-reachable-but-no-bfs-path (inconsistent)", legs };
      legs.push({ kind: "walk", waypoints: pathToWaypoints(path) });
      collectedKeyIndices.add(keyIndex);
      pos = { x: target.x + 0.5, y: target.y + 0.5 };
      continue;
    }

    const heldKeys = collectedKeyIndices.size - openedDoorCount;
    if (heldKeys > 0) {
      const found = findReachableDoor(grid, reachable);
      if (found) {
        const path = bfsPath(workingMap, start, found.from, avoidTiles);
        if (!path) return { ok: false, reason: "door-approach-reachable-but-no-bfs-path (inconsistent)", legs };
        legs.push({ kind: "walk", waypoints: pathToWaypoints(path) });
        const approachDir = { dx: found.door.x - found.from.x, dy: found.door.y - found.from.y };
        legs.push({ kind: "openDoor", doorTile: found.door, approachDir });
        grid[found.door.y][found.door.x] = 0; // mirror openDoorAhead(): door tile becomes floor
        openedDoorCount += 1;
        pos = { x: found.door.x + 0.5, y: found.door.y + 0.5 };
        continue;
      }
    }

    return { ok: false, reason: "stuck: no path to exit, no reachable key, no reachable openable door", legs };
  }
  return { ok: false, reason: "iteration limit reached", legs };
}

/**
 * Plans a route from `map.spawn` to `map.exit`. Returns `{ ok: true, legs,
 * crossesHazard }` on success, or `{ ok: false, reason, legs }` (with
 * whatever partial plan the hazard-crossing attempt built) on failure.
 *
 * Each leg is either `{ kind: "walk", waypoints }` (a sequence of fractional
 * tile-center points to walk through, see `pathToWaypoints`) or
 * `{ kind: "openDoor", doorTile, approachDir }` — `approachDir` is the
 * cardinal `{dx,dy}` step from the immediately-preceding waypoint into the
 * door tile, which the browser-side bot uses to face the door and hold
 * `KeyW` for one tick (see `openDoorAhead()` in `src/engine/engine.ts`,
 * which reads facing + held W/S, not an explicit interact key).
 */
export function planRoute(map) {
  const safe = planRouteWithAvoidSet(map, new Set([...HARD_BLOCK_TILES, ...SOFT_AVOID_TILES]));
  if (safe.ok) return { ...safe, crossesHazard: false };

  const risky = planRouteWithAvoidSet(map, HARD_BLOCK_TILES);
  if (risky.ok) return { ...risky, crossesHazard: true };

  return risky; // { ok: false, reason, legs } from the more-permissive attempt
}

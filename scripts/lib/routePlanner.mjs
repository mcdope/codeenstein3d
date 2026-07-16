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
 * Hazard/spike tiles are routed with a weighted shortest path (Dijkstra, see
 * `weightedPath`) rather than a binary avoid-or-cross choice: they're
 * traversable, just expensive (`HAZARD_TILE_COST`x a normal floor tile), so a
 * route prefers detouring around a hazard/spike patch whenever a reasonably
 * short detour exists, but still finds a way across when that's genuinely
 * the only option. A binary choice can't express "prefer avoiding, but not
 * at any cost" — an earlier version tried exactly that (avoid entirely, or
 * not at all — first for the whole route, later per-leg) and both still
 * crossed straight through a hazard patch with a perfectly good detour
 * available, because *elsewhere* in the same route some other hazard/spike
 * tile had no avoiding path at all, and once *any* crossing was permitted
 * for that whole BFS call, plain unweighted BFS had no reason to prefer the
 * longer detour over the shorter through-the-hazard route (confirmed
 * empirically on `main.c`: a real detour exists around its one hazard pool
 * via the rooms to its north/south, but the route still went straight
 * through it both times). A spike trap only damages during its active phase
 * (see the `Tile` doc comment in `src/map/types.ts`) and a hazard pool's
 * damage is a per-tick tick, not instant death — so a cost penalty (not a
 * hard block) is exactly the right shape: still solvable when crossing is
 * genuinely necessary, exactly the situation `mapGenerator.ts`'s design
 * already expects a real player to handle.
 *
 * Runs entirely against a plain `GameMap` object (Node-side, no browser) —
 * "opening" a door here just means mutating a cloned copy of `map.grid` to
 * floor (`0`), exactly what the real `openDoorAhead()` does in-engine, so
 * every subsequent path call in the same plan sees it as already open.
 */
import { bfsPath, pathToWaypoints, reachableTiles } from "./pathfind.mjs";

const HAZARD_TILE = 2;
const DOOR_TILE = 3;
const TELEPORTER_TILE = 4;
const SPIKE_TRAP_TILE = 5;
/** Preferred-avoid set for `planCoverageRoute`'s own (still binary
 * avoid-or-cross) hazard handling — kept separate from `planRoute`'s
 * `weightedPath` since this function is currently unused by any live
 * profile (`coverageMode` is `false` everywhere) and not worth migrating
 * until it's actually back in use. */
const SOFT_AVOID_TILES = new Set([HAZARD_TILE, SPIKE_TRAP_TILE]);

/** Mirrors `pathfind.mjs`'s `bfsPath` blocked set (wall/locked-door/unopened-
 * secret/lore-terminal) plus the teleporter — a mid-route warp would
 * invalidate the rest of the planned waypoint sequence, which this plain
 * tile-graph model has no way to account for, so it's always a hard block
 * here (never a target either). */
const HARD_BLOCK_TILES = new Set([1, 3, 6, 7, TELEPORTER_TILE]);
/** How many "free" floor tiles' worth of detour `weightedPath` will accept
 * to avoid stepping on one hazard/spike-trap tile — high enough to prefer a
 * reasonably short detour, not so high that a genuinely-needed crossing on
 * a small level looks artificially expensive relative to the rest of the
 * route. */
const HAZARD_TILE_COST = 25;

/**
 * Dijkstra shortest path where hazard(2)/spike-trap(5) tiles cost
 * `HAZARD_TILE_COST`x a normal floor tile instead of being freely walkable
 * or fully blocked — see the module doc comment for why. Grids here are at
 * most a few thousand cells, so a plain array-scanned "priority queue"
 * (no binary heap) stays fast enough without the extra complexity.
 */
function weightedPath(map, start, target) {
  const { width, height, grid } = map;
  const key = (x, y) => y * width + x;
  const tileCost = (tile) => (tile === HAZARD_TILE || tile === SPIKE_TRAP_TILE ? HAZARD_TILE_COST : 1);

  const best = new Map([[key(start.x, start.y), 0]]);
  const parent = new Map();
  const frontier = [{ x: start.x, y: start.y, d: 0 }];

  while (frontier.length) {
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].d < frontier[bestIdx].d) bestIdx = i;
    const cur = frontier.splice(bestIdx, 1)[0];
    const curKey = key(cur.x, cur.y);
    if (cur.d > (best.get(curKey) ?? Infinity)) continue; // stale entry, already beaten
    if (cur.x === target.x && cur.y === target.y) {
      const path = [{ x: cur.x, y: cur.y }];
      let k = curKey;
      while (parent.has(k)) {
        const p = parent.get(k);
        path.push(p);
        k = key(p.x, p.y);
      }
      return path.reverse();
    }
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const tile = grid[ny][nx];
      if (HARD_BLOCK_TILES.has(tile)) continue;
      const nd = cur.d + tileCost(tile);
      const nk = key(nx, ny);
      if (nd >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, nd);
      parent.set(nk, { x: cur.x, y: cur.y });
      frontier.push({ x: nx, y: ny, d: nd });
    }
  }
  return null;
}

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

function planRouteWithAvoidSet(map) {
  const grid = map.grid.map((row) => [...row]);
  const workingMap = { width: map.width, height: map.height, grid };
  const collectedKeyIndices = new Set();
  let openedDoorCount = 0;
  const legs = [];
  let pos = { x: map.spawn.x, y: map.spawn.y };
  let crossesHazard = false;

  // Reachability just needs "structurally reachable at all" (hazard/spike
  // tiles are always traversable now, just costed — see `weightedPath`), so
  // this only needs to avoid the true hard blocks.
  const reach = (start) => reachableTiles(workingMap, start, HARD_BLOCK_TILES);
  const findPath = (start, target) => {
    const path = weightedPath(workingMap, start, target);
    if (path && pathCrossesHazard(workingMap, path)) crossesHazard = true;
    return path;
  };

  const MAX_ITERATIONS = 200; // generous — real levels resolve in well under 10
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const start = tileOf(pos);

    const pathToExit = findPath(start, map.exit);
    if (pathToExit) {
      legs.push({ kind: "walk", waypoints: pathToWaypoints(pathToExit) });
      return { ok: true, legs, crossesHazard };
    }

    const reachable = reach(start);
    const keyIndex = map.keys.findIndex((k, idx) => !collectedKeyIndices.has(idx) && reachable.has(`${Math.floor(k.x)},${Math.floor(k.y)}`));
    if (keyIndex !== -1) {
      const key = map.keys[keyIndex];
      const target = { x: Math.floor(key.x), y: Math.floor(key.y) };
      const path = findPath(start, target);
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
        const path = findPath(start, found.from);
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

/** Whether any waypoint in a `weightedPath` result actually lands on a
 * hazard/spike-trap tile — used to report `crossesHazard` on the built route
 * without needing `weightedPath` itself to track it. */
function pathCrossesHazard(map, path) {
  return path.some((p) => {
    const tile = map.grid[p.y]?.[p.x];
    return tile === HAZARD_TILE || tile === SPIKE_TRAP_TILE;
  });
}

/**
 * Plans a route from `map.spawn` to `map.exit`. Returns `{ ok: true, legs,
 * crossesHazard }` on success — `crossesHazard` is true iff *any* leg's path
 * actually steps on a hazard/spike-trap tile (see `weightedPath`'s cost-based
 * preference for avoiding them) — or `{ ok: false, reason, legs }` (with
 * whatever partial plan was built) on failure.
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
  return planRouteWithAvoidSet(map);
}

/**
 * Like `planRoute`, but detours through every reachable room center before
 * the final approach to the exit — for a "maximize map coverage" bot profile
 * rather than a speedrunner.
 *
 * Deliberately reuses `planRoute`'s own key/door-detour solve rather than
 * re-deriving it: it replays the returned legs against a cloned grid (opening
 * doors exactly as `planRouteWithAvoidSet` does internally) to reconstruct
 * "the grid once every door this route ever opens has been opened" and the
 * position the bot is standing at right before its final walk to the exit.
 * From there it BFS's a fully deterministic greedy nearest-unvisited-room
 * tour (not optimal TSP — good enough for "cover most of the map", and
 * ties/ordering never depend on anything but grid distance and room order,
 * so two runs of the same level always produce the same tour) and splices it
 * in immediately before a freshly-computed final walk to the exit.
 */
export function planCoverageRoute(map) {
  const base = planRoute(map);
  if (!base.ok) return base;

  const avoidTiles = base.crossesHazard
    ? new Set([...HARD_BLOCK_TILES])
    : new Set([...HARD_BLOCK_TILES, ...SOFT_AVOID_TILES]);

  const grid = map.grid.map((row) => [...row]);
  const workingMap = { width: map.width, height: map.height, grid };
  const preExitLegs = base.legs.slice(0, -1);

  let pos = { x: map.spawn.x, y: map.spawn.y };
  for (const leg of preExitLegs) {
    if (leg.kind === "walk") {
      pos = leg.waypoints[leg.waypoints.length - 1];
    } else if (leg.kind === "openDoor") {
      grid[leg.doorTile.y][leg.doorTile.x] = 0; // mirror openDoorAhead(), same simulation planRoute uses internally
      pos = { x: leg.doorTile.x + 0.5, y: leg.doorTile.y + 0.5 };
    }
  }

  const reachable = reachableTiles(workingMap, tileOf(pos), avoidTiles);

  const centers = [];
  for (const room of map.rooms) {
    const c = tileOf(room.center);
    if (reachable.has(`${c.x},${c.y}`)) centers.push(c);
  }
  for (const rect of map.breakupRooms) {
    const c = { x: rect.x + Math.floor(rect.w / 2), y: rect.y + Math.floor(rect.h / 2) };
    if (reachable.has(`${c.x},${c.y}`)) centers.push(c);
  }

  const tourLegs = [];
  let cursor = tileOf(pos);
  const remaining = [...centers];
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestPath = null;
    for (let i = 0; i < remaining.length; i++) {
      const path = bfsPath(workingMap, cursor, remaining[i], avoidTiles);
      if (!path) continue;
      if (!bestPath || path.length < bestPath.length) {
        bestPath = path;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // defensive: shouldn't happen, every candidate came from the same reachable set
    if (bestPath.length > 1) tourLegs.push({ kind: "walk", waypoints: pathToWaypoints(bestPath) });
    cursor = remaining[bestIdx];
    remaining.splice(bestIdx, 1);
  }

  const finalExitPath = bfsPath(workingMap, cursor, map.exit, avoidTiles);
  if (!finalExitPath) return base; // defensive: fall back to the plain route rather than fail the whole plan

  return {
    ...base,
    legs: [...preExitLegs, ...tourLegs, { kind: "walk", waypoints: pathToWaypoints(finalExitPath) }],
  };
}

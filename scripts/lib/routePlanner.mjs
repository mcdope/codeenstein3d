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
/** Keyless Switchboard spoke door — solid until pushed, but costs no key. */
const BRANCH_DOOR_TILE = 8;
/** Preferred-avoid set for `planCoverageRoute`'s own (still binary
 * avoid-or-cross) hazard handling — kept separate from `planRoute`'s
 * `weightedPath` since this function has no live caller and is not worth
 * migrating until it's actually back in use. `planCoverageRoute` is kept
 * deliberately — it is tested and is a real capability — but the
 * `coverageMode` profile flag that used to select it was `false` for every
 * profile and never read by the policy layer, so it was removed along with
 * the per-level `planCoverageRoute` call it kept alive. */
const SOFT_AVOID_TILES = new Set([HAZARD_TILE, SPIKE_TRAP_TILE]);

/** Mirrors `pathfind.mjs`'s `bfsPath` blocked set (wall / locked door /
 * unopened secret wall / lore terminal / unopened branch door) plus the
 * teleporter — a mid-route warp would invalidate the rest of the planned
 * waypoint sequence, which this plain tile-graph model has no way to account
 * for, so it's always a hard block here (never a target either). */
const HARD_BLOCK_TILES = new Set([1, 3, 6, 7, BRANCH_DOOR_TILE, TELEPORTER_TILE]);
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

/** First door tile of `tileValue` adjacent to `reachable`, plus the reachable
 * tile it's approached from (so the caller can BFS a walk leg right up to it).
 *
 * `preferredOrder` (the map's own `doors` array, when there is one) decides
 * which frontier door wins when several are reachable at once. That ordering
 * is load-bearing, not cosmetic: `assertAllRoomsReachable` in
 * `src/map/generation/pathing.ts` runs this exact greedy key-then-frontier-door
 * simulation over `doors` in array order, and it is the *only* order the map
 * generator actually guarantees is solvable — `placeKeys` scatters each key
 * into the region reachable before its own door under that same walk. Scanning
 * the `reachable` set instead visits doors in tile order, which is a different
 * greedy and can burn the last key on a door that opens no new key, deadlocking
 * on a level a player can finish. (Observed on `stage13_batch_job.scala`: 3
 * keys spent, 3 doors opened, no fourth key reachable, while the generator's
 * own order completes.) */
/** Which gate owns door tile `d`, or -1 — the script-side twin of
 * `src/map/gates.ts`'s `gateIdAt`, kept simple because a level has a handful of
 * gates and this runs once per planning iteration, not per frame. */
function gateIdOfDoor(map, d) {
  for (const gate of map.gates ?? []) {
    if (gate.doors.some((t) => t.x === d.x && t.y === d.y)) return gate.id;
  }
  return -1;
}

function findReachableDoor(grid, reachable, tileValue, preferredOrder = null) {
  if (preferredOrder) {
    for (const door of preferredOrder) {
      if (grid[door.y]?.[door.x] !== tileValue) continue; // already opened
      for (const [dx, dy] of DIRS) {
        const fx = door.x + dx;
        const fy = door.y + dy;
        if (reachable.has(`${fx},${fy}`)) return { door: { x: door.x, y: door.y }, from: { x: fx, y: fy } };
      }
    }
    return null;
  }
  for (const key of reachable) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) continue;
      if (grid[ny][nx] === tileValue) return { door: { x: nx, y: ny }, from: { x, y } };
    }
  }
  return null;
}

/** Every tile of the 4-connected `DOOR_TILE` run containing `start` — the
 * script-side twin of `doorwayTiles` in `src/map/generation/geometry.ts`
 * (this is a plain Node script and can't import the bundled TS module). Keep
 * the two in step: the engine opens a whole doorway per key, so a planner that
 * disagreed would mis-count how many keys a route actually needs. */
function doorwayTiles(grid, start) {
  if (grid[start.y]?.[start.x] !== DOOR_TILE) return [];
  const seen = new Set();
  const run = [];
  const stack = [start];
  while (stack.length > 0) {
    const p = stack.pop();
    const k = `${p.x},${p.y}`;
    if (seen.has(k) || grid[p.y]?.[p.x] !== DOOR_TILE) continue;
    seen.add(k);
    run.push(p);
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 });
  }
  return run;
}

function planRouteWithAvoidSet(map, from) {
  const grid = map.grid.map((row) => [...row]);
  const workingMap = { width: map.width, height: map.height, grid };
  const collectedKeyIndices = new Set();
  /** Gate ids whose key has been collected. A key is permanent inventory now,
   * so this only ever grows — the old `collectedKeyIndices.size - openedDoorCount`
   * arithmetic modelled a balance that was spent down, and would refuse to open
   * a door the player can walk straight through. */
  const heldGates = new Set();
  const legs = [];
  let pos = { x: from?.x ?? map.spawn.x, y: from?.y ?? map.spawn.y };
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

    // A Switchboard branch door costs no key — push and it's open. Tried
    // before the key/locked-door detour precisely because it's free: there's
    // never a reason to go fetch a key when a branch door would already have
    // opened the region up.
    const branch = findReachableDoor(grid, reachable, BRANCH_DOOR_TILE);
    if (branch) {
      const path = findPath(start, branch.from);
      if (!path) return { ok: false, reason: "branch-door-approach-reachable-but-no-bfs-path (inconsistent)", legs };
      legs.push({ kind: "walk", waypoints: pathToWaypoints(path) });
      legs.push({ kind: "openDoor", doorTile: branch.door, approachDir: { dx: branch.door.x - branch.from.x, dy: branch.door.y - branch.from.y } });
      grid[branch.door.y][branch.door.x] = 0; // mirror openDoorAhead()
      pos = { x: branch.door.x + 0.5, y: branch.door.y + 0.5 };
      continue;
    }

    // Nearest reachable key, not the first in `map.keys` order. Since this
    // branch runs until *no* reachable key is left, the set collected before
    // the next door opens is the same either way — only the walking order
    // changes, so this cannot affect solvability the way the door order can
    // (see `findReachableDoor`). Array order is `placeKeys`' push order, which
    // is gate-opening order and says nothing about where the player is
    // standing: on `demo-campaign/stage03_legacy_api.php` it walked 94 tiles
    // west to one key, 85 back east to a key sitting 7 tiles from spawn, then
    // 114 west again to the first gate — 293 tiles to do about 130 tiles of
    // work, on the campaign's slowest level.
    const reachableKeys = map.keys
      .map((k, idx) => ({ idx, target: { x: Math.floor(k.x), y: Math.floor(k.y) } }))
      .filter(({ idx, target }) => !collectedKeyIndices.has(idx) && reachable.has(`${target.x},${target.y}`));
    if (reachableKeys.length > 0) {
      let best = null;
      for (const candidate of reachableKeys) {
        // Probed with `weightedPath` rather than `findPath` so that routes we
        // consider and reject don't latch `crossesHazard` — only the leg
        // actually walked gets to set it, below.
        const path = weightedPath(workingMap, start, candidate.target);
        // Strictly shorter, so equal-distance ties keep the lowest index and
        // the planner stays deterministic.
        if (path && (best === null || path.length < best.path.length)) best = { ...candidate, path };
      }
      if (!best) return { ok: false, reason: "key-reachable-but-no-bfs-path (inconsistent)", legs };
      if (pathCrossesHazard(workingMap, best.path)) crossesHazard = true;
      legs.push({ kind: "walk", waypoints: pathToWaypoints(best.path) });
      collectedKeyIndices.add(best.idx);
      heldGates.add(map.keys[best.idx].gateId);
      pos = { x: best.target.x + 0.5, y: best.target.y + 0.5 };
      continue;
    }

    {
      // Only doors of a gate whose key is held. Ordering still follows
      // `map.doors` (see `findReachableDoor`), so this keeps replaying the
      // generator's own greedy simulation.
      const openable = map.doors.filter((d) => heldGates.has(gateIdOfDoor(map, d)));
      const found = findReachableDoor(grid, reachable, DOOR_TILE, openable);
      if (found) {
        const path = findPath(start, found.from);
        if (!path) return { ok: false, reason: "door-approach-reachable-but-no-bfs-path (inconsistent)", legs };
        legs.push({ kind: "walk", waypoints: pathToWaypoints(path) });
        const approachDir = { dx: found.door.x - found.from.x, dy: found.door.y - found.from.y };
        legs.push({ kind: "openDoor", doorTile: found.door, approachDir });
        // Mirror `openDoorAhead()`: pushing a door opens the whole doorway —
        // the 4-connected run of door tiles — but *not* the gate's other
        // doorways, which the player would have to walk round and push
        // separately. Nothing is spent either way; the key stays held.
        for (const tile of doorwayTiles(grid, found.door)) grid[tile.y][tile.x] = 0;
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
/**
 * `from` overrides the start tile, defaulting to `map.spawn`. Needed to resume
 * a route after a teleporter pad has warped the bot mid-run: every waypoint
 * already planned was computed against a position it is no longer at, so the
 * caller re-plans from wherever it actually landed rather than treating the
 * warp as "route finished" (see `run-balancing-telemetry.mjs`'s replan loop).
 */
export function planRoute(map, from) {
  return planRouteWithAvoidSet(map, from);
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

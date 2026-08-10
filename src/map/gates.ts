// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Which gate owns the door tile at (x, y)?" — the lookup the renderer needs
 * once per wall column and the engine needs once per door push.
 *
 * The grid is a bare numeric `Tile[][]` and `Tile` is a closed union, so gate
 * identity cannot live in the tile value without adding four more of them and
 * multiplying every solid-tile set and tile switch in the codebase. It lives in
 * `GameMap.gates` instead, and this module turns that list into a lookup with
 * no per-call allocation.
 *
 * **Built once per level and never invalidated.** A door tile only ever goes
 * `DOOR_TILE -> 0` when it opens; a tile never *gains* a gate, and every caller
 * has already checked `tile === DOOR_TILE` before asking. So a stale entry for
 * an opened door is unreachable by construction, and this needs none of the
 * `gridVersion` re-keying the minimap's cached wall layer does.
 *
 * **A `WeakMap`, not a single-slot memo.** The minimap's memo gets away with one
 * entry because it also re-keys on `gridVersion` and cell size; a single slot
 * here would thrash in any process holding two maps at once, which both
 * multiplayer session suites do.
 *
 * **An `Int16Array`, not a `Map<"x,y", id>`.** At ~2048 columns a frame the
 * string concatenation is the whole cost; a typed array is ~51 KB for a 160x160
 * grid and allocation-free per lookup. `Int16Array` because `-1` has to be
 * representable and a level never has more than a handful of gates.
 */
import type { GameMap } from "./types";

const NO_GATE = -1;

const cache = new WeakMap<GameMap, Int16Array>();

function gateGrid(map: GameMap): Int16Array {
  const existing = cache.get(map);
  if (existing) return existing;
  const grid = new Int16Array(map.width * map.height).fill(NO_GATE);
  for (const gate of map.gates) {
    for (const door of gate.doors) grid[door.y * map.width + door.x] = gate.id;
  }
  cache.set(map, grid);
  return grid;
}

/**
 * The id of the gate owning the door tile at `(x, y)`, or `-1` for any tile
 * that is not one of a gate's doors (including off-grid coordinates).
 */
export function gateIdAt(map: GameMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return NO_GATE;
  return gateGrid(map)[y * map.width + x];
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Acid Overflow" rooms: a function that allocates heavily gets a room that
 * leaks. Walk in and the floor starts flooding, tile by tile; kill the enemy
 * representing that function and the leak stops where it is.
 *
 * This module is the *planning* half and runs entirely at generation time — it
 * writes nothing to the grid. The runtime half lives in
 * `src/engine/acidOverflow.ts`, in keeping with the "Enemy stays data" split:
 * the map layer decides which tiles could ever become acid and in what order,
 * the engine decides when.
 *
 * Precomputing that tile list here isn't an optimization, it's what makes the
 * whole feature safe (see `AcidOverflow`'s own doc comment): the list is taken
 * from the *final* grid, so it can't contain a door, teleporter pad, spike,
 * secret wall, lore terminal or pre-existing acid tile, and the runtime pass
 * therefore needs no rng and can retract a tile as safely as it claims one.
 */
import type { CodeEntity } from "../../parser/types";
import type { AcidOverflow, Enemy, Point, Rect, Room, Tile } from "../types";
import { clamp, key, neighbors } from "./util";

/** Feature flag — see `doc/dev/architecture.md`'s Feature Flags table. Checked
 * at the `mapGenerator.ts` call site. */
export const ACID_OVERFLOW_ENABLED = true;

/**
 * Below this many explicit allocations a function is never an overflow room,
 * however short it is — three is the point at which a leak reads as a
 * *pattern* rather than as one incidental `new`.
 */
const ACID_MIN_ALLOCATIONS = 3;
/** Allocations per source line at or above which a function counts as
 * allocation-dense. 0.08 is roughly one allocation every twelve lines. */
const ACID_MIN_DENSITY = 0.08;
/** Cap per level. Three rooms quietly filling with acid is already a lot to
 * keep track of. */
const MAX_ACID_OVERFLOWS = 3;

/** Seconds between two consecutive tiles being claimed, at exactly
 * `ACID_MIN_DENSITY`. A leakier function floods proportionally faster. */
const ACID_BASE_INTERVAL_SECONDS = 2;
/** Floor on that interval, so no function — however pathological its
 * allocation density — can produce a room that's unsurvivable to enter. */
const ACID_MIN_INTERVAL_SECONDS = 0.6;

/** Allocations per line of the entity's own source span. Integer-derived and
 * therefore stable across engines: `allocations` is a count and `lineSpan`
 * comes straight from the 1-based inclusive line range. */
export function allocationDensity(entity: CodeEntity): number {
  const lineSpan = Math.max(1, entity.endLine - entity.startLine + 1);
  return (entity.allocations ?? 0) / lineSpan;
}

/** Whether a function allocates heavily enough to earn an overflow room. Both
 * gates matter: the absolute floor stops a three-line helper with one `new`
 * from qualifying on density alone, and the density gate stops a thousand-line
 * module from qualifying on raw count alone. */
export function isAllocationDense(entity: CodeEntity): boolean {
  return (entity.allocations ?? 0) >= ACID_MIN_ALLOCATIONS && allocationDensity(entity) >= ACID_MIN_DENSITY;
}

/**
 * Plan an overflow for every allocation-dense function's room, up to
 * `MAX_ACID_OVERFLOWS`.
 *
 * **Draws no rng at all** — deliberately. Expansion order is a plain BFS from
 * the room center in `neighbors()`' fixed order, which both looks right (a
 * pool spreading outward from the middle) and means this pass can be appended
 * at the very end of `generate()` without perturbing a single earlier draw. A
 * file with no allocation-dense function therefore generates a byte-identical
 * map to one generated before this feature existed.
 *
 * `reserved` carries the tile keys other systems have claimed *without*
 * marking the grid — mines and keys both sit on plain floor — so the
 * `grid[y][x] === 0` test alone genuinely isn't enough.
 *
 * A room whose function has no enemy is skipped: with no enemy there is no
 * stop condition, and the room would flood forever.
 */
export function planAcidOverflows(
  rooms: readonly Room[],
  grid: readonly Tile[][],
  enemies: readonly Enemy[],
  reserved: ReadonlySet<string>,
): AcidOverflow[] {
  const overflows: AcidOverflow[] = [];

  rooms.forEach((room, index) => {
    if (overflows.length >= MAX_ACID_OVERFLOWS) return;
    if (index === 0) return; // the spawn room never floods
    const kind = room.entity.kind;
    if (kind !== "function" && kind !== "method") return;
    if (!isAllocationDense(room.entity)) return;

    // Object identity, not name matching: `spawnEnemies` assigns the room's
    // own `entity` reference straight onto the enemy it spawns, so this finds
    // that room's pack leader exactly, with no chance of colliding with a
    // same-named function elsewhere in the file.
    const enemyIndex = enemies.findIndex((e) => e.entity === room.entity);
    if (enemyIndex < 0) return;

    const tiles = floodOrder(room, grid, reserved);
    if (tiles.length === 0) return;

    overflows.push({
      room: { x: room.x, y: room.y, w: room.w, h: room.h },
      enemyIndex,
      tiles,
      intervalSeconds: intervalFor(room.entity),
    });
  });

  return overflows;
}

/** How fast one room leaks. Computed here rather than in the engine so a
 * multiplayer guest reads the value off the transferred `GameMap` instead of
 * recomputing it — one less thing that could ever drift between peers. */
function intervalFor(entity: CodeEntity): number {
  const scaled = ACID_BASE_INTERVAL_SECONDS * (ACID_MIN_DENSITY / allocationDensity(entity));
  return clamp(scaled, ACID_MIN_INTERVAL_SECONDS, ACID_BASE_INTERVAL_SECONDS);
}

/**
 * Every claimable tile in `room`, breadth-first from its center — the order the
 * acid will spread in. A tile qualifies only if it's plain floor on the final
 * grid and unclaimed by anything invisible to the grid.
 *
 * BFS rather than a scan so the pool spreads outward from the middle; a
 * row-major fill would read as a wave sweeping the room, which is a different
 * (and much less "something is leaking") effect.
 *
 * The walk crosses unclaimable tiles instead of stopping at them — it's
 * ordering tiles by distance from the centre, not tracing a flow. That keeps a
 * pillar (or a labyrinth wall, or the centre tile itself) from cutting the
 * flood short, at the cost of a partitioned room theoretically flooding both
 * halves at once. Inside one room that reads fine; a room is small.
 */
function floodOrder(room: Rect, grid: readonly Tile[][], reserved: ReadonlySet<string>): Point[] {
  const inRoom = (p: Point): boolean =>
    p.x >= room.x && p.x < room.x + room.w && p.y >= room.y && p.y < room.y + room.h;
  const claimable = (p: Point): boolean => grid[p.y]?.[p.x] === 0 && !reserved.has(key(p));

  const start = { x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) };
  const seen = new Set<string>([key(start)]);
  // The centre itself may be blocked (a pillar, the room's primary enemy spawn
  // once cleared, ...) — the walk still starts there so the spread stays
  // centred, it just doesn't claim that tile.
  const queue: Point[] = [start];
  const order: Point[] = [];

  while (queue.length > 0) {
    const p = queue.shift()!;
    if (inRoom(p) && claimable(p)) order.push(p);
    for (const n of neighbors(p)) {
      if (!inRoom(n) || seen.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return order;
}

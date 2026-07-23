// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Spawn-corner and exit-tile selection. */
import type { Point, Room } from "../types";
import { dist } from "./util";

/**
 * Pick a spawn point in the first room: whichever of its four corners (1 tile
 * inset from the room edge) has the greatest minimum distance to any
 * enemy-bearing room's center. Room centers are known before any enemy is
 * actually placed (an enemy pack's first member always spawns dead center —
 * see `enemyPositions`), so this needs no reordering of the generation
 * pipeline. Best-effort, not a guarantee: a corner can still end up within
 * another enemy's aggro radius if the level is small or densely packed —
 * there just isn't a better option to pick instead.
 */
export function pickSafeSpawn(rooms: Room[]): Point {
  if (rooms.length === 0) return { x: 1, y: 1 };
  const room0 = rooms[0];

  const candidates: Point[] = [
    { x: room0.x + 1, y: room0.y + 1 },
    { x: room0.x + room0.w - 2, y: room0.y + 1 },
    { x: room0.x + 1, y: room0.y + room0.h - 2 },
    { x: room0.x + room0.w - 2, y: room0.y + room0.h - 2 },
  ];

  const enemyRoomCenters = rooms
    .filter((r) => r.entity.kind === "function" || r.entity.kind === "method")
    .map((r) => r.center);
  if (enemyRoomCenters.length === 0) return candidates[0];

  let best = candidates[0];
  let bestMinDist = -1;
  for (const c of candidates) {
    const minDist = Math.min(...enemyRoomCenters.map((e) => dist(c.x + 0.5, c.y + 0.5, e.x + 0.5, e.y + 0.5)));
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      best = c;
    }
  }
  return best;
}

/** Pick the exit tile: the center of the room whose center is furthest (by
 * Euclidean distance) from the spawn. Falls back to the spawn for empty maps. */
export function pickExit(rooms: Room[], spawn: Point): Point {
  if (rooms.length === 0) return { x: spawn.x, y: spawn.y };
  let best = rooms[0];
  let bestDist = -1;
  for (const room of rooms) {
    const dx = room.center.x - spawn.x;
    const dy = room.center.y - spawn.y;
    const dist = dx * dx + dy * dy;
    if (dist > bestDist) {
      bestDist = dist;
      best = room;
    }
  }
  return { x: best.center.x, y: best.center.y };
}

/**
 * Multiplayer spawn selection: greedily pick up to `count` per-room safe
 * points, each one maximizing its minimum distance to the exit and every
 * spawn already chosen — spreads players across the level instead of
 * clustering them. Each room's own candidate is its farthest-from-every-
 * enemy-room-center *corner* (`pickSafeSpawn`'s own per-room logic, reused
 * per room here instead of just for room0) — never the room's raw center.
 * Real bug this fixes, found while building a real, no-cheats multiplayer
 * E2E bot: a room's own first enemy always spawns dead center too (see
 * `enemyPositions`' doc comment) — a spawn placed at that same center
 * landed a real player directly on top of an already-aggroed enemy from
 * tick one, with none of single-player's `pickSafeSpawn` protection. The
 * exit's own tile is excluded from the candidate pool up front, or a large
 * enough `count` would eventually assign a spawn onto the exit tile itself.
 * Pure geometry, like `pickSafeSpawn`/`pickExit` — draws nothing from `rng`,
 * so calling it changes nothing about single-player's deterministic draw
 * sequence regardless of where in `generate()` it's invoked. Returns fewer
 * than `count` points if `rooms.length < count` (no padding, no
 * duplicates) — wrapping a player index into a short result is the caller's
 * job, not this function's.
 */
export function pickMultiplayerSpawns(rooms: Room[], exit: Point, count: number): Point[] {
  if (rooms.length === 0) return [{ x: exit.x, y: exit.y }];
  const enemyRoomCenters = rooms.filter((r) => r.entity.kind === "function" || r.entity.kind === "method").map((r) => r.center);
  const safePointFor = (room: Room): Point => {
    const candidates: Point[] = [
      { x: room.x + 1, y: room.y + 1 },
      { x: room.x + room.w - 2, y: room.y + 1 },
      { x: room.x + 1, y: room.y + room.h - 2 },
      { x: room.x + room.w - 2, y: room.y + room.h - 2 },
    ];
    if (enemyRoomCenters.length === 0) return candidates[0];
    let best = candidates[0];
    let bestMinDist = -1;
    for (const c of candidates) {
      const minDist = Math.min(...enemyRoomCenters.map((e) => dist(c.x + 0.5, c.y + 0.5, e.x + 0.5, e.y + 0.5)));
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = c;
      }
    }
    return best;
  };
  const pool = rooms.map(safePointFor).filter((c) => !(c.x === exit.x && c.y === exit.y));
  const chosen: Point[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let j = 0; j < pool.length; j++) {
      const c = pool[j];
      let minDist = dist(c.x + 0.5, c.y + 0.5, exit.x + 0.5, exit.y + 0.5);
      for (const s of chosen) minDist = Math.min(minDist, dist(c.x + 0.5, c.y + 0.5, s.x + 0.5, s.y + 0.5));
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = j;
      }
    }
    chosen.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return chosen;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Pillars and cosmetic decorations for large open rooms. */
import type { Decoration, DecorKind, Point, Room, Tile } from "../types";
import { findPropSpot } from "./geometry";
import { MAZE_THRESHOLD } from "./labyrinth";

/** Minimum room footprint (tiles, both dimensions) to get pillars/decor. */
const LARGE_ROOM_MIN_DIM = 6;
/**
 * Whether cosmetic decorations (server racks, plants, desks, code-blocks) are
 * spawned. Disabled after playtest feedback that they got in the way; the
 * generation and rendering code is left in place to revisit later.
 */
export const DECORATIONS_ENABLED = false;

/**
 * A room qualifies for pillars/decorations if it's a plain open room: not a
 * labyrinth (those are already dense with walls) and not a global-variable
 * hazard room (an acid pool has no business holding a server rack), and at
 * least `LARGE_ROOM_MIN_DIM` square so there's real empty space to break up.
 */
function isLargeOpenRoom(room: Room): boolean {
  return (
    room.entity.kind !== "global" &&
    room.entity.nestingDepth < MAZE_THRESHOLD &&
    room.w >= LARGE_ROOM_MIN_DIM &&
    room.h >= LARGE_ROOM_MIN_DIM
  );
}

/**
 * Scatter 1-1x1 wall "pillars" through large open rooms to break up long
 * sightlines and empty floor. Never touches the spawn room (index 0) — a
 * pillar right at the entrance would just be an early annoyance.
 */
export function placePillars(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
): void {
  rooms.forEach((room, index) => {
    if (index === 0 || !isLargeOpenRoom(room)) return;
    const count = 1 + Math.floor(rng() * 3); // 1-3
    const placed: Point[] = [];
    for (let i = 0; i < count; i++) {
      const spot = findPropSpot(room, grid, avoid, placed, rng);
      if (!spot) continue;
      grid[spot.y][spot.x] = 1;
      placed.push(spot);
    }
  });
}

const DECOR_KINDS: DecorKind[] = ["rack", "plant", "desk", "block"];

/**
 * Scatter 1-3 cosmetic, non-blocking props (server racks, plants, desks,
 * abstract code-blocks) through large open rooms so they feel inhabited rather
 * than an empty wasteland. Unlike pillars, the spawn room is eligible too —
 * decorations never block anything, so there's no downside there.
 */
export function placeDecorations(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
): Decoration[] {
  const decorations: Decoration[] = [];
  for (const room of rooms) {
    if (!isLargeOpenRoom(room)) continue;
    const count = 1 + Math.floor(rng() * 3); // 1-3
    const placed: Point[] = [];
    for (let i = 0; i < count; i++) {
      const spot = findPropSpot(room, grid, avoid, placed, rng);
      if (!spot) continue;
      placed.push(spot);
      const kind = DECOR_KINDS[Math.floor(rng() * DECOR_KINDS.length)];
      decorations.push({ x: spot.x + 0.5, y: spot.y + 0.5, kind });
    }
  }
  return decorations;
}

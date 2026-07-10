// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** goto → label teleporter pad pairs. */
import type { GotoLink } from "../../parser/types";
import { TELEPORTER_TILE, type Point, type Room, type Teleporter, type Tile } from "../types";
import { findPropSpot, roomForLine } from "./geometry";

/**
 * Turn each resolved `goto` → label jump into a bidirectional teleporter pad
 * pair: one pad in the room containing the `goto` statement, one in the room
 * containing its label, each warping to the other. Falls back to the spawn
 * room when a line falls outside every entity (e.g. file-scope PHP code).
 * A link that can't find an open floor spot for both pads is skipped — never
 * a hard failure, same philosophy as pillar/decoration placement.
 */
export function placeTeleporters(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  gotos: GotoLink[],
  rng: () => number,
): Teleporter[] {
  if (gotos.length === 0 || rooms.length === 0) return [];

  const teleporters: Teleporter[] = [];
  const placedByRoom = new Map<Room, Point[]>();
  const placedIn = (room: Room): Point[] => placedByRoom.get(room) ?? [];
  const addPlaced = (room: Room, p: Point): void => {
    const list = placedByRoom.get(room);
    if (list) list.push(p);
    else placedByRoom.set(room, [p]);
  };

  for (const link of gotos) {
    const fromRoom = roomForLine(rooms, link.gotoLine) ?? rooms[0];
    const toRoom = roomForLine(rooms, link.labelLine) ?? rooms[0];

    const fromSpot = findPropSpot(fromRoom, grid, avoid, placedIn(fromRoom), rng);
    if (!fromSpot) continue;
    addPlaced(fromRoom, fromSpot); // reserve before picking the paired spot,
    // so a same-room pair can't collide with itself.

    const toSpot = findPropSpot(toRoom, grid, avoid, placedIn(toRoom), rng);
    if (!toSpot) continue;
    addPlaced(toRoom, toSpot);

    grid[fromSpot.y][fromSpot.x] = TELEPORTER_TILE;
    grid[toSpot.y][toSpot.x] = TELEPORTER_TILE;

    const from = { x: fromSpot.x + 0.5, y: fromSpot.y + 0.5 };
    const to = { x: toSpot.x + 0.5, y: toSpot.y + 0.5 };
    teleporters.push({ x: from.x, y: from.y, targetX: to.x, targetY: to.y, label: link.label });
    teleporters.push({ x: to.x, y: to.y, targetX: from.x, targetY: from.y, label: link.label });
  }
  return teleporters;
}

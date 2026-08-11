// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** goto → label teleporter pad pairs. */
import type { GotoLink } from "../../parser/types";
import { TELEPORTER_TILE, type Point, type Room, type Teleporter, type Tile } from "../types";
import { findPropSpot, roomForLine } from "./geometry";

/**
 * How many teleporter pairs a level may place with *both* pads in the same
 * room, before the rest are skipped.
 *
 * **Why a cap exists.** A `goto` whose label sits in the same function — the
 * error-handling `goto out;` idiom that C is full of — maps both ends to the
 * same room, so the pair becomes a pad that warps you a few tiles across the
 * room you are already standing in. That reads as disorienting rather than as
 * a shortcut, and it is not rare: measured across the corpus, in-room pairs are
 * **68-100%** of every pair generated (curl 17/17, doom 20/20, vim 445/544,
 * git 251/369, quake 37/53), and a single vim level generated **39** of them.
 *
 * One is deliberately not zero. The mechanic is a joke about `goto` being evil
 * and the joke needs to land occasionally — the backlog asks to "keep some of
 * them" while making them an exception. Cross-room pairs, the ones that
 * actually shortcut a level, are never capped.
 *
 * One also happens to leave the bundled demo campaign byte-identical: both of
 * its teleporter levels carry exactly one in-room pair, so nothing is skipped
 * there and no draw order moves.
 */
const MAX_IN_ROOM_TELEPORTER_PAIRS = 1;

/**
 * Turn each resolved `goto` → label jump into a bidirectional teleporter pad
 * pair: one pad in the room containing the `goto` statement, one in the room
 * containing its label, each warping to the other. Falls back to the spawn
 * room when a line falls outside every entity (e.g. file-scope PHP code).
 * A link that can't find an open floor spot for both pads is skipped — never
 * a hard failure, same philosophy as pillar/decoration placement.
 *
 * Pairs landing entirely inside one room are additionally capped — see
 * `MAX_IN_ROOM_TELEPORTER_PAIRS`.
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
  let inRoomPairs = 0;
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

    // Tested *before* `findPropSpot`, so a skipped link draws no rng at all and
    // the levels that keep their pairs generate exactly as they did before.
    const sameRoom = fromRoom === toRoom;
    if (sameRoom && inRoomPairs >= MAX_IN_ROOM_TELEPORTER_PAIRS) continue;

    const fromSpot = findPropSpot(fromRoom, grid, avoid, placedIn(fromRoom), rng);
    if (!fromSpot) continue;
    addPlaced(fromRoom, fromSpot); // reserve before picking the paired spot,
    // so a same-room pair can't collide with itself.

    const toSpot = findPropSpot(toRoom, grid, avoid, placedIn(toRoom), rng);
    if (!toSpot) continue;
    addPlaced(toRoom, toSpot);
    // Counted only once the pair is genuinely placed — a link that could not
    // find a second spot has cost nothing and must not spend the budget.
    if (sameRoom) inRoomPairs += 1;

    grid[fromSpot.y][fromSpot.x] = TELEPORTER_TILE;
    grid[toSpot.y][toSpot.x] = TELEPORTER_TILE;

    const from = { x: fromSpot.x + 0.5, y: fromSpot.y + 0.5 };
    const to = { x: toSpot.x + 0.5, y: toSpot.y + 0.5 };
    teleporters.push({ x: from.x, y: from.y, targetX: to.x, targetY: to.y, label: link.label });
    teleporters.push({ x: to.x, y: to.y, targetX: from.x, targetY: from.y, label: link.label });
  }
  return teleporters;
}

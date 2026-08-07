// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Door placement on private/protected method rooms, and the matching
 * solvable-in-key-order key scatter. */
import { DOOR_TILE, type Enemy, type ExceptionZone, type KeyItem, type Point, type Rect, type Room, type Tile } from "../types";
import { breakupTileKeys } from "./breakup";
import { doorwayRunCount, doorwayTiles, isLockableRoom } from "./geometry";
import { reachableTiles } from "./pathing";
import { key, neighbors } from "./util";

/**
 * How many gates a level may carry, at most.
 *
 * Every gate is a mandatory "go and find its key" detour, so this budgets the
 * player's patience, not the map's size — a bigger level does not make a
 * seventh key hunt more welcome, it just makes it longer.
 *
 * Unbounded before, which is the defect this fixes: `isLockableRoom` fires on
 * every private/protected method, so a large source file produced a level made
 * of gates. Measured 2026-08-07 across the staged corpora — ripgrep's level 8
 * carried 64 doors and 38 keys and chained into a **120-leg** route that
 * stopped 16 of 18 capture runs at exactly that level; its level 15 reached
 * 2,653 doors and 771 keys, and laravel peaked at 101 legs.
 */
export const MAX_GATES = 6;

/** How many of the highest-worth candidates are probed for gating the exit. */
const GATE_PROBE_LIMIT = 24;

/**
 * Lock a bounded, deliberately-chosen subset of the private/protected-method
 * rooms by turning their corridor mouth into a door tile. The spawn room is
 * never locked. Returns the door tiles placed.
 *
 * **The budget is counted in doorways, not rooms**, because a doorway is what
 * costs a key: the engine charges one per doorway (`openDoorAhead`, mirrored by
 * `assertAllRoomsReachable`), so a six-mouth room is six key hunts for one
 * space. Ranking divides worth by that cost, so a one-mouth room wins over an
 * equally good six-mouth one and most gates end up costing a single key. A room
 * is locked wholly or not at all — leaving one mouth open would make the other
 * locks pointless — so a room only fits if all of its doorways fit the budget.
 *
 * Requiring *only* single-doorway rooms was tried and is too strict: it left
 * ripgrep's levels with zero gates, removing the mechanic rather than bounding
 * it. Charging one key per room instead was tried too, and breaks the engine's
 * own key economy — `assertAllRoomsReachable` then reports rooms unreachable,
 * because the engine really does spend a key per doorway. Making a key open a
 * whole room needs door-to-room identity in the engine, which is a bigger
 * change than this one.
 *
 * Selection, in order:
 *
 * 1. **One gate on the critical path**, if any candidate offers one — the
 *    highest-worth room whose locking alone would cut the exit off from spawn.
 *    Without it a capped level can put every gate on a side branch and the
 *    player walks to the exit never needing a key.
 * 2. **Then the most rewarding rooms**, largest first with enemy and pickup
 *    density folded in. A locked door should be worth opening; locking a bare
 *    3x3 alcove is a chore with no payoff.
 */
export function placeDoors(
  rooms: Room[],
  grid: Tile[][],
  opts: { spawn?: Point; exit?: Point; enemies?: readonly Point[]; pickups?: readonly Point[]; maxGates?: number } = {},
): Point[] {
  const { spawn, exit, enemies = [], pickups = [], maxGates = MAX_GATES } = opts;
  const candidates = rooms
    .map((room, index) => ({ room, index }))
    .filter(({ room, index }) => isLockableRoom(room, index));
  if (candidates.length === 0) return [];

  const inside = (room: Room, p: Point): boolean => p.x >= room.x && p.x < room.x + room.w && p.y >= room.y && p.y < room.y + room.h;
  // Area dominates, with occupants as a tie-breaker: a big room is the reward,
  // and enemies/pickups inside it are what make it worth the key.
  const worth = (room: Room): number =>
    room.w * room.h + 4 * enemies.filter((e) => inside(room, { x: Math.floor(e.x), y: Math.floor(e.y) })).length + 6 * pickups.filter((p) => inside(room, p)).length;
  // A room is locked wholly or not at all, so its price is all of its mouths.
  const cost = (room: Room): number => Math.max(1, doorwayRunCount(room, grid));
  const ranked = candidates.slice().sort((a, b) => worth(b.room) / cost(b.room) - worth(a.room) / cost(a.room));

  const chosen: typeof ranked = [];
  let spent = 0;
  if (spawn && exit) {
    // Only the best few are probed: each probe is a flood fill and a level can
    // offer hundreds of candidates.
    for (const candidate of ranked.slice(0, GATE_PROBE_LIMIT)) {
      if (cost(candidate.room) <= maxGates && gatesTheExit(candidate.room, grid, spawn, exit)) {
        chosen.push(candidate);
        spent += cost(candidate.room);
        break;
      }
    }
  }
  for (const candidate of ranked) {
    if (spent >= maxGates) break;
    if (chosen.includes(candidate)) continue;
    const price = cost(candidate.room);
    if (spent + price > maxGates) continue; // take a cheaper room rather than overshoot
    chosen.push(candidate);
    spent += price;
  }

  const doors: Point[] = [];
  // Lock in map order rather than rank order, so placement does not depend on
  // how the ranking happened to sort equal-worth rooms.
  for (const { room } of chosen.slice().sort((a, b) => a.index - b.index)) {
    for (const mouth of roomMouths(room, grid)) {
      grid[mouth.y][mouth.x] = DOOR_TILE;
      doors.push(mouth);
    }
  }
  return doors;
}

/**
 * Would locking this room alone put the exit out of reach from spawn?
 *
 * Probed on a scratch copy so the real grid is untouched — the answer only
 * decides which room earns the critical-path guarantee.
 */
function gatesTheExit(room: Room, grid: Tile[][], spawn: Point, exit: Point): boolean {
  const scratch = grid.map((row) => row.slice());
  for (const mouth of roomMouths(room, scratch)) scratch[mouth.y][mouth.x] = DOOR_TILE;
  return !reachableTiles(scratch, spawn, new Set()).has(key(exit));
}

/** Floor tiles just outside `room` that connect into it (corridor mouths). */
function roomMouths(room: Room, grid: Tile[][]): Point[] {
  const mouths: Point[] = [];
  const consider = (ox: number, oy: number, ix: number, iy: number): void => {
    if (grid[oy]?.[ox] === 0 && grid[iy]?.[ix] === 0) mouths.push({ x: ox, y: oy });
  };
  for (let x = room.x; x < room.x + room.w; x++) {
    consider(x, room.y - 1, x, room.y); // top
    consider(x, room.y + room.h, x, room.y + room.h - 1); // bottom
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    consider(room.x - 1, y, room.x, y); // left
    consider(room.x + room.w, y, room.x + room.w - 1, y); // right
  }
  return mouths;
}

/**
 * Scatter one "dependency key" per door, each in an area reachable *before* its
 * door opens. Simulates unlocking: repeatedly find a door on the frontier of
 * the currently-reachable region, drop a key on reachable public floor, then
 * open that door and expand. This keeps every level solvable in key order.
 */
export function placeKeys(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
  doors: Point[],
  breakupRooms: Rect[],
  rng: () => number,
  exceptionZones: readonly ExceptionZone[] = [],
): KeyItem[] {
  if (doors.length === 0) return [];

  const keys: KeyItem[] = [];
  const opened = new Set<string>();
  const used = new Set<string>([
    key(spawn),
    key(exit),
    ...enemies.map((e) => key({ x: Math.floor(e.x), y: Math.floor(e.y) })),
    ...breakupTileKeys(breakupRooms),
    // An Exception Handling Zone is opt-in, and a key inside one takes that
    // away. Its `try` gauntlet is deliberately unavoidable acid plus spikes
    // and a mine — a toll that is only defensible because *choosing* to pay
    // it is what buys the `catch`/`finally` loot. Put a door key past it and
    // the gauntlet stops being a risk/reward detour and becomes a mandatory
    // damage tax on the critical path, which no other locked door in the
    // game charges.
    //
    // Not hypothetical: measured across the demo campaign this landed a key
    // inside a zone on 4 of the 7 levels that have one, and on
    // `stage06_pipeline.py` it produced 36 recorded `healthDrainFrozen`
    // events in a single 8-level telemetry scan — the bot crossing acid it
    // had no way to decline. All three rects are excluded, not just `try`:
    // `catch` and `finally` are only reachable *through* the gauntlet, so a
    // key in either is exactly as mandatory as one in the acid itself.
    ...breakupTileKeys(exceptionZones.flatMap((z) => [z.tryRect, z.catchRect, z.finallyRect])),
  ]);
  // Reachable set from the previous iteration, so each key can be confined
  // to the room its own door just unlocked (see `newlyReachable` below)
  // instead of the ever-growing cumulative reachable set, which would let
  // the (usually largest) initial public area dominate every pick.
  let previousReachable = new Set<string>();

  while (opened.size < doors.length) {
    // `opened` grows by a whole doorway at a time, so this still terminates —
    // it just stops sooner than one iteration per door tile.
    const reachable = reachableTiles(grid, spawn, opened);
    const frontier = doors.find(
      (d) => !opened.has(key(d)) && neighbors(d).some((n) => reachable.has(key(n))),
    );
    if (!frontier) break; // remaining doors are unreachable dead-ends

    const newlyReachable = new Set([...reachable].filter((k) => !previousReachable.has(k)));
    // Fall back to the full reachable set only when the newly-opened area
    // has no usable tile left (e.g. a door that loops back into already-
    // explored floor) — better than silently dropping the key.
    const spot = pickKeySpot(newlyReachable, grid, used, rng) ?? pickKeySpot(reachable, grid, used, rng);
    if (spot) {
      used.add(key(spot));
      keys.push({ x: spot.x + 0.5, y: spot.y + 0.5, collected: false });
    }
    // One key opens the whole doorway, not one tile of it — see
    // `doorwayTiles`. Marking every tile of the run as opened here is what
    // keeps the key count equal to the number of *gates* a player actually
    // has to get through, rather than to the width of the widest one.
    for (const tile of doorwayTiles(grid, frontier)) opened.add(key(tile));
    previousReachable = reachable;
  }
  return keys;
}

/** Pick a random reachable open-floor tile for a key (not already used). */
function pickKeySpot(
  reachable: Set<string>,
  grid: Tile[][],
  used: Set<string>,
  rng: () => number,
): Point | null {
  const candidates: Point[] = [];
  for (const k of reachable) {
    if (used.has(k)) continue;
    const [x, y] = k.split(",").map(Number);
    if (grid[y][x] === 0) candidates.push({ x, y });
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

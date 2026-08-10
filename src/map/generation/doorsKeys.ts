// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Door placement on private/protected method rooms, and the matching
 * solvable-in-key-order key scatter. */
import { DOOR_TILE, GATE_COLOR_COUNT, type Enemy, type ExceptionZone, type Gate, type KeyItem, type Point, type Rect, type Room, type Tile } from "../types";
import { breakupTileKeys } from "./breakup";
import { doorwayTiles, isLockableRoom } from "./geometry";
import { reachableTiles } from "./pathing";
import { key, neighbors } from "./util";

/**
 * How many gates — locked *rooms* — a level may carry, at most.
 *
 * Every gate is a mandatory "go and find its key" detour, so this budgets the
 * player's patience, not the map's size: a bigger level does not make a fifth
 * key hunt more welcome, it just makes it longer.
 *
 * Unbounded before, which is the defect the cap fixed: `isLockableRoom` fires
 * on every private/protected method, so a large source file produced a level
 * made of gates. Measured 2026-08-07 across the staged corpora — ripgrep's
 * level 8 carried 64 doors and 38 keys and chained into a **120-leg** route
 * that stopped 16 of 18 capture runs at exactly that level; its level 15
 * reached 2,653 doors and 771 keys, and laravel peaked at 101 legs.
 *
 * **Counted in rooms, not doorways** (2026-08-10). It used to be doorways,
 * because the engine charged a key per doorway and a six-mouth room was six key
 * hunts for one space; a key now opens its whole room, so a room costs exactly
 * one key however many mouths it has. Sized from what levels already produce
 * rather than guessed — `npm run report:gate-budget`, two independent samples
 * agreeing: demo-campaign (17 levels, 9 gating) and laravel's `Support` (25
 * levels, 15 gating) both give p50 2, p90 3, **max 3** gated rooms per level.
 * 4 therefore never gates less than today's ceiling, leaves one slot of
 * headroom, and equals `GATE_COLOR_COUNT` so no level ever reuses a colour.
 */
export const MAX_GATE_ROOMS = GATE_COLOR_COUNT;

/** How many of the highest-worth candidates are probed for gating the exit. */
const GATE_PROBE_LIMIT = 24;

/**
 * Lock a bounded, deliberately-chosen subset of the private/protected-method
 * rooms by turning every corridor mouth into a door tile. The spawn room is
 * never locked. Returns one `Gate` per locked room.
 *
 * **The budget is counted in rooms**, because a room is what costs a key: one
 * key opens every door of its own gate (`openDoorAhead`, mirrored by
 * `assertAllRoomsReachable`). A room is locked wholly or not at all — leaving
 * one mouth open would make the other locks pointless.
 *
 * That was not always true. The budget used to be doorways and the ranking
 * divided worth by them, so a one-mouth room beat an equally good six-mouth
 * one — a penalty for a shape that now costs nothing extra, so the divisor is
 * gone and ranking is worth alone. Two approaches were tried before that and
 * are worth not repeating: requiring *only* single-doorway rooms left ripgrep's
 * levels with zero gates, removing the mechanic rather than bounding it; and
 * charging one key per room while the engine still spent one per doorway broke
 * the key economy outright — `assertAllRoomsReachable` correctly reported rooms
 * unreachable, which is why the engine and the generator had to move together.
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
): Gate[] {
  const { spawn, exit, enemies = [], pickups = [], maxGates = MAX_GATE_ROOMS } = opts;
  const candidates = rooms
    .map((room, index) => ({ room, index }))
    .filter(({ room, index }) => isLockableRoom(room, index));
  if (candidates.length === 0) return [];

  const inside = (room: Room, p: Point): boolean => p.x >= room.x && p.x < room.x + room.w && p.y >= room.y && p.y < room.y + room.h;
  // Area dominates, with occupants as a tie-breaker: a big room is the reward,
  // and enemies/pickups inside it are what make it worth the key.
  const worth = (room: Room): number =>
    room.w * room.h + 4 * enemies.filter((e) => inside(room, { x: Math.floor(e.x), y: Math.floor(e.y) })).length + 6 * pickups.filter((p) => inside(room, p)).length;
  // Ranked on worth alone: every room costs exactly one key now, so there is
  // nothing to divide by. The index tie-break is deliberate — without the old
  // divisor `worth` is a small integer and exact ties are common, and sort
  // stability is a weaker guarantee than a generation input deserves.
  const ranked = candidates.slice().sort((a, b) => worth(b.room) - worth(a.room) || a.index - b.index);

  const chosen: typeof ranked = [];
  if (spawn && exit && maxGates >= 1) {
    // Only the best few are probed: each probe is a flood fill and a level can
    // offer hundreds of candidates.
    for (const candidate of ranked.slice(0, GATE_PROBE_LIMIT)) {
      if (gatesTheExit(candidate.room, grid, spawn, exit)) {
        chosen.push(candidate);
        break;
      }
    }
  }
  for (const candidate of ranked) {
    if (chosen.length >= maxGates) break;
    if (chosen.includes(candidate)) continue;
    chosen.push(candidate);
  }

  const gates: Gate[] = [];
  // Lock in map order rather than rank order, so placement — and therefore the
  // colour each gate gets — does not depend on how the ranking happened to sort
  // equal-worth rooms. Colours are assigned by position in this list, which
  // draws no rng: `placeDoors` has never drawn any, and starting would shift
  // every downstream placement.
  for (const { room } of chosen.slice().sort((a, b) => a.index - b.index)) {
    const doors: Point[] = [];
    for (const mouth of roomMouths(room, grid)) {
      grid[mouth.y][mouth.x] = DOOR_TILE;
      doors.push(mouth);
    }
    if (doors.length === 0) continue; // a room with no mouth cannot be gated
    gates.push({ id: gates.length, colorIndex: gates.length % GATE_COLOR_COUNT, room, doors });
  }
  return gates;
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
 * Scatter one "dependency key" per *gate*, each in an area reachable **before**
 * its own gate opens. Simulates unlocking: repeatedly find a gate with a door on
 * the frontier of the currently-reachable region, drop its key on reachable
 * public floor, then open that gate's whole set of doors and expand. This keeps
 * every level solvable in key order.
 *
 * Returns the surviving gates alongside the keys. A gate is dropped — its door
 * tiles reverted to floor — only when no key can be placed for it at all, or
 * when it turned out to sit entirely in a region unreachable from spawn. Both
 * are pathological; see `placeKeyFor`. Reverting is exact, because `roomMouths`
 * only ever chose tiles that were plain floor.
 *
 * The invariant this buys is total, and both `assertAllRoomsReachable` and the
 * route planner depend on it: **every gate has exactly one key.**
 */
export function placeKeys(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
  gates: Gate[],
  breakupRooms: Rect[],
  rng: () => number,
  exceptionZones: readonly ExceptionZone[] = [],
): { keys: KeyItem[]; gates: Gate[] } {
  if (gates.length === 0) return { keys: [], gates: [] };

  const keys: KeyItem[] = [];
  const opened = new Set<string>();
  const survivors: Gate[] = [];
  const hardExcluded = new Set<string>([
    key(spawn),
    key(exit),
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
    //
    // This is the one exclusion the fallback tiers below never relax: it is a
    // measured gameplay decision, not a convenience.
    ...breakupTileKeys(exceptionZones.flatMap((z) => [z.tryRect, z.catchRect, z.finallyRect])),
  ]);
  // Relaxable in the later tiers: an enemy standing on a key does not block it
  // (collection is pure proximity and enemies are not solid), a breakup room is
  // ordinary floor, and two keys sharing a tile are both still collectable.
  const occupied = new Set<string>([
    ...enemies.map((e) => key({ x: Math.floor(e.x), y: Math.floor(e.y) })),
    ...breakupTileKeys(breakupRooms),
  ]);
  const takenByKey = new Set<string>();
  // Reachable set from the previous iteration, so each key can be confined
  // to the room its own gate just unlocked (see `newlyReachable` below)
  // instead of the ever-growing cumulative reachable set, which would let
  // the (usually largest) initial public area dominate every pick.
  let previousReachable = new Set<string>();

  const unopened = new Set(gates.map((g) => g.id));
  while (unopened.size > 0) {
    const reachable = reachableTiles(grid, spawn, opened);
    const frontier = gates.find(
      (g) => unopened.has(g.id) && g.doors.some((d) => neighbors(d).some((n) => reachable.has(key(n)))),
    );
    if (!frontier) break; // every remaining gate sits in an unreachable region

    const newlyReachable = new Set([...reachable].filter((k) => !previousReachable.has(k)));
    const spot = placeKeyFor(newlyReachable, reachable, grid, { hardExcluded, occupied, takenByKey }, rng);
    if (spot) {
      takenByKey.add(key(spot));
      keys.push({ x: spot.x + 0.5, y: spot.y + 0.5, collected: false, gateId: survivors.length });
      survivors.push({ ...frontier, id: survivors.length, colorIndex: survivors.length % GATE_COLOR_COUNT });
      // One key opens the whole gate, not one doorway of it — mark every door
      // tile opened so the next iteration sees what the player would.
      for (const door of frontier.doors) for (const tile of doorwayTiles(grid, door)) opened.add(key(tile));
    } else {
      unlockGate(frontier, grid);
    }
    unopened.delete(frontier.id);
    previousReachable = reachable;
  }
  // Anything still unopened is unreachable from spawn even with every earlier
  // gate open, so locking it can only hide rooms. Un-gate rather than ship a
  // door whose key nobody can reach.
  for (const gate of gates) if (unopened.has(gate.id)) unlockGate(gate, grid);

  return { keys, gates: survivors };
}

/** Revert a gate's doors to plain floor. Exact: `roomMouths` only ever chose
 * tiles that were `0`. */
function unlockGate(gate: Gate, grid: Tile[][]): void {
  console.warn(`[map] un-gating a locked room — no reachable spot for its key (${gate.doors.length} door tile(s))`);
  for (const door of gate.doors) for (const tile of doorwayTiles(grid, door)) grid[tile.y][tile.x] = 0;
}

/**
 * Find somewhere to put a gate's key, widening the search rather than giving
 * up — a skipped key used to strand one doorway of a room that had others, but
 * a gate's single key stranding means the whole room is lost.
 *
 * The tiers relax only the exclusions that are conveniences, never the ones
 * that are decisions: the exception-zone exclusion (and spawn/exit) hold at
 * every tier.
 */
function placeKeyFor(
  newlyReachable: Set<string>,
  reachable: Set<string>,
  grid: Tile[][],
  sets: { hardExcluded: Set<string>; occupied: Set<string>; takenByKey: Set<string> },
  rng: () => number,
): Point | null {
  const { hardExcluded, occupied, takenByKey } = sets;
  const strict = new Set([...hardExcluded, ...occupied, ...takenByKey]);
  return (
    // 1-2: today's behaviour — prefer the area this gate's predecessor opened,
    // then anywhere reachable.
    pickKeySpot(newlyReachable, grid, strict, rng) ??
    pickKeySpot(reachable, grid, strict, rng) ??
    // 3: an enemy or a breakup room on the tile does not stop a player walking
    // over the key.
    pickKeySpot(reachable, grid, new Set([...hardExcluded, ...takenByKey]), rng) ??
    // 4: two keys on one tile are both collectable — collection is by radius.
    pickKeySpot(reachable, grid, hardExcluded, rng)
  );
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

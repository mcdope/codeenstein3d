// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * "Exception Handling Zones": a `try`/`catch`/`finally` becomes a sequential
 * three-part detour hanging off whichever room contains it — risk, then
 * recovery, then reward.
 *
 * 1. the **try** gauntlet: a one-tile-wide acid corridor studded with spike
 *    traps and a proximity mine. You will take damage crossing it.
 * 2. the **catch** alcove at its far end: guaranteed health *and* swap, so the
 *    damage the `try` did is genuinely handled rather than merely survived.
 * 3. the **finally** room past that: safe, with guaranteed standard loot —
 *    the block that runs no matter what.
 *
 * The whole chain is carved as one straight run out from the anchor room, or
 * not at all: a partial zone would strand a player in acid with no payoff.
 */
import type { ExceptionZoneTrigger } from "../../parser/types";
import {
  HAZARD_TILE,
  SPIKE_TRAP_TILE,
  type AmmoPickup,
  type ExceptionZone,
  type Mine,
  type Point,
  type Rect,
  type Room,
  type SpikeTrap,
  type Tile,
} from "../types";
import { roomForLine, sideCandidateFits, sideCandidates, type SideCandidate } from "./geometry";
import { SPIKE_PERIOD_MAX, SPIKE_PERIOD_MIN } from "./trapsHazards";
import { shuffle } from "./util";

/** Feature flag — see `doc/dev/architecture.md`'s Feature Flags table. Checked
 * at the `mapGenerator.ts` call site, so a disabled feature draws zero rng. */
export const EXCEPTION_ZONES_ENABLED = true;

/** Capped like lore terminals and secret rooms are: a legacy file can be wall
 * to wall with try/catch, and three of these is already a lot of level. */
const MAX_EXCEPTION_ZONES = 3;

/** Length of the one-tile-wide acid gauntlet, in tiles. Long enough to hurt at
 * `HAZARD_DPS`, short enough that it never reads as unsurvivable. */
const TRY_CORRIDOR_LENGTH = 5;
/** Interior footprint of the catch alcove and the finally room. */
const CATCH_ALCOVE_SIZE = 2;
const FINALLY_ROOM_SIZE = 3;
/** Total run of the chain along its outward axis. */
const CHAIN_LENGTH = TRY_CORRIDOR_LENGTH + CATCH_ALCOVE_SIZE + FINALLY_ROOM_SIZE;
/** Widest segment (the finally room), and therefore the chain's cross-axis
 * footprint — everything narrower is centered inside it. */
const CHAIN_CROSS_WIDTH = FINALLY_ROOM_SIZE;

/** Spike traps in the gauntlet, spread over its length. */
const TRY_SPIKE_COUNT = Math.floor(TRY_CORRIDOR_LENGTH / 2);

/**
 * The catch alcove's guaranteed restoration. Both a health *and* a swap pickup,
 * never a coin flip between them: `collectLoot` clamps health at `MAX_HEALTH`,
 * so a player who came through the gauntlet on full health would find a
 * "guaranteed" health-only reward silently doing nothing. Swap is essentially
 * never full, so the guarantee always actually lands.
 */
const CATCH_HEALTH_AMOUNT = 45;
const CATCH_SWAP_AMOUNT = 35;

/** The finally room's guaranteed standard loot. */
const FINALLY_BULLETS_AMOUNT = 14;
const FINALLY_ROCKETS_AMOUNT = 3;

export interface ExceptionZoneResult {
  zones: ExceptionZone[];
  hazards: Point[];
  spikeTraps: SpikeTrap[];
  mines: Mine[];
  pickups: AmmoPickup[];
}

/**
 * Carve up to `MAX_EXCEPTION_ZONES` three-part zones, one per anchor room.
 *
 * The spawn room is never an anchor. The gauntlet is unavoidable acid plus an
 * invisible mine, and a player must never take unavoidable damage in the first
 * instants of a level — see
 * `doc/dev/decisions.md#hazard-placement-spawn-safety`, the same rule
 * `fillHazards` and `placeTodoEncounter` already follow.
 *
 * Triggers are shuffled before the cap is applied so a file with a dozen
 * try/catches samples fairly across them rather than always taking the first
 * three in source order.
 *
 * Never a hard failure: an anchor with no room for the whole chain beside it
 * simply doesn't get a zone.
 */
export function placeExceptionZones(
  rooms: Room[],
  grid: Tile[][],
  mapSize: number,
  triggers: readonly ExceptionZoneTrigger[],
  rng: () => number,
  hasRocketLauncher: boolean,
): ExceptionZoneResult {
  const result: ExceptionZoneResult = { zones: [], hazards: [], spikeTraps: [], mines: [], pickups: [] };
  if (triggers.length === 0) return result;

  const shuffled = [...triggers];
  shuffle(shuffled, rng);

  const usedAnchors = new Set<Room>();
  for (const trigger of shuffled) {
    if (result.zones.length >= MAX_EXCEPTION_ZONES) break;
    // A construct with neither clause has no second or third segment to build.
    if (trigger.catchCount === 0 && !trigger.hasFinally) continue;

    const anchor = roomForLine(rooms, trigger.startLine) ?? rooms[0];
    if (!anchor || anchor === rooms[0] || usedAnchors.has(anchor)) continue;

    const candidates = [
      ...sideCandidates(anchor, CHAIN_CROSS_WIDTH, CHAIN_LENGTH, 0).filter((c) => c.side === "top" || c.side === "bottom"),
      ...sideCandidates(anchor, CHAIN_LENGTH, CHAIN_CROSS_WIDTH, 0).filter((c) => c.side === "left" || c.side === "right"),
    ];
    shuffle(candidates, rng);

    const fit = candidates.find((c) => sideCandidateFits(c, grid, mapSize));
    if (!fit) continue;

    usedAnchors.add(anchor);
    carveZone(fit, grid, rng, hasRocketLauncher, result);
  }

  return result;
}

/** Carve one accepted chain and fill in its three segments. */
function carveZone(
  candidate: SideCandidate,
  grid: Tile[][],
  rng: () => number,
  hasRocketLauncher: boolean,
  out: ExceptionZoneResult,
): void {
  // The doorway itself opens into the gauntlet — no separate corridor, the
  // gauntlet *is* the corridor.
  grid[candidate.wall.y][candidate.wall.x] = 0;

  // --- try: a one-tile-wide acid run, spikes spread along it, one mine. ---
  const tryTiles: Point[] = [];
  for (let along = 1; along <= TRY_CORRIDOR_LENGTH; along++) tryTiles.push(chainTile(candidate, along, 0));
  for (const tile of tryTiles) {
    grid[tile.y][tile.x] = HAZARD_TILE;
    out.hazards.push({ x: tile.x, y: tile.y });
  }

  // Spikes replace acid rather than sitting on it — a tile is one hazard kind
  // or the other, and doubling them up would be invisible to the player.
  for (let i = 0; i < TRY_SPIKE_COUNT; i++) {
    const along = 1 + Math.floor(((i + 1) * TRY_CORRIDOR_LENGTH) / (TRY_SPIKE_COUNT + 1));
    const tile = chainTile(candidate, along, 0);
    grid[tile.y][tile.x] = SPIKE_TRAP_TILE;
    dropHazardAt(out.hazards, tile);
    out.spikeTraps.push({
      x: tile.x,
      y: tile.y,
      period: SPIKE_PERIOD_MIN + rng() * (SPIKE_PERIOD_MAX - SPIKE_PERIOD_MIN),
      phase: rng() * SPIKE_PERIOD_MAX,
    });
  }

  // The mine keeps the acid tile it sits on — mines are invisible until
  // triggered and never mark the grid, the same convention `placeTraps` and
  // `placeTodoEncounter` both follow.
  const mineTile = chainTile(candidate, Math.ceil(TRY_CORRIDOR_LENGTH / 2), 0);
  out.mines.push({ x: mineTile.x + 0.5, y: mineTile.y + 0.5, alive: true, visible: false, closeTimer: 0 });

  // --- catch: the restoration alcove. ---
  const catchTiles = segmentTiles(candidate, TRY_CORRIDOR_LENGTH + 1, CATCH_ALCOVE_SIZE, CATCH_ALCOVE_SIZE);
  for (const tile of catchTiles) grid[tile.y][tile.x] = 0;
  out.pickups.push(pickupAt(catchTiles[0], "health", CATCH_HEALTH_AMOUNT));
  out.pickups.push(pickupAt(catchTiles[catchTiles.length - 1], "swap", CATCH_SWAP_AMOUNT));

  // --- finally: the safe payoff room. ---
  const finallyStart = TRY_CORRIDOR_LENGTH + CATCH_ALCOVE_SIZE + 1;
  const finallyTiles = segmentTiles(candidate, finallyStart, FINALLY_ROOM_SIZE, FINALLY_ROOM_SIZE);
  for (const tile of finallyTiles) grid[tile.y][tile.x] = 0;
  const loot: { kind: AmmoPickup["kind"]; amount: number } = hasRocketLauncher
    ? { kind: "rockets", amount: FINALLY_ROCKETS_AMOUNT }
    : { kind: "bullets", amount: FINALLY_BULLETS_AMOUNT };
  out.pickups.push(pickupAt(finallyTiles[Math.floor(finallyTiles.length / 2)], loot.kind, loot.amount));

  out.zones.push({
    tryRect: boundsOf(tryTiles),
    catchRect: boundsOf(catchTiles),
    finallyRect: boundsOf(finallyTiles),
  });
}

/**
 * A tile in the chain's own coordinate frame: `along` tiles out from the
 * doorway (1 = the first tile past it), `cross` tiles sideways from the
 * doorway's own line. The perpendicular is derived from the outward step by
 * swapping its components, which is why this works unchanged on all four
 * sides.
 */
function chainTile(candidate: SideCandidate, along: number, cross: number): Point {
  const perpX = candidate.step.y;
  const perpY = candidate.step.x;
  return {
    x: candidate.wall.x + candidate.step.x * along + perpX * cross,
    y: candidate.wall.y + candidate.step.y * along + perpY * cross,
  };
}

/** Every tile of one `size`-wide, `length`-long segment starting `along` tiles
 * out, centered on the chain's axis the same way `sideCandidates` centers a
 * footprint on its doorway. */
function segmentTiles(candidate: SideCandidate, alongStart: number, length: number, size: number): Point[] {
  const half = Math.floor(size / 2);
  const tiles: Point[] = [];
  for (let along = alongStart; along < alongStart + length; along++) {
    for (let cross = -half; cross < -half + size; cross++) tiles.push(chainTile(candidate, along, cross));
  }
  return tiles;
}

/** Remove a tile from the accumulated hazard list — used when a spike replaces
 * an acid tile that was already recorded. */
function dropHazardAt(hazards: Point[], tile: Point): void {
  const index = hazards.findIndex((h) => h.x === tile.x && h.y === tile.y);
  /* v8 ignore next -- @preserve: every spike position is one of the acid tiles
   * pushed a few lines above, so the lookup always hits. Guarded rather than
   * spliced blindly so a future change to the spike spacing can't silently
   * drop an unrelated hazard at index -1. */
  if (index >= 0) hazards.splice(index, 1);
}

function pickupAt(tile: Point, kind: AmmoPickup["kind"], amount: number): AmmoPickup {
  return { x: tile.x + 0.5, y: tile.y + 0.5, kind, amount, collected: false };
}

/** Axis-aligned bounds of a tile list, as the `{x, y, w, h}` rect `GameMap`
 * arrays use. */
function boundsOf(tiles: readonly Point[]): Rect {
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
}

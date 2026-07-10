// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Corridor choke-point traps (spikes/mines) and global-variable acid pools. */
import { HAZARD_TILE, SPIKE_TRAP_TILE, type Mine, type Point, type Rect, type Room, type SpikeTrap, type Tile } from "../types";
import { isChokePoint, isCorridorFloor } from "./corridors";
import { dist, shuffle } from "./util";

/** Minimum/maximum full safe→active→safe cycle length for a spike trap.
 * Playtest feedback: the original 2.2-3.6s cycle alternated too fast to read
 * in time, so both bounds were raised. */
export const SPIKE_PERIOD_MIN = 3.5;
export const SPIKE_PERIOD_MAX = 5.5;
/** Minimum spacing (tiles) kept between any two traps, and between a trap and
 * any other avoid-listed point (spawn/exit/enemies/doors/keys/pads). */
export const TRAP_SPACING = 3;
/** One trap (spike or mine, roughly split evenly) per this many candidate
 * choke-point tiles found, capped so tiny levels don't get overloaded. */
const CHOKE_POINTS_PER_TRAP = 5;
const MAX_TRAPS = 8;

/** Every corridor choke-point tile in the level, candidates for trap placement. */
function corridorChokePoints(rooms: Room[], grid: Tile[][], breakupRooms: Rect[]): Point[] {
  const points: Point[] = [];
  for (let y = 1; y < grid.length - 1; y++) {
    for (let x = 1; x < grid[y].length - 1; x++) {
      if (isCorridorFloor(x, y, grid, rooms, breakupRooms) && isChokePoint(x, y, grid)) points.push({ x, y });
    }
  }
  return points;
}

/**
 * Scatter timed spike traps and proximity mines across corridor choke points,
 * alternating between the two kinds. Skips any candidate too close to an
 * `avoid`-listed point (spawn, exit, enemies, doors, keys, teleporter pads) or
 * to a trap already placed. Never a hard failure — a level with few/no
 * corridors simply gets few/no traps.
 */
export function placeTraps(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
  breakupRooms: Rect[],
): { spikeTraps: SpikeTrap[]; mines: Mine[] } {
  const candidates = corridorChokePoints(rooms, grid, breakupRooms);
  shuffle(candidates, rng);

  const budget = Math.min(MAX_TRAPS, Math.floor(candidates.length / CHOKE_POINTS_PER_TRAP));
  const spikeTraps: SpikeTrap[] = [];
  const mines: Mine[] = [];
  const chosen: Point[] = [];

  const farEnough = (p: Point): boolean => {
    const px = p.x + 0.5;
    const py = p.y + 0.5;
    if (avoid.some((a) => dist(px, py, a.x, a.y) < TRAP_SPACING)) return false;
    if (chosen.some((c) => dist(px, py, c.x + 0.5, c.y + 0.5) < TRAP_SPACING)) return false;
    return true;
  };

  for (const p of candidates) {
    if (spikeTraps.length + mines.length >= budget) break;
    if (!farEnough(p)) continue;
    chosen.push(p);

    if (spikeTraps.length <= mines.length) {
      grid[p.y][p.x] = SPIKE_TRAP_TILE;
      spikeTraps.push({
        x: p.x,
        y: p.y,
        period: SPIKE_PERIOD_MIN + rng() * (SPIKE_PERIOD_MAX - SPIKE_PERIOD_MIN),
        phase: rng() * SPIKE_PERIOD_MAX,
      });
    } else {
      // Mines stay on plain floor (tile 0) — they're invisible until
      // triggered, so nothing should mark their tile on the grid.
      mines.push({ x: p.x + 0.5, y: p.y + 0.5, alive: true, visible: false, closeTimer: 0 });
    }
  }

  return { spikeTraps, mines };
}

/**
 * Turn each global-variable room into an acid pool: fill its interior (leaving
 * a 1-tile walkable rim) with hazard tiles. The spawn room is skipped and the
 * spawn/exit tiles are always kept clear so the player never starts or wins in
 * acid. Returns every hazard tile for rendering.
 */
export function fillHazards(
  rooms: Room[],
  grid: Tile[][],
  spawn: Point,
  exit: Point,
): Point[] {
  const hazards: Point[] = [];
  rooms.forEach((room, index) => {
    if (room.entity.kind !== "global") return;
    if (index === 0) return; // never flood the spawn room
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        if (x === spawn.x && y === spawn.y) continue;
        if (x === exit.x && y === exit.y) continue;
        grid[y][x] = HAZARD_TILE;
        hazards.push({ x, y });
      }
    }
  });
  return hazards;
}

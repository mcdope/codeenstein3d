// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Corridor breakup: interrupt long straight corridor runs with small rooms
 * or forced jogs so hallways never offer one endless sightline. */
import type { Rect, Room, Tile } from "../types";
import { carveHLine, carveVLine, isChokePoint, isCorridorFloor } from "./corridors";
import { roomsOverlap } from "./geometry";
import { clamp, key } from "./util";

/**
 * Longest unbroken straight corridor run (tiles) allowed after carving.
 * `corridorWaypoints` only jitters *turn* positions, so a room pair offset
 * mostly along one axis (or two unrelated corridor legs that happen to line
 * up) can still produce one long straight sightline even with jogging — see
 * `breakUpLongCorridors`, which scans the finished grid for runs past this
 * length and interrupts each one with a small room or a forced jog.
 */
const MAX_CORRIDOR_STRAIGHT_LENGTH = 9;
/** Half-width of the tile window forced back to wall when jogging a straight
 * run that couldn't fit an injected breakup room. */
const FORCED_JOG_CUT_HALFWIDTH = 1;
/** Min/max length (tiles) of the perpendicular detour carved around a forced
 * jog's cut. */
const FORCED_JOG_MIN_LEN = 2;
const FORCED_JOG_MAX_LEN = 3;
/** Local jitter (tiles) tried around each evenly-spaced target interruption
 * point, so a locally blocked target still has nearby room to try. */
const BREAKUP_LOCAL_JITTER = 3;
/** Retries at one target interruption point (each a fresh local-jitter
 * offset) before giving up on that specific point. */
const BREAKUP_ATTEMPTS_PER_POINT = 6;
/**
 * Rescan passes run *after* the primary evenly-spaced pass, to catch runs
 * formed only by two unrelated corridor legs landing collinear (rare), or a
 * stretch the primary pass's evenly-spaced targets couldn't reach because a
 * couple of adjacent targets both landed in the same locally-blocked area
 * (leaving a merged gap wider than an individual segment). Kept low relative
 * to `BREAKUP_WIDE_ATTEMPTS` — most maps need zero or one of these; only a
 * dense/adversarial layout needs several.
 */
const MAX_BREAKUP_SAFETY_PASSES = 10;
/** Random offsets tried across a run's *entire* remaining span during a
 * safety-net pass (as opposed to the primary pass's local jitter around a
 * fixed target) — a wide, unclustered search finds whatever free spot is
 * left on a run even when it's far from the run's midpoint. */
const BREAKUP_WIDE_ATTEMPTS = 15;

/** Breakup room footprint bounds (tiles), rolled independently per axis so
 * the room isn't always a fixed-size square. */
const BREAKUP_ROOM_MIN_DIM = 3;
const BREAKUP_ROOM_MAX_DIM = 5;

/** A contiguous straight run of plain corridor floor found by `findStraightRuns`. */
interface StraightRun {
  axis: "h" | "v";
  /** The row (for a horizontal run) or column (for a vertical run) the run sits on. */
  fixed: number;
  /** Inclusive start/end coordinate along the run's axis. */
  lo: number;
  hi: number;
}

/** Every tile key inside each of `rects` — used to keep grid-scanning
 * placement (keys) from claiming a breakup room's floor. */
export function breakupTileKeys(rects: Rect[]): string[] {
  const out: string[] = [];
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) out.push(key({ x, y }));
    }
  }
  return out;
}

/**
 * Every straight corridor run longer than `minLen`, found by scanning the
 * finished grid row-by-row and column-by-column for contiguous
 * `isCorridorFloor` tiles — excluding any tile already inside a previously
 * injected `breakupRooms` rect, so a room placed on an earlier pass actually
 * splits the run it interrupted instead of being counted as more corridor
 * floor (it's still tile value `0`, same as a plain corridor). Run length is
 * a property of the carved grid as a whole, not of any single carved leg —
 * two unrelated corridor legs can end up collinear and combine into one long
 * run neither leg alone exceeds — so this runs after every room and corridor
 * has been carved, rather than being folded into `carveCorridor`'s per-leg
 * loop. Scanning per fixed row/column naturally splits a run at an L-turn
 * corner (the corner tile only extends one row's or column's run), so no
 * special-casing is needed there.
 */
function findStraightRuns(grid: Tile[][], rooms: Room[], breakupRooms: Rect[], minLen: number): StraightRun[] {
  const runs: StraightRun[] = [];
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  for (let y = 1; y < h - 1; y++) {
    let start = -1;
    for (let x = 1; x <= w - 1; x++) {
      const floor = x < w - 1 && isCorridorFloor(x, y, grid, rooms, breakupRooms);
      if (floor) {
        if (start === -1) start = x;
      } else if (start !== -1) {
        if (x - start > minLen) runs.push({ axis: "h", fixed: y, lo: start, hi: x - 1 });
        start = -1;
      }
    }
  }

  for (let x = 1; x < w - 1; x++) {
    let start = -1;
    for (let y = 1; y <= h - 1; y++) {
      const floor = y < h - 1 && isCorridorFloor(x, y, grid, rooms, breakupRooms);
      if (floor) {
        if (start === -1) start = y;
      } else if (start !== -1) {
        if (y - start > minLen) runs.push({ axis: "v", fixed: x, lo: start, hi: y - 1 });
        start = -1;
      }
    }
  }

  return runs;
}

function randomBreakupDim(rng: () => number): number {
  return BREAKUP_ROOM_MIN_DIM + Math.floor(rng() * (BREAKUP_ROOM_MAX_DIM - BREAKUP_ROOM_MIN_DIM + 1));
}

/**
 * Try to interrupt a long straight run by carving a small room centered on
 * its midpoint, perpendicular to the run's axis. Rejects (returns `null`) if
 * the footprint would leave the map border, or overlap any real `Room` or a
 * previously-injected breakup room (the same overlap rule `tryPlaceRoom`
 * already uses to keep normal rooms apart — the check that matters here is
 * room/room collision, not "untouched wall": the footprint legitimately
 * straddles the run's already-floor corridor tiles).
 *
 * The room's along-run and across-run dimensions are rolled independently
 * (3-5 tiles each) rather than always a fixed square, and the run's own line
 * doesn't sit dead-center across the room's width — both roll differently
 * per room, so consecutive breakup rooms don't all look identical. See
 * `breakUpRoomSightline` for why the entry and exit aren't a straight walk
 * through the middle either.
 */
function tryInjectBreakupRoom(
  grid: Tile[][],
  rooms: Room[],
  breakupRooms: Rect[],
  size: number,
  run: StraightRun,
  mid: number,
  roomMargin: number,
  rng: () => number,
): Rect | null {
  const along = randomBreakupDim(rng);
  const across = randomBreakupDim(rng);
  // How far the run's own line sits from the room's near edge, across its
  // width — clamped so there's always at least 1 tile of room on both sides
  // of it, but otherwise free to land off-center.
  const offset = 1 + Math.floor(rng() * Math.max(1, across - 2));
  const halfAlong = Math.floor(along / 2);
  const rect: Rect =
    run.axis === "h"
      ? { x: mid - halfAlong, y: run.fixed - offset, w: along, h: across }
      : { x: run.fixed - offset, y: mid - halfAlong, w: across, h: along };

  if (rect.x < 1 || rect.y < 1 || rect.x + rect.w > size - 1 || rect.y + rect.h > size - 1) return null;
  if (rooms.some((r) => roomsOverlap(rect, r, roomMargin))) return null;
  if (breakupRooms.some((r) => roomsOverlap(rect, r, roomMargin))) return null;

  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) grid[y][x] = 0;
  }
  breakUpRoomSightline(grid, rect, run.axis, run.fixed, rng);
  return rect;
}

/**
 * Wall off one interior column (for an `"h"` run) or row (for `"v"`) of the
 * room, leaving exactly one 1-tile gap somewhere other than the run's own
 * entry/exit line — the same "solid wall, single guaranteed gap" technique
 * `carveLabyrinth`'s `divide` already uses. Without this, a breakup room is
 * just a wider stretch of the same straight corridor: the entry and exit
 * sit on the same row/column, so the room is fully visible in one glance
 * the instant you step in, and the room's other rows/columns just look like
 * empty flanking space rather than requiring an actual detour. This forces
 * a short jog around the baffle instead, so the room reads as an actual
 * room rather than a wide spot in the hallway.
 */
function breakUpRoomSightline(grid: Tile[][], rect: Rect, axis: "h" | "v", fixed: number, rng: () => number): void {
  if (axis === "h") {
    if (rect.w < 3) return;
    const bx = rect.x + 1 + Math.floor(rng() * (rect.w - 2));
    const candidates: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) if (y !== fixed) candidates.push(y);
    if (candidates.length === 0) return;
    const gap = candidates[Math.floor(rng() * candidates.length)];
    for (let y = rect.y; y < rect.y + rect.h; y++) if (y !== gap) grid[y][bx] = 1;
  } else {
    if (rect.h < 3) return;
    const by = rect.y + 1 + Math.floor(rng() * (rect.h - 2));
    const candidates: number[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x++) if (x !== fixed) candidates.push(x);
    if (candidates.length === 0) return;
    const gap = candidates[Math.floor(rng() * candidates.length)];
    for (let x = rect.x; x < rect.x + rect.w; x++) if (x !== gap) grid[by][x] = 1;
  }
}

/**
 * Fallback when a breakup room won't fit: sever a short stretch of the
 * straight run back to wall and reroute around it with a 2-3 tile
 * perpendicular detour, breaking the direct sightline without adding a room.
 * Only cuts through tiles that are 1-wide choke points (`isChokePoint`) —
 * refusing to sever a tile a *different* corridor leg might depend on for
 * connectivity. Best-effort: returns `false` (leaving the run untouched)
 * rather than failing hard, matching this file's existing "never a hard
 * failure" placement convention.
 */
function tryForceJog(
  grid: Tile[][],
  rooms: Room[],
  breakupRooms: Rect[],
  run: StraightRun,
  mid: number,
  roomMargin: number,
  rng: () => number,
): boolean {
  const cutLo = mid - FORCED_JOG_CUT_HALFWIDTH;
  const cutHi = mid + FORCED_JOG_CUT_HALFWIDTH;
  if (cutLo - 1 <= run.lo || cutHi + 1 >= run.hi) return false;

  for (let i = cutLo; i <= cutHi; i++) {
    const cx = run.axis === "h" ? i : run.fixed;
    const cy = run.axis === "h" ? run.fixed : i;
    if (!isChokePoint(cx, cy, grid)) return false;
  }

  const dir = rng() < 0.5 ? 1 : -1;
  const jogLen = FORCED_JOG_MIN_LEN + Math.floor(rng() * (FORCED_JOG_MAX_LEN - FORCED_JOG_MIN_LEN + 1));

  const detour: Rect =
    run.axis === "h"
      ? { x: cutLo, y: dir > 0 ? run.fixed : run.fixed - jogLen, w: cutHi - cutLo + 1, h: jogLen + 1 }
      : { x: dir > 0 ? run.fixed : run.fixed - jogLen, y: cutLo, w: jogLen + 1, h: cutHi - cutLo + 1 };

  if (detour.x < 1 || detour.y < 1 || detour.x + detour.w > grid[0].length - 1 || detour.y + detour.h > grid.length - 1) {
    return false;
  }
  if (rooms.some((r) => roomsOverlap(detour, r, roomMargin))) return false;
  if (breakupRooms.some((r) => roomsOverlap(detour, r, roomMargin))) return false;

  if (run.axis === "h") {
    const y = run.fixed;
    const jy = y + dir * jogLen;
    for (let x = cutLo; x <= cutHi; x++) grid[y][x] = 1;
    carveVLine(grid, y, jy, cutLo);
    carveHLine(grid, cutLo, cutHi, jy);
    carveVLine(grid, jy, y, cutHi);
  } else {
    const x = run.fixed;
    const jx = x + dir * jogLen;
    for (let y = cutLo; y <= cutHi; y++) grid[y][x] = 1;
    carveHLine(grid, x, jx, cutLo);
    carveVLine(grid, cutLo, cutHi, jx);
    carveHLine(grid, jx, x, cutHi);
  }
  return true;
}

/**
 * Try to interrupt `run` at one target coordinate along its axis: a handful
 * of small local-jitter retries (see `BREAKUP_ATTEMPTS_PER_POINT`/
 * `BREAKUP_LOCAL_JITTER`), each first attempting a breakup room injection,
 * then a forced jog, before trying a fresh nearby offset. The jitter matters
 * because the exact target is sometimes locally blocked (a real room, or a
 * breakup room from an earlier run) even though a spot a couple tiles away
 * on the same run is free.
 */
function breakUpAtTarget(
  grid: Tile[][],
  rooms: Room[],
  breakupRooms: Rect[],
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
  target: number,
): boolean {
  const loBound = run.lo + 2;
  const hiBound = run.hi - 2;
  if (loBound > hiBound) return false;

  for (let attempt = 0; attempt < BREAKUP_ATTEMPTS_PER_POINT; attempt++) {
    const jitter = attempt === 0 ? 0 : Math.floor(rng() * (BREAKUP_LOCAL_JITTER * 2 + 1)) - BREAKUP_LOCAL_JITTER;
    const offset = clamp(target + jitter, loBound, hiBound);
    const injected = tryInjectBreakupRoom(grid, rooms, breakupRooms, size, run, offset, roomMargin, rng);
    if (injected) {
      breakupRooms.push(injected);
      return true;
    }
    if (tryForceJog(grid, rooms, breakupRooms, run, offset, roomMargin, rng)) return true;
  }
  return false;
}

/**
 * Split `run` into `⌈length / (MAX_CORRIDOR_STRAIGHT_LENGTH + 1)⌉` roughly
 * equal segments by interrupting it at evenly-spaced target points — e.g. a
 * 40-tile run gets ~4 interruption points ~8 tiles apart, in one shot,
 * rather than being bisected by repeated whole-grid rescans (which snowballs
 * into far more injected rooms than necessary as the map fills up, without
 * even reliably converging under the limit — see `MAX_BREAKUP_SAFETY_PASSES`'s
 * doc comment).
 */
function breakUpRunAtPoints(
  grid: Tile[][],
  rooms: Room[],
  breakupRooms: Rect[],
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
): void {
  const length = run.hi - run.lo + 1;
  const segments = Math.ceil(length / (MAX_CORRIDOR_STRAIGHT_LENGTH + 1));
  for (let s = 1; s < segments; s++) {
    const target = run.lo + Math.round((length * s) / segments);
    breakUpAtTarget(grid, rooms, breakupRooms, size, run, roomMargin, rng, target);
  }
}

/**
 * Try to interrupt `run` at any point along its whole remaining length: a
 * wide, unclustered random search (`BREAKUP_WIDE_ATTEMPTS` offsets spread
 * across the full span), as opposed to `breakUpAtTarget`'s local jitter
 * around one fixed point. Used by the safety-net passes below, where the
 * primary pass's evenly-spaced target already failed nearby — a wide search
 * can still find whatever free spot is left on the run, wherever it is.
 */
function breakUpRunWide(
  grid: Tile[][],
  rooms: Room[],
  breakupRooms: Rect[],
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
): boolean {
  const loBound = run.lo + 2;
  const hiBound = run.hi - 2;
  if (loBound > hiBound) return false;

  for (let attempt = 0; attempt < BREAKUP_WIDE_ATTEMPTS; attempt++) {
    const offset = loBound + Math.floor(rng() * (hiBound - loBound + 1));
    const injected = tryInjectBreakupRoom(grid, rooms, breakupRooms, size, run, offset, roomMargin, rng);
    if (injected) {
      breakupRooms.push(injected);
      return true;
    }
    if (tryForceJog(grid, rooms, breakupRooms, run, offset, roomMargin, rng)) return true;
  }
  return false;
}

/**
 * Break up every straight corridor run past `MAX_CORRIDOR_STRAIGHT_LENGTH`.
 * Primary pass: every run found by a single scan right after carving gets
 * evenly-spaced interruption points in one shot (see `breakUpRunAtPoints`) —
 * cheap and well-distributed for the common case. Safety-net passes: a
 * rescan (`MAX_BREAKUP_SAFETY_PASSES`) with a wide, unclustered search
 * (`breakUpRunWide`) catches anything the primary pass missed — a run formed
 * only by two unrelated corridor legs landing collinear, or a stretch where
 * a couple of the primary pass's evenly-spaced targets both landed in the
 * same locally-blocked area, merging into a wider-than-expected leftover gap.
 *
 * Called once, right after `connectRooms`, so every later generation stage
 * (spawn/exit, enemies, hazards, doors, ...) only ever sees the finished,
 * already-broken-up grid. Returns the rects of every breakup room actually
 * injected — used both to spawn "Edge Case" enemies exclusively inside them
 * (see `spawnEdgeCaseEnemies`) and to keep grid-scanning stages like
 * `placeKeys`/`placeTraps` from claiming their floor tiles.
 */
export function breakUpLongCorridors(grid: Tile[][], rooms: Room[], size: number, roomMargin: number, rng: () => number): Rect[] {
  const breakupRooms: Rect[] = [];

  const initialRuns = findStraightRuns(grid, rooms, breakupRooms, MAX_CORRIDOR_STRAIGHT_LENGTH);
  for (const run of initialRuns) breakUpRunAtPoints(grid, rooms, breakupRooms, size, run, roomMargin, rng);

  for (let pass = 0; pass < MAX_BREAKUP_SAFETY_PASSES; pass++) {
    const runs = findStraightRuns(grid, rooms, breakupRooms, MAX_CORRIDOR_STRAIGHT_LENGTH);
    if (runs.length === 0) break;

    let progressed = false;
    for (const run of runs) {
      if (breakUpRunWide(grid, rooms, breakupRooms, size, run, roomMargin, rng)) progressed = true;
    }
    if (!progressed) break;
  }

  return breakupRooms;
}

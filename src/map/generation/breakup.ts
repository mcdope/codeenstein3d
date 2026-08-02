// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Corridor dressing: the furniture that stops a hallway being a featureless
 * tube — widenings, colonnades, alcoves, gateways and chicanes carved into
 * corridor runs after the grid is otherwise finished.
 *
 * This started as a single job, capping how long a straight corridor may be,
 * with a two-element vocabulary to do it: a small room with a baffle wall, or
 * a forced jog. That was enough while corridors were enormous — a level got
 * dozens of interruptions and they blurred together — but measured over the
 * demo campaign it put 277 of those little rooms across 17 levels, 21% of all
 * floor area, in 9 footprints that were all the same construction. Strung at
 * even spacing down a long straight hallway they read as beads on a string
 * rather than as places.
 *
 * So there are two passes now, and they want different things:
 *
 * - The **length pass** still enforces `MAX_CORRIDOR_STRAIGHT_LENGTH`, and
 *   only uses features that actually break a sightline.
 * - The **ornament pass** adds a budgeted handful of features to corridors
 *   that are already short enough, purely so corridors have character — and
 *   so `spawnEdgeCaseEnemies`, which populates these rooms exclusively, still
 *   has somewhere to put an encounter. Once rooms were packed close together
 *   the length pass alone fired on almost nothing (6 features across the whole
 *   campaign), which would have quietly deleted the corridor encounter from
 *   the game.
 *
 * Both draw from the same weighted vocabulary and both refuse to place the
 * same kind twice in a row on one run, which is what keeps a corridor from
 * looking like a repeated motif.
 */
import type { Rect, Room, Tile } from "../types";
import { carveHLine, carveVLine, isChokePoint, isCorridorFloor } from "./corridors";
import { roomsOverlap } from "./geometry";
import { clamp, key } from "./util";

/**
 * Longest unbroken straight corridor run (tiles) allowed after carving.
 * `corridorWaypoints` only jitters *turn* positions, so a room pair offset
 * mostly along one axis (or two unrelated corridor legs that happen to line
 * up) can still produce one long straight sightline even with jogging — see
 * `dressCorridors`, which scans the finished grid for runs past this length
 * and interrupts each one.
 */
const MAX_CORRIDOR_STRAIGHT_LENGTH = 9;
/** Shortest run the ornament pass will decorate. Below this a feature would
 * be wider than the corridor it decorates. */
const MIN_ORNAMENT_RUN_LENGTH = 5;
/** Ornament features aimed for per room on the level. Scaled by room count
 * rather than fixed, so a 27-room monolith gets proportionally more corridor
 * furniture than a four-room script — and it stays a target, not a quota:
 * whatever doesn't fit simply isn't placed. */
const ORNAMENTS_PER_ROOM = 0.8;
/** Half-width of the tile window forced back to wall when jogging a straight
 * run that couldn't fit any other feature. */
const CHICANE_CUT_HALFWIDTH = 1;
/** Min/max length (tiles) of the perpendicular detour carved around a
 * chicane's cut. */
const CHICANE_MIN_LEN = 2;
const CHICANE_MAX_LEN = 4;
/** Local jitter (tiles) tried around each evenly-spaced target interruption
 * point, so a locally blocked target still has nearby room to try — and so
 * consecutive features on one run don't land at a metronomic spacing. */
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

/** A contiguous straight run of plain corridor floor found by `findStraightRuns`. */
interface StraightRun {
  axis: "h" | "v";
  /** The row (for a horizontal run) or column (for a vertical run) the run sits on. */
  fixed: number;
  /** Inclusive start/end coordinate along the run's axis. */
  lo: number;
  hi: number;
}

/** Everything a feature needs to carve itself into one spot on one run. */
interface FeatureSite {
  grid: Tile[][];
  rooms: Room[];
  features: Rect[];
  size: number;
  run: StraightRun;
  /** Coordinate along the run's axis to centre the feature on. */
  mid: number;
  roomMargin: number;
  rng: () => number;
}

/**
 * One entry in the corridor vocabulary. `breaksSightline` marks the ones the
 * length pass may use: an alcove pair is decoration, it doesn't stop you
 * seeing down the hall, so it's ornament-only.
 */
interface FeatureKind {
  id: string;
  weight: number;
  breaksSightline: boolean;
  /** Carve it, or return `null` if it doesn't fit here. Any rect returned is
   * enclosed walkable space and joins `GameMap.breakupRooms`. */
  place: (site: FeatureSite) => Rect[] | null;
}

/** Every tile key inside each of `rects` — used to keep grid-scanning
 * placement (keys) from claiming a corridor feature's floor. */
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
 * injected feature rect, so a feature placed on an earlier pass actually
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
function findStraightRuns(grid: Tile[][], rooms: Room[], features: Rect[], minLen: number): StraightRun[] {
  const runs: StraightRun[] = [];
  const h = grid.length;
  const w = h > 0 ? grid[0].length : 0;

  for (let y = 1; y < h - 1; y++) {
    let start = -1;
    for (let x = 1; x <= w - 1; x++) {
      const floor = x < w - 1 && isCorridorFloor(x, y, grid, rooms, features);
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
      const floor = y < h - 1 && isCorridorFloor(x, y, grid, rooms, features);
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

function rollBetween(min: number, max: number, rng: () => number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// --- the widening primitive ------------------------------------------------

/** A carved widening plus the record of which of its cells were *already*
 * floor before it carved anything. Every interior treatment needs that
 * record: sealing a cell some unrelated corridor was already using is how
 * you silently sever a route (see `carveBaffle`). */
interface Widening {
  rect: Rect;
  /** Indexed `[y - rect.y][x - rect.x]`. */
  preExisting: boolean[][];
}

/**
 * Widen a stretch of `run` around `site.mid` into an `along` x `across`
 * rectangle and carve it to floor, or return `null` if it doesn't fit.
 *
 * `offset` is how far the run's own line sits from the rectangle's near edge
 * across its width — a `baffleRoom` rolls it so the room isn't symmetric
 * about the corridor, while a colonnade or plaza wants it centred.
 *
 * Rejects on map border, and on overlap with any real `Room` or
 * previously-placed feature (the same rule `tryGrowRoom` uses to keep rooms
 * apart). What it deliberately does *not* test is "untouched rock": the
 * footprint legitimately straddles the run's own already-carved corridor
 * tiles, and may cross an unrelated corridor leg too — hence `preExisting`.
 */
function widenRun(site: FeatureSite, along: number, across: number, offset: number): Widening | null {
  const { grid, rooms, features, size, run, mid, roomMargin } = site;
  const halfAlong = Math.floor(along / 2);
  const rect: Rect =
    run.axis === "h"
      ? { x: mid - halfAlong, y: run.fixed - offset, w: along, h: across }
      : { x: run.fixed - offset, y: mid - halfAlong, w: across, h: along };

  if (rect.x < 1 || rect.y < 1 || rect.x + rect.w > size - 1 || rect.y + rect.h > size - 1) return null;
  if (rooms.some((r) => roomsOverlap(rect, r, roomMargin))) return null;
  if (features.some((r) => roomsOverlap(rect, r, roomMargin))) return null;

  const preExisting: boolean[][] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const row: boolean[] = [];
    for (let x = rect.x; x < rect.x + rect.w; x++) row.push(grid[y][x] === 0);
    preExisting.push(row);
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) grid[y][x] = 0;
  }
  return { rect, preExisting };
}

/** Whether `(x, y)` may be turned back into wall: inside the widening, and
 * not a cell some other corridor was already using. */
function sealable(widening: Widening, x: number, y: number): boolean {
  const { rect, preExisting } = widening;
  // Unreachable: every treatment iterates within its own widening's bounds.
  // Kept as a guard because `preExisting` is indexed relative to the rect, so
  // an out-of-bounds coordinate would read `undefined` and silently seal.
  /* v8 ignore next -- @preserve */
  if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) return false;
  return !preExisting[y - rect.y][x - rect.x];
}

function seal(grid: Tile[][], widening: Widening, x: number, y: number): void {
  if (sealable(widening, x, y)) grid[y][x] = 1;
}

// --- interior treatments ---------------------------------------------------

/**
 * Wall off one interior column (for an `"h"` run) or row (for `"v"`) of the
 * widening, leaving exactly one 1-tile gap somewhere other than the run's own
 * entry/exit line — the same "solid wall, single guaranteed gap" technique
 * `carveLabyrinth`'s `divide` already uses. Without this a widening is just a
 * fatter stretch of the same straight corridor: the entry and exit sit on the
 * same line, so the whole thing is visible in one glance the instant you step
 * in, and its other rows just look like empty flanking space rather than
 * requiring an actual detour.
 *
 * The baffle column/row must never wall off a cell that was already floor at
 * any row/column other than the deliberately-chosen gap, since that would
 * silently sever whatever depends on passing through it — confirmed as a
 * real, reproducible bug: exactly this scenario isolated 3 rooms from spawn
 * on a real campaign level, with no route existing at all afterward. Tries
 * the originally-rolled column/row first, then scans outward for an
 * alternative; if every column/row would sever more than one pre-existing
 * cell (impossible to route around with a single gap), skips the baffle
 * entirely rather than risk it — the widening's own footprint already isn't
 * `isCorridorFloor` anymore, so it still contributes to breaking up the run.
 */
function carveBaffle(grid: Tile[][], widening: Widening, axis: "h" | "v", fixed: number, rng: () => number): void {
  const { rect, preExisting } = widening;
  const horizontal = axis === "h";
  // Span the baffle wall runs across, and the one it can slide along.
  const acrossFrom = horizontal ? rect.y : rect.x;
  const acrossLen = horizontal ? rect.h : rect.w;
  const alongFrom = horizontal ? rect.x : rect.y;
  const alongLen = horizontal ? rect.w : rect.h;
  // Unreachable: every kind that calls this rolls its along-run dimension at
  // 3 or more, so there is always an interior column to put the baffle on.
  /* v8 ignore next -- @preserve */
  if (alongLen < 3) return;

  const preferred = alongFrom + 1 + Math.floor(rng() * (alongLen - 2));
  for (let d = 0; d < alongLen - 2; d++) {
    const line = d === 0 ? preferred : preferred + Math.ceil(d / 2) * (d % 2 === 0 ? -1 : 1);
    if (line < alongFrom + 1 || line > alongFrom + alongLen - 2) continue;

    const forced: number[] = [];
    const candidates: number[] = [];
    for (let a = acrossFrom; a < acrossFrom + acrossLen; a++) {
      if (a === fixed) continue;
      candidates.push(a);
      const already = horizontal
        ? preExisting[a - rect.y][line - rect.x]
        : preExisting[line - rect.y][a - rect.x];
      if (already) forced.push(a);
    }
    if (forced.length > 1) continue;

    const gap = forced.length === 1 ? forced[0] : candidates[Math.floor(rng() * candidates.length)];
    for (let a = acrossFrom; a < acrossFrom + acrossLen; a++) {
      if (a === gap) continue;
      if (horizontal) seal(grid, widening, line, a);
      else seal(grid, widening, a, line);
    }
    return;
  }
}

/**
 * A colonnade: single-tile pillars spaced along the run's own line, with the
 * widening's flanking rows left clear so there's always a way past. Reads as
 * a hall you weave through rather than a room you detour around, and unlike a
 * baffle it can't isolate anything — the flanking space is continuous by
 * construction.
 */
function carvePillars(grid: Tile[][], widening: Widening, axis: "h" | "v", fixed: number, rng: () => number): void {
  const { rect } = widening;
  const alongFrom = axis === "h" ? rect.x : rect.y;
  const alongLen = axis === "h" ? rect.w : rect.h;
  const start = alongFrom + 1 + (rng() < 0.5 ? 0 : 1);
  for (let a = start; a < alongFrom + alongLen - 1; a += 2) {
    if (axis === "h") seal(grid, widening, a, fixed);
    else seal(grid, widening, fixed, a);
  }
}

/**
 * A gateway: two adjacent columns (rows) walled off except along the run's
 * own line, so a wide stretch pinches to a single-tile neck and opens out
 * again. The neck is exactly the 1-wide cross-section `isChokePoint` looks
 * for, so this is also where `placeTraps` will happily put a hazard —
 * deliberately, since a gate is a place a trap reads as intentional.
 */
function carveGateway(grid: Tile[][], widening: Widening, axis: "h" | "v", fixed: number, rng: () => number): void {
  const { rect } = widening;
  const horizontal = axis === "h";
  const alongFrom = horizontal ? rect.x : rect.y;
  const alongLen = horizontal ? rect.w : rect.h;
  const acrossFrom = horizontal ? rect.y : rect.x;
  const acrossLen = horizontal ? rect.h : rect.w;
  // Unreachable: `gateway` rolls its along-run at 5-7, so there is always room
  // for the two-column neck plus an interior tile either side of it.
  /* v8 ignore next -- @preserve */
  if (alongLen < 4) return;

  const neck = alongFrom + 1 + Math.floor(rng() * (alongLen - 3));
  for (const line of [neck, neck + 1]) {
    for (let a = acrossFrom; a < acrossFrom + acrossLen; a++) {
      if (a === fixed) continue;
      if (horizontal) seal(grid, widening, line, a);
      else seal(grid, widening, a, line);
    }
  }
}

/** A plaza: an open junction with its four corners taken back to rock, so it
 * reads as a chamber rather than a square hole punched in the map. */
function cutCorners(grid: Tile[][], widening: Widening): void {
  const { rect } = widening;
  const x1 = rect.x + rect.w - 1;
  const y1 = rect.y + rect.h - 1;
  for (const [x, y] of [[rect.x, rect.y], [x1, rect.y], [rect.x, y1], [x1, y1]]) {
    seal(grid, widening, x, y);
  }
}

// --- the vocabulary --------------------------------------------------------

/**
 * The corridor vocabulary, weighted. `baffleRoom` is deliberately no longer
 * the default — it was the *entire* vocabulary before, and at 277 instances
 * across 17 levels it was the single most repeated structure in the game.
 */
const FEATURE_KINDS: FeatureKind[] = [
  {
    id: "baffleRoom",
    weight: 2,
    breaksSightline: true,
    place: (site) => {
      const along = rollBetween(3, 5, site.rng);
      const across = rollBetween(3, 5, site.rng);
      // Off-centre, so the corridor doesn't bisect the room.
      const offset = 1 + Math.floor(site.rng() * Math.max(1, across - 2));
      const widening = widenRun(site, along, across, offset);
      if (!widening) return null;
      carveBaffle(site.grid, widening, site.run.axis, site.run.fixed, site.rng);
      return [widening.rect];
    },
  },
  {
    id: "pillarHall",
    weight: 3,
    breaksSightline: true,
    place: (site) => {
      const along = rollBetween(6, 9, site.rng);
      const widening = widenRun(site, along, 3, 1);
      if (!widening) return null;
      carvePillars(site.grid, widening, site.run.axis, site.run.fixed, site.rng);
      return [widening.rect];
    },
  },
  {
    id: "gateway",
    weight: 3,
    breaksSightline: true,
    place: (site) => {
      const along = rollBetween(5, 7, site.rng);
      const across = rollBetween(3, 5, site.rng);
      const widening = widenRun(site, along, across, Math.floor(across / 2));
      if (!widening) return null;
      carveGateway(site.grid, widening, site.run.axis, site.run.fixed, site.rng);
      return [widening.rect];
    },
  },
  {
    id: "plaza",
    weight: 2,
    breaksSightline: true,
    place: (site) => {
      const along = rollBetween(5, 7, site.rng);
      const across = rollBetween(5, 7, site.rng);
      const widening = widenRun(site, along, across, Math.floor(across / 2));
      if (!widening) return null;
      cutCorners(site.grid, widening);
      // A plaza is open by design, so on its own it would leave the sightline
      // intact — one baffle keeps it a place you round rather than see across.
      carveBaffle(site.grid, widening, site.run.axis, site.run.fixed, site.rng);
      return [widening.rect];
    },
  },
  {
    id: "alcovePair",
    weight: 3,
    breaksSightline: false,
    place: placeAlcovePair,
  },
  {
    id: "chicane",
    weight: 2,
    breaksSightline: true,
    place: placeChicane,
  },
];

/**
 * Two small niches let into opposite walls of the corridor, offset along it
 * so they don't read as a symmetric pair. Pure decoration — cover to duck
 * into, and somewhere for an Edge Case to be waiting — which is why it's
 * marked `breaksSightline: false` and never used to enforce the run limit.
 */
function placeAlcovePair(site: FeatureSite): Rect[] | null {
  const { grid, rooms, features, size, run, mid, roomMargin, rng } = site;
  const depth = rollBetween(2, 3, rng);
  const stagger = rollBetween(1, 3, rng);
  const rects: Rect[] = [];

  for (const [side, along] of [[-1, mid], [1, mid + stagger]] as const) {
    const near = run.fixed + side * 2;
    const far = run.fixed + side * (depth + 1);
    const rect: Rect =
      run.axis === "h"
        ? { x: along, y: Math.min(near, far), w: 2, h: depth }
        : { x: Math.min(near, far), y: along, w: depth, h: 2 };

    if (rect.x < 1 || rect.y < 1 || rect.x + rect.w > size - 1 || rect.y + rect.h > size - 1) continue;
    if (rooms.some((r) => roomsOverlap(rect, r, roomMargin))) continue;
    if (features.some((r) => roomsOverlap(rect, r, roomMargin))) continue;
    // Only ever cut into solid rock: an alcove has one mouth by definition,
    // and carving one over an existing passage would just widen that passage.
    let solid = true;
    for (let y = rect.y; y < rect.y + rect.h && solid; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (grid[y][x] !== 1) {
          solid = false;
          break;
        }
      }
    }
    if (!solid) continue;

    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) grid[y][x] = 0;
    }
    // The mouth: the single tile between the niche and the corridor line.
    if (run.axis === "h") carveVLine(grid, run.fixed, run.fixed + side, along);
    else carveHLine(grid, run.fixed, run.fixed + side, along);
    rects.push(rect);
  }

  return rects.length > 0 ? rects : null;
}

/**
 * Sever a short stretch of the straight run back to wall and reroute around
 * it with a perpendicular detour, breaking the direct sightline without
 * adding a room. Only cuts through tiles that are 1-wide choke points
 * (`isChokePoint`) — refusing to sever a tile a *different* corridor leg
 * might depend on for connectivity, and equally refusing to try this inside a
 * corridor wide enough that cutting three tiles wouldn't reroute anything.
 * Best-effort: returns `null` rather than failing hard, matching this file's
 * "never a hard failure" placement convention. Adds no enclosed space, so it
 * contributes no rect.
 */
function placeChicane(site: FeatureSite): Rect[] | null {
  const { grid, rooms, features, run, mid, roomMargin, rng } = site;
  const cutLo = mid - CHICANE_CUT_HALFWIDTH;
  const cutHi = mid + CHICANE_CUT_HALFWIDTH;
  if (cutLo - 1 <= run.lo || cutHi + 1 >= run.hi) return null;

  for (let i = cutLo; i <= cutHi; i++) {
    const cx = run.axis === "h" ? i : run.fixed;
    const cy = run.axis === "h" ? run.fixed : i;
    if (!isChokePoint(cx, cy, grid)) return null;
  }

  const dir = rng() < 0.5 ? 1 : -1;
  const jogLen = rollBetween(CHICANE_MIN_LEN, CHICANE_MAX_LEN, rng);

  const detour: Rect =
    run.axis === "h"
      ? { x: cutLo, y: dir > 0 ? run.fixed : run.fixed - jogLen, w: cutHi - cutLo + 1, h: jogLen + 1 }
      : { x: dir > 0 ? run.fixed : run.fixed - jogLen, y: cutLo, w: jogLen + 1, h: cutHi - cutLo + 1 };

  if (detour.x < 1 || detour.y < 1 || detour.x + detour.w > grid[0].length - 1 || detour.y + detour.h > grid.length - 1) {
    return null;
  }
  if (rooms.some((r) => roomsOverlap(detour, r, roomMargin))) return null;
  if (features.some((r) => roomsOverlap(detour, r, roomMargin))) return null;

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
  return [];
}

// --- placement -------------------------------------------------------------

/**
 * Try each vocabulary entry once, in a weighted-random order, skipping
 * `avoid` — the kind placed last on this run, so no corridor ever shows the
 * same motif twice running. Returns the kind's id and its enclosed rects, or
 * `null` if nothing fit here at all.
 */
function placeSomeFeature(
  site: FeatureSite,
  avoid: string | null,
  sightlineOnly: boolean,
): { id: string; rects: Rect[] } | null {
  const pool = FEATURE_KINDS.filter(
    (kind) => kind.id !== avoid && (!sightlineOnly || kind.breaksSightline),
  );
  let remaining = pool.reduce((sum, kind) => sum + kind.weight, 0);

  while (pool.length > 0) {
    let roll = site.rng() * remaining;
    let index = 0;
    while (index < pool.length - 1 && roll >= pool[index].weight) {
      roll -= pool[index].weight;
      index++;
    }
    const [kind] = pool.splice(index, 1);
    remaining -= kind.weight;

    const rects = kind.place(site);
    if (rects) return { id: kind.id, rects };
  }
  return null;
}

/** The running state one `dressCorridors` call threads through every pass. */
interface DressingState {
  features: Rect[];
  /** Last kind placed per run key, so the anti-repeat rule survives across
   * the several passes that may all decorate the same corridor. */
  lastKind: Map<string, string>;
  placed: number;
}

function runKey(run: StraightRun): string {
  return `${run.axis}${run.fixed}`;
}

function siteFor(
  grid: Tile[][],
  rooms: Room[],
  state: DressingState,
  size: number,
  run: StraightRun,
  mid: number,
  roomMargin: number,
  rng: () => number,
): FeatureSite {
  return { grid, rooms, features: state.features, size, run, mid, roomMargin, rng };
}

/**
 * Try to place a feature on `run` at one target coordinate along its axis: a
 * handful of small local-jitter retries (see `BREAKUP_ATTEMPTS_PER_POINT` /
 * `BREAKUP_LOCAL_JITTER`), each trying the whole vocabulary before moving to
 * a fresh nearby offset. The jitter does double duty — it finds space when
 * the exact target is locally blocked, and it keeps consecutive features off
 * a metronomic spacing.
 */
function placeAtTarget(
  grid: Tile[][],
  rooms: Room[],
  state: DressingState,
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
  target: number,
  sightlineOnly: boolean,
): boolean {
  const loBound = run.lo + 2;
  const hiBound = run.hi - 2;
  // Unreachable: every run reaching here came from `findStraightRuns` with a
  // minimum length of `MIN_ORNAMENT_RUN_LENGTH` (5), and it only reports runs
  // *longer* than the minimum — so a run is >= 6 tiles and `lo + 2` can never
  // pass `hi - 2`.
  /* v8 ignore next -- @preserve */
  if (loBound > hiBound) return false;

  for (let attempt = 0; attempt < BREAKUP_ATTEMPTS_PER_POINT; attempt++) {
    const jitter = attempt === 0 ? 0 : Math.floor(rng() * (BREAKUP_LOCAL_JITTER * 2 + 1)) - BREAKUP_LOCAL_JITTER;
    const mid = clamp(target + jitter, loBound, hiBound);
    const site = siteFor(grid, rooms, state, size, run, mid, roomMargin, rng);
    const result = placeSomeFeature(site, state.lastKind.get(runKey(run)) ?? null, sightlineOnly);
    if (result) {
      state.features.push(...result.rects);
      state.lastKind.set(runKey(run), result.id);
      state.placed++;
      return true;
    }
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
function splitRun(
  grid: Tile[][],
  rooms: Room[],
  state: DressingState,
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
): void {
  const length = run.hi - run.lo + 1;
  const segments = Math.ceil(length / (MAX_CORRIDOR_STRAIGHT_LENGTH + 1));
  for (let s = 1; s < segments; s++) {
    const target = run.lo + Math.round((length * s) / segments);
    placeAtTarget(grid, rooms, state, size, run, roomMargin, rng, target, true);
  }
}

/**
 * Try to interrupt `run` at any point along its whole remaining length: a
 * wide, unclustered random search (`BREAKUP_WIDE_ATTEMPTS` offsets spread
 * across the full span), as opposed to `placeAtTarget`'s local jitter around
 * one fixed point. Used by the safety-net passes below, where the primary
 * pass's evenly-spaced target already failed nearby — a wide search can still
 * find whatever free spot is left on the run, wherever it is.
 */
function splitRunWide(
  grid: Tile[][],
  rooms: Room[],
  state: DressingState,
  size: number,
  run: StraightRun,
  roomMargin: number,
  rng: () => number,
): boolean {
  const loBound = run.lo + 2;
  const hiBound = run.hi - 2;
  // Unreachable: every run reaching here came from `findStraightRuns` with a
  // minimum length of `MIN_ORNAMENT_RUN_LENGTH` (5), and it only reports runs
  // *longer* than the minimum — so a run is >= 6 tiles and `lo + 2` can never
  // pass `hi - 2`.
  /* v8 ignore next -- @preserve */
  if (loBound > hiBound) return false;

  for (let attempt = 0; attempt < BREAKUP_WIDE_ATTEMPTS; attempt++) {
    const target = loBound + Math.floor(rng() * (hiBound - loBound + 1));
    if (placeAtTarget(grid, rooms, state, size, run, roomMargin, rng, target, true)) return true;
  }
  return false;
}

/**
 * Dress every corridor on the level: enforce `MAX_CORRIDOR_STRAIGHT_LENGTH`
 * first, then spend an ornament budget on whatever corridors are left.
 *
 * Length pass: every run found by a single scan right after carving gets
 * evenly-spaced interruption points in one shot (`splitRun`) — cheap and
 * well-distributed for the common case. Safety-net passes
 * (`MAX_BREAKUP_SAFETY_PASSES`) rescan with a wide, unclustered search to
 * catch anything the primary pass missed: a run formed only by two unrelated
 * corridor legs landing collinear, or a stretch where a couple of the primary
 * pass's evenly-spaced targets both landed in the same locally-blocked area.
 *
 * Ornament pass: shortish runs (`MIN_ORNAMENT_RUN_LENGTH` and up) get a
 * feature each until the budget runs out, longest runs first so the biggest
 * stretches of blank hallway are dressed before the scraps.
 *
 * Called once, right after the corridors are carved, so every later
 * generation stage (spawn/exit, enemies, hazards, doors, ...) only ever sees
 * the finished grid. Returns the rects of every enclosed space injected —
 * used both to spawn "Edge Case" enemies exclusively inside them (see
 * `spawnEdgeCaseEnemies`) and to keep grid-scanning stages like
 * `placeKeys`/`placeTraps` from claiming their floor.
 */
export function dressCorridors(
  grid: Tile[][],
  rooms: Room[],
  size: number,
  roomMargin: number,
  rng: () => number,
): Rect[] {
  const state: DressingState = { features: [], lastKind: new Map(), placed: 0 };

  const initialRuns = findStraightRuns(grid, rooms, state.features, MAX_CORRIDOR_STRAIGHT_LENGTH);
  for (const run of initialRuns) splitRun(grid, rooms, state, size, run, roomMargin, rng);

  for (let pass = 0; pass < MAX_BREAKUP_SAFETY_PASSES; pass++) {
    const runs = findStraightRuns(grid, rooms, state.features, MAX_CORRIDOR_STRAIGHT_LENGTH);
    if (runs.length === 0) break;

    let progressed = false;
    for (const run of runs) {
      if (splitRunWide(grid, rooms, state, size, run, roomMargin, rng)) progressed = true;
    }
    if (!progressed) break;
  }

  const budget = Math.round(rooms.length * ORNAMENTS_PER_ROOM);
  if (state.placed < budget) {
    const runs = findStraightRuns(grid, rooms, state.features, MIN_ORNAMENT_RUN_LENGTH);
    runs.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
    for (const run of runs) {
      if (state.placed >= budget) break;
      const mid = Math.round((run.lo + run.hi) / 2);
      const site = siteFor(grid, rooms, state, size, run, mid, roomMargin, rng);
      const result = placeSomeFeature(site, state.lastKind.get(runKey(run)) ?? null, false);
      if (!result) continue;
      state.features.push(...result.rects);
      state.lastKind.set(runKey(run), result.id);
      state.placed++;
    }
  }

  return state.features;
}

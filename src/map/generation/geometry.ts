// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Room geometry: footprints, overlap tests, carving, and shared spot-finding. */
import type { CodeEntity } from "../../parser/types";
import type { Enemy, Point, Rect, Room, Tile } from "../types";
import { clamp, dist } from "./util";

/** Tiles kept clear around a room's center, the exit, spawn, and enemies when
 * placing a pillar or decoration — keeps critical spots visible/reachable. */
const PROP_CLEARANCE = 1.4;
/** Minimum spacing (tiles) between two props placed in the same room. */
const PROP_SPACING = 1.8;
/** Placement attempts per prop before giving up on it. */
const PROP_ATTEMPTS = 12;

/**
 * Room footprint: wider with complexity, taller with the entity's line span,
 * and enlarged by nesting depth so a labyrinth has room to unfold.
 */
export function roomDimensions(entity: CodeEntity, size: number): { w: number; h: number } {
  const span = Math.max(1, entity.endLine - entity.startLine + 1);
  const cap = Math.min(18, size - 2);
  const w = clamp(4 + entity.complexityScore + entity.nestingDepth * 2, 4, cap);
  const h = clamp(4 + Math.floor(span / 3) + entity.nestingDepth * 2, 4, cap);
  return { w, h };
}

export function makeRoom(x: number, y: number, w: number, h: number, entity: CodeEntity): Room {
  return {
    x,
    y,
    w,
    h,
    center: { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) },
    entity,
  };
}

/** Fallback room in the middle of the map (used when nothing else fits).
 * `kind: "class"` on the synthetic placeholder is deliberate: it fails
 * every "real code" eligibility check elsewhere in `generation/` (enemy
 * spawning, door locking — see `placeFillerRoom` in `mapGenerator.ts` for
 * the full reasoning), so a placeholder like `<entry>` never leaks onto an
 * enemy's on-screen nameplate. */
export function centeredRoom(entity: CodeEntity | undefined, size: number): Room {
  const w = Math.min(8, size - 2);
  const h = Math.min(8, size - 2);
  const x = Math.floor((size - w) / 2);
  const y = Math.floor((size - h) / 2);
  const placeholder: CodeEntity = entity ?? {
    name: "<entry>",
    kind: "class",
    startLine: 1,
    endLine: 1,
    complexityScore: 1,
    nestingDepth: 0,
  };
  return makeRoom(x, y, w, h, placeholder);
}

/** True if two rects overlap once each is grown by `margin` on all sides. */
export function roomsOverlap(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

export function carveRoom(grid: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      grid[y][x] = 0;
    }
  }
}

/** Force the spawn, exit, every enemy tile, and every multiplayer spawn tile
 * to open floor. */
export function clearCriticalTiles(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
  multiplayerSpawns: readonly Point[] = [],
): void {
  grid[spawn.y][spawn.x] = 0;
  grid[exit.y][exit.x] = 0;
  for (const enemy of enemies) {
    grid[Math.floor(enemy.y)][Math.floor(enemy.x)] = 0;
  }
  for (const s of multiplayerSpawns) {
    grid[s.y][s.x] = 0;
  }
}

/**
 * Find an open interior tile in `room` for a pillar, decoration, or ammo
 * pickup: on plain floor, clear of the room center (the primary enemy spawn
 * point) and every point in `avoid` (spawn/exit/enemies), and spaced out from
 * props already `placed` in this room. Margin 1 keeps it off the room's own
 * walls. Returns `null` if no spot is found within the attempt budget (the
 * room just gets fewer props — never a hard failure).
 */
export function findPropSpot(
  room: Room,
  grid: Tile[][],
  avoid: Point[],
  placed: Point[],
  rng: () => number,
): Point | null {
  const centerX = room.center.x + 0.5;
  const centerY = room.center.y + 0.5;
  for (let attempt = 0; attempt < PROP_ATTEMPTS; attempt++) {
    const x = room.x + 1 + Math.floor(rng() * (room.w - 2));
    const y = room.y + 1 + Math.floor(rng() * (room.h - 2));
    if (grid[y][x] !== 0) continue;

    const px = x + 0.5;
    const py = y + 0.5;
    if (dist(px, py, centerX, centerY) < PROP_CLEARANCE) continue;
    if (avoid.some((a) => dist(px, py, a.x, a.y) < PROP_CLEARANCE)) continue;
    if (placed.some((p) => dist(px, py, p.x + 0.5, p.y + 0.5) < PROP_SPACING)) continue;
    return { x, y };
  }
  return null;
}

/** Which side of an anchor rect a `SideCandidate` hangs off. */
export type Side = "top" | "bottom" | "left" | "right";

/**
 * One candidate spot for a rectangle carved into the solid rock beside an
 * anchor room: the anchor-perimeter wall tile it connects through, the
 * outward-pointing step direction, and the footprint's inclusive bounds.
 */
export interface SideCandidate {
  side: Side;
  /** The anchor's own perimeter wall tile — the doorway/mouth. */
  wall: Point;
  /** Unit step pointing away from the anchor, along `side`'s axis. */
  step: Point;
  /** Inclusive footprint bounds, `offset` tiles beyond `wall`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Every spot a `w`×`h` rectangle could sit beside `anchor`, one per perimeter
 * tile per side. The footprint always starts one tile past the `wall` tile —
 * the wall tile is the doorway, not part of the room — and `offset` pushes it
 * that many tiles further out to leave room for a connecting corridor (0 puts
 * the footprint directly behind the doorway). Ordering is deterministic and
 * caller-shuffled — see
 * `placeVendorDepots`/`placeSwitchboards`/`placeExceptionZones`, which all
 * `shuffle(candidates, rng)` and take the first that fits.
 *
 * Extracted from `placeSecretRooms`' original inline enumeration, which is
 * still the reference for what "fits" means: the `wall` tile must be untouched
 * rock, and the footprint plus a one-tile margin must be untouched rock too
 * (see `sideCandidateFits`). Testing against untouched rock is what makes
 * overlap with rooms, labyrinth interiors, corridors, breakup rooms and every
 * other carved feature structurally impossible with no extra bookkeeping —
 * which is why every carver that uses this must run after all of them.
 */
export function sideCandidates(anchor: Rect, w: number, h: number, offset: number): SideCandidate[] {
  const candidates: SideCandidate[] = [];
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);

  for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
    const x0 = x - halfW;
    const topY1 = anchor.y - 2 - offset;
    candidates.push({ side: "top", wall: { x, y: anchor.y - 1 }, step: { x: 0, y: -1 }, x0, y0: topY1 - h + 1, x1: x0 + w - 1, y1: topY1 });
    const bottomY0 = anchor.y + anchor.h + 1 + offset;
    candidates.push({ side: "bottom", wall: { x, y: anchor.y + anchor.h }, step: { x: 0, y: 1 }, x0, y0: bottomY0, x1: x0 + w - 1, y1: bottomY0 + h - 1 });
  }
  for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
    const y0 = y - halfH;
    const leftX1 = anchor.x - 2 - offset;
    candidates.push({ side: "left", wall: { x: anchor.x - 1, y }, step: { x: -1, y: 0 }, x0: leftX1 - w + 1, y0, x1: leftX1, y1: y0 + h - 1 });
    const rightX0 = anchor.x + anchor.w + 1 + offset;
    candidates.push({ side: "right", wall: { x: anchor.x + anchor.w, y }, step: { x: 1, y: 0 }, x0: rightX0, y0, x1: rightX0 + w - 1, y1: y0 + h - 1 });
  }
  return candidates;
}

/**
 * Whether `candidate` can actually be carved: its connecting wall tile is
 * still untouched rock, its footprint is fully inside the map border, and the
 * footprint **plus a one-tile margin on every side** is untouched rock as well.
 *
 * The margin isn't decorative. `placeSecretRooms` needs it because opening a
 * secret wall flood-fills every 4-connected secret tile, so two touching
 * secret rooms would reveal each other; every other carver needs it so its new
 * room can't end up sharing a wall with — and therefore silently merging into
 * — an unrelated corridor or room it never connected to.
 *
 * `corridorTiles` are checked as part of the footprint (they're carved too), so
 * pass the connector's tiles here rather than testing them separately.
 */
export function sideCandidateFits(
  candidate: SideCandidate,
  grid: Tile[][],
  mapSize: number,
  corridorTiles: readonly Point[] = [],
): boolean {
  if (grid[candidate.wall.y]?.[candidate.wall.x] !== 1) return false;
  if (candidate.x0 < 1 || candidate.y0 < 1 || candidate.x1 > mapSize - 2 || candidate.y1 > mapSize - 2) return false;

  for (let y = candidate.y0 - 1; y <= candidate.y1 + 1; y++) {
    for (let x = candidate.x0 - 1; x <= candidate.x1 + 1; x++) {
      if (grid[y]?.[x] !== 1) return false;
    }
  }
  // Corridor tiles run between the wall and the footprint, so they sit outside
  // the block just checked — but they're still about to be carved, so they
  // have to be untouched rock too (the wall tile itself excepted, which the
  // caller owns and the check above already validated).
  for (const tile of corridorTiles) {
    if (tile.x === candidate.wall.x && tile.y === candidate.wall.y) continue;
    if (grid[tile.y]?.[tile.x] !== 1) return false;
  }
  return true;
}

/** Tiles the connector occupies: the anchor's own wall tile (the doorway),
 * plus `offset` further tiles stepping outward toward the footprint. Just the
 * doorway for `offset === 0`, where the footprint sits directly behind it. */
export function connectorTiles(candidate: SideCandidate, offset: number): Point[] {
  const tiles: Point[] = [{ x: candidate.wall.x, y: candidate.wall.y }];
  for (let i = 1; i <= offset; i++) {
    tiles.push({ x: candidate.wall.x + candidate.step.x * i, y: candidate.wall.y + candidate.step.y * i });
  }
  return tiles;
}

/** Carve an inclusive-bounds rectangle to plain floor, and return it as a
 * `Rect` in the `{x, y, w, h}` form the `GameMap` arrays use. */
export function carveRect(grid: Tile[][], x0: number, y0: number, x1: number, y1: number): Rect {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) grid[y][x] = 0;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The *most specific* room whose entity's line span contains `line` — used to
 * anchor a lore terminal, secret room, or goto/label teleporter pad. A
 * method's line range always sits inside its enclosing class's range too, so
 * picking merely the first containing room (in `startLine` order, meaning the
 * outer class always sorts before its own methods) would anchor everything
 * physically inside any method to the whole class's room instead — collapsing
 * what should be several distinct rooms' worth of content onto one. Picking
 * the containing room with the smallest line span instead always prefers the
 * innermost (most specific) entity.
 */
export function roomForLine(rooms: Room[], line: number): Room | undefined {
  let best: Room | undefined;
  let bestSpan = Infinity;
  for (const room of rooms) {
    if (line < room.entity.startLine || line > room.entity.endLine) continue;
    const span = room.entity.endLine - room.entity.startLine;
    if (span < bestSpan) {
      best = room;
      bestSpan = span;
    }
  }
  return best;
}

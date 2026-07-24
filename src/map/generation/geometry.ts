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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Procedural map generator.
 *
 * Turns normalized `ParsedFile` JSON into a 2D tile grid the raycaster can
 * walk: solid rock (`1`) with one rectangular room (`0`) carved per entity,
 * rooms connected by L-shaped corridors, and a spawn in the first room.
 *
 * Generation is deterministic: the same parsed file always yields the same
 * map, via a seeded PRNG hashed from the file's content signature.
 */
import type { CodeEntity, ParsedFile } from "../parser/types";
import type { Enemy, GameMap, Point, Room, Tile } from "./types";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

export interface MapGeneratorOptions {
  /** Lower bound for the (square) map size in tiles. */
  minSize?: number;
  /** Upper bound for the map size in tiles. */
  maxSize?: number;
  /** Minimum wall thickness kept between adjacent rooms. */
  roomMargin?: number;
  /** Attempts to place each room before giving up on it. */
  placementAttempts?: number;
}

const DEFAULTS: Required<MapGeneratorOptions> = {
  minSize: 64,
  maxSize: 160,
  roomMargin: 1,
  placementAttempts: 200,
};

export class MapGenerator {
  private readonly opts: Required<MapGeneratorOptions>;

  constructor(options: MapGeneratorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  generate(parsed: ParsedFile): GameMap {
    const rng = mulberry32(seedFrom(parsed));
    const size = this.mapSize(parsed);

    // Start fully solid; rooms and corridors carve empty space out of it.
    const grid: Tile[][] = Array.from({ length: size }, () =>
      new Array<Tile>(size).fill(1),
    );

    const rooms = this.placeRooms(parsed.entities, size, grid, rng);
    connectRooms(rooms, grid);

    // Spawn in a room corner so the player doesn't start inside the room's
    // center enemy; the exit goes in the room furthest from that spawn.
    const spawn: Point =
      rooms.length > 0 ? { x: rooms[0].x + 1, y: rooms[0].y + 1 } : { x: 1, y: 1 };
    const enemies = spawnEnemies(rooms);
    const exit = pickExit(rooms, spawn);

    return { width: size, height: size, grid, rooms, spawn, enemies, exit };
  }

  /** Square map size, floored at `minSize` and growing with LOC and entities. */
  private mapSize(parsed: ParsedFile): number {
    const fromLoc = Math.floor(parsed.linesOfCode / 8);
    const fromEntities = parsed.entities.length * 4;
    const raw = this.opts.minSize + Math.max(fromLoc, fromEntities);
    return clamp(raw, this.opts.minSize, this.opts.maxSize);
  }

  private placeRooms(
    entities: CodeEntity[],
    size: number,
    grid: Tile[][],
    rng: () => number,
  ): Room[] {
    const rooms: Room[] = [];

    for (const entity of entities) {
      const room = this.tryPlaceRoom(entity, size, rooms, rng);
      if (room) {
        carveRoom(grid, room);
        rooms.push(room);
      }
    }

    // A file with no entities (or none that fit) still needs a spawnable room.
    if (rooms.length === 0) {
      const fallback = centeredRoom(entities[0], size);
      carveRoom(grid, fallback);
      rooms.push(fallback);
    }

    return rooms;
  }

  /** Find a non-overlapping spot for one entity's room, or `null`. */
  private tryPlaceRoom(
    entity: CodeEntity,
    size: number,
    placed: Room[],
    rng: () => number,
  ): Room | null {
    const { w, h } = roomDimensions(entity, size);
    // Keep rooms off the outer border so walls always enclose the level.
    const maxX = size - w - 1;
    const maxY = size - h - 1;
    if (maxX < 1 || maxY < 1) return null;

    for (let attempt = 0; attempt < this.opts.placementAttempts; attempt++) {
      const x = 1 + Math.floor(rng() * maxX);
      const y = 1 + Math.floor(rng() * maxY);
      const candidate = makeRoom(x, y, w, h, entity);
      if (!placed.some((r) => roomsOverlap(candidate, r, this.opts.roomMargin))) {
        return candidate;
      }
    }
    return null;
  }
}

// --- geometry helpers -------------------------------------------------------

/** Room footprint: wider with complexity, taller with the entity's line span. */
function roomDimensions(entity: CodeEntity, size: number): { w: number; h: number } {
  const span = Math.max(1, entity.endLine - entity.startLine + 1);
  const w = clamp(4 + entity.complexityScore, 4, Math.min(16, size - 2));
  const h = clamp(4 + Math.floor(span / 3), 4, Math.min(16, size - 2));
  return { w, h };
}

function makeRoom(x: number, y: number, w: number, h: number, entity: CodeEntity): Room {
  return {
    x,
    y,
    w,
    h,
    center: { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) },
    entity,
  };
}

/** Fallback room in the middle of the map (used when nothing else fits). */
function centeredRoom(entity: CodeEntity | undefined, size: number): Room {
  const w = Math.min(8, size - 2);
  const h = Math.min(8, size - 2);
  const x = Math.floor((size - w) / 2);
  const y = Math.floor((size - h) / 2);
  const placeholder: CodeEntity = entity ?? {
    name: "<entry>",
    kind: "function",
    startLine: 1,
    endLine: 1,
    complexityScore: 1,
  };
  return makeRoom(x, y, w, h, placeholder);
}

/** True if two rooms overlap once each is grown by `margin` on all sides. */
function roomsOverlap(a: Room, b: Room, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

function carveRoom(grid: Tile[][], room: Room): void {
  for (let y = room.y; y < room.y + room.h; y++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      grid[y][x] = 0;
    }
  }
}

/**
 * Spawn one enemy per function/method, at its room's center. Classes,
 * interfaces, and traits get rooms but no enemy — only callable entities are
 * "monsters". HP scales with the entity's cyclomatic complexity.
 */
function spawnEnemies(rooms: Room[]): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of rooms) {
    if (room.entity.kind !== "function" && room.entity.kind !== "method") continue;
    const hp = Math.max(1, room.entity.complexityScore) * HP_PER_COMPLEXITY;
    enemies.push({
      x: room.x + room.w / 2,
      y: room.y + room.h / 2,
      hp,
      maxHp: hp,
      alive: true,
      entity: room.entity,
    });
  }
  return enemies;
}

/** Pick the exit tile: the center of the room whose center is furthest (by
 * Euclidean distance) from the spawn. Falls back to the spawn for empty maps. */
function pickExit(rooms: Room[], spawn: Point): Point {
  if (rooms.length === 0) return { x: spawn.x, y: spawn.y };
  let best = rooms[0];
  let bestDist = -1;
  for (const room of rooms) {
    const dx = room.center.x - spawn.x;
    const dy = room.center.y - spawn.y;
    const dist = dx * dx + dy * dy;
    if (dist > bestDist) {
      bestDist = dist;
      best = room;
    }
  }
  return { x: best.center.x, y: best.center.y };
}

/**
 * Chain the rooms together with L-shaped corridors (room i ↔ room i-1),
 * guaranteeing the whole level is reachable from the spawn.
 */
function connectRooms(rooms: Room[], grid: Tile[][]): void {
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(grid, rooms[i - 1].center, rooms[i].center);
  }
}

function carveCorridor(grid: Tile[][], from: Point, to: Point): void {
  carveHLine(grid, from.x, to.x, from.y);
  carveVLine(grid, from.y, to.y, to.x);
}

function carveHLine(grid: Tile[][], x1: number, x2: number, y: number): void {
  const [lo, hi] = x1 <= x2 ? [x1, x2] : [x2, x1];
  for (let x = lo; x <= hi; x++) grid[y][x] = 0;
}

function carveVLine(grid: Tile[][], y1: number, y2: number, x: number): void {
  const [lo, hi] = y1 <= y2 ? [y1, y2] : [y2, y1];
  for (let y = lo; y <= hi; y++) grid[y][x] = 0;
}

// --- determinism helpers ----------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Stable seed from the file's content signature (FNV-1a). */
function seedFrom(parsed: ParsedFile): number {
  const signature =
    `${parsed.language}:${parsed.linesOfCode}:` +
    parsed.entities.map((e) => `${e.kind}/${e.name}/${e.complexityScore}`).join(",");
  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small, fast, seedable PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

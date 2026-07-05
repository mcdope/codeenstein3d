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
import {
  DOOR_TILE,
  HAZARD_TILE,
  type Enemy,
  type GameMap,
  type KeyItem,
  type Point,
  type Room,
  type Tile,
} from "./types";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

/** Nesting depth at/above which an entity's room becomes a labyrinth. */
const MAZE_THRESHOLD = 2;

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
    // Exit is chosen before enemies so their placement can steer clear of it —
    // the 'return' tile must never be hidden under a monster.
    const exit = pickExit(rooms, spawn);
    const enemies = spawnEnemies(rooms, exit, rng);
    const hazards = fillHazards(rooms, grid, spawn, exit);

    // Corridors already punch through labyrinth walls; this guarantees the
    // spawn, exit, and every enemy stand on open floor even inside a maze.
    clearCriticalTiles(grid, spawn, exit, enemies);

    // Lock private/protected-method rooms behind doors, then scatter one key
    // per door in areas reachable before that door (keeps every level solvable).
    const doors = placeDoors(rooms, grid);
    const keys = placeKeys(grid, spawn, exit, enemies, doors, rng);

    // Fog-of-war overlay grid, all unexplored until the player moves through.
    const visited: boolean[][] = Array.from({ length: size }, () =>
      new Array<boolean>(size).fill(false),
    );

    return { width: size, height: size, grid, visited, rooms, spawn, enemies, exit, hazards, doors, keys };
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
        // Deeply nested code becomes a labyrinth of internal walls instead of
        // an open box. Passages stay ≥1 tile wide so the player fits through.
        if (entity.nestingDepth >= MAZE_THRESHOLD) {
          carveLabyrinth(grid, room, entity.nestingDepth, rng);
        }
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

/**
 * Room footprint: wider with complexity, taller with the entity's line span,
 * and enlarged by nesting depth so a labyrinth has room to unfold.
 */
function roomDimensions(entity: CodeEntity, size: number): { w: number; h: number } {
  const span = Math.max(1, entity.endLine - entity.startLine + 1);
  const cap = Math.min(18, size - 2);
  const w = clamp(4 + entity.complexityScore + entity.nestingDepth * 2, 4, cap);
  const h = clamp(4 + Math.floor(span / 3) + entity.nestingDepth * 2, 4, cap);
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
    nestingDepth: 0,
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
 * Turn an already-carved room into a labyrinth by recursive division: split the
 * region with a wall (value `1`, native to the raycaster) that has a single
 * 1-tile gap, then recurse into each half. The recursion budget scales with
 * `nestingDepth`, so deeper code yields a denser maze. Every passage stays ≥1
 * tile wide, and the maze remains fully connected (each wall keeps one gap).
 */
function carveLabyrinth(grid: Tile[][], room: Room, nestingDepth: number, rng: () => number): void {
  const budget = Math.min(nestingDepth, 6);
  divide(grid, room.x, room.y, room.x + room.w - 1, room.y + room.h - 1, budget, rng);
}

function divide(
  grid: Tile[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  budget: number,
  rng: () => number,
): void {
  if (budget <= 0) return;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  // A region needs ≥3 tiles along an axis to hold a wall plus a floor either
  // side (keeping passages ≥1 wide).
  const canHorizontal = h >= 3;
  const canVertical = w >= 3;
  if (!canHorizontal && !canVertical) return;

  const horizontal =
    canHorizontal && canVertical ? h > w || (h === w && rng() < 0.5) : canHorizontal;

  if (horizontal) {
    const wallY = y0 + 1 + Math.floor(rng() * (h - 2)); // interior row
    for (let x = x0; x <= x1; x++) grid[wallY][x] = 1;
    grid[wallY][x0 + Math.floor(rng() * w)] = 0; // one 1-wide passage
    divide(grid, x0, y0, x1, wallY - 1, budget - 1, rng);
    divide(grid, x0, wallY + 1, x1, y1, budget - 1, rng);
  } else {
    const wallX = x0 + 1 + Math.floor(rng() * (w - 2)); // interior column
    for (let y = y0; y <= y1; y++) grid[y][wallX] = 1;
    grid[y0 + Math.floor(rng() * h)][wallX] = 0; // one 1-wide passage
    divide(grid, x0, y0, wallX - 1, y1, budget - 1, rng);
    divide(grid, wallX + 1, y0, x1, y1, budget - 1, rng);
  }
}

/** Force the spawn, exit, and every enemy tile to open floor. */
function clearCriticalTiles(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
): void {
  grid[spawn.y][spawn.x] = 0;
  grid[exit.y][exit.x] = 0;
  for (const enemy of enemies) {
    grid[Math.floor(enemy.y)][Math.floor(enemy.x)] = 0;
  }
}

/**
 * Lock each private/protected-method room by turning its corridor mouths (the
 * open floor tiles just outside the room that lead into it) into door tiles.
 * The spawn room is never locked. Returns the door tiles placed.
 */
function placeDoors(rooms: Room[], grid: Tile[][]): Point[] {
  const doors: Point[] = [];
  rooms.forEach((room, index) => {
    if (index === 0) return; // never lock the spawn room
    const vis = room.entity.visibility;
    if (room.entity.kind !== "method" || (vis !== "private" && vis !== "protected")) {
      return;
    }
    for (const mouth of roomMouths(room, grid)) {
      grid[mouth.y][mouth.x] = DOOR_TILE;
      doors.push(mouth);
    }
  });
  return doors;
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
function placeKeys(
  grid: Tile[][],
  spawn: Point,
  exit: Point,
  enemies: Enemy[],
  doors: Point[],
  rng: () => number,
): KeyItem[] {
  if (doors.length === 0) return [];

  const keys: KeyItem[] = [];
  const opened = new Set<string>();
  const used = new Set<string>([
    key(spawn),
    key(exit),
    ...enemies.map((e) => key({ x: Math.floor(e.x), y: Math.floor(e.y) })),
  ]);

  while (opened.size < doors.length) {
    const reachable = reachableTiles(grid, spawn, opened);
    const frontier = doors.find(
      (d) => !opened.has(key(d)) && neighbors(d).some((n) => reachable.has(key(n))),
    );
    if (!frontier) break; // remaining doors are unreachable dead-ends

    const spot = pickKeySpot(reachable, grid, used, rng);
    if (spot) {
      used.add(key(spot));
      keys.push({ x: spot.x + 0.5, y: spot.y + 0.5, collected: false });
    }
    opened.add(key(frontier));
  }
  return keys;
}

/** BFS of tiles reachable from spawn; walls and unopened doors block. */
function reachableTiles(grid: Tile[][], spawn: Point, opened: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack: Point[] = [spawn];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const k = key(p);
    if (seen.has(k)) continue;
    const tile = grid[p.y]?.[p.x];
    if (tile === undefined || tile === 1) continue; // wall / out of bounds
    if (tile === DOOR_TILE && !opened.has(k)) continue; // still-locked door
    seen.add(k);
    for (const n of neighbors(p)) stack.push(n);
  }
  return seen;
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

function neighbors(p: Point): Point[] {
  return [
    { x: p.x + 1, y: p.y },
    { x: p.x - 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x, y: p.y - 1 },
  ];
}

function key(p: Point): string {
  return `${p.x},${p.y}`;
}

/** Extra enemies spawned per this many complexity points, beyond the first. */
const COMPLEXITY_PER_EXTRA_ENEMY = 10;

/**
 * Populate rooms with enemies. Classes, interfaces, and traits get rooms but no
 * enemy — only callable entities are "monsters". A room's total HP scales with
 * the entity's cyclomatic complexity; highly complex functions split that into
 * a pack (one extra enemy per 10 complexity points) rather than a single boss.
 * Placements avoid the exit tile so the 'return' marker stays visible.
 */
function spawnEnemies(rooms: Room[], exit: Point, rng: () => number): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of rooms) {
    if (room.entity.kind !== "function" && room.entity.kind !== "method") continue;

    const complexity = Math.max(1, room.entity.complexityScore);
    const count = 1 + Math.floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY);
    // Split the room's HP budget across the pack so total toughness is stable.
    const hp = Math.max(HP_PER_COMPLEXITY, Math.round((complexity * HP_PER_COMPLEXITY) / count));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };

    for (const pos of enemyPositions(room, count, exit, rng)) {
      enemies.push({
        x: pos.x,
        y: pos.y,
        hp,
        maxHp: hp,
        alive: true,
        attackCooldown: 0,
        hitFlash: 0,
        home,
        aggroed: false,
        roamX: pos.x,
        roamY: pos.y,
        entity: room.entity,
      });
    }
  }
  return enemies;
}

/**
 * Fractional spawn points for a room's enemy pack: the first at the room center,
 * the rest scattered randomly inside it. Any point landing on the exit tile is
 * re-rolled (then nudged to a corner as a last resort) so nothing hides it.
 */
function enemyPositions(room: Room, count: number, exit: Point, rng: () => number): Point[] {
  const spots: Point[] = [];
  const onExit = (p: Point): boolean => Math.floor(p.x) === exit.x && Math.floor(p.y) === exit.y;
  const randomInRoom = (): Point => ({
    x: room.x + 0.5 + rng() * (room.w - 1),
    y: room.y + 0.5 + rng() * (room.h - 1),
  });

  for (let i = 0; i < count; i++) {
    // First enemy anchors at the room center; the rest scatter randomly.
    let p = i === 0 ? { x: room.x + room.w / 2, y: room.y + room.h / 2 } : randomInRoom();
    for (let guard = 0; onExit(p) && guard < 8; guard++) p = randomInRoom();
    if (onExit(p)) p = { x: room.x + 1.5, y: room.y + 1.5 }; // last-resort corner
    spots.push(p);
  }
  return spots;
}

/**
 * Turn each global-variable room into an acid pool: fill its interior (leaving
 * a 1-tile walkable rim) with hazard tiles. The spawn room is skipped and the
 * spawn/exit tiles are always kept clear so the player never starts or wins in
 * acid. Returns every hazard tile for rendering.
 */
function fillHazards(
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

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
import type { CodeEntity, GotoLink, ParsedFile } from "../parser/types";
import {
  DOOR_TILE,
  HAZARD_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type Decoration,
  type DecorKind,
  type Enemy,
  type GameMap,
  type KeyItem,
  type Mine,
  type Point,
  type Room,
  type SpikeTrap,
  type Teleporter,
  type Tile,
} from "./types";

/** Hit points granted per point of cyclomatic complexity. */
const HP_PER_COMPLEXITY = 25;

/** Nesting depth at/above which an entity's room becomes a labyrinth. */
const MAZE_THRESHOLD = 2;

/** Manhattan distance beyond which a corridor gets 1-2 jogs instead of a
 * single straight L-turn, so long hallways don't offer one full sightline. */
const CORRIDOR_JOG_THRESHOLD = 10;
/** Perpendicular jitter applied to each corridor jog waypoint, in tiles. */
const CORRIDOR_JOG_JITTER = 3;

/** Minimum room footprint (tiles, both dimensions) to get pillars/decor. */
const LARGE_ROOM_MIN_DIM = 6;
/** Tiles kept clear around a room's center, the exit, spawn, and enemies when
 * placing a pillar or decoration — keeps critical spots visible/reachable. */
const PROP_CLEARANCE = 1.4;
/** Minimum spacing (tiles) between two props placed in the same room. */
const PROP_SPACING = 1.8;
/** Placement attempts per prop before giving up on it. */
const PROP_ATTEMPTS = 12;
/**
 * Whether cosmetic decorations (server racks, plants, desks, code-blocks) are
 * spawned. Disabled after playtest feedback that they got in the way; the
 * generation and rendering code is left in place to revisit later.
 */
const DECORATIONS_ENABLED = false;

/** Minimum/maximum full safe→active→safe cycle length for a spike trap. */
const SPIKE_PERIOD_MIN = 2.2;
const SPIKE_PERIOD_MAX = 3.6;
/** Minimum spacing (tiles) kept between any two traps, and between a trap and
 * any other avoid-listed point (spawn/exit/enemies/doors/keys/pads). */
const TRAP_SPACING = 3;
/** One trap (spike or mine, roughly split evenly) per this many candidate
 * choke-point tiles found, capped so tiny levels don't get overloaded. */
const CHOKE_POINTS_PER_TRAP = 5;
const MAX_TRAPS = 8;

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
    connectRooms(rooms, grid, rng);

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

    // Break up large empty rooms with structural pillars, then dress them with
    // cosmetic (non-blocking) props — both steer clear of the spawn, exit, room
    // centers (primary enemy spawns) and each other. Run before doors/keys so
    // those systems see the final walkable grid.
    const avoidPoints: Point[] = [
      { x: spawn.x + 0.5, y: spawn.y + 0.5 },
      { x: exit.x + 0.5, y: exit.y + 0.5 },
      ...enemies.map((e) => ({ x: e.x, y: e.y })),
    ];
    placePillars(rooms, grid, avoidPoints, rng);
    // Decorative props are disabled for now (playtest feedback: they got in
    // the way / felt annoying). Generation + rendering code stays intact —
    // just flip DECORATIONS_ENABLED back on to revisit them.
    const decorations = DECORATIONS_ENABLED ? placeDecorations(rooms, grid, avoidPoints, rng) : [];

    // Lock private/protected-method rooms behind doors, then scatter one key
    // per door in areas reachable before that door (keeps every level solvable).
    const doors = placeDoors(rooms, grid);
    const keys = placeKeys(grid, spawn, exit, enemies, doors, rng);

    // Turn each resolved `goto` → label jump into a teleporter pad pair, once
    // the floor plan (doors/keys included) is final so pads never overwrite
    // something load-bearing.
    const teleporterAvoid: Point[] = [
      ...avoidPoints,
      ...doors.map((d) => ({ x: d.x + 0.5, y: d.y + 0.5 })),
      ...keys.map((k) => ({ x: k.x, y: k.y })),
    ];
    const teleporters = placeTeleporters(rooms, grid, teleporterAvoid, parsed.gotos, rng);

    // Traps go in corridor choke points last, once every room-side system has
    // claimed its floor tiles — so a trap can never overwrite a door, key,
    // teleporter pad, or the spawn/exit/enemy clearances.
    const trapAvoid: Point[] = [
      ...teleporterAvoid,
      ...teleporters.map((t) => ({ x: t.x, y: t.y })),
    ];
    const { spikeTraps, mines } = placeTraps(rooms, grid, trapAvoid, rng);

    // Fog-of-war overlay grid, all unexplored until the player moves through.
    const visited: boolean[][] = Array.from({ length: size }, () =>
      new Array<boolean>(size).fill(false),
    );

    return {
      width: size,
      height: size,
      grid,
      visited,
      rooms,
      spawn,
      enemies,
      exit,
      hazards,
      doors,
      keys,
      decorations,
      teleporters,
      spikeTraps,
      mines,
    };
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
        discovered: false,
        roamX: pos.x,
        roamY: pos.y,
        fireCooldown: rng() * 2, // stagger initial shots across the pack
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
 * A room qualifies for pillars/decorations if it's a plain open room: not a
 * labyrinth (those are already dense with walls) and not a global-variable
 * hazard room (an acid pool has no business holding a server rack), and at
 * least `LARGE_ROOM_MIN_DIM` square so there's real empty space to break up.
 */
function isLargeOpenRoom(room: Room): boolean {
  return (
    room.entity.kind !== "global" &&
    room.entity.nestingDepth < MAZE_THRESHOLD &&
    room.w >= LARGE_ROOM_MIN_DIM &&
    room.h >= LARGE_ROOM_MIN_DIM
  );
}

/**
 * Scatter 1-1x1 wall "pillars" through large open rooms to break up long
 * sightlines and empty floor. Never touches the spawn room (index 0) — a
 * pillar right at the entrance would just be an early annoyance.
 */
function placePillars(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
): void {
  rooms.forEach((room, index) => {
    if (index === 0 || !isLargeOpenRoom(room)) return;
    const count = 1 + Math.floor(rng() * 3); // 1-3
    const placed: Point[] = [];
    for (let i = 0; i < count; i++) {
      const spot = findPropSpot(room, grid, avoid, placed, rng);
      if (!spot) continue;
      grid[spot.y][spot.x] = 1;
      placed.push(spot);
    }
  });
}

const DECOR_KINDS: DecorKind[] = ["rack", "plant", "desk", "block"];

/**
 * Scatter 1-3 cosmetic, non-blocking props (server racks, plants, desks,
 * abstract code-blocks) through large open rooms so they feel inhabited rather
 * than an empty wasteland. Unlike pillars, the spawn room is eligible too —
 * decorations never block anything, so there's no downside there.
 */
function placeDecorations(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
): Decoration[] {
  const decorations: Decoration[] = [];
  for (const room of rooms) {
    if (!isLargeOpenRoom(room)) continue;
    const count = 1 + Math.floor(rng() * 3); // 1-3
    const placed: Point[] = [];
    for (let i = 0; i < count; i++) {
      const spot = findPropSpot(room, grid, avoid, placed, rng);
      if (!spot) continue;
      placed.push(spot);
      const kind = DECOR_KINDS[Math.floor(rng() * DECOR_KINDS.length)];
      decorations.push({ x: spot.x + 0.5, y: spot.y + 0.5, kind });
    }
  }
  return decorations;
}

/**
 * Find an open interior tile in `room` for a pillar or decoration: on plain
 * floor, clear of the room center (the primary enemy spawn point) and every
 * point in `avoid` (spawn/exit/enemies), and spaced out from props already
 * `placed` in this room. Margin 1 keeps it off the room's own walls. Returns
 * `null` if no spot is found within the attempt budget (the room just gets
 * fewer props — never a hard failure).
 */
function findPropSpot(
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

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}

/** The room whose entity's line span contains `line`, if any. Used to anchor
 * a goto/label teleporter pad inside the room its source line lives in. */
function roomForLine(rooms: Room[], line: number): Room | undefined {
  return rooms.find((r) => line >= r.entity.startLine && line <= r.entity.endLine);
}

/**
 * Turn each resolved `goto` → label jump into a bidirectional teleporter pad
 * pair: one pad in the room containing the `goto` statement, one in the room
 * containing its label, each warping to the other. Falls back to the spawn
 * room when a line falls outside every entity (e.g. file-scope PHP code).
 * A link that can't find an open floor spot for both pads is skipped — never
 * a hard failure, same philosophy as pillar/decoration placement.
 */
function placeTeleporters(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  gotos: GotoLink[],
  rng: () => number,
): Teleporter[] {
  if (gotos.length === 0 || rooms.length === 0) return [];

  const teleporters: Teleporter[] = [];
  const placedByRoom = new Map<Room, Point[]>();
  const placedIn = (room: Room): Point[] => placedByRoom.get(room) ?? [];
  const addPlaced = (room: Room, p: Point): void => {
    const list = placedByRoom.get(room);
    if (list) list.push(p);
    else placedByRoom.set(room, [p]);
  };

  for (const link of gotos) {
    const fromRoom = roomForLine(rooms, link.gotoLine) ?? rooms[0];
    const toRoom = roomForLine(rooms, link.labelLine) ?? rooms[0];

    const fromSpot = findPropSpot(fromRoom, grid, avoid, placedIn(fromRoom), rng);
    if (!fromSpot) continue;
    addPlaced(fromRoom, fromSpot); // reserve before picking the paired spot,
    // so a same-room pair can't collide with itself.

    const toSpot = findPropSpot(toRoom, grid, avoid, placedIn(toRoom), rng);
    if (!toSpot) continue;
    addPlaced(toRoom, toSpot);

    grid[fromSpot.y][fromSpot.x] = TELEPORTER_TILE;
    grid[toSpot.y][toSpot.x] = TELEPORTER_TILE;

    const from = { x: fromSpot.x + 0.5, y: fromSpot.y + 0.5 };
    const to = { x: toSpot.x + 0.5, y: toSpot.y + 0.5 };
    teleporters.push({ x: from.x, y: from.y, targetX: to.x, targetY: to.y, label: link.label });
    teleporters.push({ x: to.x, y: to.y, targetX: from.x, targetY: from.y, label: link.label });
  }
  return teleporters;
}

/** A floor tile that belongs to no room — i.e. part of a corridor. */
function isCorridorFloor(x: number, y: number, grid: Tile[][], rooms: Room[]): boolean {
  if (grid[y][x] !== 0) return false;
  for (const room of rooms) {
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return false;
  }
  return true;
}

/**
 * A "choke point": a corridor tile exactly one tile wide in cross-section —
 * open on both sides along one axis, blocked on both sides along the other.
 * Traps are placed only here, never in open room floor, so they read as a
 * deliberate hazard blocking a passage rather than random floor clutter.
 */
function isChokePoint(x: number, y: number, grid: Tile[][]): boolean {
  const blocked = (cx: number, cy: number): boolean =>
    cy < 0 || cy >= grid.length || cx < 0 || cx >= grid[cy].length || grid[cy][cx] === 1;
  const openL = !blocked(x - 1, y);
  const openR = !blocked(x + 1, y);
  const openU = !blocked(x, y - 1);
  const openD = !blocked(x, y + 1);
  return (openL && openR && !openU && !openD) || (openU && openD && !openL && !openR);
}

/** Every corridor choke-point tile in the level, candidates for trap placement. */
function corridorChokePoints(rooms: Room[], grid: Tile[][]): Point[] {
  const points: Point[] = [];
  for (let y = 1; y < grid.length - 1; y++) {
    for (let x = 1; x < grid[y].length - 1; x++) {
      if (isCorridorFloor(x, y, grid, rooms) && isChokePoint(x, y, grid)) points.push({ x, y });
    }
  }
  return points;
}

/** Fisher-Yates shuffle using the level's seeded PRNG, for deterministic but
 * non-scan-order trap placement. */
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

/**
 * Scatter timed spike traps and proximity mines across corridor choke points,
 * alternating between the two kinds. Skips any candidate too close to an
 * `avoid`-listed point (spawn, exit, enemies, doors, keys, teleporter pads) or
 * to a trap already placed. Never a hard failure — a level with few/no
 * corridors simply gets few/no traps.
 */
function placeTraps(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
): { spikeTraps: SpikeTrap[]; mines: Mine[] } {
  const candidates = corridorChokePoints(rooms, grid);
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
 * Chain the rooms together with corridors (room i ↔ room i-1), guaranteeing
 * the whole level is reachable from the spawn.
 */
function connectRooms(rooms: Room[], grid: Tile[][], rng: () => number): void {
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(grid, rooms[i - 1].center, rooms[i].center, rng);
  }
}

/**
 * Carve a corridor between two points. Short hops stay a single L-turn; long
 * ones (see `corridorWaypoints`) pick up 1-2 jittered intermediate waypoints so
 * the path bends instead of offering one long straight sightline. Each leg
 * alternates which axis goes first, so consecutive jogs don't all bend the
 * same way.
 */
function carveCorridor(grid: Tile[][], from: Point, to: Point, rng: () => number): void {
  const waypoints = corridorWaypoints(from, to, grid.length, rng);
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (i % 2 === 1) {
      carveHLine(grid, a.x, b.x, a.y);
      carveVLine(grid, a.y, b.y, b.x);
    } else {
      carveVLine(grid, a.y, b.y, a.x);
      carveHLine(grid, a.x, b.x, b.y);
    }
  }
}

/**
 * Intermediate turn points between two room centers. Distances at/under
 * `CORRIDOR_JOG_THRESHOLD` stay a plain two-point (single L-turn) path; longer
 * ones get 1-2 waypoints placed along the line and jittered perpendicular to
 * it, clamped inside the map border.
 */
function corridorWaypoints(from: Point, to: Point, size: number, rng: () => number): Point[] {
  const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (manhattan <= CORRIDOR_JOG_THRESHOLD) return [from, to];

  const jogs = Math.min(2, Math.floor(manhattan / CORRIDOR_JOG_THRESHOLD));
  const points: Point[] = [from];
  for (let i = 1; i <= jogs; i++) {
    const t = i / (jogs + 1);
    const bx = from.x + (to.x - from.x) * t;
    const by = from.y + (to.y - from.y) * t;
    const jx = clamp(Math.round(bx + (rng() * 2 - 1) * CORRIDOR_JOG_JITTER), 1, size - 2);
    const jy = clamp(Math.round(by + (rng() * 2 - 1) * CORRIDOR_JOG_JITTER), 1, size - 2);
    points.push({ x: jx, y: jy });
  }
  points.push(to);
  return points;
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

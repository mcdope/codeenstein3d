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
import type { CodeComment, CodeEntity, GotoLink, ParsedFile, SecretTrigger } from "../parser/types";
import { isTodoFlagged } from "../parser/astUtils";
import { mulberry32 } from "../prng";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type AmmoPickup,
  type Decoration,
  type DecorKind,
  type Enemy,
  type GameMap,
  type KeyItem,
  type LoreTerminal,
  type Mine,
  type Point,
  type Rect,
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

/** Minimum/maximum full safe→active→safe cycle length for a spike trap.
 * Playtest feedback: the original 2.2-3.6s cycle alternated too fast to read
 * in time, so both bounds were raised. */
const SPIKE_PERIOD_MIN = 3.5;
const SPIKE_PERIOD_MAX = 5.5;
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

  /**
   * `bonusLevel` marks this as a "restock arena" (see `main.ts`, which sets it
   * for header/equivalent files): a distinct visual theme (handled by the
   * raycaster from the returned `GameMap.bonusLevel` flag) and a boosted
   * static-pickup rate, treating the level as a loot stop rather than a fight.
   *
   * `hasRocketLauncher` mirrors the same gate applied to enemy-kill drops (see
   * `rollLoot` in `engine/loot.ts`): until the player owns the launcher,
   * static rocket pickups would just be dead loot, so they're generated as
   * bullets/health instead.
   *
   * `missingWeaponIndices` feeds `placeSecretRooms`' weapon-unlock loot slot
   * — see that function's doc comment for why the map layer only ever
   * receives an opaque list of numbers here, never an engine-layer weapon
   * concept.
   */
  generate(parsed: ParsedFile, bonusLevel = false, hasRocketLauncher = true, missingWeaponIndices: readonly number[] = []): GameMap {
    const rng = mulberry32(seedFrom(parsed));
    const size = this.mapSize(parsed);

    // Start fully solid; rooms and corridors carve empty space out of it.
    const grid: Tile[][] = Array.from({ length: size }, () =>
      new Array<Tile>(size).fill(1),
    );

    const rooms = this.placeRooms(parsed.entities, size, grid, rng);
    connectRooms(rooms, grid, rng);
    // Long, empty straight corridors read as boring "endless walk" filler —
    // interrupt any run past MAX_CORRIDOR_STRAIGHT_LENGTH with a small room
    // (or, failing that, a forced jog) right after the grid is fully carved,
    // since run length is a property of the whole grid, not any single leg.
    const breakupRooms = breakUpLongCorridors(grid, rooms, size, this.opts.roomMargin, rng);

    // Spawn in whichever corner of the first room sits farthest from every
    // enemy-bearing room's center — not just a fixed corner — so the player
    // doesn't start already inside (or right at the edge of) an enemy's aggro
    // radius. Aggro is a straight-line distance check (see enemyAi.ts), so an
    // enemy in an adjacent room can otherwise reach clean through the wall
    // between them if that corner happens to be the closest one.
    const spawn: Point = pickSafeSpawn(rooms);
    // Exit is chosen before enemies so their placement can steer clear of it —
    // the 'return' tile must never be hidden under a monster.
    const exit = pickExit(rooms, spawn);
    const enemies = spawnEnemies(rooms, exit, rng);
    // "Edge Case" enemies populate the corridor-breakup rooms exclusively —
    // never a normal room, and normal enemies never spawn in a breakup room.
    enemies.push(...spawnEdgeCaseEnemies(grid, breakupRooms, exit, rng));
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
    const keys = placeKeys(grid, spawn, exit, enemies, doors, breakupRooms, rng);

    // Glowing "lore terminals" from large source comments, and hidden secret
    // rooms carved behind fake walls from unreachable ("dead") code — both
    // consume only still-untouched wall tiles (grid value `1`), so they can
    // never collide with a door, key spot, or each other regardless of order.
    // A TODO/FIXME-flagged comment also spawns a small trap, mine, or weak
    // enemy right next to its terminal — folded into `enemies` immediately
    // (so it flows through to the final `GameMap` like any other enemy) and
    // into `teleporterAvoid` below (so a teleporter pad can't land on top of
    // one).
    const loreResult = placeLoreTerminals(rooms, grid, parsed.comments, rng, spawn);
    const loreTerminals = loreResult.terminals;
    enemies.push(...loreResult.todoEnemies);
    const { secretLoot } = placeSecretRooms(rooms, grid, size, parsed.secretTriggers, rng, hasRocketLauncher, missingWeaponIndices);

    // Turn each resolved `goto` → label jump into a teleporter pad pair, once
    // the floor plan (doors/keys included) is final so pads never overwrite
    // something load-bearing.
    const teleporterAvoid: Point[] = [
      ...avoidPoints,
      ...doors.map((d) => ({ x: d.x + 0.5, y: d.y + 0.5 })),
      ...keys.map((k) => ({ x: k.x, y: k.y })),
      ...loreResult.todoTraps.map((t) => ({ x: t.x, y: t.y })),
      ...loreResult.todoMines.map((m) => ({ x: m.x, y: m.y })),
      ...loreResult.todoEnemies.map((e) => ({ x: e.x, y: e.y })),
    ];
    const teleporters = placeTeleporters(rooms, grid, teleporterAvoid, parsed.gotos, rng);

    // Traps go in corridor choke points last, once every room-side system has
    // claimed its floor tiles — so a trap can never overwrite a door, key,
    // teleporter pad, or the spawn/exit/enemy clearances.
    const trapAvoid: Point[] = [
      ...teleporterAvoid,
      ...teleporters.map((t) => ({ x: t.x, y: t.y })),
    ];
    const { spikeTraps: generatedSpikeTraps, mines: generatedMines } = placeTraps(rooms, grid, trapAvoid, rng, breakupRooms);
    const spikeTraps = [...generatedSpikeTraps, ...loreResult.todoTraps];
    const mines = [...generatedMines, ...loreResult.todoMines];

    // Sparse ammo pickups go dead last, once every other floor-claiming
    // system (pillars/decor/doors/keys/teleporters/traps) has placed its
    // final tiles, avoiding all of them plus the traps just placed above.
    const ammoAvoid: Point[] = [
      ...trapAvoid,
      ...spikeTraps.map((t) => ({ x: t.x, y: t.y })),
      ...mines.map((m) => ({ x: m.x, y: m.y })),
    ];
    const ammoPickups = [
      ...placeAmmoPickups(rooms, grid, ammoAvoid, rng, bonusLevel, hasRocketLauncher),
      ...secretLoot,
    ];

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
      breakupRooms,
      spawn,
      enemies,
      exit,
      shortestPathTiles: shortestPath(grid, spawn, exit),
      hazards,
      doors,
      keys,
      decorations,
      teleporters,
      spikeTraps,
      mines,
      ammoPickups,
      loreTerminals,
      bonusLevel,
      secretRoomCount: secretLoot.length,
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

/** True if two rects overlap once each is grown by `margin` on all sides. */
function roomsOverlap(a: Rect, b: Rect, margin: number): boolean {
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
  breakupRooms: Rect[],
  rng: () => number,
): KeyItem[] {
  if (doors.length === 0) return [];

  const keys: KeyItem[] = [];
  const opened = new Set<string>();
  const used = new Set<string>([
    key(spawn),
    key(exit),
    ...enemies.map((e) => key({ x: Math.floor(e.x), y: Math.floor(e.y) })),
    ...breakupTileKeys(breakupRooms),
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

/**
 * BFS-shortest tile distance from `spawn` to `exit` over the finished grid.
 * Walls, secret walls, and lore terminals block; a locked door doesn't — a
 * perfect run always ends up opening every door along its route anyway, so
 * the "ideal" path ignores key-gating and just measures raw geometry (see
 * `GameMap.shortestPathTiles`'s doc comment). Falls back to 0 (no path bonus,
 * rather than a crash) in the unreachable case, which generation shouldn't
 * actually produce given corridors always connect every room.
 */
function shortestPath(grid: Tile[][], spawn: Point, exit: Point): number {
  const start = key(spawn);
  const target = key(exit);
  if (start === target) return 0;

  const dist = new Map<string, number>([[start, 0]]);
  const queue: Point[] = [spawn];
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const d = dist.get(key(p))!;
    if (key(p) === target) return d;
    for (const n of neighbors(p)) {
      const nk = key(n);
      if (dist.has(nk)) continue;
      const tile = grid[n.y]?.[n.x];
      if (tile === undefined || tile === 1 || tile === SECRET_WALL_TILE || tile === LORE_TILE) continue;
      dist.set(nk, d + 1);
      queue.push(n);
    }
  }
  return dist.get(target) ?? 0;
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

/** Every tile key inside each of `rects` — used to keep grid-scanning
 * placement (keys) from claiming a breakup room's floor. */
function breakupTileKeys(rects: Rect[]): string[] {
  const out: string[] = [];
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) out.push(key({ x, y }));
    }
  }
  return out;
}

/** Extra enemies spawned per this many complexity points, beyond the first. */
const COMPLEXITY_PER_EXTRA_ENEMY = 10;
/**
 * Complexity at/above which a function spawns as a single Elite enemy instead
 * of a pack — this is exactly the complexity a pack would hit 5 members at
 * (`1 + floor(40/10)`), so "extreme complexity" means "would otherwise be the
 * biggest kind of pack, so make it one boss-tier threat instead."
 */
const ELITE_COMPLEXITY_THRESHOLD = 40;
/** An Elite's HP is this multiple of what a *single* (non-pack) enemy would
 * have at the same complexity — not the pack's already-split-down HP. */
const ELITE_HP_MULTIPLIER = 4;

/**
 * Populate rooms with enemies. Classes, interfaces, and traits get rooms but no
 * enemy — only callable entities are "monsters". A room's total HP scales with
 * the entity's cyclomatic complexity; highly complex functions split that into
 * a pack (one extra enemy per 10 complexity points) rather than a single boss
 * — unless complexity crosses `ELITE_COMPLEXITY_THRESHOLD`, in which case it's
 * a single Elite instead of the biggest packs (see `Enemy.elite`). Placements
 * avoid the exit tile so the 'return' marker stays visible.
 */
function spawnEnemies(rooms: Room[], exit: Point, rng: () => number): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of rooms) {
    if (room.entity.kind !== "function" && room.entity.kind !== "method") continue;

    const complexity = Math.max(1, room.entity.complexityScore);
    const elite = complexity >= ELITE_COMPLEXITY_THRESHOLD;
    const count = elite ? 1 : 1 + Math.floor(complexity / COMPLEXITY_PER_EXTRA_ENEMY);
    // Split the room's HP budget across the pack so total toughness is stable
    // — an Elite instead gets a flat multiple of a single enemy's HP at this
    // complexity, since it's replacing the pack entirely, not just its first
    // member.
    const hp = elite
      ? complexity * HP_PER_COMPLEXITY * ELITE_HP_MULTIPLIER
      : Math.max(HP_PER_COMPLEXITY, Math.round((complexity * HP_PER_COMPLEXITY) / count));
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
        elite,
        edgeCase: false,
      });
    }
  }
  return enemies;
}

/** Enemies spawned per breakup room, range [min, max]. */
const EDGE_CASE_MIN_PER_ROOM = 1;
const EDGE_CASE_MAX_PER_ROOM = 3;
/** An Edge Case enemy's HP, range [min, max] — a "literal bug in the system"
 * dies almost instantly, on purpose. */
const EDGE_CASE_HP_MIN = 10;
const EDGE_CASE_HP_MAX = 15;

/**
 * `p`, snapped to the nearest actual floor tile within `rect` (BFS outward
 * from `p`'s own tile, never leaving `rect`'s bounds). Unlike a normal
 * rectangular room, a breakup room's interior isn't fully open floor — it
 * has an internal baffle wall (see `breakUpRoomSightline`) — so `enemyPositions`'
 * raw geometric picks (in particular, its first-enemy-at-room-center pick,
 * which for a small odd-dimensioned room often lands exactly on the baffle)
 * can land on a wall tile. Returning `p` unsnapped there and letting
 * `clearCriticalTiles` force-floor it later would punch a hole straight
 * through the baffle at that exact spot, defeating the whole point of it.
 */
function nearestFloorInRect(grid: Tile[][], rect: Rect, p: Point): Point {
  const startX = Math.floor(p.x);
  const startY = Math.floor(p.y);
  if (grid[startY]?.[startX] === 0) return p;

  const seen = new Set<string>([`${startX},${startY}`]);
  const queue: Point[] = [{ x: startX, y: startY }];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of neighbors(cur)) {
      if (n.x < rect.x || n.x >= rect.x + rect.w || n.y < rect.y || n.y >= rect.y + rect.h) continue;
      const k = `${n.x},${n.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (grid[n.y][n.x] === 0) return { x: n.x + 0.5, y: n.y + 0.5 };
      queue.push(n);
    }
  }
  return p;
}

/**
 * Populate every corridor-breakup room (see `breakUpLongCorridors`) with 1-3
 * "Edge Case" enemies — small, fast, low-HP nuisances that break up the
 * "endless walk" feeling of a long corridor stretch. Modeled directly on
 * `placeTodoEncounter`'s enemy branch: a synthetic `CodeEntity` stands in for
 * the (nonexistent) parsed entity a breakup room would otherwise need. Never
 * spawns in a normal AST-derived room, and normal enemies never spawn here —
 * both are guaranteed structurally, since `spawnEnemies` only ever iterates
 * `rooms: Room[]` and this only ever iterates `breakupRooms: Rect[]`.
 */
function spawnEdgeCaseEnemies(grid: Tile[][], breakupRooms: Rect[], exit: Point, rng: () => number): Enemy[] {
  const enemies: Enemy[] = [];
  for (const room of breakupRooms) {
    const count =
      EDGE_CASE_MIN_PER_ROOM + Math.floor(rng() * (EDGE_CASE_MAX_PER_ROOM - EDGE_CASE_MIN_PER_ROOM + 1));
    const home = { x: room.x, y: room.y, w: room.w, h: room.h };
    const entity: CodeEntity = {
      name: "EdgeCase",
      kind: "class",
      startLine: 0,
      endLine: 0,
      complexityScore: 1,
      nestingDepth: 0,
    };

    for (const rawPos of enemyPositions(room, count, exit, rng)) {
      const pos = nearestFloorInRect(grid, room, rawPos);
      const hp = EDGE_CASE_HP_MIN + Math.floor(rng() * (EDGE_CASE_HP_MAX - EDGE_CASE_HP_MIN + 1));
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
        fireCooldown: rng() * 2,
        entity,
        elite: false,
        edgeCase: true,
      });
    }
  }
  return enemies;
}

/**
 * Fractional spawn points for a room's enemy pack: the first at the room center,
 * the rest scattered randomly inside it. Any point landing on the exit tile is
 * re-rolled (then nudged to a corner as a last resort) so nothing hides it.
 *
 * Every candidate is snapped to the center of whichever tile it falls in
 * before being returned — not left at its raw continuous (or, for the room
 * center, possibly boundary-straddling) coordinate. Two things otherwise leave
 * an enemy's collision box (`ENEMY_RADIUS` in `enemyAi.ts`) overlapping a
 * neighboring wall tile, which visually looks like it's embedded in the wall:
 * a room center calculated as `room.x + room.w / 2` lands exactly *on* a grid
 * line whenever `room.w`/`room.h` is even, straddling up to four tiles instead
 * of centering in one; and for a labyrinth room (deeply nested functions —
 * most of its bounding rectangle is actually wall, not floor), a fully
 * continuous random point can land close enough to an internal maze wall for
 * the same overlap even without hitting a boundary exactly. `clearCriticalTiles`
 * already force-clears the one tile under each enemy's *position* to
 * guarantee it's floor — snapping to that tile's center is what makes the
 * enemy's full collision box actually fit inside it, on every side.
 */
function enemyPositions(room: Rect, count: number, exit: Point, rng: () => number): Point[] {
  const spots: Point[] = [];
  const onExit = (p: Point): boolean => Math.floor(p.x) === exit.x && Math.floor(p.y) === exit.y;
  const randomInRoom = (): Point => ({
    x: room.x + 0.5 + rng() * (room.w - 1),
    y: room.y + 0.5 + rng() * (room.h - 1),
  });
  const tileCenter = (p: Point): Point => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 });

  for (let i = 0; i < count; i++) {
    // First enemy anchors at the room center; the rest scatter randomly.
    let p = tileCenter(i === 0 ? { x: room.x + room.w / 2, y: room.y + room.h / 2 } : randomInRoom());
    for (let guard = 0; onExit(p) && guard < 8; guard++) p = tileCenter(randomInRoom());
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

/** Odds any given non-spawn room gets a scattered ammo pickup — deliberately
 * sparse, since the primary ammo source is the starting reserve plus enemy
 * loot drops, not free static pickups. */
const AMMO_PICKUP_ROOM_CHANCE = 0.22;
/** Odds a given scattered pickup is rockets rather than bullets — rockets are
 * the scarcer, higher-value ammo type. */
const AMMO_PICKUP_ROCKET_CHANCE = 0.3;
/** Amount granted per scattered pickup, by kind (kept local rather than
 * imported from the engine layer's `loot.ts` — the map layer never depends on
 * the engine layer, only the reverse). Bumped ~40-50% over the original
 * 8/2 baseline — playtest feedback was that ammo ran too scarce on Normal. */
const AMMO_PICKUP_BULLETS_AMOUNT = 11;
const AMMO_PICKUP_ROCKETS_AMOUNT = 3;
/** A bonus (restock-arena) level scatters pickups far more liberally, and
 * each one grants more — it's meant to feel like a deliberate resupply stop,
 * not a normal combat level that happens to have a few pickups. */
const BONUS_AMMO_ROOM_CHANCE = 0.65;
const BONUS_AMMO_AMOUNT_MULTIPLIER = 1.5;

/**
 * Scatter a sparse handful of statically-placed ammo pickups (bullets or
 * rockets) across the map — one candidate roll per non-spawn room, each
 * independently likely to actually get one. A backup source, not the primary
 * one (see `AMMO_PICKUP_ROOM_CHANCE`'s doc comment) — except on a bonus level,
 * where both the odds and the amounts are boosted (see `BONUS_AMMO_ROOM_CHANCE`).
 */
function placeAmmoPickups(
  rooms: Room[],
  grid: Tile[][],
  avoid: Point[],
  rng: () => number,
  bonusLevel: boolean,
  hasRocketLauncher: boolean,
): AmmoPickup[] {
  const pickups: AmmoPickup[] = [];
  const roomChance = bonusLevel ? BONUS_AMMO_ROOM_CHANCE : AMMO_PICKUP_ROOM_CHANCE;
  const amountMultiplier = bonusLevel ? BONUS_AMMO_AMOUNT_MULTIPLIER : 1;

  rooms.forEach((room, index) => {
    if (index === 0) return; // never in the spawn room
    if (rng() >= roomChance) return;

    const placedSoFar = pickups.map((p) => ({ x: Math.floor(p.x), y: Math.floor(p.y) }));
    const spot = findPropSpot(room, grid, avoid, placedSoFar, rng);
    if (!spot) return;

    const kind = hasRocketLauncher && rng() < AMMO_PICKUP_ROCKET_CHANCE ? "rockets" : "bullets";
    const base = kind === "rockets" ? AMMO_PICKUP_ROCKETS_AMOUNT : AMMO_PICKUP_BULLETS_AMOUNT;
    pickups.push({
      x: spot.x + 0.5,
      y: spot.y + 0.5,
      kind,
      amount: Math.round(base * amountMultiplier),
      collected: false,
    });
  });
  return pickups;
}

/** Comments must reach this length (or already span multiple lines — see
 * `extractLargeComments`) to be worth a lore terminal; kept in step with a cap
 * on how many any single file spawns, so a huge file doesn't wallpaper every
 * room in glowing text. */
const MAX_LORE_TERMINALS = 6;

/** Flat HP for a TODO/FIXME "Bug" enemy — well under `HP_PER_COMPLEXITY`
 * (25, the existing floor for a normal complexity-scaled enemy from
 * `spawnEnemies`), so it reads as a minor nuisance, not a real fight. */
const TODO_BUG_HP = 10;

/**
 * Turn each large source comment into a glowing "lore terminal": a normal
 * wall tile, just outside whichever room contains the comment's source line,
 * re-tagged `LORE_TILE` so the raycaster renders it distinctly. Never a hard
 * failure — a comment whose room has no free wall tile left simply doesn't
 * get one. A TODO/FIXME-flagged comment (see `isTodoFlagged`) also gets a
 * small "technical debt" encounter — a timed spike trap, a proximity mine, or
 * a weak "Bug" enemy, picked per-instance via the seeded `rng` — on the floor
 * tile just inside the room, right next to its terminal. Never placed within
 * `TRAP_SPACING` of `spawn`, same as every other hazard system, so a comment
 * that happens to resolve to the spawn room can't ambush the player before
 * they can react.
 */
function placeLoreTerminals(
  rooms: Room[],
  grid: Tile[][],
  comments: CodeComment[],
  rng: () => number,
  spawn: Point,
): { terminals: LoreTerminal[]; todoTraps: SpikeTrap[]; todoMines: Mine[]; todoEnemies: Enemy[] } {
  const terminals: LoreTerminal[] = [];
  const todoTraps: SpikeTrap[] = [];
  const todoMines: Mine[] = [];
  const todoEnemies: Enemy[] = [];
  const used = new Set<string>();
  const claimedFloor = new Set<string>();

  for (const comment of comments.slice(0, MAX_LORE_TERMINALS)) {
    const room = roomForLine(rooms, comment.startLine) ?? rooms[0];
    if (!room) continue;
    const spot = findWallPerimeterSpot(room, grid, used, rng);
    if (!spot) continue;
    used.add(key(spot));
    grid[spot.y][spot.x] = LORE_TILE;
    terminals.push({ x: spot.x, y: spot.y, text: comment.text });

    if (isTodoFlagged(comment.text)) {
      const encounter = placeTodoEncounter(room, grid, spot, comment, claimedFloor, rng, spawn);
      if (encounter && "trap" in encounter) todoTraps.push(encounter.trap);
      else if (encounter && "mine" in encounter) todoMines.push(encounter.mine);
      else if (encounter) todoEnemies.push(encounter.enemy);
    }
  }
  return { terminals, todoTraps, todoMines, todoEnemies };
}

/** The floor tile just inside `room`, adjacent to `spot` — `spot` (from
 * `findWallPerimeterSpot`) always sits exactly one tile outside one of the
 * room's four sides, so this deterministically steps back in from it. */
function interiorNeighborOf(room: Room, spot: Point): Point {
  if (spot.y === room.y - 1) return { x: spot.x, y: room.y };
  if (spot.y === room.y + room.h) return { x: spot.x, y: room.y + room.h - 1 };
  if (spot.x === room.x - 1) return { x: room.x, y: spot.y };
  return { x: room.x + room.w - 1, y: spot.y };
}

/**
 * Places a small "technical debt" encounter — a timed spike trap, a
 * proximity mine, or a weak "Bug" enemy, each equally likely — on a free
 * floor tile next to a TODO/FIXME terminal's `spot`. Deliberately a *trap*
 * or *mine* (both reusing `placeTraps`' own shapes/mechanics), not a
 * `fillHazards`-style permanent acid pool: the candidate tile is right where
 * the player has to stand to interact with the terminal, and a permanently
 * damaging tile there would make it painful to ever reach rather than just
 * riskier — a trap/mine keeps a genuine safe approach instead. Never a hard
 * failure — a room with no free adjacent floor tile simply gets nothing, and
 * the same holds if every free tile is within `TRAP_SPACING` of `spawn` (a
 * TODO comment can resolve to the spawn room itself), so the player can never
 * take unavoidable damage in the first instants of a level.
 */
function placeTodoEncounter(
  room: Room,
  grid: Tile[][],
  spot: Point,
  comment: CodeComment,
  claimedFloor: Set<string>,
  rng: () => number,
  spawn: Point,
): { trap: SpikeTrap } | { mine: Mine } | { enemy: Enemy } | null {
  const anchor = interiorNeighborOf(room, spot);
  const candidates = [anchor, ...neighbors(anchor)];
  shuffle(candidates, rng);
  const free = candidates.filter(
    (p) =>
      grid[p.y]?.[p.x] === 0 &&
      !claimedFloor.has(key(p)) &&
      dist(p.x + 0.5, p.y + 0.5, spawn.x + 0.5, spawn.y + 0.5) >= TRAP_SPACING,
  );
  if (free.length === 0) return null;

  const p = free[0];
  claimedFloor.add(key(p));

  const roll = rng();
  if (roll < 1 / 3) {
    grid[p.y][p.x] = SPIKE_TRAP_TILE;
    return {
      trap: {
        x: p.x,
        y: p.y,
        period: SPIKE_PERIOD_MIN + rng() * (SPIKE_PERIOD_MAX - SPIKE_PERIOD_MIN),
        phase: rng() * SPIKE_PERIOD_MAX,
      },
    };
  }

  if (roll < 2 / 3) {
    // Mines stay on plain floor (tile 0) — same as `placeTraps`' own mines,
    // invisible until triggered, so nothing marks the grid tile itself.
    return { mine: { x: p.x + 0.5, y: p.y + 0.5, alive: true, visible: false, closeTimer: 0 } };
  }

  const entity: CodeEntity = {
    name: "Bug",
    kind: "class",
    startLine: comment.startLine,
    endLine: comment.endLine,
    complexityScore: 1,
    nestingDepth: 0,
  };
  return {
    enemy: {
      x: p.x + 0.5,
      y: p.y + 0.5,
      hp: TODO_BUG_HP,
      maxHp: TODO_BUG_HP,
      alive: true,
      attackCooldown: 0,
      hitFlash: 0,
      home: { x: room.x, y: room.y, w: room.w, h: room.h },
      aggroed: false,
      discovered: false,
      roamX: p.x + 0.5,
      roamY: p.y + 0.5,
      fireCooldown: rng() * 2,
      entity,
      elite: false,
      edgeCase: false,
    },
  };
}

/** A still-untouched wall tile (`grid` value `1`) on `room`'s own perimeter,
 * not already claimed by an earlier call — used by lore terminal placement,
 * which (unlike a door/corridor mouth) doesn't need floor on the far side. */
function findWallPerimeterSpot(
  room: Room,
  grid: Tile[][],
  used: Set<string>,
  rng: () => number,
): Point | null {
  const candidates: Point[] = [];
  for (let x = room.x; x < room.x + room.w; x++) {
    candidates.push({ x, y: room.y - 1 });
    candidates.push({ x, y: room.y + room.h });
  }
  for (let y = room.y; y < room.y + room.h; y++) {
    candidates.push({ x: room.x - 1, y });
    candidates.push({ x: room.x + room.w, y });
  }
  shuffle(candidates, rng);
  for (const c of candidates) {
    if (used.has(key(c))) continue;
    if (grid[c.y]?.[c.x] === 1) return c;
  }
  return null;
}

/** Interior footprint (both dimensions) of a carved secret room. */
const SECRET_ROOM_SIZE = 3;
/** Secret-room triggers are capped the same way lore terminals are — a huge
 * legacy file can have dozens of qualifying spots, but not every one needs
 * its own hidden room. */
const MAX_SECRET_ROOMS = 5;
/** A secret room's guaranteed pickup — "mega-health", a fat rockets stash, or
 * a chunky armor top-up — noticeably above the normal
 * `AMMO_PICKUP_*`/`HEALTH_DROP_AMOUNT`/`SWAP_DROP_AMOUNT` scale, since finding
 * one is meant to feel like a real reward for exploring. */
const SECRET_LOOT_HEALTH_AMOUNT = 60;
const SECRET_LOOT_ROCKETS_AMOUNT = 4;
const SECRET_LOOT_SWAP_AMOUNT = 40;

/** One candidate outcome for a secret room's guaranteed pickup — see the
 * `candidates` list built in `placeSecretRooms`. */
interface SecretLootCandidate {
  kind: AmmoPickup["kind"];
  amount: number;
  weaponIndex?: number;
}

/**
 * Carve a hidden room for a capped, fairly-sampled, one-per-room subset of
 * `secretTriggers` (dead code, empty catch blocks, deprecation markers,
 * commented-out code, magic-number/blob literals), off a random side of
 * whichever room contains its source line, behind a `SECRET_WALL_TILE` that
 * renders and blocks exactly like a normal wall (see `Tile`'s doc comment) —
 * the only way to find one is to interact with the right stretch of wall.
 * Never a hard failure: a trigger whose anchor room has no free, clear patch
 * of solid rock beside it on any of its four sides simply doesn't get one.
 *
 * `missingWeaponIndices` is an opaque list of `WEAPONS` indices the current
 * player doesn't own yet (computed by `main.ts` from `ownedWeapons`, same
 * pattern as `hasRocketLauncher`) — the map layer never imports engine-layer
 * weapon concepts (see `doc/dev/architecture.md`), it just carries the
 * numbers through to `AmmoPickup.weaponIndex` for the engine to interpret
 * once collected.
 */
function placeSecretRooms(
  rooms: Room[],
  grid: Tile[][],
  mapSize: number,
  secretTriggers: SecretTrigger[],
  rng: () => number,
  hasRocketLauncher: boolean,
  missingWeaponIndices: readonly number[],
): { secretLoot: AmmoPickup[] } {
  const secretLoot: AmmoPickup[] = [];

  // With five source patterns concatenated in a fixed order, a file with many
  // dead-code regions (added first) could otherwise starve out every other
  // trigger kind from ever getting one of the capped slots below — shuffle a
  // copy first so the cap samples fairly across all kinds. Still fully
  // deterministic, since `rng` is the map's own seeded PRNG.
  const shuffled = [...secretTriggers];
  shuffle(shuffled, rng);

  // A single function/entity can trip several different trigger kinds at
  // once (e.g. dead code AND a magic number in the same method) and they'd
  // all resolve to the same anchor room via `roomForLine` — `usedAnchors`
  // caps it at one secret room per room, so the whole level's worth of
  // triggers is walked (not just the first `MAX_SECRET_ROOMS` in shuffled
  // order) until either the room cap is filled or triggers run out.
  const usedAnchors = new Set<Room>();
  for (const trigger of shuffled) {
    if (secretLoot.length >= MAX_SECRET_ROOMS) break;
    const anchor = roomForLine(rooms, trigger.startLine) ?? rooms[0];
    if (!anchor || usedAnchors.has(anchor)) continue;
    const secret = trySecretRoomOffAnchor(anchor, grid, mapSize, rng);
    if (!secret) continue;
    usedAnchors.add(anchor);

    // Picked uniformly among whatever's actually available this run — a
    // still-unowned weapon only competes once one exists, rockets only once
    // the launcher is owned, so "always health" (the reported complaint)
    // can't happen: swap is always in the running as a real alternative.
    const candidates: SecretLootCandidate[] = [{ kind: "health", amount: SECRET_LOOT_HEALTH_AMOUNT }, { kind: "swap", amount: SECRET_LOOT_SWAP_AMOUNT }];
    if (hasRocketLauncher) candidates.push({ kind: "rockets", amount: SECRET_LOOT_ROCKETS_AMOUNT });
    if (missingWeaponIndices.length > 0) {
      const weaponIndex = missingWeaponIndices[Math.floor(rng() * missingWeaponIndices.length)];
      candidates.push({ kind: "weapon", amount: 0, weaponIndex });
    }
    const choice = candidates[Math.floor(rng() * candidates.length)];

    secretLoot.push({
      x: secret.center.x + 0.5,
      y: secret.center.y + 0.5,
      kind: choice.kind,
      amount: choice.amount,
      weaponIndex: choice.weaponIndex,
      collected: false,
    });
  }
  return { secretLoot };
}

/**
 * Try each of `anchor`'s four sides (in random order) for a still-untouched
 * wall tile behind which a `SECRET_ROOM_SIZE`² patch of unclaimed solid rock
 * exists, fully inside the map border. Carves that patch to floor and turns
 * the connecting tile into `SECRET_WALL_TILE` on the first fit found.
 */
function trySecretRoomOffAnchor(
  anchor: Room,
  grid: Tile[][],
  mapSize: number,
  rng: () => number,
): { center: Point } | null {
  const size = SECRET_ROOM_SIZE;
  const half = Math.floor(size / 2);
  const candidates: { wall: Point; x0: number; y0: number; x1: number; y1: number }[] = [];

  for (let x = anchor.x; x < anchor.x + anchor.w; x++) {
    const nx0 = x - half;
    candidates.push({
      wall: { x, y: anchor.y - 1 },
      x0: nx0,
      y0: anchor.y - 1 - size,
      x1: nx0 + size - 1,
      y1: anchor.y - 2,
    });
    candidates.push({
      wall: { x, y: anchor.y + anchor.h },
      x0: nx0,
      y0: anchor.y + anchor.h + 1,
      x1: nx0 + size - 1,
      y1: anchor.y + anchor.h + size,
    });
  }
  for (let y = anchor.y; y < anchor.y + anchor.h; y++) {
    const ny0 = y - half;
    candidates.push({
      wall: { x: anchor.x - 1, y },
      x0: anchor.x - 1 - size,
      y0: ny0,
      x1: anchor.x - 2,
      y1: ny0 + size - 1,
    });
    candidates.push({
      wall: { x: anchor.x + anchor.w, y },
      x0: anchor.x + anchor.w + 1,
      y0: ny0,
      x1: anchor.x + anchor.w + size,
      y1: ny0 + size - 1,
    });
  }
  shuffle(candidates, rng);

  for (const c of candidates) {
    if (grid[c.wall.y]?.[c.wall.x] !== 1) continue;
    if (c.x0 < 1 || c.y0 < 1 || c.x1 > mapSize - 2 || c.y1 > mapSize - 2) continue;

    // Checked with a 1-tile margin beyond the room's own footprint, not just
    // the footprint itself: opening this room now flood-fills every
    // 4-connected `SECRET_WALL_TILE` cell reachable from the door (see
    // `tryOpenSecretWall`), so if another secret room's carved footprint
    // ended up directly touching this one, opening either would leak into
    // revealing both. A 1-tile buffer of untouched rock on every side rules
    // that out entirely.
    let clear = true;
    for (let y = c.y0 - 1; y <= c.y1 + 1 && clear; y++) {
      for (let x = c.x0 - 1; x <= c.x1 + 1; x++) {
        if (grid[y]?.[x] !== 1) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;

    // The whole room — interior *and* the one connecting tile — is carved as
    // `SECRET_WALL_TILE`, not floor. Rendering already treats every
    // `SECRET_WALL_TILE` cell as an ordinary wall (3D view, corner minimap,
    // automap), so a room made entirely of it is genuinely indistinguishable
    // from solid rock until opened — a room carved as floor here would show
    // up as a room-shaped hole in the surrounding walls (no fog-of-war on the
    // corner minimap) or leak through the automap's `visited` radius (which
    // has no wall-awareness and reaches past the one doorway tile) well
    // before the player ever interacts with it. Opening flood-fills this
    // whole connected patch to floor at once — see `tryOpenSecretWall`.
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) grid[y][x] = SECRET_WALL_TILE;
    }
    grid[c.wall.y][c.wall.x] = SECRET_WALL_TILE;
    return { center: { x: Math.floor((c.x0 + c.x1) / 2), y: Math.floor((c.y0 + c.y1) / 2) } };
  }
  return null;
}

/**
 * Find an open interior tile in `room` for a pillar, decoration, or ammo
 * pickup: on plain floor, clear of the room center (the primary enemy spawn
 * point) and every point in `avoid` (spawn/exit/enemies), and spaced out from
 * props already `placed` in this room. Margin 1 keeps it off the room's own
 * walls. Returns `null` if no spot is found within the attempt budget (the
 * room just gets fewer props — never a hard failure).
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
function roomForLine(rooms: Room[], line: number): Room | undefined {
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

/** A floor tile that belongs to no room and no breakup room — i.e. part of a
 * plain corridor. */
function isCorridorFloor(x: number, y: number, grid: Tile[][], rooms: Room[], breakupRooms: Rect[]): boolean {
  if (grid[y][x] !== 0) return false;
  for (const room of rooms) {
    if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) return false;
  }
  for (const room of breakupRooms) {
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
function corridorChokePoints(rooms: Room[], grid: Tile[][], breakupRooms: Rect[]): Point[] {
  const points: Point[] = [];
  for (let y = 1; y < grid.length - 1; y++) {
    for (let x = 1; x < grid[y].length - 1; x++) {
      if (isCorridorFloor(x, y, grid, rooms, breakupRooms) && isChokePoint(x, y, grid)) points.push({ x, y });
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

/**
 * Pick a spawn point in the first room: whichever of its four corners (1 tile
 * inset from the room edge) has the greatest minimum distance to any
 * enemy-bearing room's center. Room centers are known before any enemy is
 * actually placed (an enemy pack's first member always spawns dead center —
 * see `enemyPositions`), so this needs no reordering of the generation
 * pipeline. Best-effort, not a guarantee: a corner can still end up within
 * another enemy's aggro radius if the level is small or densely packed —
 * there just isn't a better option to pick instead.
 */
function pickSafeSpawn(rooms: Room[]): Point {
  if (rooms.length === 0) return { x: 1, y: 1 };
  const room0 = rooms[0];

  const candidates: Point[] = [
    { x: room0.x + 1, y: room0.y + 1 },
    { x: room0.x + room0.w - 2, y: room0.y + 1 },
    { x: room0.x + 1, y: room0.y + room0.h - 2 },
    { x: room0.x + room0.w - 2, y: room0.y + room0.h - 2 },
  ];

  const enemyRoomCenters = rooms
    .filter((r) => r.entity.kind === "function" || r.entity.kind === "method")
    .map((r) => r.center);
  if (enemyRoomCenters.length === 0) return candidates[0];

  let best = candidates[0];
  let bestMinDist = -1;
  for (const c of candidates) {
    const minDist = Math.min(...enemyRoomCenters.map((e) => dist(c.x + 0.5, c.y + 0.5, e.x + 0.5, e.y + 0.5)));
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      best = c;
    }
  }
  return best;
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

// --- corridor breakup --------------------------------------------------------

/** A contiguous straight run of plain corridor floor found by `findStraightRuns`. */
interface StraightRun {
  axis: "h" | "v";
  /** The row (for a horizontal run) or column (for a vertical run) the run sits on. */
  fixed: number;
  /** Inclusive start/end coordinate along the run's axis. */
  lo: number;
  hi: number;
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

/** Breakup room footprint bounds (tiles), rolled independently per axis so
 * the room isn't always a fixed-size square. */
const BREAKUP_ROOM_MIN_DIM = 3;
const BREAKUP_ROOM_MAX_DIM = 5;

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
function breakUpLongCorridors(grid: Tile[][], rooms: Room[], size: number, roomMargin: number, rng: () => number): Rect[] {
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

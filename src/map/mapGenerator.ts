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
import type { CodeComment, CodeEntity, DeadCodeRegion, GotoLink, ParsedFile } from "../parser/types";
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
   */
  generate(parsed: ParsedFile, bonusLevel = false, hasRocketLauncher = true): GameMap {
    const rng = mulberry32(seedFrom(parsed));
    const size = this.mapSize(parsed);

    // Start fully solid; rooms and corridors carve empty space out of it.
    const grid: Tile[][] = Array.from({ length: size }, () =>
      new Array<Tile>(size).fill(1),
    );

    const rooms = this.placeRooms(parsed.entities, size, grid, rng);
    connectRooms(rooms, grid, rng);

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
    /* v8 ignore next */
    const decorations = DECORATIONS_ENABLED ? placeDecorations(rooms, grid, avoidPoints, rng) : [];

    // Lock private/protected-method rooms behind doors, then scatter one key
    // per door in areas reachable before that door (keeps every level solvable).
    const doors = placeDoors(rooms, grid);
    const keys = placeKeys(grid, spawn, exit, enemies, doors, rng);

    // Glowing "lore terminals" from large source comments, and hidden secret
    // rooms carved behind fake walls from unreachable ("dead") code — both
    // consume only still-untouched wall tiles (grid value `1`), so they can
    // never collide with a door, key spot, or each other regardless of order.
    // A TODO/FIXME-flagged comment also spawns a small trap, mine, or weak
    // enemy right next to its terminal — folded into `enemies` immediately
    // (so it flows through to the final `GameMap` like any other enemy) and
    // into `teleporterAvoid` below (so a teleporter pad can't land on top of
    // one).
    const loreResult = placeLoreTerminals(rooms, grid, parsed.comments, rng);
    const loreTerminals = loreResult.terminals;
    enemies.push(...loreResult.todoEnemies);
    const { secretLoot } = placeSecretRooms(rooms, grid, size, parsed.deadCodeRegions, rng, hasRocketLauncher);

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
    const { spikeTraps: generatedSpikeTraps, mines: generatedMines } = placeTraps(rooms, grid, trapAvoid, rng);
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
    /* v8 ignore next */
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
  /* v8 ignore start */
  if (!canHorizontal && !canVertical) return;

  const horizontal =
    canHorizontal && canVertical ? h > w || (h === w && rng() < 0.5) : canHorizontal;
  /* v8 ignore stop */

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
    /* v8 ignore next */
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
  /* v8 ignore next */
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
  /* v8 ignore next */
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
  /* v8 ignore next */
  }
  /* v8 ignore next */
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
function enemyPositions(room: Room, count: number, exit: Point, rng: () => number): Point[] {
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
    /* v8 ignore next */
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
      /* v8 ignore next */
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
/* v8 ignore start */
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
/* v8 ignore stop */

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
 * tile just inside the room, right next to its terminal.
 */
function placeLoreTerminals(
  rooms: Room[],
  grid: Tile[][],
  comments: CodeComment[],
  rng: () => number,
): { terminals: LoreTerminal[]; todoTraps: SpikeTrap[]; todoMines: Mine[]; todoEnemies: Enemy[] } {
  const terminals: LoreTerminal[] = [];
  const todoTraps: SpikeTrap[] = [];
  const todoMines: Mine[] = [];
  const todoEnemies: Enemy[] = [];
  const used = new Set<string>();
  const claimedFloor = new Set<string>();

  for (const comment of comments.slice(0, MAX_LORE_TERMINALS)) {
    /* v8 ignore next */
    const room = roomForLine(rooms, comment.startLine) ?? rooms[0];
    /* v8 ignore next */
    if (!room) continue;
    const spot = findWallPerimeterSpot(room, grid, used, rng);
    if (!spot) continue;
    used.add(key(spot));
    grid[spot.y][spot.x] = LORE_TILE;
    terminals.push({ x: spot.x, y: spot.y, text: comment.text });

    if (isTodoFlagged(comment.text)) {
      const encounter = placeTodoEncounter(room, grid, spot, comment, claimedFloor, rng);
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
 * failure — a room with no free adjacent floor tile simply gets nothing.
 */
function placeTodoEncounter(
  room: Room,
  grid: Tile[][],
  spot: Point,
  comment: CodeComment,
  claimedFloor: Set<string>,
  rng: () => number,
): { trap: SpikeTrap } | { mine: Mine } | { enemy: Enemy } | null {
  const anchor = interiorNeighborOf(room, spot);
  const candidates = [anchor, ...neighbors(anchor)];
  shuffle(candidates, rng);
  const free = candidates.filter((p) => grid[p.y]?.[p.x] === 0 && !claimedFloor.has(key(p)));
  /* v8 ignore next */
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
/** Dead-code regions are capped the same way lore terminals are — a huge
 * legacy file can have dozens of unreachable blocks, but not every one needs
 * its own hidden room. */
const MAX_SECRET_ROOMS = 5;
/** A secret room's guaranteed pickup, "mega-health" or a fat rockets stash —
 * noticeably above the normal `AMMO_PICKUP_*`/`HEALTH_DROP_AMOUNT` scale, since
 * finding one is meant to feel like a real reward for exploring. */
const SECRET_LOOT_HEALTH_AMOUNT = 60;
const SECRET_LOOT_ROCKETS_AMOUNT = 4;

/**
 * Carve a hidden room for each unreachable-code region, off a random side of
 * whichever room contains its source line, behind a `SECRET_WALL_TILE` that
 * renders and blocks exactly like a normal wall (see `Tile`'s doc comment) —
 * the only way to find one is to interact with the right stretch of wall.
 * Never a hard failure: a region whose anchor room has no free, clear patch of
 * solid rock beside it on any of its four sides simply doesn't get one.
 */
function placeSecretRooms(
  rooms: Room[],
  grid: Tile[][],
  mapSize: number,
  deadCodeRegions: DeadCodeRegion[],
  rng: () => number,
  hasRocketLauncher: boolean,
): { secretLoot: AmmoPickup[] } {
  const secretLoot: AmmoPickup[] = [];

  for (const region of deadCodeRegions.slice(0, MAX_SECRET_ROOMS)) {
    /* v8 ignore next */
    const anchor = roomForLine(rooms, region.startLine) ?? rooms[0];
    /* v8 ignore next */
    if (!anchor) continue;
    const secret = trySecretRoomOffAnchor(anchor, grid, mapSize, rng);
    if (!secret) continue;

    const kind = hasRocketLauncher && rng() < 0.5 ? "rockets" : "health";
    secretLoot.push({
      x: secret.center.x + 0.5,
      y: secret.center.y + 0.5,
      kind,
      amount: kind === "health" ? SECRET_LOOT_HEALTH_AMOUNT : SECRET_LOOT_ROCKETS_AMOUNT,
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

    let clear = true;
    for (let y = c.y0; y <= c.y1 && clear; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (grid[y][x] !== 1) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;

    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) grid[y][x] = 0;
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
    /* v8 ignore next */
    const fromRoom = roomForLine(rooms, link.gotoLine) ?? rooms[0];
    /* v8 ignore next */
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
        /* v8 ignore start */
        if (x === spawn.x && y === spawn.y) continue;
        if (x === exit.x && y === exit.y) continue;
        /* v8 ignore stop */
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
  /* v8 ignore next */
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
  /* v8 ignore next */
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
  /* v8 ignore next */
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

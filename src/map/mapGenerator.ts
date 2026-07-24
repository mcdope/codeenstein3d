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
 *
 * This class only orchestrates: every placement subsystem lives in its own
 * module under `./generation/` (pure functions over the shared grid + seeded
 * rng), and `generate()` owns the one place their ordering — and therefore
 * the deterministic rng draw sequence — is defined. Don't reorder calls here
 * without accepting that every existing map layout (and recorded replay)
 * changes.
 */
import type { CodeEntity, ParsedFile } from "../parser/types";
import { mulberry32 } from "../prng";
import type { GameMap, Point, Room, Tile } from "./types";
import { breakUpLongCorridors } from "./generation/breakup";
import { connectRooms } from "./generation/corridors";
import { placeDoors, placeKeys } from "./generation/doorsKeys";
import { spawnEdgeCaseEnemies, spawnEnemies } from "./generation/enemies";
import {
  carveRoom,
  centeredRoom,
  clearCriticalTiles,
  makeRoom,
  roomDimensions,
  roomsOverlap,
} from "./generation/geometry";
import { carveLabyrinth, MAZE_THRESHOLD } from "./generation/labyrinth";
import { placeLoreTerminals } from "./generation/lore";
import { assertAllRoomsReachable, shortestPath } from "./generation/pathing";
import { placeAmmoPickups } from "./generation/pickups";
import { DECORATIONS_ENABLED, placeDecorations, placePillars } from "./generation/props";
import { seedFrom } from "./generation/seed";
import { placeSecretRooms } from "./generation/secretRooms";
import { pickExit, pickMultiplayerSpawns, pickSafeSpawn } from "./generation/spawnExit";
import { placeTeleporters } from "./generation/teleporters";
import { fillHazards, placeTraps } from "./generation/trapsHazards";
import { clamp } from "./generation/util";

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

/** Synthetic `CodeEntity` for a filler room — see `placeFillerRoom`.
 * `kind: "class"` is deliberate: it fails every "real code" eligibility
 * check elsewhere in `generation/` (enemy spawning in `enemies.ts`, door
 * locking in `doorsKeys.ts`), so a placeholder like `<filler>` never leaks
 * onto an enemy's on-screen nameplate — no actual code backs this room, so
 * nothing should represent it in-world. */
const FILLER_ENTITY: CodeEntity = {
  name: "<filler>",
  kind: "class",
  startLine: 1,
  endLine: 1,
  complexityScore: 1,
  nestingDepth: 0,
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
   *
   * `maxPlayers` requests extra, spread-out spawn points for a multiplayer
   * session (see `GameMap.multiplayerSpawns`) — 1 (the default) preserves
   * every existing call site's behavior exactly, `multiplayerSpawns` simply
   * comes back `undefined`.
   */
  generate(
    parsed: ParsedFile,
    bonusLevel = false,
    hasRocketLauncher = true,
    missingWeaponIndices: readonly number[] = [],
    maxPlayers = 1,
  ): GameMap {
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
    // Multiplayer spawns are picked here too — before enemies — so a pack's
    // first member (which always anchors on its room's center, the same pool
    // this draws from) can steer clear of one, the same reasoning as the exit.
    const multiplayerSpawns = maxPlayers > 1 ? pickMultiplayerSpawns(rooms, exit, maxPlayers) : undefined;
    const enemies = spawnEnemies(rooms, exit, rng, multiplayerSpawns ?? []);
    // "Edge Case" enemies populate the corridor-breakup rooms exclusively —
    // never a normal room, and normal enemies never spawn in a breakup room.
    enemies.push(...spawnEdgeCaseEnemies(grid, breakupRooms, exit, rng));
    const hazards = fillHazards(rooms, grid, spawn, exit, multiplayerSpawns ?? []);

    // Corridors already punch through labyrinth walls; this guarantees the
    // spawn, exit, every enemy, and every multiplayer spawn stand on open
    // floor even inside a maze.
    clearCriticalTiles(grid, spawn, exit, enemies, multiplayerSpawns ?? []);

    // Break up large empty rooms with structural pillars, then dress them with
    // cosmetic (non-blocking) props — both steer clear of the spawn, exit, room
    // centers (primary enemy spawns) and each other. Run before doors/keys so
    // those systems see the final walkable grid.
    const avoidPoints: Point[] = [
      { x: spawn.x + 0.5, y: spawn.y + 0.5 },
      { x: exit.x + 0.5, y: exit.y + 0.5 },
      ...enemies.map((e) => ({ x: e.x, y: e.y })),
      ...(multiplayerSpawns ?? []).map((s) => ({ x: s.x + 0.5, y: s.y + 0.5 })),
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

    // Safety net: should never fire (see `placeRooms`'s room-count floor and
    // `connectRooms`'s doc comment), but logs loudly instead of silently
    // shipping an unreachable room if some future change breaks that
    // invariant some other way (notes:155).
    assertAllRoomsReachable(grid, spawn, rooms, doors, keys);

    return {
      width: size,
      height: size,
      grid,
      visited,
      rooms,
      breakupRooms,
      spawn,
      multiplayerSpawns,
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

    // `connectRooms` only carves a corridor once a second room exists — a
    // level that ends up with a single room (an empty file, or one entity
    // whose room is the only one that fits) would otherwise get zero
    // corridors and a sealed, exit-less spawn room (notes:155). Top up to
    // at least 2 so that can never happen.
    while (rooms.length < 2) {
      const filler = this.placeFillerRoom(size, rooms, rng);
      carveRoom(grid, filler);
      rooms.push(filler);
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

  /**
   * A non-overlapping filler room, guaranteed to succeed — see `placeRooms`.
   * Tries normal random placement first (`tryPlaceRoom`); on the minimum
   * 64-tile map with only 1-2 rooms placed so far, that all but always
   * succeeds immediately. Falls back to whichever map corner doesn't
   * overlap an existing room (corners are always clear of interior rooms,
   * which stay off the outer border margin) so this can never itself fail
   * to produce a room.
   */
  private placeFillerRoom(size: number, placed: Room[], rng: () => number): Room {
    const random = this.tryPlaceRoom(FILLER_ENTITY, size, placed, rng);
    if (random) return random;

    const { w, h } = roomDimensions(FILLER_ENTITY, size);
    // `roomDimensions` always returns at least a 4-tile room regardless of
    // `size` — on a pathologically tiny configured map (well below any real
    // minSize this game ships with) that can exceed what the grid actually
    // has room for, putting a "bottom-right" corner at a negative
    // coordinate. Filtered out here rather than trusted blindly, so a
    // later `carveRoom` can never be handed an out-of-bounds room to write.
    const corners = [
      { x: 1, y: 1 },
      { x: size - w - 1, y: 1 },
      { x: 1, y: size - h - 1 },
      { x: size - w - 1, y: size - h - 1 },
    ].filter(({ x, y }) => x >= 0 && y >= 0 && x + w <= size && y + h <= size);
    for (const { x, y } of corners) {
      const candidate = makeRoom(x, y, w, h, FILLER_ENTITY);
      if (!placed.some((r) => roomsOverlap(candidate, r, this.opts.roomMargin))) {
        return candidate;
      }
    }
    // Every random attempt and every in-bounds corner overlapped — or, on an
    // extremely small configured map, no corner was even in-bounds at all.
    // Astronomically unlikely for any realistic map size. Clamp width/height
    // to whatever room the grid actually has, so this can never itself
    // produce an out-of-bounds room — accept a rare overlap/undersized
    // filler over leaving the level with under 2 rooms or crashing.
    const clampedW = Math.min(w, Math.max(1, size - 2));
    const clampedH = Math.min(h, Math.max(1, size - 2));
    return makeRoom(1, 1, clampedW, clampedH, FILLER_ENTITY);
  }
}

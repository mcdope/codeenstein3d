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
import { ACID_OVERFLOW_ENABLED, planAcidOverflows } from "./generation/acidOverflow";
import { dressCorridors } from "./generation/breakup";
import { connectLoops, connectRooms } from "./generation/corridors";
import { placeDoors, placeKeys } from "./generation/doorsKeys";
import { spawnEdgeCaseEnemies, spawnEnemies } from "./generation/enemies";
import { EXCEPTION_ZONES_ENABLED, placeExceptionZones } from "./generation/exceptionZones";
import {
  carveRoom,
  centeredRoom,
  clearCriticalTiles,
  growRoomCandidate,
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
import { styleSetFor } from "./generation/styleSet";
import { SWITCHBOARDS_ENABLED, placeSwitchboardEncounters, placeSwitchboards } from "./generation/switchboards";
import { placeTeleporters } from "./generation/teleporters";
import { VENDOR_DEPOTS_ENABLED, placeVendorDepots } from "./generation/vendorDepots";
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

/**
 * Per-level inputs to `generate()` — everything about *this* level and *this*
 * player's progress, as opposed to `MapGeneratorOptions`' generator-wide
 * tuning. Every field is optional and its default is the "plain single-player
 * level, nothing unlocked yet" case, so `generate(parsed)` stays meaningful on
 * its own.
 *
 * An options object rather than positional parameters: these grew one at a
 * time as features landed, and seven positional arguments — four of them
 * booleans — made every call site unreadable and trivially easy to
 * mis-order. Nothing about the *values* changed in that conversion, so no
 * generated map moved.
 */
export interface GenerateOptions {
  /**
   * Marks this as a "restock arena" (see `main.ts`, which sets it for
   * header/equivalent files): a distinct visual theme (handled by the
   * raycaster from the returned `GameMap.bonusLevel` flag) and a boosted
   * static-pickup rate, treating the level as a loot stop rather than a fight.
   */
  bonusLevel?: boolean;
  /**
   * Whether the player owns the rocket launcher. Mirrors the same gate applied
   * to enemy-kill drops (see `rollLoot` in `engine/loot.ts`): until they own
   * it, static rocket pickups would just be dead loot, so they're generated as
   * bullets/health instead.
   */
  hasRocketLauncher?: boolean;
  /**
   * `WEAPONS` indices the player doesn't own yet, feeding `placeSecretRooms`'
   * weapon-unlock loot slot — see that function's doc comment for why the map
   * layer only ever receives an opaque list of numbers here, never an
   * engine-layer weapon concept.
   */
  missingWeaponIndices?: readonly number[];
  /**
   * Requests extra, spread-out spawn points for a multiplayer session (see
   * `GameMap.multiplayerSpawns`). 1 (the default) preserves single-player
   * behavior exactly — `multiplayerSpawns` simply comes back `undefined`.
   */
  maxPlayers?: number;
  /** Whether the player owns gdb — gates whether a "Vendor Depot" may stock
   * its ammo pool, since a magazine for a gun they haven't unlocked is dead
   * loot. Same shape as `hasRocketLauncher` deliberately: the map layer never
   * learns what a weapon is, only whether a pool is worth stocking. */
  hasSmg?: boolean;
  /** Whether the player owns Friday Hotfix — see `hasSmg`. */
  hasGas?: boolean;
}

/** Defaults for one `generate()` call: a plain single-player level with
 * nothing unlocked. Spelled out as a `Required<>` record for the same reason
 * `DEFAULTS` below is — so a newly added option can't silently default to
 * `undefined` somewhere in the body. */
const GENERATE_DEFAULTS: Required<GenerateOptions> = {
  bonusLevel: false,
  hasRocketLauncher: true,
  missingWeaponIndices: [],
  maxPlayers: 1,
  hasSmg: true,
  hasGas: true,
};

const DEFAULTS: Required<MapGeneratorOptions> = {
  // Lowered from 64 alongside `mapSize`'s move to footprint-based sizing: a
  // short file's rooms now pack into one small cluster, and a 64-tile floor
  // left the smallest levels 94% solid rock — visible to the player on the
  // automap and in the exported map PNG, even though the raycaster never
  // renders it.
  minSize: 48,
  maxSize: 160,
  roomMargin: 1,
  placementAttempts: 200,
};

/**
 * Min/max rock left between a newly grown room and the anchor it hangs off
 * (see `tryGrowRoom`). This gap *is* the corridor between them, so it sets
 * corridor length directly — the whole point of growth placement is that the
 * distance between two consecutive rooms becomes a chosen number instead of
 * a side effect of where two uniform-random draws landed.
 *
 * The lower bound isn't cosmetic either. Every AST-driven carver
 * (`placeSecretRooms`, `placeVendorDepots`, `placeSwitchboards`,
 * `placeExceptionZones`) claims *untouched rock plus a one-tile margin* via
 * `sideCandidateFits`, so packing rooms flush against each other would starve
 * all four of them at once. `npm run report:level-maps` plus
 * `npm run verify:campaign` (which fails if a feature stops appearing
 * anywhere) are what confirm the budget is actually enough.
 */
const ROOM_GAP_MIN = 4;
const ROOM_GAP_MAX = 9;
/** Wall thickness kept between a grown room and *every* already-placed room —
 * deliberately larger than `roomMargin` (1), which only has to stop two rooms
 * from merging. Growth placement packs rooms far tighter than random
 * placement ever did, so without this the side-feature carvers above would
 * find no rock even where the anchor gap itself was generous. */
const ROOM_PACK_MARGIN = 3;
/** Side/gap combinations tried against one anchor room before falling back to
 * the next anchor. */
const GROW_ATTEMPTS_PER_ANCHOR = 24;
/** Jitter applied to the first room's position around the map center, so a
 * level doesn't always grow outward from the exact same tile. */
const FIRST_ROOM_JITTER = 6;

/** How far a packed room cluster spreads, as a multiple of the square root of
 * its summed room area — see `mapSize`, which calibrates it. */
const ROOM_SPREAD = 2.0;
/** Border of untouched rock kept beyond the room cluster, for the carvers
 * that can only claim rock (`sideCandidateFits`) — see `mapSize`. */
const ROCK_RESERVE = 10;

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
   * Turn one `ParsedFile` into a playable `GameMap`. See `GenerateOptions` for
   * what each per-level input means; omitting the argument entirely gives a
   * plain single-player level with nothing unlocked.
   */
  generate(parsed: ParsedFile, options: GenerateOptions = {}): GameMap {
    const { bonusLevel, hasRocketLauncher, missingWeaponIndices, maxPlayers, hasSmg, hasGas } = {
      ...GENERATE_DEFAULTS,
      ...options,
    };
    const rng = mulberry32(seedFrom(parsed));
    const size = this.mapSize(parsed);

    // Start fully solid; rooms and corridors carve empty space out of it.
    const grid: Tile[][] = Array.from({ length: size }, () =>
      new Array<Tile>(size).fill(1),
    );

    const rooms = this.placeRooms(parsed.entities, size, grid, rng);
    connectRooms(rooms, grid, rng);
    // The chain above is the spine and the reachability guarantee; this adds a
    // few shortcuts between rooms that ended up neighbours in space but not in
    // parse order, so the level has junctions and a way round instead of being
    // a pure dead-end tree. It only ever adds connectivity, so it runs before
    // everything that reads the finished grid.
    connectLoops(rooms, grid, rng);
    // Long, empty straight corridors read as boring "endless walk" filler —
    // interrupt any run past MAX_CORRIDOR_STRAIGHT_LENGTH with a small room
    // (or, failing that, a forced jog) right after the grid is fully carved,
    // since run length is a property of the whole grid, not any single leg.
    const breakupRooms = dressCorridors(grid, rooms, size, this.opts.roomMargin, rng);

    // AST-driven carving passes run here, last among everything that cuts new
    // space out of the map: each one only ever claims *untouched rock* (plus a
    // one-tile margin — see `sideCandidateFits`), which is a sufficient
    // overlap test against rooms, labyrinth interiors, corridors and breakup
    // rooms precisely because all of those have already been carved. They also
    // have to land before `placeTraps`, whose choke-point scan only considers
    // plain floor, so an exception zone's own hazard/spike tiles are excluded
    // from trap candidacy automatically. They all only ever turn rock into
    // floor, so they can never sever an existing route.
    const switchboardRooms = SWITCHBOARDS_ENABLED ? placeSwitchboards(rooms, grid, size, rng) : [];
    const exception = EXCEPTION_ZONES_ENABLED
      ? placeExceptionZones(rooms, grid, size, parsed.exceptionZones, rng, hasRocketLauncher)
      : { zones: [], hazards: [], spikeTraps: [], mines: [], pickups: [] };
    const vendor = VENDOR_DEPOTS_ENABLED
      ? placeVendorDepots(rooms[0], grid, size, parsed.importCount, rng, hasRocketLauncher, hasSmg, hasGas)
      : { depots: [], pickups: [] };

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
    // "Edge Case" enemies populate the corridor features exclusively — never
    // a normal room, and normal enemies never spawn in one.
    enemies.push(...spawnEdgeCaseEnemies(grid, breakupRooms, exit, rng));
    // Switchboard spokes get their minor encounter here, for the same reason
    // Edge Cases do: `spawn`/`exit` are final, `clearCriticalTiles` hasn't run
    // yet so any enemy tile still gets force-cleared, and everything produced
    // flows into `avoidPoints` below so every later floor-claiming system
    // steers around it.
    const switchboards = SWITCHBOARDS_ENABLED
      ? placeSwitchboardEncounters(switchboardRooms, grid, spawn, exit, rng)
      : { enemies: [], spikeTraps: [], mines: [], pickups: [] };
    enemies.push(...switchboards.enemies);
    // The exception zones' acid is already carved into the grid; it joins the
    // generation-time hazard list here so the corner minimap marks it too.
    const hazards = [...exception.hazards, ...fillHazards(rooms, grid, spawn, exit, multiplayerSpawns ?? [])];

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
      // A depot's mouth is a one-tile choke right next to spawn — exactly what
      // `placeTraps` looks for. Feeding the stock positions in here keeps
      // TRAP_SPACING between a trap and the alcove a player walks into in the
      // first seconds of a level (`decisions.md#hazard-placement-spawn-safety`).
      ...vendor.pickups.map((p) => ({ x: p.x, y: p.y })),
    ];
    placePillars(rooms, grid, avoidPoints, rng);
    // Decorative props are disabled for now (playtest feedback: they got in
    // the way / felt annoying). Generation + rendering code stays intact —
    // just flip DECORATIONS_ENABLED back on to revisit them.
    const decorations = DECORATIONS_ENABLED ? placeDecorations(rooms, grid, avoidPoints, rng) : [];

    // Lock private/protected-method rooms behind doors, then scatter one key
    // per door in areas reachable before that door (keeps every level solvable).
    const doors = placeDoors(rooms, grid);
    const keys = placeKeys(grid, spawn, exit, enemies, doors, breakupRooms, rng, exception.zones);

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
      ...switchboards.spikeTraps.map((t) => ({ x: t.x, y: t.y })),
      ...switchboards.mines.map((m) => ({ x: m.x, y: m.y })),
      ...switchboards.pickups.map((p) => ({ x: p.x, y: p.y })),
      ...exception.spikeTraps.map((t) => ({ x: t.x, y: t.y })),
      ...exception.mines.map((m) => ({ x: m.x, y: m.y })),
      ...exception.pickups.map((p) => ({ x: p.x, y: p.y })),
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
    const spikeTraps = [...generatedSpikeTraps, ...loreResult.todoTraps, ...switchboards.spikeTraps, ...exception.spikeTraps];
    const mines = [...generatedMines, ...loreResult.todoMines, ...switchboards.mines, ...exception.mines];

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
      ...vendor.pickups,
      ...switchboards.pickups,
      ...exception.pickups,
    ];

    // Acid Overflow planning goes dead last, for two reasons. It must see the
    // FINAL grid, so its candidate tiles are guaranteed to be plain floor that
    // nothing else claimed — that guarantee is what lets the runtime pass skip
    // `pendingGridDelta` entirely (see `AcidOverflow`'s doc comment). And it
    // draws zero rng, so appending it here perturbs nothing: a file with no
    // allocation-dense function generates a byte-identical map either way.
    //
    // `reserved` is the accumulated avoid-list plus every tile a system claimed
    // *without* marking the grid — mines and keys both sit on plain floor, so
    // the `grid[y][x] === 0` test alone genuinely isn't enough.
    const reserved = new Set<string>([
      ...ammoAvoid.map((p) => `${Math.floor(p.x)},${Math.floor(p.y)}`),
      ...ammoPickups.map((p) => `${Math.floor(p.x)},${Math.floor(p.y)}`),
      `${spawn.x},${spawn.y}`,
      `${exit.x},${exit.y}`,
    ]);
    const acidOverflows = ACID_OVERFLOW_ENABLED ? planAcidOverflows(rooms, grid, enemies, reserved) : [];

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
      styleSet: styleSetFor(parsed, bonusLevel),
      secretRoomCount: secretLoot.length,
      switchboardRooms,
      exceptionZones: exception.zones,
      vendorDepots: vendor.depots,
      acidOverflows,
    };
  }

  /** Square map size, floored at `minSize` and growing with LOC and entities. */
  private mapSize(parsed: ParsedFile): number {
    // Sized from the space the rooms will actually occupy, not from lines of
    // code. LOC was a reasonable proxy while rooms scattered across the whole
    // grid — the map had to be big enough that 200 random draws found gaps —
    // but once `tryGrowRoom` packs them into one connected cluster the level
    // only ever spans its own footprint, and keeping the old formula left
    // every level a small island in a mostly-empty square (measured: 3-14% of
    // the grid was floor, and the automap/export view showed it).
    //
    // `ROOM_SPREAD` is calibrated, not derived: across the demo campaign the
    // packed cluster's bounding side came out 1.56-2.72x the square root of
    // the summed room area, and the constant sits at 2.0, inside that band.
    // (This comment used to argue for 2.6; the constant has been 2.0 for long
    // enough that the campaign's current floor-density figures are measured
    // against it, so the prose was what went stale — but why it was retuned
    // isn't recorded anywhere, so this no longer claims a rationale it can't
    // support.) `ROCK_RESERVE` is the border the `sideCandidates` carvers need
    // on top — they only ever claim untouched rock, so a level squeezed to
    // exactly its own footprint would have nowhere to put a secret room or a
    // depot.
    const cap = Math.min(18, this.opts.maxSize - 2);
    const roomArea = parsed.entities.reduce((sum, entity) => {
      const { w, h } = roomDimensions(entity, cap + 2);
      return sum + w * h;
    }, 0);
    const raw = Math.round(ROOM_SPREAD * Math.sqrt(roomArea)) + ROCK_RESERVE;
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
      // Grow beside an already-placed room first; only fall back to the random
      // scan when nothing fits next to anything, and even then keep the result
      // as close to the previous room as the scan can manage.
      const room =
        this.tryGrowRoom(entity, size, rooms, rng) ??
        this.tryPlaceRoom(entity, size, rooms, rng, rooms.at(-1)?.center);
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

  /**
   * Place one entity's room *beside an already-placed room*, or `null` if no
   * side of any existing room has space for it.
   *
   * This is what bounds corridor length. `connectRooms` carves between the
   * centers of rooms `i-1` and `i`, so with the original uniform-random
   * placement the corridor between two consecutive entities was however far
   * apart two independent draws happened to land — measured across the demo
   * campaign that averaged 59 tiles and peaked at 191, against rooms only
   * 4-18 tiles wide, which is what made every level read as a few rooms
   * strung along enormous hallways. Growing room `i` off room `i-1` makes
   * that distance `ROOM_GAP_MIN..ROOM_GAP_MAX` plus the two half-widths, by
   * construction rather than by chance.
   *
   * Anchors are tried nearest-to-the-predecessor first for exactly that
   * reason: room `i-1` is the one `connectRooms` will carve to. The random
   * scan remains behind all of them as a last resort, so a dense map degrades
   * to the old behaviour for the odd room rather than dropping it.
   */
  private tryGrowRoom(
    entity: CodeEntity,
    size: number,
    placed: Room[],
    rng: () => number,
  ): Room | null {
    const { w, h } = roomDimensions(entity, size);
    if (size - w - 1 < 1 || size - h - 1 < 1) return null;

    // The seed room anchors the whole level, so it starts near the middle and
    // everything else grows outward from it — a level that started from a
    // random corner would sprawl against the border instead of spreading.
    if (placed.length === 0) {
      const jitter = (): number => Math.round((rng() * 2 - 1) * FIRST_ROOM_JITTER);
      const x = clamp(Math.floor((size - w) / 2) + jitter(), 1, size - w - 1);
      const y = clamp(Math.floor((size - h) / 2) + jitter(), 1, size - h - 1);
      return makeRoom(x, y, w, h, entity);
    }

    // Anchors ordered by how close they sit to the room this one will be
    // connected to. The predecessor itself is always first (distance 0), and
    // when it's boxed in the next-best anchor is its nearest neighbour rather
    // than merely the next-most-recent room — which could be anywhere on the
    // map, and would put a map-spanning leg back into the chain for exactly
    // the rooms that needed the fallback most.
    const target = placed[placed.length - 1].center;
    const anchors = [...placed].sort(
      (a, b) =>
        Math.abs(a.center.x - target.x) + Math.abs(a.center.y - target.y) -
        (Math.abs(b.center.x - target.x) + Math.abs(b.center.y - target.y)),
    );

    for (const anchor of anchors) {
      for (let attempt = 0; attempt < GROW_ATTEMPTS_PER_ANCHOR; attempt++) {
        const candidate = growRoomCandidate(anchor, w, h, size, ROOM_GAP_MIN, ROOM_GAP_MAX, rng);
        if (!candidate) continue;
        if (placed.some((r) => roomsOverlap(candidate, r, ROOM_PACK_MARGIN))) continue;
        return makeRoom(candidate.x, candidate.y, w, h, entity);
      }
    }
    return null;
  }

  /**
   * Find a non-overlapping spot for one entity's room by scanning random
   * positions, or `null`.
   *
   * With `nearestTo` set, every attempt in the budget is evaluated and the
   * fitting candidate closest to that point wins, instead of the first fit
   * returning immediately. That's the difference between a fallback and a
   * regression: this runs when `tryGrowRoom` found no side of any existing
   * room free, and taking the first random fit puts the room wherever the
   * draw landed — reintroducing exactly the map-spanning corridor leg growth
   * placement exists to prevent, for the one room that needed the fallback.
   * `placeFillerRoom` omits it and keeps the original first-fit behaviour,
   * since a filler room has no predecessor to stay near.
   */
  private tryPlaceRoom(
    entity: CodeEntity,
    size: number,
    placed: Room[],
    rng: () => number,
    nearestTo?: Point,
  ): Room | null {
    const { w, h } = roomDimensions(entity, size);
    // Keep rooms off the outer border so walls always enclose the level.
    const maxX = size - w - 1;
    const maxY = size - h - 1;
    if (maxX < 1 || maxY < 1) return null;

    let best: Room | null = null;
    let bestDistance = Infinity;
    for (let attempt = 0; attempt < this.opts.placementAttempts; attempt++) {
      const x = 1 + Math.floor(rng() * maxX);
      const y = 1 + Math.floor(rng() * maxY);
      const candidate = makeRoom(x, y, w, h, entity);
      if (placed.some((r) => roomsOverlap(candidate, r, this.opts.roomMargin))) continue;
      if (!nearestTo) return candidate;

      const distance = Math.abs(candidate.center.x - nearestTo.x) + Math.abs(candidate.center.y - nearestTo.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * A non-overlapping filler room, guaranteed to succeed — see `placeRooms`.
   * Tries normal random placement first (`tryPlaceRoom`); on the minimum-size
   * map (`DEFAULTS.minSize`, 48 tiles) with only 1-2 rooms placed so far, that
   * all but always succeeds immediately. Falls back to whichever map corner doesn't
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

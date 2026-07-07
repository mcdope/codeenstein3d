// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Map data types produced by the procedural generator and consumed by the
 * raycaster. Like the parser layer, these are plain serializable structures —
 * the generator turns `ParsedFile` JSON into this and nothing more.
 */
import type { CodeEntity } from "../parser/types";

/**
 * A grid cell: 0 = empty floor, 1 = wall, 2 = hazard (acid, walkable),
 * 3 = locked door (solid until opened with a key, then becomes 0),
 * 4 = goto/label teleporter pad (walkable; warps the player elsewhere),
 * 5 = timed spike trap (walkable; damages only while in its active phase),
 * 6 = fake wall hiding a secret room (solid and indistinguishable from a
 * normal wall until interacted with, then becomes 0 permanently),
 * 7 = lore terminal (solid; renders as a distinct glowing wall texture,
 * readable from an adjacent tile).
 */
export type Tile = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Tile value for a walkable hazard (acid pool) cell. */
export const HAZARD_TILE = 2;
/** Tile value for a locked door (blocks like a wall until a key opens it). */
export const DOOR_TILE = 3;
/** Tile value for a goto/label teleporter pad (walkable, not a wall). */
export const TELEPORTER_TILE = 4;
/** Tile value for a timed spike trap (walkable; see `SpikeTrap`). */
export const SPIKE_TRAP_TILE = 5;
/** Tile value for a fake wall hiding a secret room (solid; see `Tile`). */
export const SECRET_WALL_TILE = 6;
/** Tile value for a lore terminal wall (solid; see `Tile`). */
export const LORE_TILE = 7;

/** Tile coordinate (integer grid position). */
export interface Point {
  x: number;
  y: number;
}

/**
 * A rectangular room carved for one code entity. Coordinates are the top-left
 * tile; the room spans `[x, x+w)` × `[y, y+h)`. Keeps a back-reference to the
 * entity so later stages (enemies, bosses) can scale off its complexity.
 */
export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center tile, used for corridors and spawn. */
  center: Point;
  entity: CodeEntity;
}

/**
 * An enemy spawned for a code entity (a function or method). Lives at a
 * fractional tile position and carries HP scaled from the entity's complexity.
 */
export interface Enemy {
  /** World position in fractional tile units. */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /**
   * Seconds remaining before this enemy can melee the player again. Ticked
   * down by the engine's enemy AI each frame; 0 means "ready to bite". Starts
   * at 0. (Behaviour lives in src/engine/enemyAi.ts — this stays plain data.)
   */
  attackCooldown: number;
  /**
   * Frames remaining for which the sprite renders tinted red after being hit
   * (a "bleed" flash). Ticked down by the engine each frame; 0 = normal color.
   * Starts at 0.
   */
  hitFlash: number;
  /**
   * Origin room's walkable rectangle (tile units): the enemy roams only within
   * `[x, x+w) × [y, y+h)` while idle, so it never wanders out of its room.
   */
  home: { x: number; y: number; w: number; h: number };
  /**
   * Whether the enemy is in the chase state. Set once the player comes within
   * aggro range, or instantly when the enemy is shot ("damage aggro"). Sticky:
   * an aggroed enemy keeps chasing even after the player leaves aggro range.
   */
  aggroed: boolean;
  /**
   * Whether the player has ever physically entered this enemy's room (an AABB
   * intersection between the player's collision box and `home`). Sticky, once
   * true stays true. Gates whether the always-on HUD minimap draws this enemy
   * at all — see `renderMinimap` in `raycaster.ts`.
   */
  discovered: boolean;
  /** Current roam destination (world coords) while idle; re-picked on arrival. */
  roamX: number;
  roamY: number;
  /**
   * Seconds until this enemy may fire its next ranged bolt. Ticks down each
   * frame and resets after a shot; randomized on spawn so a pack doesn't volley
   * in unison. Only fires while chasing with line of sight to the player.
   */
  fireCooldown: number;
  /** The function/method this enemy represents. */
  entity: CodeEntity;
  /**
   * An "extreme complexity" function spawned as a single boss-tier enemy
   * instead of a multi-member pack: 4x HP, higher melee/ranged damage (see
   * `enemyAi.ts`), a larger sprite and a distinct tint (see `sprites.ts`), and
   * a guaranteed high-value drop on death instead of the normal loot roll.
   */
  elite: boolean;
}

/** The full generated level. */
export interface GameMap {
  width: number;
  height: number;
  /** Row-major grid; index as `grid[y][x]`. */
  grid: Tile[][];
  /**
   * Fog-of-war: `visited[y][x]` becomes true once the player has been on or
   * next to that tile. The automap only reveals visited tiles. Same dimensions
   * as `grid`; starts all-false.
   */
  visited: boolean[][];
  rooms: Room[];
  /** Player spawn, in a corner of the first room (clear of its enemy). */
  spawn: Point;
  /** Enemies to populate the rooms (one per function/method). */
  enemies: Enemy[];
  /** Exit tile (the `return` statement) in the room furthest from spawn. */
  exit: Point;
  /** BFS-shortest walkable tile distance from `spawn` to `exit` (doors count
   * as passable — a perfect run always ends up opening every one of them
   * anyway). The scoring system's path-efficiency bonus compares this against
   * how much ground the player actually covered (see `src/engine/scoring.ts`). */
  shortestPathTiles: number;
  /** Hazard (acid) tiles — one pool per global-variable room. */
  hazards: Point[];
  /** Locked-door tiles guarding private/protected-method rooms. */
  doors: Point[];
  /** Collectible dependency keys scattered in reachable public areas. */
  keys: KeyItem[];
  /** Cosmetic, non-blocking props scattered in larger rooms (set dressing). */
  decorations: Decoration[];
  /** Goto/label teleporter pads — one entry per pad, each pointing at its
   * paired pad's position. */
  teleporters: Teleporter[];
  /** Timed spike traps, procedurally placed at corridor choke points. */
  spikeTraps: SpikeTrap[];
  /** Proximity mines, procedurally placed at corridor choke points. */
  mines: Mine[];
  /**
   * Sparse, statically-placed pickups — a backup source, not the primary one
   * (spawn heap + enemy loot drops cover most of a run). Almost always
   * bullets/rockets scattered by `placeAmmoPickups`; also carries the
   * high-value health/rockets left inside a secret room by `placeSecretRooms`
   * (see `AmmoPickup.kind`). See `LootDrop` for the runtime, enemy-death
   * equivalent.
   */
  ammoPickups: AmmoPickup[];
  /**
   * Wall tiles rendered as glowing "lore terminals" (`LORE_TILE`), each
   * carrying the source comment it was generated from. Interacting with one
   * from an adjacent tile pauses the game and shows its text (see
   * `placeLoreTerminals` in `mapGenerator.ts`).
   */
  loreTerminals: LoreTerminal[];
  /**
   * True for a "bonus level" generated from a header (or equivalent) file: a
   * distinct visual theme and a boosted loot rate, treating it as a restock
   * arena rather than a normal combat level (see `placeAmmoPickups` and
   * `rollLoot`).
   */
  bonusLevel: boolean;
}

/** What a defeated enemy (or a scattered map pickup) can leave behind. */
export type LootKind = "bullets" | "rockets" | "health" | "swap" | "weapon";

/**
 * A dynamic loot drop left at a defeated enemy's death position. Spawned at
 * runtime by the engine and removed once the player walks over it — the
 * runtime counterpart to the map generator's statically-placed `AmmoPickup`.
 */
export interface LootDrop {
  /** World position in fractional tile units. */
  x: number;
  y: number;
  kind: LootKind;
  /** Overrides the kind's default pickup amount (elite kills drop more). Not
   * used for `"weapon"`. */
  amount?: number;
  /** For a `"weapon"` drop: which `WEAPONS` index it grants. */
  weaponIndex?: number;
}

/**
 * A sparse, statically-placed pickup scattered across the map at generation
 * time — a backup source, separate from enemy loot drops. `placeAmmoPickups`
 * only ever creates "bullets"/"rockets" ones; `placeSecretRooms` also drops a
 * single "health" or "rockets" pickup (a bigger amount, see
 * `SECRET_LOOT_HEALTH_AMOUNT`/`SECRET_LOOT_ROCKETS_AMOUNT`) inside each secret
 * room it carves, which is why the type covers more than just ammo.
 */
export interface AmmoPickup {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  kind: "bullets" | "rockets" | "health" | "swap";
  amount: number;
  collected: boolean;
}

/**
 * A glowing wall texture generated from a large source comment (see
 * `placeLoreTerminals` in `mapGenerator.ts`). Solid, like a normal wall —
 * interacting with it from an adjacent tile pauses the game and shows `text`.
 */
export interface LoreTerminal {
  /** Tile coordinates (integers) of the wall tile itself. */
  x: number;
  y: number;
  text: string;
}

/** A collectible "dependency key" (opens one locked door). */
export interface KeyItem {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  collected: boolean;
}

/** Visual flavor of a decorative prop; purely cosmetic, no gameplay effect. */
export type DecorKind = "rack" | "plant" | "desk" | "block";

/**
 * A cosmetic, non-blocking set-dressing sprite (server rack, potted plant,
 * desk, or abstract code-block) scattered in larger rooms so they don't feel
 * like an empty wasteland. Purely decorative: no collision, no interaction.
 */
export interface Decoration {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  kind: DecorKind;
}

/**
 * One pad of a bidirectional goto↔label teleporter pair, generated from a
 * `goto` statement and the label it jumps to (see `GotoLink`). Stepping onto
 * this pad's tile warps the player to (`targetX`, `targetY`) — the paired
 * pad's center. Each resolved goto link contributes two `Teleporter` entries,
 * one per pad, each pointing at the other.
 */
export interface Teleporter {
  /** World position in fractional tile units (this pad's tile center). */
  x: number;
  y: number;
  /** World position of the paired pad this one warps the player to. */
  targetX: number;
  targetY: number;
  /** The label name, for HUD/debug display. */
  label: string;
}

/**
 * A timed spike trap tile (grid value `SPIKE_TRAP_TILE`): alternates between a
 * safe first half and a damaging second half of each `period`-second cycle.
 * `phase` offsets that cycle per-trap so a level's traps don't all click in
 * unison. Always walkable — only the active half deals damage.
 */
export interface SpikeTrap {
  /** Tile coordinates (integers). */
  x: number;
  y: number;
  /** Full safe→active→safe cycle length, in seconds. */
  period: number;
  /** Per-trap offset into the cycle, in seconds. */
  phase: number;
}

/**
 * A proximity mine: invisible until the player lingers within its trigger
 * radius, then detonates for AoE damage if they don't back off in time.
 * One-shot — `alive` goes false forever once it detonates. Runtime behavior
 * lives in `src/engine/traps.ts`; this stays plain data.
 */
export interface Mine {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  /** False once detonated (consumed; no longer rendered or dangerous). */
  alive: boolean;
  /**
   * True once the player has come within the proximity radius at least once.
   * Sticky, like `Enemy.discovered` — a spotted mine stays visible even after
   * the player backs away.
   */
  visible: boolean;
  /** Seconds the player has been continuously within the proximity radius;
   * resets to 0 the moment they back out of it. Detonates on reaching the fuse
   * threshold — see `MINE_FUSE_SECONDS` in `traps.ts`. */
  closeTimer: number;
}

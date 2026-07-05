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
 * 3 = locked door (solid until opened with a key, then becomes 0).
 */
export type Tile = 0 | 1 | 2 | 3;

/** Tile value for a walkable hazard (acid pool) cell. */
export const HAZARD_TILE = 2;
/** Tile value for a locked door (blocks like a wall until a key opens it). */
export const DOOR_TILE = 3;

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
  /** The function/method this enemy represents. */
  entity: CodeEntity;
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
  /** Hazard (acid) tiles — one pool per global-variable room. */
  hazards: Point[];
  /** Locked-door tiles guarding private/protected-method rooms. */
  doors: Point[];
  /** Collectible dependency keys scattered in reachable public areas. */
  keys: KeyItem[];
}

/** A collectible "dependency key" (opens one locked door). */
export interface KeyItem {
  /** World position in fractional tile units (tile center). */
  x: number;
  y: number;
  collected: boolean;
}

/**
 * A heap (ammo) pickup dropped by a defeated enemy at its death position.
 * Spawned at runtime by the engine and removed once the player walks over it.
 */
export interface AmmoDrop {
  /** World position in fractional tile units. */
  x: number;
  y: number;
}

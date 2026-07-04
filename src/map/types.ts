// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Map data types produced by the procedural generator and consumed by the
 * raycaster. Like the parser layer, these are plain serializable structures —
 * the generator turns `ParsedFile` JSON into this and nothing more.
 */
import type { CodeEntity } from "../parser/types";

/** A grid cell: 0 = empty floor, 1 = wall, 2 = hazard (acid, walkable). */
export type Tile = 0 | 1 | 2;

/** Tile value for a walkable hazard (acid pool) cell. */
export const HAZARD_TILE = 2;

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
  /** The function/method this enemy represents. */
  entity: CodeEntity;
}

/** The full generated level. */
export interface GameMap {
  width: number;
  height: number;
  /** Row-major grid; index as `grid[y][x]`. */
  grid: Tile[][];
  rooms: Room[];
  /** Player spawn, in a corner of the first room (clear of its enemy). */
  spawn: Point;
  /** Enemies to populate the rooms (one per function/method). */
  enemies: Enemy[];
  /** Exit tile (the `return` statement) in the room furthest from spawn. */
  exit: Point;
  /** Hazard (acid) tiles — one pool per global-variable room. */
  hazards: Point[];
}

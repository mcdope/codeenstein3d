/**
 * Map data types produced by the procedural generator and consumed by the
 * raycaster. Like the parser layer, these are plain serializable structures —
 * the generator turns `ParsedFile` JSON into this and nothing more.
 */
import type { CodeEntity } from "../parser/types";

/** A grid cell: 0 = empty (walkable), 1 = wall. */
export type Tile = 0 | 1;

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

/** The full generated level. */
export interface GameMap {
  width: number;
  height: number;
  /** Row-major grid; index as `grid[y][x]`. */
  grid: Tile[][];
  rooms: Room[];
  /** Player spawn, at the center of the first room. */
  spawn: Point;
}

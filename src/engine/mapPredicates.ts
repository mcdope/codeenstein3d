// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The tile questions everything asks: is this cell solid, does it hurt, can a
 * route be planned through it, and can one point see another.
 *
 * **Why they live here.** Until now each of these existed twice — once in the
 * engine and once, re-typed in plain JavaScript, in the playtest bot under
 * `scripts/lib/`. Two of the three tile sets were byte-for-byte identical and
 * nothing in the build compared them. That is not a hypothetical cost: the
 * demo-campaign L6 wedge (fixed 2026-08-18, open eleven days across seven
 * wrong root causes) was exactly this — the bot's sight test was built on its
 * *route planner's* passability rule, so closed doors were transparent to it
 * and it spent whole levels shooting at enemies no bullet of its could reach.
 * `combatConstants.ts` records the same class of failure paid for once
 * already, with a mirrored `ROCKET_TRAVEL_SPEED` wrong by 3.6x.
 *
 * **The import rule this module must keep, and why it is not the one the docs
 * state.** Several docs say `src/` and `scripts/` cannot share code because
 * "`src/` cannot import from `scripts/`". True, but backwards: `scripts/`
 * imports *this*. Node (>=22.18, and this repo's floor is `^22.22.2`) strips
 * TypeScript types natively, so a plain `.mjs` can import a `.ts` module —
 * but Node ESM does no extensionless resolution, so any **value** import here
 * must carry an explicit `.ts` extension. `tsconfig.json` already sets
 * `allowImportingTsExtensions`, so the same specifier satisfies Vite, Vitest
 * and tsc. A `import type` is erased before resolution and needs nothing.
 *
 * So the standing rule for this file: **no value import without an explicit
 * extension, and no DOM.** `constantMirrors.test.mjs` enforces it by importing
 * this module in a real `node` subprocess — Vitest resolves through Vite and
 * would happily pass on a module plain Node can no longer load.
 *
 * **Two coordinate conventions, on purpose.** The engine asks about integer
 * cells (`isWall(map, cx, cy)`); the bot asks about the fractional position a
 * body is standing at. Rather than make one side convert at every call site,
 * both are exported, the `*At` pair being the flooring wrappers. One
 * implementation each.
 */
import { BRANCH_DOOR_TILE, DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE } from "../map/types.ts";
import type { GameMap } from "../map/types";

/**
 * Anything with a `grid` — the engine passes a real `GameMap`, the bot's unit
 * tests and its own snapshots pass bare `{grid}` objects that carry no
 * `width`/`height`. Bounds are therefore read off the grid itself rather than
 * off `map.width`/`map.height`: the generator sets both to the same `size`
 * (`mapGenerator.ts:410`), so this is equivalent for a real map and merely
 * survives the ones that omit the fields.
 */
type GridLike = Pick<GameMap, "grid"> | { grid: readonly (readonly number[])[] };

/**
 * The solid tile values, as a set — for callers that already hold a tile value
 * and want membership rather than a grid lookup (the BFS in `pathfind.mjs`,
 * the lateral-step check in `combatPolicy.mjs`). Both of those previously
 * carried their own `new Set([1, 3, 6, 7, 8])` literal.
 *
 * `isWall` below deliberately does **not** use this, and that is measured
 * rather than assumed: over 2.6M lookups a `Set.has` costs **3.0x** an
 * explicit comparison chain (20.4ms vs 6.7ms on this machine). `isWall` runs
 * per enemy per AI tick and again per ~0.1-tile sample inside
 * `hasLineOfSight`, so it keeps the chain. `solidTilesMatchIsWall` in
 * `mapPredicates.test.ts` pins the two representations against each other, so
 * the split cannot drift the way the two hand-typed copies could.
 */
export const SOLID_TILES: ReadonlySet<number> = new Set([1, DOOR_TILE, SECRET_WALL_TILE, LORE_TILE, BRANCH_DOOR_TILE]);

/** A cell is solid if it is out of bounds, or a wall (1), still-locked door
 * (3), unopened fake wall (6), lore terminal wall (7) or unopened branch door
 * (8). Acid (2) and floor (0) are not — a branch door needs no key, but it
 * still has to be pushed open before anyone walks through it.
 *
 * This is what a *body or a bullet* hits, and therefore also what blocks
 * sight. */
export function isWall(map: GridLike, cx: number, cy: number): boolean {
  const tile = map.grid[cy]?.[cx];
  return (
    tile === undefined ||
    tile === 1 ||
    tile === DOOR_TILE ||
    tile === SECRET_WALL_TILE ||
    tile === LORE_TILE ||
    tile === BRANCH_DOOR_TILE
  );
}

/**
 * Solid to a *route planner*, which is a strictly smaller set: a door is
 * passable terrain to something that can walk up and open it, so only walls
 * (1), unopened fake walls (6) and lore terminal walls (7) block.
 *
 * This is the one genuine divergence between the bot's view of the map and the
 * engine's, and it is deliberate — the route planner tracks `openedDoors`
 * separately. Do not collapse it into `isWall`; that is the bug the L6 wedge
 * was.
 */
export function isRouteBlocking(map: GridLike, cx: number, cy: number): boolean {
  const tile = map.grid[cy]?.[cx];
  return tile === undefined || tile === 1 || tile === SECRET_WALL_TILE || tile === LORE_TILE;
}

/** True if the cell is a hazard (acid) tile — walkable, but it drains health.
 * Out of bounds is *not* a hazard (unlike `isWall`, where it is solid). */
export function isHazard(map: GridLike, cx: number, cy: number): boolean {
  return map.grid[cy]?.[cx] === HAZARD_TILE;
}

/** `isWall` at a fractional world position. */
export function isWallAt(map: GridLike, x: number, y: number): boolean {
  return isWall(map, Math.floor(x), Math.floor(y));
}

/** `isRouteBlocking` at a fractional world position. */
export function isRouteBlockingAt(map: GridLike, x: number, y: number): boolean {
  return isRouteBlocking(map, Math.floor(x), Math.floor(y));
}

/** `isHazard` at a fractional world position. */
export function isHazardAt(map: GridLike, x: number, y: number): boolean {
  return isHazard(map, Math.floor(x), Math.floor(y));
}

/**
 * AABB-vs-grid test: does a box of half-width `radius` centered at (px,py)
 * overlap any solid cell? Shared by the player and the enemy AI so both
 * resolve collisions against the tile matrix identically.
 */
export function collidesWithWall(map: GridLike, px: number, py: number, radius: number): boolean {
  const minX = Math.floor(px - radius);
  const maxX = Math.floor(px + radius);
  const minY = Math.floor(py - radius);
  const maxY = Math.floor(py + radius);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (isWall(map, cx, cy)) return true;
    }
  }
  return false;
}

/**
 * Can (x0,y0) see (x1,y1)? Samples every ~0.1 tiles and fails on the first
 * solid cell.
 *
 * `sealedCorner` is the one behavioural difference between the two callers,
 * and it is now an argument rather than a second implementation:
 *
 * - **`false` (the engine, `enemyAi.ts`)** — plain point sampling. This is
 *   what decides whether an enemy notices the player, and widening it would
 *   change aggro, which is a gameplay change and wants its own A/B. Left
 *   exactly as it was.
 * - **`true` (the bot)** — additionally blocks when the ray changes cell
 *   *diagonally* and **both** flanking tiles are solid. Point sampling alone
 *   leaks through lattice corners: a ray passing exactly through the point
 *   where four tiles meet steps from one diagonal cell to the other without
 *   ever landing inside the two wedged between them, and reports a clear view
 *   through what is, to a bullet, a solid corner. Denser sampling cannot fix
 *   it — the corner is a single point, so a ray through it lands inside
 *   neither tile at any resolution.
 *
 *   Measured on demo-campaign L6: bot at (14.20,50.20), enemy at (13.7,49.7),
 *   an exact 45 degrees crossing (14.0,50.0) dead on, so samples stepped
 *   (14,50) -> (13,49) and skipped both the wall at (13,50) and the closed
 *   door at (14,49).
 *
 *   **Both** flanking tiles, not either. Blocking on *either* was measured far
 *   too strict — it made a blocker standing diagonally in a doorway
 *   unshootable, so `driveToExit`'s hunt drove at it forever without ever
 *   firing, and both `verify (multiplayer-transition)` and
 *   `verify (Playwright/webkit)` hit their CI timeouts. A corner with one
 *   solid and one open tile is a diagonal graze the engine lets through: it
 *   occludes sprites with the render z-buffer, not a tile test, so an enemy
 *   diagonally past a single wall corner is on screen and hittable.
 */
export function hasLineOfSight(
  map: GridLike,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sealedCorner = false,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.1); // sample every ~0.1 tiles
  let px = Math.floor(x0);
  let py = Math.floor(y0);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = x0 + dx * t;
    const sy = y0 + dy * t;
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    if (sealedCorner && cx !== px && cy !== py && isWall(map, cx, py) && isWall(map, px, cy)) return false;
    px = cx;
    py = cy;
    if (isWall(map, cx, cy)) return false;
  }
  return true;
}

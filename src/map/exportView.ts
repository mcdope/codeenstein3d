// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Player-facing top-down level export, shown once a level is won (see
 * `main.ts`'s "Export Map as PNG" button). Unlike `debugView.ts`'s flat
 * black/white diagnostic grid, this stamps the *actual* wall/door/floor/
 * hazard/teleporter/spike/lore-terminal textures the raycaster rendered
 * that session (procedural defaults, or a loaded WAD's real textures) —
 * a visually accurate rendering of the level, just viewed from above,
 * meant to look good enough to share rather than only to debug generation.
 *
 * `MapGenerator` allocates a full `size × size` grid of solid wall
 * (`mapGenerator.ts`), then carves rooms/corridors out of it — a player
 * never sees most of that filler in first-person play (the raycaster only
 * renders what's actually reachable/visible), but a naive top-down export
 * would paint all of it. This renderer only draws a wall tile if it's
 * within one tile of real content, and crops the output to the bounding
 * box of what actually gets drawn, so the image is the level, not a mostly-
 * empty rectangle of repeated wall texture around a small maze.
 */
import type { GameMap, Tile } from "./types";
import { DOOR_TILE, HAZARD_TILE, LORE_TILE, SECRET_WALL_TILE, SPIKE_TRAP_TILE, TELEPORTER_TILE } from "./types";
import type { TextureBitmap, TextureSet } from "../engine/textures";

export interface ExportViewOptions {
  /** Target on-screen size (px) for the longest map dimension. */
  targetPixels?: number;
  /** Minimum/maximum tile size in pixels — kept larger than debugView's own
   * defaults so a stamped texture still reads as a texture rather than
   * blurring into an unrecognizable average color at a tiny cell size. */
  minCell?: number;
  maxCell?: number;
}

const DEFAULTS: Required<ExportViewOptions> = {
  targetPixels: 1200,
  minCell: 16,
  maxCell: 48,
};

/** True for a tile that's solid *filler* — `MapGenerator`'s default-wall
 * background, not a wall a player could ever actually walk up to and see.
 * `SECRET_WALL_TILE` is included: an *unopened* secret is indistinguishable
 * from a plain wall (by design), so it's exactly as much "real border" or
 * "filler" as the wall around it would be. */
function isWallLike(tile: Tile): boolean {
  return tile === 1 || tile === SECRET_WALL_TILE;
}

/** A wall-like tile is "real border" (kept) if any of its 8 neighbors is
 * non-wall-like content — i.e. a player could actually stand next to it and
 * see its face. Anything else is filler, dropped entirely (left transparent
 * — the canvas's own default, no fill needed). Content tiles themselves are
 * always kept regardless of this check. */
function isRealBorder(map: GameMap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const ny = y + dy;
      const nx = x + dx;
      if (ny < 0 || ny >= map.height || nx < 0 || nx >= map.width) continue;
      if (!isWallLike(map.grid[ny][nx])) return true;
    }
  }
  return false;
}

/** Whether tile `(x, y)` should be drawn at all. */
function shouldDraw(map: GameMap, x: number, y: number): boolean {
  const tile = map.grid[y][x];
  return !isWallLike(tile) || isRealBorder(map, x, y);
}

/** Which texture a given (already `shouldDraw`-confirmed) tile renders
 * with — mirrors `raycaster.ts`'s own wall-hit/floor-cast texture
 * selection exactly, so the export matches what the player actually saw
 * in first-person. An unopened secret wall (`SECRET_WALL_TILE`)
 * intentionally resolves the same as a plain wall — it's meant to be
 * indistinguishable until interacted with; an *opened* one is already
 * tile `0` (floor) in `map.grid` by the time a level is won, so it falls
 * through to the floor case automatically, no special-casing needed.
 * Spike traps always render their resting-state texture — there's no
 * "currently mid-blink" state worth freezing in a static export. */
function textureFor(tile: Tile, bonusLevel: boolean, textureSet: TextureSet): TextureBitmap {
  switch (tile) {
    case DOOR_TILE:
      return textureSet.door;
    case LORE_TILE:
      return textureSet.loreWall;
    case TELEPORTER_TILE:
      return textureSet.teleporterFloor;
    case HAZARD_TILE:
      return textureSet.hazardFloor;
    case SPIKE_TRAP_TILE:
      return textureSet.spikeSafeFloor;
    case 1:
    case SECRET_WALL_TILE:
      return bonusLevel ? textureSet.bonusWall : textureSet.wall;
    default:
      return bonusLevel ? textureSet.bonusFloor : textureSet.floor;
  }
}

interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Tight bounding box of every tile `shouldDraw` keeps — content plus its
 * 1-tile wall border ring, and nothing more, since `isRealBorder` has
 * already done the "how much border" job; no further padding is added on
 * top of it. Seeded with `map.spawn` so it's never empty (the spawn tile
 * is always real, walkable content). */
function computeBoundingBox(map: GameMap): BoundingBox {
  const box: BoundingBox = { minX: map.spawn.x, minY: map.spawn.y, maxX: map.spawn.x, maxY: map.spawn.y };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!shouldDraw(map, x, y)) continue;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }
  }
  return box;
}

/** Render `map` into a new canvas element, textured with `textureSet`
 * (pass `textures.getActiveSet()` for "what the player was actually
 * seeing"), cropped to the level's actual content, and return it. */
export function renderExportMap(map: GameMap, textureSet: TextureSet, options: ExportViewOptions = {}): HTMLCanvasElement {
  const opts = { ...DEFAULTS, ...options };
  const box = computeBoundingBox(map);
  const boxWidth = box.maxX - box.minX + 1;
  const boxHeight = box.maxY - box.minY + 1;
  const cell = clamp(Math.floor(opts.targetPixels / Math.max(boxWidth, boxHeight)), opts.minCell, opts.maxCell);

  const canvas = document.createElement("canvas");
  canvas.width = boxWidth * cell;
  canvas.height = boxHeight * cell;
  canvas.className = "export-map";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  for (let y = box.minY; y <= box.maxY; y++) {
    const row = map.grid[y];
    for (let x = box.minX; x <= box.maxX; x++) {
      if (!shouldDraw(map, x, y)) continue;
      const bitmap = textureFor(row[x], map.bonusLevel, textureSet);
      ctx.drawImage(bitmap.canvas, (x - box.minX) * cell, (y - box.minY) * cell, cell, cell);
    }
  }

  drawMarker(ctx, map.spawn.x - box.minX, map.spawn.y - box.minY, cell, "#e21b1b");
  drawMarker(ctx, map.exit.x - box.minX, map.exit.y - box.minY, cell, "#41ff6e");

  return canvas;
}

/** A small filled circle centered on a tile — used for the spawn/exit
 * orientation markers. Deliberately minimal (no labels, no icons) so it
 * reads as a map pin rather than a HUD element competing with the textured
 * render underneath. */
function drawMarker(ctx: CanvasRenderingContext2D, tileX: number, tileY: number, cell: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc((tileX + 0.5) * cell, (tileY + 0.5) * cell, Math.max(2, cell * 0.3), 0, Math.PI * 2);
  ctx.fill();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

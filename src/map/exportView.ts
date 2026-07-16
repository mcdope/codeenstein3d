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

/** Which texture a given tile renders with — mirrors `raycaster.ts`'s own
 * wall-hit/floor-cast texture selection exactly, so the export matches what
 * the player actually saw in first-person. An unopened secret wall
 * (`SECRET_WALL_TILE`) intentionally resolves the same as a plain wall —
 * it's meant to be indistinguishable until interacted with; an *opened* one
 * is already tile `0` (floor) in `map.grid` by the time a level is won, so
 * it falls through to the floor case automatically, no special-casing
 * needed. Spike traps always render their resting-state texture — there's
 * no "currently mid-blink" state worth freezing in a static export. */
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

/** Render `map` into a new canvas element, textured with `textureSet`
 * (pass `textures.getActiveSet()` for "what the player was actually
 * seeing"), and return it. */
export function renderExportMap(map: GameMap, textureSet: TextureSet, options: ExportViewOptions = {}): HTMLCanvasElement {
  const opts = { ...DEFAULTS, ...options };
  const cell = clamp(
    Math.floor(opts.targetPixels / Math.max(map.width, map.height)),
    opts.minCell,
    opts.maxCell,
  );

  const canvas = document.createElement("canvas");
  canvas.width = map.width * cell;
  canvas.height = map.height * cell;
  canvas.className = "export-map";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      const bitmap = textureFor(row[x], map.bonusLevel, textureSet);
      ctx.drawImage(bitmap.canvas, x * cell, y * cell, cell, cell);
    }
  }

  drawMarker(ctx, map.spawn.x, map.spawn.y, cell, "#e21b1b");
  drawMarker(ctx, map.exit.x, map.exit.y, cell, "#41ff6e");

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

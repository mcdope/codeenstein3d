/**
 * Top-down debug renderer for a `GameMap`.
 *
 * Draws the raw tile grid (black = wall, white = empty) into a fresh <canvas>
 * and marks the player spawn with a red dot. This is a temporary diagnostic
 * view for the map generator — the real game is rendered by the raycaster.
 */
import type { GameMap } from "./types";

export interface DebugViewOptions {
  /** Target on-screen size (px) for the longest map dimension. */
  targetPixels?: number;
  /** Minimum/maximum tile size in pixels. */
  minCell?: number;
  maxCell?: number;
}

const DEFAULTS: Required<DebugViewOptions> = {
  targetPixels: 640,
  minCell: 3,
  maxCell: 12,
};

/** Render `map` into a new canvas element and return it. */
export function renderDebugMap(map: GameMap, options: DebugViewOptions = {}): HTMLCanvasElement {
  const opts = { ...DEFAULTS, ...options };
  const cell = clamp(
    Math.floor(opts.targetPixels / Math.max(map.width, map.height)),
    opts.minCell,
    opts.maxCell,
  );

  const canvas = document.createElement("canvas");
  canvas.width = map.width * cell;
  canvas.height = map.height * cell;
  canvas.className = "debug-map";

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Empty background, then paint walls as black squares.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (row[x] === 1) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // Player spawn: red dot centered on its tile.
  ctx.fillStyle = "#e21b1b";
  ctx.beginPath();
  ctx.arc(
    (map.spawn.x + 0.5) * cell,
    (map.spawn.y + 0.5) * cell,
    Math.max(2, cell * 0.45),
    0,
    Math.PI * 2,
  );
  ctx.fill();

  return canvas;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

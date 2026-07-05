// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The automap: a full-screen, togglable 2D overlay of the level drawn in neon
 * green, revealing only the tiles the player has already explored (fog of war).
 * A solid triangle marks the player's position and facing. Pure Canvas 2D — the
 * engine pauses the sim while this is up.
 */
import { DOOR_TILE, type GameMap } from "../map/types";
import type { Player } from "./player";

/** Neon green for explored walls / the map frame. */
const WALL_COLOR = "#39ff14";
/** Cold steel-blue for explored, still-locked doors. */
const DOOR_COLOR = "#57c7ff";
/** Faint wash marking explored open floor. */
const FLOOR_COLOR = "rgba(57,255,20,0.10)";

/**
 * Draw the automap centered over the canvas: a dark scrim, then the explored
 * walls/rooms and the player marker. Only tiles with `map.visited` set are
 * shown.
 */
export function drawAutomap(ctx: CanvasRenderingContext2D, map: GameMap, player: Player): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  // Dim the frozen 3D scene behind the map.
  ctx.fillStyle = "rgba(0,10,4,0.78)";
  ctx.fillRect(0, 0, width, height);

  // Fit the whole grid into a centered region, capping cell size on small maps.
  const cell = Math.max(1, Math.min(14, Math.floor(Math.min((width * 0.86) / map.width, (height * 0.8) / map.height))));
  const mapW = map.width * cell;
  const mapH = map.height * cell;
  const ox = Math.floor((width - mapW) / 2);
  const oy = Math.floor((height - mapH) / 2);

  // Explored tiles only.
  for (let y = 0; y < map.height; y++) {
    const visitedRow = map.visited[y];
    const tileRow = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (!visitedRow[x]) continue;
      const tile = tileRow[x];
      const px = ox + x * cell;
      const py = oy + y * cell;
      if (tile === 1) {
        ctx.fillStyle = WALL_COLOR;
        ctx.fillRect(px, py, cell, cell);
      } else if (tile === DOOR_TILE) {
        ctx.fillStyle = DOOR_COLOR;
        ctx.fillRect(px, py, cell, cell);
      } else {
        ctx.fillStyle = FLOOR_COLOR;
        ctx.fillRect(px, py, cell, cell);
      }
    }
  }

  // Exit tile, once discovered.
  if (map.visited[map.exit.y]?.[map.exit.x]) {
    ctx.fillStyle = "#8effa0";
    const ex = ox + map.exit.x * cell;
    const ey = oy + map.exit.y * cell;
    ctx.fillRect(ex, ey, Math.max(3, cell), Math.max(3, cell));
  }

  // Neon frame around the map area.
  ctx.strokeStyle = "rgba(57,255,20,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - 0.5, oy - 0.5, mapW + 1, mapH + 1);

  drawPlayerMarker(ctx, player, ox, oy, cell);

  // Title.
  ctx.fillStyle = WALL_COLOR;
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("AUTOMAP — TAB TO CLOSE", width / 2, Math.max(16, oy - 8));
  ctx.textAlign = "start";
}

/** Solid triangle at the player's exact position, pointing along their facing. */
function drawPlayerMarker(
  ctx: CanvasRenderingContext2D,
  player: Player,
  ox: number,
  oy: number,
  cell: number,
): void {
  const px = ox + player.posX * cell;
  const py = oy + player.posY * cell;
  const angle = Math.atan2(player.dirY, player.dirX);
  const size = Math.max(6, cell * 1.6);

  ctx.fillStyle = "#ffd23f";
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(angle) * size, py + Math.sin(angle) * size);
  ctx.lineTo(px + Math.cos(angle + 2.5) * size * 0.7, py + Math.sin(angle + 2.5) * size * 0.7);
  ctx.lineTo(px + Math.cos(angle - 2.5) * size * 0.7, py + Math.sin(angle - 2.5) * size * 0.7);
  ctx.closePath();
  ctx.fill();
}

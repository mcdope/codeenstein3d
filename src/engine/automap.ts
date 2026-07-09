// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The automap: a togglable 2D overlay of the level, revealing only the tiles
 * the player has already explored (fog of war). Pure Canvas 2D, drawn as a
 * late-stage overlay each frame — the sim keeps running while this is up
 * (movement, combat, hazards all continue, Diablo-style), it's not a pause
 * screen. The view is a fixed-cell-size viewport centered on and panning with
 * the player (clamped to the map's bounds), not a shrink-to-fit of the whole
 * grid — that kept large maps illegible and always letterboxed the (always
 * square) grid inside the landscape canvas.
 */
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
} from "../map/types";
import { activeSpikeTileKeys } from "./traps";
import type { Player } from "./player";
import { HUD_HEIGHT } from "./hud";

/** Fixed tile size in canvas pixels — independent of map size, so large maps
 * stay just as readable as small ones (the old fit-to-box math shrank as low
 * as ~2px/tile on big levels). Zoomed well out relative to a "1:1" 10px/tile
 * read, so a given viewport shows a wide swath of the map at once. */
const CELL_PX = 3;
/** Margin kept clear on the left/right/top/bottom of the viewport. */
const MARGIN = 12;

/** Structural/navigational tiles render in muted greyscale, Diablo-style, so
 * the map doesn't visually fight the live world still rendering around it.
 * Only danger/goal tiles keep a distinct accent color (see below). */
const WALL_COLOR = "#c8c8ce";
/** Explored, still-locked doors — a cooler mid-grey, distinguishable from
 * plain wall by tone alone. */
const DOOR_COLOR = "#9aa0ab";
/** Explored goto/label teleporter pads — brightest of the structural tones so
 * they still stand out for navigation despite being desaturated. */
const TELEPORTER_COLOR = "#e8eaf0";
/** Lore terminal walls — a mid grey, distinct in tone from wall/door/teleporter. */
const LORE_COLOR = "#b4b8ba";
/** Faint wash marking explored open floor. */
const FLOOR_COLOR = "rgba(200,200,210,0.08)";

/** Spike trap: dull metal when safe, hot red when active — kept as a danger
 * accent (unchanged from before the greyscale restyle). */
const SPIKE_SAFE_COLOR = "#8a8a90";
const SPIKE_ACTIVE_COLOR = "#e02818";
/** Hazard (acid) tiles — same hot, non-green accent as the HUD minimap, kept
 * distinct so danger reads at a glance even in an otherwise grey map. */
const HAZARD_COLOR = "#ff9d1f";
/** Discovered, still-live proximity mines — danger accent. */
const MINE_COLOR = "#ff5050";
/** Exit tile, once discovered — goal accent, matching the corner minimap's
 * exit-pulse hue family. */
const EXIT_COLOR = "#41ff6e";
/** Player marker — the one warm, unambiguous color so it never blends into
 * either the grey terrain or the red/orange/green accents. */
const PLAYER_COLOR = "#ffd23f";

/**
 * Draw the automap as a translucent viewport overlay filling the available
 * area (margin + bottom HUD strip reserved), so most of the live game stays
 * dimly visible through it. Shows explored tiles in a fixed-size grid that
 * pans to keep the player roughly centered (clamped so it never scrolls past
 * the map's edges — same idea as Diablo's map). Only tiles with
 * `map.visited` set are shown.
 */
export function drawAutomap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  levelTime = 0,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  const vx0 = MARGIN;
  const vy0 = MARGIN;
  const viewW = Math.max(1, width - MARGIN * 2);
  const viewH = Math.max(1, height - HUD_HEIGHT - MARGIN * 2);
  const viewTilesW = viewW / CELL_PX;
  const viewTilesH = viewH / CELL_PX;

  // Camera top-left corner, in fractional tile units: centered on the player
  // by default, clamped per-axis to the map's bounds — but centered on that
  // axis instead when the map is smaller than the viewport there, since the
  // clamp range would otherwise be invalid (negative).
  const camX =
    map.width <= viewTilesW
      ? (map.width - viewTilesW) / 2
      : Math.max(0, Math.min(player.posX - viewTilesW / 2, map.width - viewTilesW));
  const camY =
    map.height <= viewTilesH
      ? (map.height - viewTilesH) / 2
      : Math.max(0, Math.min(player.posY - viewTilesH / 2, map.height - viewTilesH));

  ctx.save();
  ctx.beginPath();
  ctx.rect(vx0, vy0, viewW, viewH);
  ctx.clip();

  // Translucent panel behind the map, Diablo-style — the live 3D scene stays
  // clearly visible through it rather than being mostly hidden.
  ctx.fillStyle = "rgba(0,5,2,0.35)";
  ctx.fillRect(vx0, vy0, viewW, viewH);

  const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);

  // Only the tile range that can actually be visible in the viewport.
  const tileX0 = Math.max(0, Math.floor(camX));
  const tileY0 = Math.max(0, Math.floor(camY));
  const tileX1 = Math.min(map.width, Math.ceil(camX + viewTilesW));
  const tileY1 = Math.min(map.height, Math.ceil(camY + viewTilesH));

  for (let y = tileY0; y < tileY1; y++) {
    const visitedRow = map.visited[y];
    const tileRow = map.grid[y];
    for (let x = tileX0; x < tileX1; x++) {
      if (!visitedRow[x]) continue;
      const tile = tileRow[x];
      const px = vx0 + (x - camX) * CELL_PX;
      const py = vy0 + (y - camY) * CELL_PX;
      if (tile === 1 || tile === SECRET_WALL_TILE) {
        // An unopened secret wall is indistinguishable from a plain wall
        // here on purpose — the automap must not spoil its location before
        // the player actually finds/opens it. The one intended discovery
        // hint is the much subtler in-view tint (`secretWallTint` in
        // raycaster.ts); once opened, the tile becomes plain floor (0) and
        // falls through to the ordinary floor branch below like any other
        // explored room.
        ctx.fillStyle = WALL_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === LORE_TILE) {
        ctx.fillStyle = LORE_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === DOOR_TILE) {
        ctx.fillStyle = DOOR_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === TELEPORTER_TILE) {
        ctx.fillStyle = TELEPORTER_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === SPIKE_TRAP_TILE) {
        ctx.fillStyle = activeSpikes.has(`${x},${y}`) ? SPIKE_ACTIVE_COLOR : SPIKE_SAFE_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === HAZARD_TILE) {
        ctx.fillStyle = HAZARD_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else {
        ctx.fillStyle = FLOOR_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      }
    }
  }

  // Discovered, still-live proximity mines.
  ctx.fillStyle = MINE_COLOR;
  for (const mine of map.mines) {
    if (!mine.alive || !mine.visible) continue;
    if (mine.x < tileX0 - 1 || mine.x > tileX1 || mine.y < tileY0 - 1 || mine.y > tileY1) continue;
    const mx = vx0 + (mine.x - camX) * CELL_PX - CELL_PX / 2;
    const my = vy0 + (mine.y - camY) * CELL_PX - CELL_PX / 2;
    ctx.fillRect(mx, my, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
  }

  // Exit tile, once discovered.
  if (map.visited[map.exit.y]?.[map.exit.x]) {
    ctx.fillStyle = EXIT_COLOR;
    const ex = vx0 + (map.exit.x - camX) * CELL_PX;
    const ey = vy0 + (map.exit.y - camY) * CELL_PX;
    ctx.fillRect(ex, ey, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
  }

  drawPlayerMarker(ctx, player, vx0, vy0, camX, camY, CELL_PX);

  ctx.restore();
}

/** Solid triangle at the player's exact position, pointing along their
 * facing — camera-relative, so it stays near the viewport's center while the
 * camera is actively panning, sliding toward an edge only near the map's
 * actual boundary. */
function drawPlayerMarker(
  ctx: CanvasRenderingContext2D,
  player: Player,
  vx0: number,
  vy0: number,
  camX: number,
  camY: number,
  cell: number,
): void {
  const px = vx0 + (player.posX - camX) * cell;
  const py = vy0 + (player.posY - camY) * cell;
  const angle = Math.atan2(player.dirY, player.dirX);
  const size = Math.max(6, cell * 1.6);

  ctx.fillStyle = PLAYER_COLOR;
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(angle) * size, py + Math.sin(angle) * size);
  ctx.lineTo(px + Math.cos(angle + 2.5) * size * 0.7, py + Math.sin(angle + 2.5) * size * 0.7);
  ctx.lineTo(px + Math.cos(angle - 2.5) * size * 0.7, py + Math.sin(angle - 2.5) * size * 0.7);
  ctx.closePath();
  ctx.fill();
}

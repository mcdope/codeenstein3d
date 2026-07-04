// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Software raycaster using the DDA (Digital Differential Analyzer) grid
 * traversal. For each screen column we cast one ray, step it cell-by-cell
 * through the tile grid until it hits a wall, then draw a single vertical line
 * whose height is inversely proportional to the perpendicular wall distance.
 *
 * Pure native Canvas 2D — no WebGL, no 3D libraries.
 */
import { DOOR_TILE, HAZARD_TILE, type GameMap } from "../map/types";
import type { Player } from "./player";
import { enemyColor } from "./sprites";

/** Base wall color (a warm dungeon brick), before distance shading. */
const WALL_RGB: [number, number, number] = [186, 152, 116];
/** Locked-door color (a cold steel blue), before distance shading. */
const DOOR_RGB: [number, number, number] = [86, 142, 190];
/** Ceiling, plain floor, and hazard (acid) floor base colors, as RGB. */
const CEILING_RGB: [number, number, number] = [11, 13, 22];
const FLOOR_RGB: [number, number, number] = [21, 21, 26];
const ACID_RGB: [number, number, number] = [64, 196, 72];
/** Distance (tiles) at which walls fade to near-black. */
const SHADE_DISTANCE = 22;
/** Minimum brightness so distant walls stay faintly visible. */
const MIN_SHADE = 0.12;
/** y-side walls are dimmed to fake directional lighting. */
const SIDE_SHADE = 0.68;

/** Reusable floor-cast frame buffer, re-created only when the size changes. */
let floorImage: ImageData | null = null;

/**
 * Draw one frame of the 3D walls into the canvas, and record the perpendicular
 * wall distance for each column into `zBuffer` (length must equal the canvas
 * width). Sprites use that buffer to hide behind walls.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  if (map.hazards.length > 0) {
    // Floor-cast so acid pools appear as colored floor tiles.
    renderBackground(ctx, map, player, width, height);
  } else {
    // No hazards: flat ceiling (top half) and floor (bottom half) is cheaper.
    ctx.fillStyle = rgb(CEILING_RGB);
    ctx.fillRect(0, 0, width, height / 2);
    ctx.fillStyle = rgb(FLOOR_RGB);
    ctx.fillRect(0, height / 2, width, height / 2);
  }

  for (let x = 0; x < width; x++) {
    // Ray direction for this column: dir + plane * cameraX, cameraX ∈ [-1, 1].
    const cameraX = (2 * x) / width - 1;
    const rayDirX = player.dirX + player.planeX * cameraX;
    const rayDirY = player.dirY + player.planeY * cameraX;

    let mapX = Math.floor(player.posX);
    let mapY = Math.floor(player.posY);

    // Distance the ray travels to cross one full cell in x / y.
    const deltaDistX = rayDirX === 0 ? Infinity : Math.abs(1 / rayDirX);
    const deltaDistY = rayDirY === 0 ? Infinity : Math.abs(1 / rayDirY);

    let stepX: number;
    let stepY: number;
    let sideDistX: number;
    let sideDistY: number;

    if (rayDirX < 0) {
      stepX = -1;
      sideDistX = (player.posX - mapX) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX + 1 - player.posX) * deltaDistX;
    }
    if (rayDirY < 0) {
      stepY = -1;
      sideDistY = (player.posY - mapY) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY + 1 - player.posY) * deltaDistY;
    }

    // DDA: advance to the nearest cell boundary until we hit a wall.
    let side = 0; // 0 = hit on an x-side, 1 = y-side
    let hit = false;
    let hitTile = 1; // wall (1) or door (DOOR_TILE)
    for (let guard = 0; guard < 4096 && !hit; guard++) {
      if (sideDistX < sideDistY) {
        sideDistX += deltaDistX;
        mapX += stepX;
        side = 0;
      } else {
        sideDistY += deltaDistY;
        mapY += stepY;
        side = 1;
      }
      if (mapX < 0 || mapY < 0 || mapX >= map.width || mapY >= map.height) {
        hit = true; // out of bounds counts as a wall
        hitTile = 1;
      } else {
        const tile = map.grid[mapY][mapX];
        if (tile === 1 || tile === DOOR_TILE) {
          hit = true;
          hitTile = tile;
        }
      }
    }

    // Perpendicular distance (avoids the fisheye a Euclidean distance gives).
    const perpDist =
      side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
    const dist = Math.max(perpDist, 0.0001);
    zBuffer[x] = dist;

    const lineHeight = Math.floor(height / dist);
    const drawStart = Math.max(0, Math.floor((height - lineHeight) / 2));
    const drawEnd = Math.min(height - 1, Math.floor((height + lineHeight) / 2));

    // Distance shading, dimmed further on y-sides for depth. Doors use their
    // own color so they read as openable, not solid rock.
    let shade = Math.max(MIN_SHADE, 1 - dist / SHADE_DISTANCE);
    if (side === 1) shade *= SIDE_SHADE;

    const base = hitTile === DOOR_TILE ? DOOR_RGB : WALL_RGB;
    const r = Math.floor(base[0] * shade);
    const g = Math.floor(base[1] * shade);
    const b = Math.floor(base[2] * shade);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, drawStart, 1, drawEnd - drawStart + 1);
  }
}

/**
 * Floor-cast the background: ceiling in the top half, and for the bottom half
 * the actual floor cell under each pixel — tinted acid-green on hazard tiles —
 * with mild distance shading. Painted before the walls, which then occlude it.
 */
function renderBackground(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  width: number,
  height: number,
): void {
  if (!floorImage || floorImage.width !== width || floorImage.height !== height) {
    floorImage = ctx.createImageData(width, height);
  }
  const data = floorImage.data;
  const halfH = height / 2;

  // Leftmost (cameraX=-1) and rightmost (cameraX=+1) ray directions.
  const rayDir0X = player.dirX - player.planeX;
  const rayDir0Y = player.dirY - player.planeY;
  const rayDir1X = player.dirX + player.planeX;
  const rayDir1Y = player.dirY + player.planeY;
  const posZ = 0.5 * height; // camera height in pixels

  let idx = 0;
  for (let y = 0; y < height; y++) {
    if (y < halfH) {
      // Ceiling: flat fill.
      for (let x = 0; x < width; x++) {
        data[idx++] = CEILING_RGB[0];
        data[idx++] = CEILING_RGB[1];
        data[idx++] = CEILING_RGB[2];
        data[idx++] = 255;
      }
      continue;
    }

    // Floor row: perpendicular distance to the floor at this scanline.
    const rowDistance = posZ / (y - halfH);
    const stepX = (rowDistance * (rayDir1X - rayDir0X)) / width;
    const stepY = (rowDistance * (rayDir1Y - rayDir0Y)) / width;
    let floorX = player.posX + rowDistance * rayDir0X;
    let floorY = player.posY + rowDistance * rayDir0Y;

    const shade = Math.max(MIN_SHADE, 1 - rowDistance / SHADE_DISTANCE);

    for (let x = 0; x < width; x++) {
      const cx = Math.floor(floorX);
      const cy = Math.floor(floorY);
      const hazard =
        cx >= 0 && cy >= 0 && cx < map.width && cy < map.height && map.grid[cy][cx] === HAZARD_TILE;
      const base = hazard ? ACID_RGB : FLOOR_RGB;
      data[idx++] = base[0] * shade;
      data[idx++] = base[1] * shade;
      data[idx++] = base[2] * shade;
      data[idx++] = 255;
      floorX += stepX;
      floorY += stepY;
    }
  }

  ctx.putImageData(floorImage, 0, 0);
}

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

/**
 * Small top-left minimap: walls, live enemies, and the player's position and
 * facing. Useful for confirming movement, collision, and combat while playing.
 */
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  maxPixels = 140,
): void {
  const cell = Math.max(1, Math.floor(maxPixels / Math.max(map.width, map.height)));
  const w = map.width * cell;
  const h = map.height * cell;
  const pad = 8;

  ctx.save();
  ctx.globalAlpha = 0.85;

  // Backing panel.
  ctx.fillStyle = "#000";
  ctx.fillRect(pad - 2, pad - 2, w + 4, h + 4);

  // Walls.
  ctx.fillStyle = "#4a4a55";
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (row[x] === 1) ctx.fillRect(pad + x * cell, pad + y * cell, cell, cell);
    }
  }

  // Hazard (acid) tiles.
  ctx.fillStyle = "#2f9e3a";
  for (const hz of map.hazards) {
    ctx.fillRect(pad + hz.x * cell, pad + hz.y * cell, cell, cell);
  }

  // Locked doors still closed (grid is the source of truth once opened).
  ctx.fillStyle = "#568ebe";
  for (const door of map.doors) {
    if (map.grid[door.y][door.x] === DOOR_TILE) {
      ctx.fillRect(pad + door.x * cell, pad + door.y * cell, cell, cell);
    }
  }

  // Uncollected keys.
  ctx.fillStyle = "#f2d64b";
  for (const item of map.keys) {
    if (item.collected) continue;
    ctx.fillRect(pad + item.x * cell - cell / 2, pad + item.y * cell - cell / 2, Math.max(2, cell), Math.max(2, cell));
  }

  // Exit tile (the return statement).
  ctx.fillStyle = "#37d24a";
  ctx.fillRect(
    pad + map.exit.x * cell,
    pad + map.exit.y * cell,
    Math.max(2, cell),
    Math.max(2, cell),
  );

  // Live enemies.
  for (const enemy of map.enemies) {
    if (!enemy.alive) continue;
    ctx.fillStyle = enemyColor(enemy.entity.kind);
    ctx.fillRect(
      pad + enemy.x * cell - cell / 2,
      pad + enemy.y * cell - cell / 2,
      Math.max(2, cell),
      Math.max(2, cell),
    );
  }

  // Player position and heading.
  const px = pad + player.posX * cell;
  const py = pad + player.posY * cell;
  ctx.strokeStyle = "#e21b1b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + player.dirX * cell * 3, py + player.dirY * cell * 3);
  ctx.stroke();

  ctx.fillStyle = "#e21b1b";
  ctx.beginPath();
  ctx.arc(px, py, Math.max(1.5, cell * 0.6), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

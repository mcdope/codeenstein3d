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
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
} from "../map/types";
import type { Player } from "./player";
import { enemyColor } from "./sprites";
import { activeSpikeTileKeys } from "./traps";

/** Base wall color (a warm dungeon brick), before distance shading. */
const WALL_RGB: [number, number, number] = [186, 152, 116];
/** A bonus (restock-arena) level uses a cool, distinct steel-and-teal theme
 * instead of the normal warm brick, so it reads as visually different the
 * instant it loads — see `GameMap.bonusLevel`. */
const BONUS_WALL_RGB: [number, number, number] = [92, 142, 168];
const BONUS_CEILING_RGB: [number, number, number] = [8, 16, 24];
const BONUS_FLOOR_RGB: [number, number, number] = [14, 24, 30];
/** Locked-door color (a cold steel blue), before distance shading. */
const DOOR_RGB: [number, number, number] = [86, 142, 190];
/** Lore terminal wall color (a glowing violet-cyan), before pulsing/shading. */
const LORE_RGB: [number, number, number] = [120, 200, 210];
/** Ceiling, plain floor, and hazard (acid) floor base colors, as RGB. */
const CEILING_RGB: [number, number, number] = [11, 13, 22];
const FLOOR_RGB: [number, number, number] = [21, 21, 26];
const ACID_RGB: [number, number, number] = [64, 196, 72];
/** Base color for goto/label teleporter pad floor tiles, before pulsing. */
const TELEPORTER_RGB: [number, number, number] = [130, 70, 220];
/** Spike trap floor tint: dull metal grey while safe, hot pulsing red while active. */
const SPIKE_SAFE_RGB: [number, number, number] = [90, 90, 96];
const SPIKE_ACTIVE_RGB: [number, number, number] = [220, 40, 30];

/** Wall/floor/ceiling base colors for `map`'s theme — bonus (restock arena)
 * levels get a distinct cool palette (see `BONUS_WALL_RGB`). */
function scenePalette(map: GameMap): {
  wall: [number, number, number];
  floor: [number, number, number];
  ceiling: [number, number, number];
} {
  return map.bonusLevel
    ? { wall: BONUS_WALL_RGB, floor: BONUS_FLOOR_RGB, ceiling: BONUS_CEILING_RGB }
    : { wall: WALL_RGB, floor: FLOOR_RGB, ceiling: CEILING_RGB };
}

/**
 * A fake secret wall is meant to be findable, not literally invisible: a very
 * slight cool nudge off the real wall color (a touch less red, a touch more
 * blue) — subtle enough to blend in at a glance or in the heat of a fight,
 * but a player who stops and really looks at a stretch of wall has a real
 * shot at spotting it before ever pressing "R" against it.
 */
function secretWallTint(base: [number, number, number]): [number, number, number] {
  return [Math.max(0, base[0] - 8), base[1], Math.min(255, base[2] + 10)];
}
/** Within this many tiles the world keeps full brightness (no fog). */
const FOG_NEAR = 2.5;
/** Beyond this many tiles the world has faded to pure black. */
const FOG_FAR = 14;
/** y-side walls are dimmed to fake directional lighting. */
const SIDE_SHADE = 0.68;

/**
 * Distance fog brightness multiplier in [0, 1]: full (1) within `FOG_NEAR`,
 * pure black (0) at/beyond `FOG_FAR`, smoothstepped in between so walls sink
 * gently into the dark rather than banding.
 */
function fogShade(dist: number): number {
  if (dist <= FOG_NEAR) return 1;
  if (dist >= FOG_FAR) return 0;
  const brightness = 1 - (dist - FOG_NEAR) / (FOG_FAR - FOG_NEAR); // linear 1→0
  return brightness * brightness * (3 - 2 * brightness); // smoothstep
}

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
  horizonShift = 0,
  levelTime = 0,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  // Screen row of the horizon, nudged by the head-bob so walls, ceiling, and
  // floor all rise and fall with the camera.
  const horizon = height / 2 + horizonShift;
  const palette = scenePalette(map);

  if (map.hazards.length > 0 || map.teleporters.length > 0 || map.spikeTraps.length > 0) {
    // Floor-cast so acid pools / teleporter pads / spike traps appear as
    // colored floor tiles.
    renderBackground(ctx, map, player, width, height, horizon, levelTime);
  } else {
    // No hazards: flat ceiling (above the horizon) and floor (below) is cheaper.
    const split = Math.max(0, Math.min(height, Math.round(horizon)));
    ctx.fillStyle = rgb(palette.ceiling);
    ctx.fillRect(0, 0, width, split);
    ctx.fillStyle = rgb(palette.floor);
    ctx.fillRect(0, split, width, height - split);
  }

  // Lore terminal walls pulse gently so they read as an active "terminal"
  // rather than a static tinted wall — computed once per frame, not per column.
  const lorePulse = 0.75 + 0.25 * Math.sin(performance.now() / 200);
  const loreGlow: [number, number, number] = [
    LORE_RGB[0] * lorePulse,
    LORE_RGB[1] * lorePulse,
    LORE_RGB[2] * lorePulse,
  ];

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
        if (tile === 1 || tile === DOOR_TILE || tile === SECRET_WALL_TILE || tile === LORE_TILE) {
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
    const drawStart = Math.max(0, Math.floor(horizon - lineHeight / 2));
    const drawEnd = Math.min(height - 1, Math.floor(horizon + lineHeight / 2));

    // Distance fog, dimmed further on y-sides for depth. Doors use their own
    // color so they read as openable, not solid rock.
    let shade = fogShade(dist);
    if (side === 1) shade *= SIDE_SHADE;

    const base =
      hitTile === DOOR_TILE
        ? DOOR_RGB
        : hitTile === LORE_TILE
          ? loreGlow
          : hitTile === SECRET_WALL_TILE
            ? secretWallTint(palette.wall)
            : palette.wall;
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
  horizon: number,
  levelTime: number,
): void {
  if (!floorImage || floorImage.width !== width || floorImage.height !== height) {
    floorImage = ctx.createImageData(width, height);
  }
  const data = floorImage.data;
  const halfH = horizon;
  const palette = scenePalette(map);

  // Teleporter pads pulse gently so they read as "active" rather than a
  // static colored tile; computed once per frame, not per pixel.
  const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 260);
  const teleporterGlow: [number, number, number] = [
    TELEPORTER_RGB[0] * pulse,
    TELEPORTER_RGB[1] * pulse,
    TELEPORTER_RGB[2] * pulse,
  ];

  // Which spike traps are in their damaging half of the cycle this frame —
  // resolved once here, not per pixel. Active tiles pulse hot to read as
  // dangerous; safe ones stay a flat dull metal.
  const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);
  const spikePulse = 0.75 + 0.25 * Math.sin(performance.now() / 90);
  const spikeActiveGlow: [number, number, number] = [
    SPIKE_ACTIVE_RGB[0] * spikePulse,
    SPIKE_ACTIVE_RGB[1] * spikePulse,
    SPIKE_ACTIVE_RGB[2] * spikePulse,
  ];

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
        data[idx++] = palette.ceiling[0];
        data[idx++] = palette.ceiling[1];
        data[idx++] = palette.ceiling[2];
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

    const shade = fogShade(rowDistance);

    for (let x = 0; x < width; x++) {
      const cx = Math.floor(floorX);
      const cy = Math.floor(floorY);
      const tile =
        cx >= 0 && cy >= 0 && cx < map.width && cy < map.height ? map.grid[cy][cx] : -1;
      const base =
        tile === TELEPORTER_TILE
          ? teleporterGlow
          : tile === HAZARD_TILE
            ? ACID_RGB
            : tile === SPIKE_TRAP_TILE
              ? (activeSpikes.has(`${cx},${cy}`) ? spikeActiveGlow : SPIKE_SAFE_RGB)
              : palette.floor;
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
 * Small top-left minimap: walls, discovered enemies, traps, and the player's
 * exact position and facing. Useful for confirming movement, collision, and
 * combat while playing. Enemies only appear once the player has physically
 * entered their room (an AABB check against `Enemy.home`, done once per frame
 * in `RaycasterEngine`) — see `Enemy.discovered`.
 */
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  levelTime = 0,
  maxPixels = 140,
): void {
  const cell = Math.max(1, Math.floor(maxPixels / Math.max(map.width, map.height)));
  const w = map.width * cell;
  const h = map.height * cell;
  const pad = 8;

  ctx.save();

  // Semi-transparent dark backing panel — legible over the 3D scene without
  // fully occluding it, and without washing out the high-contrast markers
  // drawn on top (those stay at full opacity for clarity).
  ctx.fillStyle = "rgba(4,8,10,0.6)";
  ctx.fillRect(pad - 2, pad - 2, w + 4, h + 4);

  ctx.globalAlpha = 0.9;

  // Walls.
  ctx.fillStyle = map.bonusLevel ? "#3f7fae" : "#4a4a55";
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (row[x] === 1 || row[x] === LORE_TILE) {
        ctx.fillRect(pad + x * cell, pad + y * cell, cell, cell);
      }
    }
  }

  // Fake secret walls: the same very slight cool hue nudge as the 3D scene
  // (see `secretWallTint`) — close enough to a plain wall to stay hidden at a
  // glance, but a real (if tiny) hint for a player who looks closely.
  ctx.fillStyle = map.bonusLevel ? "#377fb8" : "#424a5f";
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (row[x] === SECRET_WALL_TILE) ctx.fillRect(pad + x * cell, pad + y * cell, cell, cell);
    }
  }

  // Lore terminals: a small glowing marker layered over their wall tile so
  // they still stand out from a plain (or secret) wall at a glance.
  const lorePulse = 0.6 + 0.4 * Math.sin(performance.now() / 200);
  ctx.fillStyle = `rgba(120,200,210,${lorePulse})`;
  for (const t of map.loreTerminals) {
    ctx.fillRect(pad + t.x * cell, pad + t.y * cell, cell, cell);
  }

  // Hazard (acid) tiles — a hot, non-green color so a glance never confuses
  // them with the green pulsing exit marker drawn below.
  ctx.fillStyle = "#ff9d1f";
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

  // Spike traps: dull metal when safe, pulsing red when active.
  const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);
  const spikePulse = 0.6 + 0.4 * Math.sin(performance.now() / 90);
  for (const trap of map.spikeTraps) {
    ctx.fillStyle = activeSpikes.has(`${trap.x},${trap.y}`)
      ? `rgba(220,40,30,${spikePulse})`
      : "#5a5a60";
    ctx.fillRect(pad + trap.x * cell, pad + trap.y * cell, cell, cell);
  }

  // Discovered, still-live proximity mines.
  ctx.fillStyle = "#ff5050";
  for (const mine of map.mines) {
    if (!mine.alive || !mine.visible) continue;
    ctx.fillRect(pad + mine.x * cell - cell / 2, pad + mine.y * cell - cell / 2, Math.max(2, cell), Math.max(2, cell));
  }

  // Goto teleporter pads.
  ctx.fillStyle = "#a855f7";
  for (const t of map.teleporters) {
    ctx.fillRect(pad + t.x * cell - cell / 2, pad + t.y * cell - cell / 2, Math.max(2, cell), Math.max(2, cell));
  }

  // Uncollected keys.
  ctx.fillStyle = "#f2d64b";
  for (const item of map.keys) {
    if (item.collected) continue;
    ctx.fillRect(pad + item.x * cell - cell / 2, pad + item.y * cell - cell / 2, Math.max(2, cell), Math.max(2, cell));
  }

  // Exit tile (the return statement): high-contrast and pulsing so it never
  // gets lost among walls/hazards at a glance.
  const exitPulse = 0.65 + 0.35 * Math.sin(performance.now() / 260);
  const exitSize = Math.max(2, cell) * (1 + 0.25 * exitPulse);
  const exitOffset = (exitSize - Math.max(2, cell)) / 2;
  ctx.fillStyle = `rgba(65,255,110,${0.75 + 0.25 * exitPulse})`;
  ctx.fillRect(pad + map.exit.x * cell - exitOffset, pad + map.exit.y * cell - exitOffset, exitSize, exitSize);

  // Discovered, living enemies only — see the doc comment above.
  for (const enemy of map.enemies) {
    if (!enemy.alive || !enemy.discovered) continue;
    ctx.fillStyle = enemyColor(enemy.entity.kind);
    ctx.fillRect(
      pad + enemy.x * cell - cell / 2,
      pad + enemy.y * cell - cell / 2,
      Math.max(2, cell),
      Math.max(2, cell),
    );
  }

  ctx.globalAlpha = 1;

  // Player: a solid, bright triangle at the exact position pointing along the
  // facing direction — unmistakably distinct from every other marker color.
  const px = pad + player.posX * cell;
  const py = pad + player.posY * cell;
  const angle = Math.atan2(player.dirY, player.dirX);
  const size = Math.max(4, cell * 1.4);
  ctx.fillStyle = "#f5ffef";
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(angle) * size, py + Math.sin(angle) * size);
  ctx.lineTo(px + Math.cos(angle + 2.5) * size * 0.6, py + Math.sin(angle + 2.5) * size * 0.6);
  ctx.lineTo(px + Math.cos(angle - 2.5) * size * 0.6, py + Math.sin(angle - 2.5) * size * 0.6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

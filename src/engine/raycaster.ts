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
import { EDGE_CASE_COLOR, enemyColor } from "./sprites";
import { LORE_BASE, type TextureBitmap, type TextureSet } from "./textures";
import { activeSpikeTileKeys } from "./traps";

/** A bonus (restock-arena) level's ceiling stays a distinct cool tone,
 * matching its steel/teal wall and floor textures — see `GameMap.bonusLevel`. */
const BONUS_CEILING_RGB: [number, number, number] = [8, 16, 24];
/** Ceiling base color — the one thing that stays flat-colored/untextured. */
const CEILING_RGB: [number, number, number] = [11, 13, 22];

/** Ceiling base color for `map`'s theme — bonus (restock arena) levels get a
 * distinct cool ceiling to match their steel/teal wall and floor textures. */
function sceneCeiling(map: GameMap): [number, number, number] {
  return map.bonusLevel ? BONUS_CEILING_RGB : CEILING_RGB;
}

/**
 * A fake secret wall is meant to be findable, not literally invisible: a very
 * slight cool translucent overlay drawn on top of the real wall texture —
 * subtle enough to blend in at a glance or in the heat of a fight, but a
 * player who stops and really looks at a stretch of wall has a real shot at
 * spotting it before ever pressing "R" against it.
 */
const SECRET_WALL_OVERLAY = "rgba(20,40,90,0.12)";
/** Shared empty default for `renderScene`/`renderMinimap`'s `readTerminals`
 * param — one instance reused across calls rather than a fresh `Set` every
 * frame a caller omits it. */
const NO_READ_TERMINALS: ReadonlySet<string> = new Set();
/** Within this many tiles the world keeps full brightness (no fog). */
const FOG_NEAR = 2.5;
/** Beyond this many tiles the world has faded to pure black — also doubles as
 * the "maximum visual range" the Cone of Fire scales aim deviation against
 * (see `engine.ts`'s `fire()`), so a shot only really goes wide right at the
 * edge of what you can actually see. */
export const FOG_FAR = 14;
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
 * Exact shaded color of one texel at a given screen row, read straight from
 * `tex.pixels` (no runtime `getImageData`). Used for the wall/door/secret-wall
 * edge-antialiasing rows, where a flat blend color would visibly smear a flat
 * tone across a patterned texture instead of blending its true edge color.
 */
function shadedTexel(
  tex: TextureBitmap,
  texX: number,
  screenY: number,
  wallTop: number,
  wallBottom: number,
  shade: number,
  secret: boolean,
): string {
  const v = Math.max(
    0,
    Math.min(tex.height - 1, Math.floor(((screenY - wallTop) / (wallBottom - wallTop)) * tex.height)),
  );
  const i = (v * tex.width + texX) * 4;
  let r = tex.pixels[i] * shade;
  let g = tex.pixels[i + 1] * shade;
  let b = tex.pixels[i + 2] * shade;
  if (secret) {
    // Same subtle "findable, not invisible" nudge as `SECRET_WALL_OVERLAY`,
    // applied directly to the sampled texel since this row is drawn with an
    // exact color rather than an overlay blend.
    r *= 0.88;
    b = Math.min(255, b + 10 * shade);
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

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
  textureSet: TextureSet,
  horizonShift = 0,
  levelTime = 0,
  readTerminals: ReadonlySet<string> = NO_READ_TERMINALS,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  // Screen row of the horizon, nudged by the head-bob so walls, ceiling, and
  // floor all rise and fall with the camera.
  const horizon = height / 2 + horizonShift;

  // Floor-cast every frame now that the floor is texture-mapped — this used
  // to be skipped in favor of two flat `fillRect`s on maps with no hazards/
  // teleporters/traps, but that fast path can't show floor texture
  // variation, so it's retired (see renderBackground's doc comment).
  renderBackground(ctx, map, player, width, height, horizon, levelTime, textureSet);

  // Lore terminal walls sample a real texture (see `tex` below) plus a thin
  // pulsing tint overlay on top, so the "this is interactive, walk up to it"
  // signal survives the switch away from a flat glow fill — computed once per
  // frame, not per column. Unlike `SECRET_WALL_OVERLAY` (deliberately barely
  // noticeable, since secret walls want to blend in), this one wants to be seen.
  const lorePulseAlpha = 0.4 + 0.15 * Math.sin(performance.now() / 200);
  const loreOverlay = `rgba(${LORE_BASE[0]},${LORE_BASE[1]},${LORE_BASE[2]},${lorePulseAlpha})`;

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

    // Where exactly the ray hit the wall face, in [0,1) along its width — the
    // texture-space U coordinate. Classic DDA formula: recover the hit
    // point's off-axis world coordinate and take its fractional part.
    let wallX = side === 0 ? player.posY + dist * rayDirY : player.posX + dist * rayDirX;
    wallX -= Math.floor(wallX);

    // Kept as floats (not floored to whole pixels) so the top/bottom edge can
    // be antialiased below — flooring here is what causes the classic
    // raycaster "staircase" silhouette against the ceiling/floor.
    const lineHeight = height / dist;
    const wallTop = horizon - lineHeight / 2;
    const wallBottom = horizon + lineHeight / 2;

    // Distance fog, dimmed further on y-sides for depth.
    let shade = fogShade(dist);
    if (side === 1) shade *= SIDE_SHADE;

    // Every solid tile now samples a real texture — lore terminals get their
    // own composite texture (see `loreOverlay` above for how they stay
    // distinguishable from a plain wall) instead of a flat fill.
    const tex: TextureBitmap =
      hitTile === DOOR_TILE
        ? textureSet.door
        : hitTile === LORE_TILE
          ? textureSet.loreWall
          : map.bonusLevel
            ? textureSet.bonusWall
            : textureSet.wall;

    const solidStart = Math.max(0, Math.ceil(wallTop));
    const solidEnd = Math.min(height, Math.floor(wallBottom));

    // Mirror correction: without this, facing walls on the "far" side of a
    // cell would sample their texture backwards.
    let texX = Math.floor(wallX * tex.width);
    if (side === 0 && rayDirX > 0) texX = tex.width - texX - 1;
    if (side === 1 && rayDirY < 0) texX = tex.width - texX - 1;
    texX = Math.max(0, Math.min(tex.width - 1, texX));

    // Bulk blit: one source column, scaled to the wall's on-screen span —
    // drawImage clips to canvas bounds natively, no manual clamping needed.
    ctx.drawImage(tex.canvas, texX, 0, 1, tex.height, x, wallTop, 1, wallBottom - wallTop);

    if (solidEnd > solidStart) {
      // Alpha-blending black at (1-shade) over an opaque pixel reproduces
      // the old flat-fill era's `base*shade` multiply exactly, and composes
      // for free with the `drawImage` scale above.
      ctx.globalAlpha = 1 - shade;
      ctx.fillStyle = "#000";
      ctx.fillRect(x, solidStart, 1, solidEnd - solidStart);
      if (hitTile === SECRET_WALL_TILE) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = SECRET_WALL_OVERLAY;
        ctx.fillRect(x, solidStart, 1, solidEnd - solidStart);
      } else if (hitTile === LORE_TILE && !readTerminals.has(`${mapX},${mapY}`)) {
        // Once read, the terminal keeps its distinct wall texture (still
        // findable) but drops the animated pulse — "glowing" specifically
        // means this overlay, not the texture itself.
        ctx.globalAlpha = 1;
        ctx.fillStyle = loreOverlay;
        ctx.fillRect(x, solidStart, 1, solidEnd - solidStart);
      }
      ctx.globalAlpha = 1;
    }

    // Edge antialiasing: sample the exact shaded texel at the boundary row
    // instead of a flat blend color, so the partial-coverage row matches the
    // texture's pattern instead of smearing one flat tone across it.
    if (wallTop > 0 && wallTop < height) {
      const edgeRow = Math.floor(wallTop);
      const coverage = Math.min(1, edgeRow + 1 - wallTop, wallBottom - wallTop);
      if (coverage > 0) {
        ctx.fillStyle = shadedTexel(tex, texX, edgeRow, wallTop, wallBottom, shade, hitTile === SECRET_WALL_TILE);
        ctx.globalAlpha = coverage;
        ctx.fillRect(x, edgeRow, 1, 1);
        ctx.globalAlpha = 1;
      }
    }
    if (wallBottom > 0 && wallBottom < height) {
      const edgeRow = Math.floor(wallBottom);
      // A very thin (sub-pixel-height) wall can land its top and bottom edge
      // in the same row — already fully handled by the block above, so skip
      // it here to avoid double-blending that row.
      if (edgeRow !== Math.floor(wallTop) || wallTop <= 0) {
        const coverage = Math.min(1, wallBottom - edgeRow);
        if (coverage > 0) {
          ctx.fillStyle = shadedTexel(tex, texX, edgeRow, wallTop, wallBottom, shade, hitTile === SECRET_WALL_TILE);
          ctx.globalAlpha = coverage;
          ctx.fillRect(x, edgeRow, 1, 1);
          ctx.globalAlpha = 1;
        }
      }
    }
  }
}

/**
 * Floor-cast the background: ceiling in the top half (flat-colored), and for
 * the bottom half the actual floor cell under each pixel, sampling whichever
 * real texture that tile's kind maps to (plain floor, hazard, teleporter, or
 * — depending on `activeSpikeTileKeys` — one of the two spike-trap flats) —
 * with mild distance shading. Painted before the walls, which then occlude
 * it. Runs unconditionally now that the floor is texture-mapped (it used to
 * be skipped in favor of two flat `fillRect`s on maps with no hazards/
 * teleporters/traps — that fast path can't show a texture, so it's retired).
 */
function renderBackground(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  width: number,
  height: number,
  horizon: number,
  levelTime: number,
  textureSet: TextureSet,
): void {
  if (!floorImage || floorImage.width !== width || floorImage.height !== height) {
    floorImage = ctx.createImageData(width, height);
  }
  const data = floorImage.data;
  const halfH = horizon;
  const ceiling = sceneCeiling(map);
  const floorTex = map.bonusLevel ? textureSet.bonusFloor : textureSet.floor;

  // Which spike traps are in their damaging half of the cycle this frame —
  // resolved once here, not per pixel — decides whether a spike-trap tile
  // samples `spikeActiveFloor` (a blood/lava-looking flat) or
  // `spikeSafeFloor` (a plain metal-looking one) this frame.
  const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);

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
        data[idx++] = ceiling[0];
        data[idx++] = ceiling[1];
        data[idx++] = ceiling[2];
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

      // Every floor kind samples a real texture — which bitmap depends only
      // on the tile's kind (and, for a spike trap, its current safe/active
      // phase). The fractional part of the already-computed world position
      // *is* the texture UV in every case — no extra math needed.
      const tex =
        tile === TELEPORTER_TILE
          ? textureSet.teleporterFloor
          : tile === HAZARD_TILE
            ? textureSet.hazardFloor
            : tile === SPIKE_TRAP_TILE
              ? activeSpikes.has(`${cx},${cy}`)
                ? textureSet.spikeActiveFloor
                : textureSet.spikeSafeFloor
              : floorTex;
      const u = Math.min(tex.width - 1, Math.floor((floorX - cx) * tex.width));
      const v = Math.min(tex.height - 1, Math.floor((floorY - cy) * tex.height));
      const i = (v * tex.width + u) * 4;
      const r = tex.pixels[i];
      const g = tex.pixels[i + 1];
      const b = tex.pixels[i + 2];
      data[idx++] = r * shade;
      data[idx++] = g * shade;
      data[idx++] = b * shade;
      data[idx++] = 255;
      floorX += stepX;
      floorY += stepY;
    }
  }

  ctx.putImageData(floorImage, 0, 0);
}

/** The minimap panel's outer bounding box in canvas pixels, as returned by
 * `renderMinimap`. `compassBadge` is a small circle straddling the panel's
 * bottom-right corner — for the exit compass (see `hud.ts`'s `drawCompass`)
 * to draw into — rather than a rectangular cutout reserved inside the panel
 * itself; a prior notch design read as "a full bar" since the whole panel
 * had to grow a dead strip just to fit it. */
export interface MinimapPanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  compassBadge: { cx: number; cy: number; r: number };
}

/** Outer radius, in canvas pixels, of the compass badge circle. */
const COMPASS_BADGE_RADIUS = 13;

/**
 * Small top-left minimap: walls, discovered enemies, traps, and the player's
 * exact position and facing. Useful for confirming movement, collision, and
 * combat while playing. Enemies only appear once the player has physically
 * entered their room (an AABB check against `Enemy.home`, done once per frame
 * in `RaycasterEngine`) — see `Enemy.discovered`. Returns the panel's outer
 * rect so the exit compass can be drawn directly on its frame afterward.
 */
export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  levelTime = 0,
  maxPixels = 70,
  readTerminals: ReadonlySet<string> = NO_READ_TERMINALS,
): MinimapPanelRect {
  const cell = Math.max(1, Math.floor(maxPixels / Math.max(map.width, map.height)));
  const w = map.width * cell;
  const h = map.height * cell;
  const pad = 8;
  const panelX = pad - 2;
  const panelY = pad - 2;
  const panelW = w + 4;
  const panelH = h + 4;
  // Centered exactly on the panel's bottom-right corner point, so the badge
  // straddles/overlaps it (half in, half out) — drawn last, after every grid
  // marker below, so it reads as attached on top of the corner rather than
  // sitting underneath the grid content.
  const compassBadge = {
    cx: panelX + panelW,
    cy: panelY + panelH,
    r: COMPASS_BADGE_RADIUS,
  };
  const panel: MinimapPanelRect = { x: panelX, y: panelY, w: panelW, h: panelH, compassBadge };

  ctx.save();

  // Semi-transparent dark backing panel — legible over the 3D scene without
  // fully occluding it, and without washing out the high-contrast markers
  // drawn on top (those stay at full opacity for clarity).
  ctx.fillStyle = "rgba(4,8,10,0.6)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);

  // Subtle frame around the whole panel.
  ctx.strokeStyle = "rgba(140,255,170,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(panel.x + 0.5, panel.y + 0.5, panel.w - 1, panel.h - 1);

  ctx.globalAlpha = 0.9;

  // Walls — an unopened secret wall (SECRET_WALL_TILE) renders identically to
  // a plain one on purpose, so the minimap can't spoil its location before
  // the player actually finds/opens it (this minimap has no fog-of-war gate
  // at all, unlike the automap, so a distinct color here would reveal every
  // secret room's exact position from the moment the level loads). The one
  // intended discovery hint is the much subtler in-view overlay
  // (`SECRET_WALL_OVERLAY`, used by `renderScene`); once opened, the tile
  // becomes plain floor (0) and stops being drawn here at all, like any
  // other explored room.
  ctx.fillStyle = map.bonusLevel ? "#3f7fae" : "#4a4a55";
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      if (row[x] === 1 || row[x] === LORE_TILE || row[x] === SECRET_WALL_TILE) {
        ctx.fillRect(pad + x * cell, pad + y * cell, cell, cell);
      }
    }
  }

  // Lore terminals: a small glowing marker layered over their wall tile so
  // they still stand out from a plain (or secret) wall at a glance — skipped
  // once a terminal's been read, so it just fades back into the plain wall
  // fill drawn above instead of glowing forever.
  const lorePulse = 0.6 + 0.4 * Math.sin(performance.now() / 200);
  ctx.fillStyle = `rgba(120,200,210,${lorePulse})`;
  for (const t of map.loreTerminals) {
    if (readTerminals.has(`${t.x},${t.y}`)) continue;
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
    ctx.fillStyle = enemy.edgeCase ? EDGE_CASE_COLOR : enemyColor(enemy.entity.kind);
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

  // Compass badge: drawn last, straddling the panel's bottom-right corner —
  // see `drawCompass` in `hud.ts` for the needle drawn into it. Painting this
  // after every grid marker above is what makes it read as attached on top
  // of the corner rather than sitting underneath the grid content.
  ctx.beginPath();
  ctx.arc(compassBadge.cx, compassBadge.cy, compassBadge.r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(2,5,6,0.55)";
  ctx.fill();
  ctx.strokeStyle = "rgba(140,255,170,0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();

  return panel;
}

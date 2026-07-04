// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Billboard sprite rendering and crosshair hit-testing for enemies.
 *
 * Enemies are 2D billboards: a single upright quad projected with the same
 * camera transform used for walls, so they always face the player. The wall
 * z-buffer from `renderScene` occludes sprites that stand behind walls.
 *
 * The exact same projection drives combat: a hitscan shot "hits" whichever
 * living enemy's on-screen box contains the crosshair (screen center) and sits
 * in front of the nearest wall — so what you see under the crosshair is what
 * you shoot.
 */
import type { Enemy, KeyItem, Point } from "../map/types";
import type { CodeEntity, EntityKind } from "../parser/types";
import type { Player } from "./player";

/** Sprite footprint as a fraction of a full tile-height billboard. */
const ENEMY_SIZE = 0.7;

/** Per-kind body color. Only functions/methods become enemies today. */
export function enemyColor(kind: EntityKind): string {
  switch (kind) {
    case "function":
      return "#e0483a"; // red
    case "method":
      return "#e08a2a"; // orange
    default:
      return "#b84ad0"; // purple (future kinds)
  }
}

/** An enemy's on-screen placement for a given camera. */
export interface EnemyProjection {
  /** Camera-space depth; > 0 means in front of the player. */
  depth: number;
  /** Horizontal screen center of the sprite, in pixels. */
  screenX: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Project a world point into screen space for `player` on a `width`×`height`
 * view, sizing the billboard as `sizeFactor` of a full tile-height sprite. */
export function projectPoint(
  player: Player,
  worldX: number,
  worldY: number,
  width: number,
  height: number,
  sizeFactor = ENEMY_SIZE,
): EnemyProjection {
  const spriteX = worldX - player.posX;
  const spriteY = worldY - player.posY;

  // Inverse of the [plane | dir] camera matrix.
  const invDet = 1 / (player.planeX * player.dirY - player.dirX * player.planeY);
  const transformX = invDet * (player.dirY * spriteX - player.dirX * spriteY);
  const transformY = invDet * (-player.planeY * spriteX + player.planeX * spriteY);

  const screenX = (width / 2) * (1 + transformX / transformY);
  const size = Math.abs(height / transformY) * sizeFactor;

  return {
    depth: transformY,
    screenX,
    left: screenX - size / 2,
    right: screenX + size / 2,
    top: height / 2 - size / 2,
    bottom: height / 2 + size / 2,
  };
}

/** Project an enemy into screen space for `player` on a `width`×`height` view. */
export function projectEnemy(
  player: Player,
  enemy: Enemy,
  width: number,
  height: number,
): EnemyProjection {
  return projectPoint(player, enemy.x, enemy.y, width, height);
}

/** Draw all living enemies as billboards, occluded by the wall z-buffer. */
export function renderSprites(
  ctx: CanvasRenderingContext2D,
  player: Player,
  enemies: Enemy[],
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  // Draw farthest first so nearer sprites paint over them.
  const visible = enemies
    .filter((e) => e.alive)
    .map((enemy) => ({ enemy, proj: projectEnemy(player, enemy, width, height) }))
    .filter(({ proj }) => proj.depth > 0.2)
    .sort((a, b) => b.proj.depth - a.proj.depth);

  for (const { enemy, proj } of visible) {
    const startX = Math.max(0, Math.floor(proj.left));
    const endX = Math.min(width - 1, Math.ceil(proj.right));
    const startY = Math.max(0, Math.floor(proj.top));
    const spriteH = proj.bottom - proj.top;

    // Body: vertical stripes, skipping columns hidden behind a wall.
    ctx.fillStyle = enemyColor(enemy.entity.kind);
    for (let x = startX; x <= endX; x++) {
      if (proj.depth >= zBuffer[x]) continue;
      ctx.fillRect(x, startY, 1, spriteH);
    }

    // Only draw the label / HP bar if the sprite's center isn't wall-occluded.
    const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth < zBuffer[centerCol]) {
      drawEnemyOverlay(ctx, enemy.entity, enemy.hp, enemy.maxHp, proj);
    }
  }
}

function drawEnemyOverlay(
  ctx: CanvasRenderingContext2D,
  entity: CodeEntity,
  hp: number,
  maxHp: number,
  proj: EnemyProjection,
): void {
  const barWidth = Math.min(80, Math.max(20, proj.right - proj.left));
  const barX = proj.screenX - barWidth / 2;
  const barY = proj.top - 12;
  const barH = 4;

  // HP bar: red background, green fill.
  ctx.fillStyle = "#3a0d0d";
  ctx.fillRect(barX, barY, barWidth, barH);
  ctx.fillStyle = "#37d24a";
  ctx.fillRect(barX, barY, (barWidth * Math.max(0, hp)) / maxHp, barH);

  // Name label above the bar.
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(barX, barY - 13, barWidth, 11);
  ctx.fillStyle = "#fff";
  ctx.fillText(entity.name, proj.screenX, barY - 4);
  ctx.textAlign = "start";
}

/**
 * Find the living enemy hit by a ray aimed at screen point (`screenX`, mid-
 * height), in front of the nearest wall — nearest one wins. Returns `null`
 * when nothing is hit. Used both for the aim reticle and for each shotgun
 * pellet (which aims at an offset column).
 */
export function findTargetAtColumn(
  player: Player,
  enemies: Enemy[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Enemy | null {
  const cy = height / 2;

  let best: Enemy | null = null;
  let bestDepth = Infinity;

  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const proj = projectEnemy(player, enemy, width, height);
    if (proj.depth <= 0) continue;
    if (screenX < proj.left || screenX > proj.right || cy < proj.top || cy > proj.bottom) {
      continue;
    }

    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    if (proj.depth < bestDepth) {
      best = enemy;
      bestDepth = proj.depth;
    }
  }
  return best;
}

/** The living enemy directly under the crosshair (screen center), if any. */
export function findTargetUnderCrosshair(
  player: Player,
  enemies: Enemy[],
  zBuffer: Float64Array,
  width: number,
  height: number,
): Enemy | null {
  return findTargetAtColumn(player, enemies, zBuffer, width, height, width / 2);
}

/**
 * Draw the green exit marker (the `return` statement) as a billboard at the
 * center of its tile, occluded by walls via the z-buffer.
 */
export function renderExitMarker(
  ctx: CanvasRenderingContext2D,
  player: Player,
  exit: Point,
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const proj = projectPoint(player, exit.x + 0.5, exit.y + 0.5, width, height, 0.9);
  if (proj.depth <= 0.2) return;

  const startX = Math.max(0, Math.floor(proj.left));
  const endX = Math.min(width - 1, Math.ceil(proj.right));
  const startY = Math.max(0, Math.floor(proj.top));
  const markerH = proj.bottom - proj.top;

  ctx.fillStyle = "#37d24a";
  for (let x = startX; x <= endX; x++) {
    if (proj.depth >= zBuffer[x]) continue;
    ctx.fillRect(x, startY, 1, markerH);
  }

  const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
  if (proj.depth < zBuffer[centerCol]) {
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const label = "return";
    const labelW = Math.max(40, proj.right - proj.left);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(proj.screenX - labelW / 2, proj.top - 15, labelW, 12);
    ctx.fillStyle = "#8effa0";
    ctx.fillText(label, proj.screenX, proj.top - 5);
    ctx.textAlign = "start";
  }
}

/** Draw uncollected keys as small floating gold "keycard" billboards. */
export function renderKeys(
  ctx: CanvasRenderingContext2D,
  player: Player,
  keys: KeyItem[],
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  const visible = keys
    .filter((k) => !k.collected)
    .map((item) => ({ item, proj: projectPoint(player, item.x, item.y, width, height, 0.28) }))
    .filter(({ proj }) => proj.depth > 0.2)
    .sort((a, b) => b.proj.depth - a.proj.depth);

  for (const { proj } of visible) {
    const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[centerCol]) continue; // behind a wall

    const size = proj.right - proj.left;
    const cx = proj.screenX;
    // Float the card at roughly waist height, not the floor.
    const cy = height / 2 + size * 0.4;
    ctx.fillStyle = "#8a6d12";
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    ctx.fillStyle = "#f2d64b";
    ctx.fillRect(cx - size / 2 + size * 0.15, cy - size / 2 + size * 0.15, size * 0.7, size * 0.7);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

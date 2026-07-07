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
import type { Decoration, DecorKind, Enemy, KeyItem, LootDrop, Mine, Point, Teleporter } from "../map/types";
import type { CodeEntity, EntityKind } from "../parser/types";
import type { Player } from "./player";

/**
 * One item's draw call, tagged with the camera-space depth it should sort by.
 * Every category of world billboard (enemies, drops, the exit marker,
 * teleporters, decorations, mines, projectiles) is collected into a flat list
 * of these, sorted furthest-to-nearest, and drawn in that single combined
 * order — see `RaycasterEngine`'s `renderWorldBillboards`. Drawing
 * category-by-category in a fixed order (the old approach) let a later
 * category always paint over an earlier one regardless of which was actually
 * closer to the player — e.g. the exit marker, always drawn last, could
 * paint over a nearer ammo drop and make it vanish.
 */
export interface BillboardJob {
  depth: number;
  draw: () => void;
}

/** Sprite footprint as a fraction of a full tile-height billboard. */
const ENEMY_SIZE = 0.7;
/** Elite (boss-tier) enemies render 1.5x the size of a regular one — a
 * silhouette you notice as different before you even read its HP bar. */
const ELITE_SCALE = 1.5;
/**
 * Near clip for sprite billboards, in camera-space depth. Kept well below one
 * tile so an enemy right in the player's face still draws (its projected quad
 * just grows huge and is clamped to the screen) instead of popping out of view.
 */
const SPRITE_NEAR = 0.05;

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

/** An elite's tint overrides its normal kind color entirely — a deep,
 * unmistakable gold that no regular enemy ever shows. */
const ELITE_COLOR = "#f2c230";

/** Body color for `enemy`: its elite tint if it's an Elite, else the normal
 * per-kind color. Hit-flash (a temporary red tint on taking damage) always
 * takes priority over both — see the `draw` callback in
 * `collectEnemyBillboards`. */
function enemyBodyColor(enemy: Enemy): string {
  return enemy.elite ? ELITE_COLOR : enemyColor(enemy.entity.kind);
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

/** Project an enemy into screen space for `player` on a `width`×`height` view.
 * Elites project 1.5x the size of a regular enemy (see `ELITE_SCALE`). */
export function projectEnemy(
  player: Player,
  enemy: Enemy,
  width: number,
  height: number,
): EnemyProjection {
  return projectPoint(player, enemy.x, enemy.y, width, height, enemy.elite ? ENEMY_SIZE * ELITE_SCALE : ENEMY_SIZE);
}

/** Collect all living enemies as billboard draw jobs, occluded by the wall
 * z-buffer. See `BillboardJob` — combined and depth-sorted with every other
 * world-billboard category before anything is actually drawn. */
export function collectEnemyBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  enemies: Enemy[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  return enemies
    .filter((e) => e.alive)
    .map((enemy) => ({ enemy, proj: projectEnemy(player, enemy, width, height) }))
    .filter(({ proj }) => proj.depth > SPRITE_NEAR)
    .map(({ enemy, proj }) => ({
      depth: proj.depth,
      draw: () => {
        const startX = Math.max(0, Math.floor(proj.left));
        const endX = Math.min(width - 1, Math.ceil(proj.right));
        // Clamp the vertical extent to the screen — a point-blank sprite
        // projects taller than the canvas, and an unclamped huge rect is
        // wasteful to fill.
        const startY = Math.max(0, Math.floor(proj.top));
        const endY = Math.min(height - 1, Math.ceil(proj.bottom));
        const spriteH = endY - startY + 1;

        // Body: vertical stripes, skipping columns hidden behind a wall. A
        // recent hit tints the whole body red for a few frames (the "bleed"
        // flash), which takes priority over an Elite's gold tint.
        ctx.fillStyle = enemy.hitFlash > 0 ? "#ff5a4a" : enemyBodyColor(enemy);
        for (let x = startX; x <= endX; x++) {
          if (proj.depth >= zBuffer[x]) continue;
          ctx.fillRect(x, startY, 1, spriteH);
        }

        // Only draw the label / HP bar if the sprite's center isn't wall-occluded.
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth < zBuffer[centerCol]) {
          drawEnemyOverlay(ctx, enemy.entity, enemy.hp, enemy.maxHp, enemy.elite, proj);
        }
      },
    }));
}

function drawEnemyOverlay(
  ctx: CanvasRenderingContext2D,
  entity: CodeEntity,
  hp: number,
  maxHp: number,
  elite: boolean,
  proj: EnemyProjection,
): void {
  const barWidth = Math.min(80, Math.max(20, proj.right - proj.left));
  const barX = proj.screenX - barWidth / 2;
  const barY = proj.top - 12;
  const barH = 4;

  // HP bar: red background, green fill (gold for an Elite, matching its tint).
  ctx.fillStyle = "#3a0d0d";
  ctx.fillRect(barX, barY, barWidth, barH);
  ctx.fillStyle = elite ? ELITE_COLOR : "#37d24a";
  ctx.fillRect(barX, barY, (barWidth * Math.max(0, hp)) / maxHp, barH);

  // Name label above the bar; an Elite additionally gets a small warning
  // caption above that, so its extra toughness/damage reads as intentional
  // rather than the HP bar just looking wrong.
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(barX, barY - 13, barWidth, 11);
  ctx.fillStyle = "#fff";
  ctx.fillText(entity.name, proj.screenX, barY - 4);

  if (elite) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(barX, barY - 26, barWidth, 11);
    ctx.fillStyle = ELITE_COLOR;
    ctx.font = "bold 9px monospace";
    ctx.fillText("⚠ ELITE", proj.screenX, barY - 17);
  }

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
 * The discovered, still-live mine hit by a shot aimed at screen column
 * `screenX` — mirrors `findTargetAtColumn`'s enemy hit-test (same fixed
 * screen-center vertical reticle, no pitch aiming in this engine). Only
 * `visible` mines are hittable at all — you can't shoot what you haven't
 * spotted yet, matching the sight-radius reveal in `traps.ts`.
 */
export function findMineAtColumn(
  player: Player,
  mines: Mine[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Mine | null {
  const cy = height / 2;

  let best: Mine | null = null;
  let bestDepth = Infinity;

  for (const mine of mines) {
    if (!mine.alive || !mine.visible) continue;
    const proj = projectPoint(player, mine.x, mine.y, width, height, MINE_SIZE);
    if (proj.depth <= 0) continue;
    if (screenX < proj.left || screenX > proj.right || cy < proj.top || cy > proj.bottom) {
      continue;
    }

    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    if (proj.depth < bestDepth) {
      best = mine;
      bestDepth = proj.depth;
    }
  }
  return best;
}

/**
 * Collect the green exit marker (the `return` statement) as a billboard draw
 * job at the center of its tile, occluded by walls via the z-buffer. Returns
 * an empty array when it's not renderable at all (too close/behind camera),
 * so callers can always spread the result into a combined job list.
 */
export function collectExitBillboard(
  ctx: CanvasRenderingContext2D,
  player: Player,
  exit: Point,
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const proj = projectPoint(player, exit.x + 0.5, exit.y + 0.5, width, height, 0.9);
  if (proj.depth <= 0.2) return [];

  return [
    {
      depth: proj.depth,
      draw: () => {
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
      },
    },
  ];
}

/** Collect uncollected keys as small floating gold "keycard" billboard draw
 * jobs. */
export function collectKeyBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  keys: KeyItem[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  return keys
    .filter((k) => !k.collected)
    .map((item) => ({ proj: projectPoint(player, item.x, item.y, width, height, 0.28) }))
    .filter(({ proj }) => proj.depth > 0.2)
    .map(({ proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const size = proj.right - proj.left;
        const cx = proj.screenX;
        // Float the card at roughly waist height, not the floor.
        const cy = height / 2 + size * 0.4;
        ctx.fillStyle = "#8a6d12";
        ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
        ctx.fillStyle = "#f2d64b";
        ctx.fillRect(cx - size / 2 + size * 0.15, cy - size / 2 + size * 0.15, size * 0.7, size * 0.7);
      },
    }));
}

/** Backing-panel / fill color pairs per loot kind — a distinct look so a
 * glance tells you what a drop actually is before you walk over it. */
function lootColors(kind: LootDrop["kind"]): { back: string; fill: string } {
  switch (kind) {
    case "bullets":
      return { back: "#0e3540", fill: "#3fd0e0" }; // cyan "RAM chip", unchanged
    case "rockets":
      return { back: "#402210", fill: "#ff8a3f" }; // hot orange
    case "health":
      return { back: "#0e401c", fill: "#3fe06a" }; // green cross
    case "swap":
      return { back: "#101c40", fill: "#4a7fff" }; // blue shard
    case "weapon":
      return { back: "#3a1040", fill: "#e06aff" }; // violet — a rare, special drop
  }
}

/** Collect dropped loot (ammo, health, swap, or a weapon unlock) as small
 * floating billboard draw jobs, colored per `LootDrop.kind` (see
 * `lootColors`). A `"weapon"` drop additionally gets a bright pulsing ring so
 * it never gets mistaken for an ordinary pickup. */
export function collectLootBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  // Structural, not `LootDrop[]`, so the map generator's statically-placed
  // `AmmoPickup`s (bullets/rockets only, no `weaponIndex`) can share this
  // renderer with the engine's runtime enemy-kill drops.
  drops: { x: number; y: number; kind: LootDrop["kind"] }[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);

  return drops
    .map((drop) => ({ kind: drop.kind, proj: projectPoint(player, drop.x, drop.y, width, height, 0.26) }))
    .filter(({ proj }) => proj.depth > 0.2)
    .map(({ kind, proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const size = proj.right - proj.left;
        const cx = proj.screenX;
        // Float the pickup at roughly waist height, not the floor.
        const cy = height / 2 + size * 0.45;
        const { back, fill } = lootColors(kind);
        if (kind === "weapon") {
          ctx.strokeStyle = `rgba(224,106,255,${0.5 + 0.5 * pulse})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(cx - size * 0.75, cy - size * 0.75, size * 1.5, size * 1.5);
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = back;
        ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
        ctx.fillStyle = fill;
        ctx.fillRect(cx - size / 2 + size * 0.18, cy - size / 2 + size * 0.18, size * 0.64, size * 0.64);
      },
    }));
}

/** Footprint (fraction of a full tile-height billboard) per decoration kind. */
function decorSizeFactor(kind: DecorKind): number {
  switch (kind) {
    case "rack":
      return 0.85; // tall server tower
    case "desk":
      return 0.5;
    case "plant":
      return 0.45;
    case "block":
      return 0.55;
  }
}

/**
 * Collect cosmetic, non-blocking props (server racks, plants, desks, abstract
 * code-blocks) as floor-standing billboard draw jobs, occluded by the wall
 * z-buffer. Purely visual set dressing — no collision, no interaction.
 */
export function collectDecorationBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  decorations: Decoration[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  return decorations
    .map((d) => ({ kind: d.kind, proj: projectPoint(player, d.x, d.y, width, height, decorSizeFactor(d.kind)) }))
    .filter(({ proj }) => proj.depth > 0.2)
    .map(({ kind, proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        // Anchor to the true floor scanline at this depth — the same line a
        // full-height wall's bottom edge would project to — rather than a
        // fraction of the billboard's own (possibly short) size. Using the
        // billboard's size for the vertical anchor is what made shorter props
        // (the plant, the desk) float above the ground instead of standing on it.
        const w = proj.right - proj.left;
        const groundY = height / 2 + height / proj.depth / 2;
        drawDecoration(ctx, kind, proj.screenX, w, groundY);
      },
    }));
}

function drawDecoration(
  ctx: CanvasRenderingContext2D,
  kind: DecorKind,
  cx: number,
  w: number,
  groundY: number,
): void {
  const top = groundY - w;

  switch (kind) {
    case "rack": {
      // A dark server tower with a column of small blinking status lights.
      ctx.fillStyle = "#33383e";
      ctx.fillRect(cx - w / 2, top, w, w);
      ctx.fillStyle = "#1c1f23";
      ctx.fillRect(cx - w / 2, top, w, w * 0.08); // top vent bar
      // Lights sit on the object's vertical centerline (not off to one side):
      // since a billboard always faces the camera, an off-center detail would
      // visibly swing around the object as you walk past it.
      const lightColors = ["#37d24a", "#37d24a", "#e0483a"];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = lightColors[i];
        ctx.fillRect(cx - w * 0.06, top + w * (0.2 + i * 0.2), w * 0.12, w * 0.12);
      }
      break;
    }
    case "plant": {
      // A brown pot with a rounded green top.
      const potH = w * 0.5;
      ctx.fillStyle = "#5a3d24";
      ctx.fillRect(cx - w / 2, groundY - potH, w, potH);
      ctx.fillStyle = "#2f7a38";
      ctx.fillRect(cx - w * 0.55, groundY - potH - w * 0.6, w * 1.1, w * 0.7);
      ctx.fillStyle = "#3f9a4a";
      ctx.fillRect(cx - w * 0.3, groundY - potH - w * 0.85, w * 0.6, w * 0.4);
      break;
    }
    case "desk": {
      // A low, wide tabletop on short legs (mirrored left/right of center).
      const legH = w * 0.5;
      const topH = w * 0.18;
      ctx.fillStyle = "#3a2a18";
      ctx.fillRect(cx - w / 2, groundY - legH, w * 0.08, legH);
      ctx.fillRect(cx + w * 0.42, groundY - legH, w * 0.08, legH);
      ctx.fillStyle = "#6a4a2a";
      ctx.fillRect(cx - w / 2, groundY - legH - topH, w, topH);
      break;
    }
    case "block": {
      // A translucent, glowing abstract code-block cube.
      ctx.fillStyle = "rgba(74,111,212,0.55)";
      ctx.fillRect(cx - w / 2, top, w, w);
      ctx.fillStyle = "rgba(160,190,255,0.75)";
      ctx.fillRect(cx - w * 0.3, top + w * 0.3, w * 0.6, w * 0.4);
      break;
    }
  }
}

/** Footprint (fraction of a full tile-height billboard) for a teleporter pad. */
const PORTAL_SIZE = 0.8;
/** Violet, matching the teleporter floor tint and automap/minimap markers. */
const PORTAL_RGB = "168,85,247";

/**
 * Collect goto/label teleporter pads as glowing, pulsing violet UT-style
 * portal billboard draw jobs, floor-anchored the same way as decorations.
 * Purely visual — the engine handles the actual warp when the player's tile
 * matches a pad.
 */
export function collectTeleporterBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  teleporters: Teleporter[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 220);

  return teleporters
    .map((t) => ({ proj: projectPoint(player, t.x, t.y, width, height, PORTAL_SIZE) }))
    .filter(({ proj }) => proj.depth > 0.15)
    .map(({ proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const w = proj.right - proj.left;
        const groundY = height / 2 + height / proj.depth / 2;
        const cx = proj.screenX;
        const ringH = w * 1.6;
        const top = groundY - ringH;

        // A glowing violet energy column: a translucent fill, a bright
        // pulsing outline, and a brighter core — reads as "active" rather
        // than a static prop, the way UT's teleporters shimmer.
        ctx.fillStyle = `rgba(${PORTAL_RGB},${0.18 + 0.12 * pulse})`;
        ctx.fillRect(cx - w / 2, top, w, ringH);
        ctx.strokeStyle = `rgba(${PORTAL_RGB},${0.6 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(1, w * 0.08);
        ctx.strokeRect(cx - w / 2, top, w, ringH);
        ctx.fillStyle = `rgba(230,210,255,${0.35 + 0.35 * pulse})`;
        ctx.fillRect(cx - w * 0.22, top + ringH * 0.15, w * 0.44, ringH * 0.7);
      },
    }));
}

/** Footprint (fraction of a full tile-height billboard) for a proximity mine —
 * shared between rendering and hit-testing so what you see is what you hit. */
const MINE_SIZE = 0.42;

/**
 * Collect discovered-but-undetonated proximity mines as a low, pulsing red
 * warning device draw jobs. Invisible (never drawn at all) until the engine
 * marks `visible` true, so stumbling into one's sight radius is the only way
 * to ever see it coming.
 */
export function collectMineBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  mines: Mine[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  // A slower, brighter pulse than the original — playtest feedback was that
  // mines were too easy to miss even once revealed.
  const pulse = 0.4 + 0.6 * Math.sin(performance.now() / 220);

  return mines
    .filter((m) => m.alive && m.visible)
    .map((m) => ({ proj: projectPoint(player, m.x, m.y, width, height, MINE_SIZE) }))
    .filter(({ proj }) => proj.depth > 0.15)
    .map(({ proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const w = proj.right - proj.left;
        const groundY = height / 2 + height / proj.depth / 2;
        const cx = proj.screenX;
        const bodyH = w * 0.6;

        ctx.fillStyle = "#2a1414";
        ctx.fillRect(cx - w / 2, groundY - bodyH, w, bodyH);
        ctx.fillStyle = `rgba(255,60,40,${0.65 + 0.35 * pulse})`;
        ctx.fillRect(cx - w * 0.26, groundY - bodyH * 0.8, w * 0.52, w * 0.52);
      },
    }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

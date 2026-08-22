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
import { drawDisc, fillLine, outlineRect } from "./pathSprites";
import { clamp } from "../mathUtil";

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
/** Edge Case enemies render at roughly half the size of a regular one — small
 * and jarring, reads as "not supposed to be here". */
const EDGE_CASE_SCALE = 0.55;
/** An Edge Case enemy's tint: an unmistakable "glitch" cyan that overrides
 * both its (synthetic) kind color and being confused for an Elite. Exported
 * so the minimap dot (`raycaster.ts`) can match it. */
export const EDGE_CASE_COLOR = "#00FFFF";
/**
 * Near clip for sprite billboards, in camera-space depth. Kept well below one
 * tile so an enemy right in the player's face still draws (its projected quad
 * just grows huge and is clamped to the screen) instead of popping out of view.
 */
const SPRITE_NEAR = 0.05;
/**
 * The other three near-clip depths, one per billboard family. They were inline
 * literals until now, which made "at what distance does this kind pop out of
 * view" answerable only by reading eight call sites.
 *
 * **The values are preserved exactly as they were** — this names them, it does
 * not unify them. Whether the four tiers are a deliberate per-kind tuning or
 * just accreted isn't recorded anywhere, and no test pins any of them (the two
 * that exercise a near clip place the entity at the player's exact position or
 * behind the camera, so any value in this range satisfies them). Naming them is
 * the prerequisite for someone deciding that later; guessing at a single shared
 * value now would be a behaviour change dressed up as a cleanup.
 */
const ORB_NEAR = 0.1;
/** Exit marker, keys, loot drops, decorations. */
const MARKER_NEAR = 0.2;
/** Teleporter pads and mines — floor-level markers, so they stay visible a
 * little closer in than the upright markers above. */
const PAD_NEAR = 0.15;

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

/** Gate tones for key sprites — a dark bezel plus the gate's own face colour,
 * by value rather than shared import, following the same convention as every
 * other colour table in the renderers. Indexed by `Gate.colorIndex`. */
const KEY_GATE_COLORS = [
  { back: "#40100c", fill: "#d63a30" }, // red
  { back: "#0c1c40", fill: "#3470d6" }, // blue
  { back: "#0c3018", fill: "#34b25c" }, // green
  { back: "#2c0c40", fill: "#a848d6" }, // violet
];

/** An elite's tint overrides its normal kind color entirely — a deep,
 * unmistakable gold that no regular enemy ever shows. */
const ELITE_COLOR = "#f2c230";

/** Body color for `enemy`: its elite tint if it's an Elite, else the normal
 * per-kind color. Hit-flash (a temporary red tint on taking damage) always
 * takes priority over both — see the `draw` callback in
 * `collectEnemyBillboards`. */
function enemyBodyColor(enemy: Enemy): string {
  if (enemy.edgeCase) return EDGE_CASE_COLOR;
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
 * Elites project 1.5x the size of a regular enemy (see `ELITE_SCALE`); Edge
 * Case enemies project roughly half-size (see `EDGE_CASE_SCALE`).
 *
 * `positionOverride`, when given, projects from that position instead of the
 * enemy's own live `x`/`y` — used only for multiplayer's lag-compensated hit
 * resolution (see `RaycasterEngine.rewoundEnemyPositions()`'s doc comment).
 * Every other caller (rendering included — a billboard must always show
 * where the enemy actually, currently is) omits it and gets exactly today's
 * live-position behavior. */
export function projectEnemy(
  player: Player,
  enemy: Enemy,
  width: number,
  height: number,
  positionOverride?: { x: number; y: number },
): EnemyProjection {
  const sizeFactor = enemy.edgeCase
    ? ENEMY_SIZE * EDGE_CASE_SCALE
    : enemy.elite
      ? ENEMY_SIZE * ELITE_SCALE
      : ENEMY_SIZE;
  const pos = positionOverride ?? enemy;
  return projectPoint(player, pos.x, pos.y, width, height, sizeFactor);
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
          drawEnemyOverlay(ctx, enemy.entity, enemy.hp, enemy.maxHp, enemy.elite, enemy.edgeCase, proj);
        }
      },
    }));
}

/** A living, connected teammate the local viewer can see — never the viewer
 * themselves (they're the camera, never billboarded; enforced by the
 * caller's list construction, not an identity check here) and never a dead
 * teammate (they've left the world simulation — see
 * `RaycasterEngine.killPlayer`). `color` is that player's distinct marker
 * color, reused for their automap/minimap dot too (one color source, not
 * two). */
export interface OtherPlayerBillboard {
  player: Player;
  color: string;
  /** Already resolved and sanitized upstream (`PlayerState.displayName`) —
   * this is drawn as-is, never re-derived from a roster id here. */
  name: string;
}

/**
 * The same teammate, reduced to what the two map renderers need: a position in
 * tile space, their marker colour, and whether they are currently calling for
 * help.
 *
 * Deliberately a flat value type rather than a `PlayerState`: `renderMinimap`
 * and `drawAutomap` are pure drawing functions that know nothing about the
 * roster, and handing them engine state would be the first time either did.
 * The `color` is the same one `OtherPlayerBillboard` carries, from the same
 * `colorForPlayer` call — which is what makes the comment above true rather
 * than aspirational.
 */
export interface TeammateMapMarker {
  x: number;
  y: number;
  color: string;
  /** True while this player's coop help ping is live — the marker is drawn
   * brightened and wrapped in a sonar ring, rather than as a plain dot. */
  helpPing: boolean;
}

/** Collect every other connected, living player as a billboard draw job,
 * occluded by the wall z-buffer — the same vertical-stripe fill
 * `collectEnemyBillboards` uses, tinted per player instead of by hit-flash/
 * Elite state, with that player's name above it and no HP bar (a teammate's
 * health is already on the HUD's roster, and repeating it in the world would
 * read as an enemy's). */
export function collectPlayerBillboards(
  ctx: CanvasRenderingContext2D,
  viewer: Player,
  others: readonly OtherPlayerBillboard[],
  zBuffer: Float64Array,
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  return others
    .map(({ player, color, name }) => ({ color, name, proj: projectPoint(viewer, player.posX, player.posY, width, height) }))
    .filter(({ proj }) => proj.depth > SPRITE_NEAR)
    .map(({ color, name, proj }) => ({
      depth: proj.depth,
      draw: () => {
        const startX = Math.max(0, Math.floor(proj.left));
        const endX = Math.min(width - 1, Math.ceil(proj.right));
        const startY = Math.max(0, Math.floor(proj.top));
        const endY = Math.min(height - 1, Math.ceil(proj.bottom));
        const spriteH = endY - startY + 1;

        ctx.fillStyle = color;
        for (let x = startX; x <= endX; x++) {
          if (proj.depth >= zBuffer[x]) continue;
          ctx.fillRect(x, startY, 1, spriteH);
        }

        // Same rule the enemy overlay uses: only label a sprite whose center
        // column isn't wall-occluded, so a name never floats over the wall a
        // teammate is standing behind.
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth < zBuffer[centerCol]) drawPlayerNameLabel(ctx, name, color, proj);
      },
    }));
}

/** Deliberately built to `drawEnemyOverlay`'s conventions — same 10px
 * monospace, same centered alignment, same translucent black plate for
 * legibility against any wall, same restore of `textAlign` on the way out —
 * so a teammate's label and an enemy's read as one game rather than two
 * people's ideas of a label. It sits where the enemy's *name* line sits
 * (`top - 13`), not where the HP bar does; teammates have no bar, so nothing
 * occupies the row between. Tinted with the player's own marker color, which
 * is what ties the label to the dot on the automap and minimap. */
function drawPlayerNameLabel(ctx: CanvasRenderingContext2D, name: string, color: string, proj: EnemyProjection): void {
  ctx.font = "10px monospace";
  // Sized to the *text*, not to the sprite the way `drawEnemyOverlay`'s HP
  // bar is — that bar is a gauge whose width means something, whereas this
  // plate exists only to keep the text readable against a wall. Measured
  // rather than estimated: a distant teammate's sprite is a few pixels wide,
  // so a sprite-width plate leaves most of the name sitting on bare wall
  // (seen directly, which is why this doesn't just copy the enemy version).
  const plateWidth = ctx.measureText(name).width + 8;
  const plateX = proj.screenX - plateWidth / 2;
  const plateY = proj.top - 13;

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(plateX, plateY, plateWidth, 11);
  ctx.fillStyle = color;
  ctx.fillText(name, proj.screenX, plateY + 9);
  ctx.textAlign = "start";
}

function drawEnemyOverlay(
  ctx: CanvasRenderingContext2D,
  entity: CodeEntity,
  hp: number,
  maxHp: number,
  elite: boolean,
  edgeCase: boolean,
  proj: EnemyProjection,
): void {
  const barWidth = Math.min(80, Math.max(20, proj.right - proj.left));
  const barX = proj.screenX - barWidth / 2;
  const barY = proj.top - 12;
  const barH = 4;

  // HP bar: red background, green fill (gold for an Elite, cyan for an Edge
  // Case, matching each one's tint).
  ctx.fillStyle = "#3a0d0d";
  ctx.fillRect(barX, barY, barWidth, barH);
  ctx.fillStyle = elite ? ELITE_COLOR : edgeCase ? EDGE_CASE_COLOR : "#37d24a";
  ctx.fillRect(barX, barY, (barWidth * Math.max(0, hp)) / maxHp, barH);

  // Name label above the bar; an Elite/Edge Case additionally gets a small
  // warning caption above that, so its stats reading differently from a
  // normal enemy's feels intentional rather than the HP bar just looking wrong.
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
  } else if (edgeCase) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(barX, barY - 26, barWidth, 11);
    ctx.fillStyle = EDGE_CASE_COLOR;
    ctx.font = "bold 9px monospace";
    ctx.fillText("⚠ EDGE CASE", proj.screenX, barY - 17);
  }

  ctx.textAlign = "start";
}

/** One living enemy's projection, snapshotted for reuse across multiple
 * hit-tests against the same camera — see `projectLivingEnemies`. */
export interface ProjectedEnemy {
  enemy: Enemy;
  proj: EnemyProjection;
}

/**
 * Project every living enemy once, for reuse across multiple hit-tests
 * against the same shot (e.g. every pellet of one shotgun blast) instead of
 * recomputing each enemy's projection from scratch per pellet — see
 * `findTargetInProjections`.
 *
 * `positions`, when given, overrides individual enemies' projected position
 * (looked up by object reference — see `projectEnemy`'s doc comment); an
 * enemy missing from the map falls back to its own live position. Omitted
 * for every caller except multiplayer's lag-compensated hit resolution.
 */
export function projectLivingEnemies(
  player: Player,
  enemies: Enemy[],
  width: number,
  height: number,
  positions?: ReadonlyMap<Enemy, { x: number; y: number }>,
): ProjectedEnemy[] {
  const result: ProjectedEnemy[] = [];
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const proj = projectEnemy(player, enemy, width, height, positions?.get(enemy));
    if (proj.depth <= 0) continue;
    result.push({ enemy, proj });
  }
  return result;
}

/**
 * Find the living enemy hit by a ray aimed at screen point (`screenX`, mid-
 * height), in front of the nearest wall — nearest one wins. Returns `null`
 * when nothing is hit. Tests against an already-projected list from
 * `projectLivingEnemies` rather than reprojecting, but still re-checks
 * `enemy.alive` per entry: an earlier pellet in the same shot can kill an
 * enemy mid-loop, which the projection snapshot itself doesn't reflect.
 */
export function findTargetInProjections(
  projected: ProjectedEnemy[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Enemy | null {
  const cy = height / 2;

  let best: Enemy | null = null;
  let bestDepth = Infinity;

  for (const { enemy, proj } of projected) {
    if (!enemy.alive) continue;
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

/**
 * Find the living enemy hit by a ray aimed at screen point (`screenX`, mid-
 * height), in front of the nearest wall — nearest one wins. Returns `null`
 * when nothing is hit. Used for the aim reticle, which only ever needs one
 * hit-test per frame — a shot with multiple pellets should instead call
 * `projectLivingEnemies` once and reuse it via `findTargetInProjections`.
 */
export function findTargetAtColumn(
  player: Player,
  enemies: Enemy[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Enemy | null {
  return findTargetInProjections(projectLivingEnemies(player, enemies, width, height), zBuffer, width, height, screenX);
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

/** One visible, still-live mine's projection, snapshotted for reuse across
 * multiple hit-tests against the same camera — see `projectVisibleMines`. */
export interface ProjectedMine {
  mine: Mine;
  proj: EnemyProjection;
}

/**
 * Project every discovered, still-live mine once, for reuse across multiple
 * hit-tests against the same shot — see `findMineInProjections`. Only
 * `visible` mines are hittable at all — you can't shoot what you haven't
 * spotted yet, matching the sight-radius reveal in `traps.ts`.
 */
export function projectVisibleMines(player: Player, mines: Mine[], width: number, height: number): ProjectedMine[] {
  const result: ProjectedMine[] = [];
  for (const mine of mines) {
    if (!mine.alive || !mine.visible) continue;
    const proj = projectPoint(player, mine.x, mine.y, width, height, MINE_SIZE);
    if (proj.depth <= 0) continue;
    result.push({ mine, proj });
  }
  return result;
}

/**
 * The discovered, still-live mine hit by a shot aimed at screen column
 * `screenX` — mirrors `findTargetInProjections`'s enemy hit-test (same fixed
 * screen-center vertical reticle, no pitch aiming in this engine). Tests
 * against an already-projected list from `projectVisibleMines`, re-checking
 * `mine.alive` per entry since an earlier pellet in the same shot can destroy
 * a mine mid-loop.
 */
export function findMineInProjections(
  projected: ProjectedMine[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Mine | null {
  const cy = height / 2;

  let best: Mine | null = null;
  let bestDepth = Infinity;

  for (const { mine, proj } of projected) {
    if (!mine.alive) continue;
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
 * The discovered, still-live mine hit by a shot aimed at screen column
 * `screenX` — mirrors `findTargetAtColumn`'s enemy hit-test. A shot with
 * multiple pellets should instead call `projectVisibleMines` once and reuse
 * it via `findMineInProjections`.
 */
export function findMineAtColumn(
  player: Player,
  mines: Mine[],
  zBuffer: Float64Array,
  width: number,
  height: number,
  screenX: number,
): Mine | null {
  return findMineInProjections(projectVisibleMines(player, mines, width, height), zBuffer, width, height, screenX);
}

/** Halo/core/center fill colors for a small glowing orb billboard — the only
 * thing that differs between an enemy bolt and a player rocket in flight. */
export interface OrbPalette {
  halo: string;
  core: string;
  center: string;
}

/**
 * Collect small glowing orb billboards flying at eye level, wall-occluded via
 * the z-buffer — the one shared draw routine behind
 * `collectProjectileBillboards` (enemy bolts) and `collectRocketBillboards`
 * (player rockets), which differ only in palette. See `BillboardJob`.
 *
 * `palette` may be a function of the point rather than a single value, which
 * is what lets one call colour each enemy bolt by the archetype that fired it
 * without grouping the list into a temporary array per archetype first. The
 * plain-object form is unchanged and still the common case (rockets, and any
 * caller with one colour).
 */
export function collectOrbBillboards<P extends Point>(
  ctx: CanvasRenderingContext2D,
  player: Player,
  points: readonly P[],
  zBuffer: Float64Array,
  palette: OrbPalette | ((point: P) => OrbPalette),
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const paletteFor = typeof palette === "function" ? palette : () => palette;

  return points
    .map((p) => ({ proj: projectPoint(player, p.x, p.y, width, height, 0.3), palette: paletteFor(p) }))
    .filter(({ proj }) => proj.depth > ORB_NEAR)
    .map(({ proj, palette }) => ({
      depth: proj.depth,
      draw: () => {
        const col = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[col]) return; // behind a wall

        const size = Math.max(3, (proj.right - proj.left) * 0.5);
        const cx = proj.screenX;
        const cy = height / 2; // orbs fly at eye level
        ctx.fillStyle = palette.halo;
        ctx.fillRect(cx - size, cy - size, size * 2, size * 2);
        ctx.fillStyle = palette.core;
        ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
        ctx.fillStyle = palette.center;
        ctx.fillRect(cx - size / 4, cy - size / 4, size / 2, size / 2);
      },
    }));
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
  if (proj.depth <= MARKER_NEAR) return [];

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

/** Collect uncollected keys as small floating "keycard" billboard draw jobs,
 * each in its own gate's colour (`gateColors`, indexed by `KeyItem.gateId`).
 * A caller that omits `gateColors` gets the `?? 1` fallback for *every* key,
 * which reads as "all keys are blue" rather than as a missing argument — see
 * the call site in `engine.ts`, where exactly that went unnoticed. */
export function collectKeyBillboards(
  ctx: CanvasRenderingContext2D,
  player: Player,
  keys: KeyItem[],
  zBuffer: Float64Array,
  gateColors: readonly number[] = [],
): BillboardJob[] {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  return keys
    .filter((k) => !k.collected)
    .map((item) => ({
      // The key is drawn in its own gate's colour — the whole point being that
      // you can tell from across the room which door it fits. `?? 1` covers a
      // map with no gate table (test fixtures), landing on the old blue-ish
      // reading rather than crashing.
      tone: KEY_GATE_COLORS[gateColors[item.gateId] ?? 1],
      proj: projectPoint(player, item.x, item.y, width, height, 0.28),
    }))
    .filter(({ proj }) => proj.depth > MARKER_NEAR)
    .map(({ proj, tone }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const size = proj.right - proj.left;
        const cx = proj.screenX;
        // Float the card at roughly waist height, not the floor.
        const cy = height / 2 + size * 0.4;
        ctx.fillStyle = tone.back;
        ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
        ctx.fillStyle = tone.fill;
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
    case "shells":
      // Deliberately far from the bullets cyan next to it: these are two
      // separate pools now, and a drop you can only use with one of your two
      // starting weapons has to read as different at a glance. Amber, matching
      // its own HUD readout rather than the shotgun's orange tracer, which is
      // already the rockets colour.
      return { back: "#402f10", fill: "#ffb547" };
    case "rockets":
      return { back: "#402210", fill: "#ff8a3f" }; // hot orange
    case "smg":
      return { back: "#102540", fill: "#3fa9ff" }; // gdb blue, matches its tracer/HUD color
    case "gas":
      return { back: "#401e10", fill: "#ff8a4a" }; // Friday Hotfix's fiery orange, matches its tracer/HUD color
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
    .filter(({ proj }) => proj.depth > MARKER_NEAR)
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
          outlineRect(ctx, cx - size * 0.75, cy - size * 0.75, size * 1.5, size * 1.5);
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
    .filter(({ proj }) => proj.depth > MARKER_NEAR)
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
    .filter(({ proj }) => proj.depth > PAD_NEAR)
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
        outlineRect(ctx, cx - w / 2, top, w, ringH);
        ctx.fillStyle = `rgba(230,210,255,${0.35 + 0.35 * pulse})`;
        ctx.fillRect(cx - w * 0.22, top + ringH * 0.15, w * 0.44, ringH * 0.7);
      },
    }));
}

/** Footprint (fraction of a full tile-height billboard) for a proximity mine —
 * shared between rendering and hit-testing so what you see is what you hit. */
const MINE_SIZE = 0.42;

/** The mine's dome and its pulsing lens, as `drawDisc` "r,g,b" strings.
 *
 * Kept as constants rather than inlined because `drawDisc` caches a rendered
 * sprite keyed on this string — passing a per-frame value (an alpha baked into
 * the colour, say) would allocate a fresh sprite every frame. The pulse is
 * therefore applied through `drawDisc`'s separate `alpha` argument.
 *
 * The dome is a touch lighter than the `#2a1414` body it replaced, and that is
 * deliberate compensation rather than a restyle: the old silhouette was a
 * `w x 0.6w` rectangle, and a dome of radius `0.28w` covers roughly a fifth of
 * that area. Holding the tone would have meant a much smaller dark mass against
 * near-black floor tiles — quietly undoing the earlier playtest fix that made
 * mines easier to spot. The plate keeps the original darker tone, so the two
 * parts still separate. */
const MINE_BODY_RGB = "58,26,24";
const MINE_LENS_RGB = "255,60,40";

/** The base plate the dome stands on — darker than the dome, so the device
 * reads as two parts rather than one blob. */
const MINE_PLATE = "#2a1414";

/**
 * Collect discovered-but-undetonated proximity mines as a low, pulsing red
 * warning device draw jobs. Invisible (never drawn at all) until the engine
 * marks `visible` true, so stumbling into one's sight radius is the only way
 * to ever see it coming.
 *
 * **The silhouette is round and spiky on purpose, and that is the whole point
 * of this function.** A mine used to be drawn as a dark rectangle with a
 * brighter square inside it — which is precisely the shape every *pickup* in
 * the game uses (see `collectLootBillboards` and `collectKeyBillboards`, and
 * the design rule stated in `doc/user/colors-and-pickups.md`: colour is the
 * only thing that separates one pickup from another). That made the one
 * entity in the game that deals 32 damage wear the collectible uniform, and
 * left ~41 points of red channel as the only thing distinguishing it from a
 * red keycard. A playtest report put it plainly: "red key and mine look almost
 * the same, i actively avoid it by reflex."
 *
 * So a mine is a dome bolted to a base plate, with three prongs and a pulsing
 * lens. It differs from a keycard in *outline*, not in hue — which is what
 * makes it hold up at distance, where the two old cues (the key floats at
 * waist height, the mine pulses) both collapse: the `height/depth` term shrinks
 * toward the horizon and the pulse becomes a couple of flickering pixels. It is
 * also the reason this survives red-green colour blindness, under which the old
 * pair were the same object.
 *
 * The red and the pulse are deliberately *unchanged*. They are load-bearing
 * from an earlier playtest fix (mines were too easy to miss even once
 * revealed), so this change buys identity without spending conspicuity.
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
    .filter(({ proj }) => proj.depth > PAD_NEAR)
    .map(({ proj }) => ({
      depth: proj.depth,
      draw: () => {
        const centerCol = clamp(Math.round(proj.screenX), 0, width - 1);
        if (proj.depth >= zBuffer[centerCol]) return; // behind a wall

        const w = proj.right - proj.left;
        const groundY = height / 2 + height / proj.depth / 2;
        const cx = proj.screenX;
        const domeR = w * 0.28;
        const plateH = w * 0.14;
        // The dome rests *on* the floor line rather than straddling it: its
        // centre is exactly one radius up, so its lowest pixel lands on
        // `groundY`. Getting this wrong is what the first draft did — a disc
        // centred on the plate hangs 0.18w below the floor and reads as a ball
        // half-sunk into the ground with a belt across it, not as a device
        // standing on a base.
        const domeCy = groundY - domeR;

        // Dome first, plate over it: the plate hides the disc's bottom slice,
        // which buys a flat-bottomed dome without an arc path (banned on this
        // canvas — see `renderCost.test.ts`).
        drawDisc(ctx, MINE_BODY_RGB, 1, cx, domeCy, domeR);
        ctx.fillStyle = MINE_PLATE;
        ctx.fillRect(cx - w / 2, groundY - plateH, w, plateH);

        // Prongs, at roughly 10 / 12 / 2 o'clock. Skipped once they would be
        // sub-pixel: below ~6px of footprint they read as noise rather than as
        // spikes, and a distant mine is better served by a clean pulsing dot
        // than by three stray pixels.
        if (w >= 6) {
          const prongW = Math.max(1, w * 0.04);
          ctx.fillStyle = `rgba(${MINE_LENS_RGB},${0.5 + 0.3 * pulse})`;
          const shoulderY = domeCy - domeR * 0.55;
          fillLine(ctx, cx - domeR * 0.7, shoulderY, cx - domeR * 1.2, shoulderY - domeR * 0.9, prongW);
          fillLine(ctx, cx, domeCy - domeR, cx, domeCy - domeR * 2.05, prongW);
          fillLine(ctx, cx + domeR * 0.7, shoulderY, cx + domeR * 1.2, shoulderY - domeR * 0.9, prongW);
        }

        // The lens carries the pulse — same colour and same breathing range as
        // before, so the mine is no less noticeable than it was.
        drawDisc(ctx, MINE_LENS_RGB, 0.65 + 0.35 * pulse, cx, domeCy - domeR * 0.3, w * 0.1);
      },
    }));
}


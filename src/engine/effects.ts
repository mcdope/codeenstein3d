// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Transient "game feel" effects layered over the raycast scene: a full-screen
 * red damage flash, weapon bullet-tracer lines, and falling "digital blood"
 * particles.
 *
 * The engine owns the effect *state* (a flash counter plus a tracer and a blood
 * list); this module owns the types, the per-frame integration, and the
 * drawing. Timers are frame-based (damage flash, tracers) where the brief is
 * specified in frames, and time-based for the blood physics.
 */
import { projectPoint } from "./sprites";
import type { Player } from "./player";

/** Frames a full-strength player damage flash lasts before fading to 0. */
export const DAMAGE_FLASH_FRAMES = 12;
/** Frames a bullet tracer line stays on screen. */
export const BULLET_TRACE_FRAMES = 4;
/** Frames an enemy sprite stays tinted red after being hit. */
export const HIT_FLASH_FRAMES = 5;
/** Gravity pulling blood pixels toward the floor, in tiles/sec². */
const BLOOD_GRAVITY = 6;

/** A weapon tracer: a fading screen-space line from the muzzle to the impact. */
export interface BulletTrace {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Frames of life remaining; the line fades linearly to 0. */
  frames: number;
}

/** One "digital blood" pixel, in world (tile) space, falling under gravity. */
export interface BloodParticle {
  /** Tile-space horizontal position. */
  x: number;
  y: number;
  /** Height above the floor, in tiles (0 = resting on the floor). */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds of life remaining. */
  life: number;
}

/** Overlay the whole canvas with red at `0.4 * intensity` (intensity 0..1). */
export function drawDamageFlash(ctx: CanvasRenderingContext2D, intensity: number): void {
  if (intensity <= 0) return;
  ctx.fillStyle = `rgba(255,0,0,${(0.4 * intensity).toFixed(3)})`;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Create a muzzle→impact tracer for a shot aimed at screen (`toX`,`toY`). */
export function makeBulletTrace(
  width: number,
  height: number,
  toX: number,
  toY: number,
): BulletTrace {
  return { x1: width / 2, y1: height, x2: toX, y2: toY, frames: BULLET_TRACE_FRAMES };
}

/** Draw all live tracers as bright yellow lines, fading with remaining frames. */
export function drawBulletTraces(ctx: CanvasRenderingContext2D, traces: BulletTrace[]): void {
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  for (const t of traces) {
    const alpha = 0.9 * Math.max(0, t.frames / BULLET_TRACE_FRAMES);
    ctx.strokeStyle = `rgba(255,240,90,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(t.x1, t.y1);
    ctx.lineTo(t.x2, t.y2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

/** Age tracer lifetimes by one frame, dropping expired ones (in place). */
export function tickBulletTraces(traces: BulletTrace[]): void {
  for (let i = traces.length - 1; i >= 0; i--) {
    if (--traces[i].frames <= 0) traces.splice(i, 1);
  }
}

/** Spawn a burst of `count` blood pixels bursting out from (x,y) at body height. */
export function spawnBlood(
  list: BloodParticle[],
  x: number,
  y: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.4 + Math.random() * 0.8; // tiles/sec, outward
    list.push({
      x,
      y,
      z: 0.4 + Math.random() * 0.3, // start around mid-body height
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: 0.6 + Math.random() * 0.8, // initial upward kick
      life: 0.5 + Math.random() * 0.2,
    });
  }
}

/** Integrate blood particles by `dt`, removing those that expired (in place). */
export function updateBlood(list: BloodParticle[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.vz -= BLOOD_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    if (p.z <= 0) {
      // Settle on the floor tile and skid to a stop.
      p.z = 0;
      p.vz = 0;
      p.vx *= 0.4;
      p.vy *= 0.4;
    }
    if (p.life <= 0) list.splice(i, 1);
  }
}

/** Project and draw blood pixels as small red squares, wall-occluded via zBuffer. */
export function renderBlood(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: BloodParticle[],
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.fillStyle = "#c81e1e";
  for (const p of list) {
    const proj = projectPoint(player, p.x, p.y, width, height, 1);
    if (proj.depth <= 0.2) continue;
    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    const tilePx = proj.bottom - proj.top; // pixels per world tile at this depth
    const sy = proj.bottom - p.z * tilePx; // lift off the floor by the particle height
    const s = Math.max(1, Math.round(tilePx * 0.05));
    ctx.fillRect(Math.round(proj.screenX) - (s >> 1), Math.round(sy) - (s >> 1), s, s);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

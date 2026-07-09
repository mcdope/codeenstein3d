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

/** Frames a flame stream stays drawn — a touch longer than a bullet tracer so
 * the fanning wedge reads as a stream rather than flickering in and out. */
const FLAME_STREAM_FRAMES = 6;

/** Handful of embers spawned per flamethrower hit — far fewer than a rocket's
 * `EXPLOSION_PARTICLE_COUNT`, since Friday Hotfix can land several hits a
 * second and a full detonation-sized burst per pellet would flood the list. */
const BURN_PARTICLE_COUNT = 4;
/** Gravity pulling a burn ember down before it settles, in tiles/sec² —
 * lighter than `EXPLOSION_PARTICLE_GRAVITY` for a slower, lingering fall. */
const BURN_GRAVITY = 4;
/** Seconds a settled burn ember keeps glowing before fading out — an order of
 * magnitude longer than its airborne life, since a quick mid-air burst alone
 * read as barely noticeable in playtesting. */
const BURN_SETTLED_LIFE = 1.6;
/** Frames an enemy sprite stays tinted red after being hit. */
export const HIT_FLASH_FRAMES = 5;
/** Gravity pulling blood pixels toward the floor, in tiles/sec². */
const BLOOD_GRAVITY = 6;
/** Seconds a landed blood particle lingers as a "floor stain" at the Normal
 * (1x) gore level, before `GoreMultipliers.stainDuration` scales it. */
const BASE_STAIN_LIFE = 1.5;
/** Seconds a rocket-blast VFX circle stays on screen. */
const EXPLOSION_LIFE = 0.35;
/** Gravity pulling explosion debris back down, in tiles/sec² — lighter than
 * `BLOOD_GRAVITY` so sparks hang in the air a beat longer than a blood pixel. */
const EXPLOSION_PARTICLE_GRAVITY = 5;
/** How many debris/spark particles one rocket detonation kicks up. */
const EXPLOSION_PARTICLE_COUNT = 16;

/** Gore intensity setting — scales blood-particle count, rendered size, and
 * how long a landed particle lingers before despawning. Persisted by
 * `main.ts` and read once per level launch (see `RaycasterEngine`'s
 * constructor); not part of `EngineCarryover` since it's a standing
 * preference, not carried-over run state. */
export type GoreLevel = "none" | "normal" | "more" | "extreme";

export interface GoreMultipliers {
  /** Multiplies `spawnBlood`'s particle count. */
  count: number;
  /** Multiplies rendered particle size (see `renderBlood`). */
  size: number;
  /** Multiplies how long a landed particle lingers (see `updateBlood`). */
  stainDuration: number;
}

/** Per-level multipliers, per the task spec: None/Normal/More/Extreme =
 * 0x/1x/3x/10x. Size/stainDuration at `none` are irrelevant (count 0 means no
 * particles ever spawn) but filled in defensively rather than left unused. */
export const GORE_MULTIPLIERS: Record<GoreLevel, GoreMultipliers> = {
  none: { count: 0, size: 1, stainDuration: 1 },
  normal: { count: 1, size: 1, stainDuration: 1 },
  more: { count: 3, size: 3, stainDuration: 3 },
  extreme: { count: 10, size: 10, stainDuration: 10 },
};

/**
 * Whether the "Extreme" tier is actually selectable. Playtest feedback: 10x
 * gore reads as over-the-top, so it's hidden from the sidebar dropdown (see
 * `main.ts`) and any previously-saved "extreme" preference is downgraded to
 * "more" — pending a revisit later. The multiplier table entry above is left
 * intact so re-enabling is just flipping this flag back to `true`, same
 * pattern as `DECORATIONS_ENABLED` in `mapGenerator.ts`.
 */
export const EXTREME_GORE_ENABLED = false;

export const DEFAULT_GORE_LEVEL: GoreLevel = "normal";

/** A weapon tracer: a fading screen-space line from the muzzle to the impact. */
export interface BulletTrace {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Frames of life remaining; the line fades linearly to 0. */
  frames: number;
  /** CSS color string — lets each weapon's tracer read as visually distinct. */
  color: string;
}

/** A flamethrower shot: a fanning wedge of fire from the muzzle up to its
 * cone's screen-space spread, instead of the thin per-pellet line every other
 * hitscan weapon draws (see `BulletTrace`) — a continuous flame stream reads
 * nothing like a bullet tracer. */
export interface FlameStream {
  leftX: number;
  rightX: number;
  /** Screen y the cone's spread is measured at (crosshair height). */
  y2: number;
  /** Frames of life remaining; fades linearly to 0. */
  frames: number;
  color: string;
}

/** A rocket blast: a screen-space circle that grows and fades over its life,
 * telegraphing the splash-damage radius at the moment it hits. */
export interface Explosion {
  x: number;
  y: number;
  /** Final (world-tile) radius the circle grows to — matches the weapon's
   * actual blast radius, so the visual and the real hitbox agree. */
  radius: number;
  life: number;
  maxLife: number;
}

/** One debris/spark particle kicked up by a rocket detonation, in world (tile)
 * space — bursts outward from the blast center and falls under gravity, same
 * shape as `BloodParticle` but shorter-lived and colored by its own remaining
 * life (hot white-yellow when fresh, cooling through orange to smoky ember as
 * it dies) rather than a single fixed color. */
export interface ExplosionParticle {
  x: number;
  y: number;
  /** Height above the floor, in tiles. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds of life remaining. */
  life: number;
  /** Life this particle spawned with — `life / maxLife` drives its color/size
   * fade, since particles don't share one uniform lifespan (see `spawnExplosionParticles`). */
  maxLife: number;
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
  /** True once this particle has landed (z reached 0) — the moment it flips
   * to true, `life` is reset to a gore-scaled "floor stain" duration (see
   * `updateBlood`); guards against re-triggering that reset every subsequent
   * frame the particle just sits there. */
  settled: boolean;
}

/** One burn ember from a flamethrower hit, in world (tile) space — falls
 * under gravity like `ExplosionParticle` debris, then settles and lingers
 * like `BloodParticle`'s floor stain instead of burning out the instant it
 * lands (see `updateBurnParticles`). */
export interface BurnParticle {
  x: number;
  y: number;
  /** Height above the floor, in tiles. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds of life remaining. */
  life: number;
  /** True once this ember has landed — flips `life` to `BURN_SETTLED_LIFE`
   * the moment it does (see `updateBurnParticles`). */
  settled: boolean;
}

/** Overlay the whole canvas with red at `0.4 * intensity` (intensity 0..1). */
export function drawDamageFlash(ctx: CanvasRenderingContext2D, intensity: number): void {
  if (intensity <= 0) return;
  ctx.fillStyle = `rgba(255,0,0,${(0.4 * intensity).toFixed(3)})`;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Create a muzzle→impact tracer for a shot aimed at screen (`toX`,`toY`),
 * in the firing weapon's `color`. */
export function makeBulletTrace(
  width: number,
  height: number,
  toX: number,
  toY: number,
  color: string,
): BulletTrace {
  return { x1: width / 2, y1: height, x2: toX, y2: toY, frames: BULLET_TRACE_FRAMES, color };
}

/** Draw all live tracers in their own color, fading with remaining frames. */
export function drawBulletTraces(ctx: CanvasRenderingContext2D, traces: BulletTrace[]): void {
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  for (const t of traces) {
    const alpha = 0.9 * Math.max(0, t.frames / BULLET_TRACE_FRAMES);
    ctx.strokeStyle = withAlpha(t.color, alpha);
    ctx.beginPath();
    ctx.moveTo(t.x1, t.y1);
    ctx.lineTo(t.x2, t.y2);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

/** Create a flame stream spanning `leftX`..`rightX` (the widest and narrowest
 * columns any of this shot's pellets actually landed on, post-Cone-of-Fire
 * deviation — see `RaycasterEngine.fire()`) at crosshair height. */
export function spawnFlameStream(height: number, leftX: number, rightX: number, color: string): FlameStream {
  return { leftX, rightX, y2: height / 2, frames: FLAME_STREAM_FRAMES, color };
}

/** Age flame streams by one frame, dropping expired ones (in place). */
export function tickFlameStreams(list: FlameStream[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (--list[i].frames <= 0) list.splice(i, 1);
  }
}

/** Draw every live flame stream as two layered, flickering jets (the
 * weapon's own tracer-color outer flame, a brighter yellow-orange inner
 * core) — needle-thin for most of the distance and only actually fanning
 * out in the last stretch before the cone's tip, a real flamethrower's
 * shape rather than an immediate wide blast off the nozzle. Re-jittered
 * every frame so a held trigger reads as a roaring, unstable flame rather
 * than a static shape. */
export function drawFlameStreams(ctx: CanvasRenderingContext2D, width: number, height: number, list: FlameStream[]): void {
  const baseX = width / 2;
  const baseY = height;
  const jitter = () => (Math.random() - 0.5) * 6;

  for (const f of list) {
    const alpha = 0.85 * Math.max(0, f.frames / FLAME_STREAM_FRAMES);

    ctx.fillStyle = withAlpha(f.color, alpha * 0.9);
    flameJet(ctx, baseX, baseY, f.leftX + jitter(), f.rightX + jitter(), f.y2, 3);

    ctx.fillStyle = `rgba(255,220,120,${(alpha * 0.85).toFixed(3)})`;
    const coreLeft = baseX + (f.leftX - baseX) * 0.5 + jitter();
    const coreRight = baseX + (f.rightX - baseX) * 0.5 + jitter();
    flameJet(ctx, baseX, baseY, coreLeft, coreRight, f.y2, 4);
  }
}

/** A flame "jet" silhouette from (x1,y1) up to (leftX,y2)/(rightX,y2) — unlike
 * a straight-sided wedge, raising the edge's deviation from center to
 * `power` (> 1) keeps it needle-thin for most of the distance and only
 * actually widens in the last stretch before the tip. The brighter inner
 * core layer uses a higher `power` than the outer flame so it stays even
 * narrower, reading as a hot center inside a wider outer flame. */
function flameJet(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  leftX: number,
  rightX: number,
  y2: number,
  power: number,
): void {
  const steps = 10;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    ctx.lineTo(x1 + (leftX - x1) * t ** power, y1 + (y2 - y1) * t);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    ctx.lineTo(x1 + (rightX - x1) * t ** power, y1 + (y2 - y1) * t);
  }
  ctx.closePath();
  ctx.fill();
}

/** Apply `alpha` to a `#rrggbb` color string, for effects whose color is data
 * (per-weapon tracers) rather than a literal baked into an `rgba()` string. */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/** Spawn a rocket-blast VFX circle at (x,y) that grows to `radius` tiles over
 * its short life. `radius` should match the weapon's real blast radius so the
 * visual and the actual splash-damage hitbox agree. */
export function spawnExplosion(list: Explosion[], x: number, y: number, radius: number): void {
  list.push({ x, y, radius, life: EXPLOSION_LIFE, maxLife: EXPLOSION_LIFE });
}

/** Age explosion VFX by `dt`, dropping any that finished (in place). */
export function updateExplosions(list: Explosion[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    list[i].life -= dt;
    if (list[i].life <= 0) list.splice(i, 1);
  }
}

/** Draw every live explosion as a growing, fading orange ring at eye level,
 * wall-occluded via the z-buffer like every other world billboard. */
export function renderExplosions(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: Explosion[],
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  for (const ex of list) {
    const proj = projectPoint(player, ex.x, ex.y, width, height, 1);
    if (proj.depth <= 0.1) continue;
    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    const tilePx = proj.bottom - proj.top; // pixels per world tile at this depth
    const t = 1 - ex.life / ex.maxLife; // 0 at spawn, 1 at death
    const r = tilePx * ex.radius * t;
    const alpha = (1 - t) * 0.8;
    const cy = height / 2;

    ctx.fillStyle = `rgba(255,150,40,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(proj.screenX, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,230,150,${(alpha * 0.7).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(proj.screenX, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Spawn a burst of debris/spark particles at (x,y) for a rocket detonation —
 * layered on top of `spawnExplosion`'s growing ring to give the blast some
 * actual texture instead of just a flat flash. Independent of the Gore
 * setting (that only scales *blood*); a rocket always kicks up the same
 * amount of debris regardless of gore level. */
export function spawnExplosionParticles(list: ExplosionParticle[], x: number, y: number): void {
  for (let i = 0; i < EXPLOSION_PARTICLE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.2 + Math.random() * 2.4; // tiles/sec, outward
    const life = 0.3 + Math.random() * 0.35;
    list.push({
      x,
      y,
      z: 0.25 + Math.random() * 0.3,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: 1.4 + Math.random() * 2.2, // initial upward kick
      life,
      maxLife: life,
    });
  }
}

/** Spawn a handful of embers at (x,y) for a flamethrower hit. Unlike
 * `ExplosionParticle` debris (which just burns out mid-air, see
 * `updateExplosionParticles`'s doc comment), these settle on the floor and
 * keep glowing for a while — `BURN_SETTLED_LIFE` — the same "land, then
 * linger" shape as `BloodParticle`'s floor stain, since a quick mid-air burst
 * alone read as barely noticeable in playtesting. Purely cosmetic — no
 * damage-over-time follows from this. */
export function spawnBurnParticles(list: BurnParticle[], x: number, y: number): void {
  for (let i = 0; i < BURN_PARTICLE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.2 + Math.random() * 0.35; // tiles/sec, outward
    list.push({
      x,
      y,
      z: 0.4 + Math.random() * 0.3,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: 0.3 + Math.random() * 0.4,
      life: 0, // placeholder — overwritten with BURN_SETTLED_LIFE on landing, see updateBurnParticles
      settled: false,
    });
  }
}

/**
 * Integrate burn embers by `dt`. Airborne particles fall under gravity like
 * `ExplosionParticle` debris and don't age out at all yet (`life` while
 * airborne is just a placeholder, overwritten the moment they land — a fixed
 * short airborne life here could otherwise expire an ember mid-fall on an
 * unlucky spawn roll, deleting it before it ever gets to linger). The instant
 * one lands it settles (matching `updateBlood`'s pattern), `life` resets to
 * `BURN_SETTLED_LIFE`, and only then does it actually count down toward
 * removal — so the ember reads as lingering on the floor rather than a
 * blink-and-you-miss-it flash.
 */
export function updateBurnParticles(list: BurnParticle[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p.settled) {
      p.vz -= BURN_GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z <= 0) {
        p.z = 0;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.settled = true;
        p.life = BURN_SETTLED_LIFE;
      }
      continue;
    }
    p.life -= dt;
    if (p.life <= 0) list.splice(i, 1);
  }
}

/** Draw every live burn ember: a hot white-orange spark while airborne, then
 * a dimming orange glow that fades out over `BURN_SETTLED_LIFE` once
 * settled, wall-occluded via the z-buffer like every other world billboard. */
export function renderBurnParticles(ctx: CanvasRenderingContext2D, player: Player, list: BurnParticle[], zBuffer: Float64Array): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  for (const p of list) {
    const proj = projectPoint(player, p.x, p.y, width, height, 1);
    if (proj.depth <= 0.1) continue;
    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    const tilePx = proj.bottom - proj.top; // pixels per world tile at this depth
    const sy = proj.bottom - p.z * tilePx; // lift off the floor by the particle height
    const t = p.settled ? p.life / BURN_SETTLED_LIFE : 1; // fades only once settled
    const s = Math.max(1, Math.round(tilePx * 0.06 * t));

    ctx.fillStyle = p.settled ? `rgba(255,110,30,${(t * 0.85).toFixed(3)})` : "rgba(255,225,150,0.95)";
    ctx.fillRect(Math.round(proj.screenX) - (s >> 1), Math.round(sy) - (s >> 1), s, s);
  }
}

/** Integrate explosion particles by `dt`, removing those that expired or
 * fell through the floor (in place) — unlike blood, debris doesn't settle
 * and linger, it just burns out mid-air. */
export function updateExplosionParticles(list: ExplosionParticle[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.vz -= EXPLOSION_PARTICLE_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    if (p.life <= 0 || p.z < 0) list.splice(i, 1);
  }
}

/** Draw every live explosion particle as a small square that cools from a hot
 * white-yellow core through orange to a smoky ember as its remaining life
 * drops, wall-occluded via the z-buffer like every other world billboard. */
export function renderExplosionParticles(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: ExplosionParticle[],
  zBuffer: Float64Array,
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  for (const p of list) {
    const proj = projectPoint(player, p.x, p.y, width, height, 1);
    if (proj.depth <= 0.1) continue;
    const col = clamp(Math.round(proj.screenX), 0, width - 1);
    if (proj.depth >= zBuffer[col]) continue; // behind a wall

    const tilePx = proj.bottom - proj.top; // pixels per world tile at this depth
    const sy = proj.bottom - p.z * tilePx; // lift off the floor by the particle height
    const t = p.life / p.maxLife; // 1 fresh -> 0 dying
    const s = Math.max(1, Math.round(tilePx * 0.07 * t));

    ctx.fillStyle =
      t > 0.6 ? `rgba(255,235,190,${t.toFixed(3)})` : t > 0.3 ? `rgba(255,110,35,${t.toFixed(3)})` : `rgba(90,75,65,${t.toFixed(3)})`;
    ctx.fillRect(Math.round(proj.screenX) - (s >> 1), Math.round(sy) - (s >> 1), s, s);
  }
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
      settled: false,
    });
  }
}

/**
 * Integrate blood particles by `dt`, removing those that expired (in place).
 * Airborne particles use their original spawn-time `life` unchanged; the
 * instant one lands (z clamps to 0 for the first time), its `life` is reset
 * to a fresh "floor stain" duration scaled by `stainDurationMultiplier` (see
 * `GoreMultipliers`), then decrements normally from there.
 */
export function updateBlood(list: BloodParticle[], dt: number, stainDurationMultiplier: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.vz -= BLOOD_GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.z <= 0) {
      // Settle on the floor tile and skid to a stop.
      p.z = 0;
      p.vz = 0;
      p.vx *= 0.4;
      p.vy *= 0.4;
      if (!p.settled) {
        p.settled = true;
        p.life = BASE_STAIN_LIFE * stainDurationMultiplier;
      }
    }
    p.life -= dt;
    if (p.life <= 0) list.splice(i, 1);
  }
}

/** Project and draw blood pixels as small red squares, wall-occluded via
 * zBuffer. `sizeMultiplier` scales the rendered size (see `GoreMultipliers`). */
export function renderBlood(
  ctx: CanvasRenderingContext2D,
  player: Player,
  list: BloodParticle[],
  zBuffer: Float64Array,
  sizeMultiplier: number,
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
    const s = Math.max(1, Math.round(tilePx * 0.05 * sizeMultiplier));
    ctx.fillRect(Math.round(proj.screenX) - (s >> 1), Math.round(sy) - (s >> 1), s, s);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

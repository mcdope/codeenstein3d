// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wall/door/floor texture bitmaps for the raycaster. By default these are
 * procedurally generated into detached offscreen canvases at startup —
 * consistent with the rest of the engine's "no external asset files"
 * approach (see audio.ts, viewmodel.ts) — but a player can optionally load a
 * DOOM WAD file to source real wall/door textures and floor flats instead
 * (see `src/wad/`, wired in via `TextureManager.loadFromWad`). Either way,
 * `TextureManager.getActiveSet()` always returns a fully-populated
 * `TextureSet`; the raycaster never needs to null-check a slot.
 */
import { loadWadTextures } from "../wad/loadWad";
import type { WadTexturePixels } from "../wad/compositeTexture";

/** Size of every procedurally-generated default texture — matches classic
 * Doom wall/flat proportions. WAD-sourced textures are *not* forced to this
 * size: the raycaster reads `TextureBitmap.width`/`.height` at sample time
 * rather than assuming a fixed size, since a real WAD's composite wall/door
 * textures are often wider or taller than 64px (e.g. `BIGDOOR2` is 128px). */
export const TEXTURE_SIZE = 64;

/** A single texture, ready for the renderer to sample, at whatever size it
 * actually is (see `TEXTURE_SIZE`'s doc comment). `canvas` is a detached
 * (never appended to the DOM) `drawImage` source for the wall/door bulk-blit
 * path; `pixels` is the same RGBA data precomputed once, for the renderer's
 * exact-color lookups (wall/door edge antialiasing, and the floor-cast's
 * per-pixel sampling, which never uses `drawImage` at all) that would
 * otherwise need a runtime `getImageData` call every frame. */
export interface TextureBitmap {
  canvas: HTMLCanvasElement;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** One texture per wall-like/floor-like slot the raycaster samples from.
 * Secret walls reuse `wall`/`bonusWall` plus the existing subtle tint
 * overlay (unchanged from before texturing) rather than getting their own
 * slot — they're meant to be visually near-identical to a plain wall. Lore
 * terminals, the ceiling, and hazard/teleporter/spike-trap floor tiles
 * intentionally stay flat-colored/procedural-glow and never consult this set
 * — see raycaster.ts. */
export interface TextureSet {
  wall: TextureBitmap;
  bonusWall: TextureBitmap;
  door: TextureBitmap;
  floor: TextureBitmap;
  bonusFloor: TextureBitmap;
}

// Base tones for the procedural defaults, matching the flat colors this
// feature replaces (raycaster.ts's former WALL_RGB/BONUS_WALL_RGB/DOOR_RGB/
// FLOOR_RGB/BONUS_FLOOR_RGB) so the first frame after this change looks like
// a textured version of the same palette, not a re-theme.
const WALL_BASE: [number, number, number] = [186, 152, 116];
const WALL_MORTAR: [number, number, number] = [96, 78, 58];
const BONUS_WALL_BASE: [number, number, number] = [92, 142, 168];
const BONUS_WALL_SEAM: [number, number, number] = [44, 74, 92];
const DOOR_BASE: [number, number, number] = [86, 142, 190];
const FLOOR_BASE: [number, number, number] = [21, 21, 26];
const FLOOR_GROUT: [number, number, number] = [10, 10, 13];
const BONUS_FLOOR_BASE: [number, number, number] = [14, 24, 30];
const BONUS_FLOOR_GROUT: [number, number, number] = [6, 12, 16];

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function shade(base: [number, number, number], delta: number): [number, number, number] {
  return [clamp255(base[0] + delta), clamp255(base[1] + delta), clamp255(base[2] + delta)];
}

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for procedural texture generation");
  return { canvas, ctx };
}

/** Precomputes the RGBA pixel cache once at build time — never called again
 * per frame, unlike a naive per-column `getImageData`. */
function bitmapFromCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): TextureBitmap {
  const pixels = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE).data;
  return { canvas, pixels, width: TEXTURE_SIZE, height: TEXTURE_SIZE };
}

/**
 * Warm dungeon brick pattern — the default `wall` (and, via the same slot,
 * `SECRET_WALL_TILE`) texture. Per-brick color jitter uses plain `Math.random`
 * since this is purely cosmetic and never feeds simulation/replay state.
 */
function buildBrickTexture(base: [number, number, number], mortar: [number, number, number]): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(mortar);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const rows = 8;
  const rowH = TEXTURE_SIZE / rows;
  const brickW = TEXTURE_SIZE / 4;
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let bx = -brickW; bx < TEXTURE_SIZE; bx += brickW) {
      const jitter = (Math.random() - 0.5) * 18;
      ctx.fillStyle = rgb(shade(base, jitter));
      ctx.fillRect(bx + offset + 1, row * rowH + 1, brickW - 2, rowH - 2);
    }
  }
  return bitmapFromCanvas(canvas, ctx);
}

/** Cool steel panel pattern — the default `bonusWall` texture, matching the
 * distinct cool theme bonus (restock-arena) levels already use. */
function buildPanelTexture(base: [number, number, number], seam: [number, number, number]): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  ctx.strokeStyle = rgb(seam);
  ctx.lineWidth = 2;
  for (const x of [0, TEXTURE_SIZE / 2, TEXTURE_SIZE]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEXTURE_SIZE);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, TEXTURE_SIZE / 2);
  ctx.lineTo(TEXTURE_SIZE, TEXTURE_SIZE / 2);
  ctx.stroke();
  ctx.fillStyle = rgb(seam);
  const inset = 5;
  for (const cx of [inset, TEXTURE_SIZE / 2 - inset, TEXTURE_SIZE / 2 + inset, TEXTURE_SIZE - inset]) {
    for (const cy of [inset, TEXTURE_SIZE / 2 - inset, TEXTURE_SIZE / 2 + inset, TEXTURE_SIZE - inset]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return bitmapFromCanvas(canvas, ctx);
}

/**
 * Two-leaf door with a center seam and handles — deliberately reads as an
 * openable door on its own, since texturing removes the old flat `DOOR_RGB`
 * fill that used to be the only "this is a door" signal.
 */
function buildDoorTexture(base: [number, number, number]): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  ctx.strokeStyle = rgb(shade(base, -50));
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, TEXTURE_SIZE - 6, TEXTURE_SIZE - 6);

  ctx.beginPath();
  ctx.moveTo(TEXTURE_SIZE / 2, 3);
  ctx.lineTo(TEXTURE_SIZE / 2, TEXTURE_SIZE - 3);
  ctx.stroke();

  ctx.strokeStyle = rgb(shade(base, -25));
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, TEXTURE_SIZE / 2 - 12, TEXTURE_SIZE - 16);
  ctx.strokeRect(TEXTURE_SIZE / 2 + 4, 8, TEXTURE_SIZE / 2 - 12, TEXTURE_SIZE - 16);

  ctx.fillStyle = rgb(shade(base, 70));
  for (const hx of [TEXTURE_SIZE / 2 - 7, TEXTURE_SIZE / 2 + 7]) {
    ctx.beginPath();
    ctx.arc(hx, TEXTURE_SIZE / 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return bitmapFromCanvas(canvas, ctx);
}

/** Flagstone-tile floor pattern, with per-tile color jitter for the same
 * cosmetic-randomness reasons as `buildBrickTexture`. */
function buildFloorTexture(base: [number, number, number], grout: [number, number, number]): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(grout);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const tiles = 4;
  const tileSize = TEXTURE_SIZE / tiles;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const jitter = (Math.random() - 0.5) * 12;
      ctx.fillStyle = rgb(shade(base, jitter));
      ctx.fillRect(tx * tileSize + 1, ty * tileSize + 1, tileSize - 2, tileSize - 2);
    }
  }
  return bitmapFromCanvas(canvas, ctx);
}

function buildDefaultTextureSet(): TextureSet {
  return {
    wall: buildBrickTexture(WALL_BASE, WALL_MORTAR),
    bonusWall: buildPanelTexture(BONUS_WALL_BASE, BONUS_WALL_SEAM),
    door: buildDoorTexture(DOOR_BASE),
    floor: buildFloorTexture(FLOOR_BASE, FLOOR_GROUT),
    bonusFloor: buildFloorTexture(BONUS_FLOOR_BASE, BONUS_FLOOR_GROUT),
  };
}

/**
 * Turns a `src/wad/`-composited texture into a renderer-ready `TextureBitmap`
 * at its native size (see `TEXTURE_SIZE`'s doc comment). `src/wad/` leaves
 * pixels no patch covered fully transparent (`alpha === 0`) — filled in here
 * with the theme's flat base color, fully opaque, so the renderer's hot path
 * stays alpha-free and always draws fully opaque strips, exactly like the
 * procedural defaults. Mutates `pixels.rgba` in place (it's a fresh buffer
 * from `loadWadTextures`, never reused elsewhere).
 */
function bitmapFromWadPixels(pixels: WadTexturePixels, holeFill: [number, number, number]): TextureBitmap {
  const { rgba, width, height } = pixels;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      rgba[i] = holeFill[0];
      rgba[i + 1] = holeFill[1];
      rgba[i + 2] = holeFill[2];
      rgba[i + 3] = 255;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for WAD texture conversion");
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(rgba);
  ctx.putImageData(imageData, 0, 0);

  return { canvas, pixels: rgba, width, height };
}

/** Everything `loadFromWad` needs to report back to the UI: which name (if
 * any) matched each slot, or a fatal parse error. Never includes the actual
 * bitmaps — `main.ts` only needs to phrase a status string from this. */
export interface WadLoadSummary {
  ok: boolean;
  error: string | null;
  wallName: string | null;
  bonusWallName: string | null;
  doorName: string | null;
  floorName: string | null;
  bonusFloorName: string | null;
}

/**
 * Owns the active `TextureSet` the raycaster renders with. Starts out on the
 * procedural defaults; `loadFromWad` swaps in WAD-sourced textures per slot,
 * falling back to that slot's default individually if the WAD doesn't have
 * a matching name (or its data turned out corrupt) — never an all-or-nothing
 * swap, and never leaves `active` with a missing slot.
 */
export class TextureManager {
  private readonly defaults: TextureSet;
  private active: TextureSet;

  constructor() {
    this.defaults = buildDefaultTextureSet();
    this.active = this.defaults;
  }

  /** Always fully populated — the raycaster never needs to null-check a slot. */
  getActiveSet(): TextureSet {
    return this.active;
  }

  /** Parses `bytes` as a DOOM WAD and swaps in whichever slots it has a
   * matching allowlisted texture/flat for (see `src/wad/textureAllowlist.ts`).
   * A fatal parse failure leaves the active set untouched. Session-only: not
   * persisted, matching the existing "Select BGM Folder" precedent — a fresh
   * page load always starts back on the procedural defaults. */
  loadFromWad(bytes: ArrayBuffer): WadLoadSummary {
    const result = loadWadTextures(bytes);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        wallName: null,
        bonusWallName: null,
        doorName: null,
        floorName: null,
        bonusFloorName: null,
      };
    }

    this.active = {
      wall: result.wallTexture ? bitmapFromWadPixels(result.wallTexture, WALL_BASE) : this.defaults.wall,
      bonusWall: result.bonusWallTexture
        ? bitmapFromWadPixels(result.bonusWallTexture, BONUS_WALL_BASE)
        : this.defaults.bonusWall,
      door: result.doorTexture ? bitmapFromWadPixels(result.doorTexture, DOOR_BASE) : this.defaults.door,
      floor: result.floorTexture ? bitmapFromWadPixels(result.floorTexture, FLOOR_BASE) : this.defaults.floor,
      bonusFloor: result.bonusFloorTexture
        ? bitmapFromWadPixels(result.bonusFloorTexture, BONUS_FLOOR_BASE)
        : this.defaults.bonusFloor,
    };

    return {
      ok: true,
      error: null,
      wallName: result.wallName,
      bonusWallName: result.bonusWallName,
      doorName: result.doorName,
      floorName: result.floorName,
      bonusFloorName: result.bonusFloorName,
    };
  }
}

export const textures = new TextureManager();

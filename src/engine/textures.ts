// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Wall/door/floor texture bitmaps for the raycaster, organised into
 * *stylesets*: one coherent look — wall, floor and door bitmaps plus a
 * ceiling colour and an automap wall colour — that a level keeps for its
 * whole duration. Which styleset a level gets is decided in the map layer
 * (`GameMap.styleSet`, see `src/map/generation/styleSet.ts`); this module owns
 * the id-to-pixels table and nothing else knows how a styleset is chosen.
 *
 * Only *structural* surfaces vary. The gameplay-signal textures — lore
 * terminal, hazard/acid, teleporter pad, spike trap safe/active — are built
 * once and shared by reference across every styleset, deliberately: "this
 * tile will hurt me" must read identically on every level, not depend on
 * which palette the level happened to draw.
 *
 * By default all of it is procedurally generated into detached offscreen
 * canvases at startup — consistent with the rest of the engine's "no external
 * asset files" approach (see audio.ts, viewmodel.ts) — but a player can
 * optionally load a DOOM WAD file to source real wall/door textures and floor
 * flats instead (see `src/wad/`, wired in via `TextureManager.loadFromWad`).
 * Either way, `TextureManager.getStyle()` always returns a fully-populated
 * `LevelStyle`; the raycaster never needs to null-check a slot.
 */
import { STYLE_SET_IDS, type StyleSetId } from "../map/types";
import { loadWadTextures, type WadSlot } from "../wad/loadWad";
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

/** The slots that vary from styleset to styleset. Secret walls reuse `wall`
 * plus the existing subtle tint overlay (unchanged from before stylesets)
 * rather than getting their own slot — they're meant to be visually
 * near-identical to a plain wall — and branch doors likewise reuse `door`
 * plus an amber wash. See raycaster.ts. */
export interface StyleTextures {
  wall: TextureBitmap;
  floor: TextureBitmap;
  door: TextureBitmap;
}

/** The slots that are identical in every styleset, because their colour *is*
 * their meaning. Lore terminals sample `loreWall` (plus a thin pulsing tint
 * overlay, so the "interact with me" signal survives the switch to a real
 * texture); hazard/teleporter/spike-trap floor tiles sample the rest with no
 * tint at all, matching how Doom itself textures these. */
export interface SignalTextures {
  loreWall: TextureBitmap;
  hazardFloor: TextureBitmap;
  teleporterFloor: TextureBitmap;
  spikeSafeFloor: TextureBitmap;
  spikeActiveFloor: TextureBitmap;
}

/** Everything the raycaster samples, flattened — one lookup per tile kind,
 * no branching on where a slot came from. */
export type TextureSet = StyleTextures & SignalTextures;

/**
 * One level's complete look. The ceiling is the only surface that stays flat
 * -coloured and never gets a bitmap (see raycaster.ts); `automapWall` is the
 * minimap's wall fill, which has to move with the palette or a rust level's
 * minimap would still read as cold grey.
 */
export interface LevelStyle {
  id: StyleSetId;
  textures: TextureSet;
  ceiling: [number, number, number];
  automapWall: string;
}

type Rgb = [number, number, number];

/** Which procedural generator draws a styleset's wall. */
type WallPattern = "brick" | "panel" | "blockwork";
/** Which procedural generator draws a styleset's floor. */
type FloorPattern = "flagstone" | "grating" | "concrete";

interface StylePalette {
  wall: { pattern: WallPattern; base: Rgb; accent: Rgb };
  floor: { pattern: FloorPattern; base: Rgb; accent: Rgb };
  door: Rgb;
  ceiling: Rgb;
  automapWall: string;
}

/**
 * The five stylesets' base tones.
 *
 * `stone` and `techCool` reproduce exactly the two looks that existed before
 * stylesets — the former was every normal level's palette, the latter every
 * `bonusLevel` restock arena's (raycaster.ts's former WALL_RGB/BONUS_WALL_RGB/
 * DOOR_RGB/FLOOR_RGB/BONUS_FLOOR_RGB/CEILING_RGB/BONUS_CEILING_RGB and the two
 * hardcoded minimap fills). Keeping them byte-identical means this change
 * reads as "three new looks were added", not as a re-theme of the game.
 *
 * Doors vary in hue but never in *pattern*: `buildDoorTexture`'s two-leaf
 * shape with a centre seam and handles is what actually says "door", and that
 * affordance is too load-bearing to make palette-dependent. Each door tone is
 * also deliberately kept away from the amber `BRANCH_DOOR_OVERLAY` wash the
 * raycaster puts on branch doors, so the two door kinds stay tellable apart.
 */
const STYLE_PALETTES: Readonly<Record<StyleSetId, StylePalette>> = {
  stone: {
    wall: { pattern: "brick", base: [186, 152, 116], accent: [96, 78, 58] },
    floor: { pattern: "flagstone", base: [21, 21, 26], accent: [10, 10, 13] },
    door: [86, 142, 190],
    ceiling: [11, 13, 22],
    automapWall: "#4a4a55",
  },
  rust: {
    wall: { pattern: "brick", base: [150, 86, 58], accent: [72, 40, 28] },
    floor: { pattern: "concrete", base: [34, 26, 22], accent: [18, 14, 12] },
    door: [150, 110, 70],
    ceiling: [22, 14, 11],
    automapWall: "#6b4436",
  },
  tech: {
    wall: { pattern: "panel", base: [122, 128, 136], accent: [56, 60, 66] },
    floor: { pattern: "grating", base: [96, 100, 106], accent: [16, 18, 20] },
    door: [96, 150, 176],
    ceiling: [14, 16, 20],
    automapWall: "#5a6068",
  },
  marble: {
    wall: { pattern: "blockwork", base: [176, 180, 196], accent: [92, 96, 110] },
    floor: { pattern: "flagstone", base: [30, 32, 40], accent: [16, 17, 22] },
    door: [120, 132, 178],
    ceiling: [18, 20, 26],
    automapWall: "#6a7080",
  },
  techCool: {
    wall: { pattern: "panel", base: [92, 142, 168], accent: [44, 74, 92] },
    floor: { pattern: "flagstone", base: [14, 24, 30], accent: [6, 12, 16] },
    door: [86, 142, 190],
    ceiling: [8, 16, 24],
    automapWall: "#3f7fae",
  },
};

// Base tones for the gameplay-signal defaults, matching the flat/pulsing
// colors this feature replaced (raycaster.ts's former LORE_RGB/ACID_RGB/
// TELEPORTER_RGB/SPIKE_SAFE_RGB/SPIKE_ACTIVE_RGB). Shared by every styleset.
/** Also used at runtime by `raycaster.ts` for the lore-terminal pulsing tint
 * overlay, so the overlay hue stays consistent with this default's base tone. */
export const LORE_BASE: Rgb = [120, 200, 210];
const LORE_SEAM: Rgb = [58, 98, 104];
const HAZARD_FLOOR_BASE: Rgb = [64, 196, 72];
const HAZARD_FLOOR_GROUT: Rgb = [32, 98, 36];
const TELEPORTER_FLOOR_BASE: Rgb = [130, 70, 220];
const TELEPORTER_FLOOR_GROUT: Rgb = [65, 35, 110];
const SPIKE_SAFE_FLOOR_BASE: Rgb = [90, 90, 96];
const SPIKE_SAFE_FLOOR_GROUT: Rgb = [45, 45, 48];
const SPIKE_ACTIVE_FLOOR_BASE: Rgb = [220, 40, 30];
const SPIKE_ACTIVE_FLOOR_GROUT: Rgb = [110, 20, 15];

function rgb([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function shade(base: Rgb, delta: number): Rgb {
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
 * Dungeon brick pattern — `stone`'s and `rust`'s wall. Per-brick color jitter
 * uses plain `Math.random` since this is purely cosmetic and never feeds
 * simulation/replay state.
 */
function buildBrickTexture(base: Rgb, mortar: Rgb): TextureBitmap {
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

/** Steel panel pattern — `tech`'s and `techCool`'s wall. */
function buildPanelTexture(base: Rgb, seam: Rgb): TextureBitmap {
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
 * Large bevelled ashlar blocks — `marble`'s wall. Deliberately much coarser
 * than `buildBrickTexture` (3 courses of 2 wide blocks against 8 courses of
 * 4): at a distance the two patterns have to be tellable apart by silhouette
 * alone, not just by hue, or the stylesets read as recolours of one wall.
 */
function buildBlockworkTexture(base: Rgb, mortar: Rgb): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(mortar);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const rows = 3;
  const rowH = TEXTURE_SIZE / rows;
  const blockW = TEXTURE_SIZE / 2;
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : blockW / 2;
    for (let bx = -blockW; bx < TEXTURE_SIZE; bx += blockW) {
      const x = bx + offset + 1.5;
      const y = row * rowH + 1.5;
      const w = blockW - 3;
      const h = rowH - 3;
      ctx.fillStyle = rgb(shade(base, (Math.random() - 0.5) * 14));
      ctx.fillRect(x, y, w, h);

      // Bevel: lit from the top-left, so each block reads as a solid slab
      // rather than a flat rectangle.
      ctx.strokeStyle = rgb(shade(base, 34));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.stroke();

      ctx.strokeStyle = rgb(shade(base, -38));
      ctx.beginPath();
      ctx.moveTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.stroke();
    }
  }
  return bitmapFromCanvas(canvas, ctx);
}

/**
 * Flagstone-tile floor pattern, with per-tile color jitter for the same
 * cosmetic-randomness reasons as `buildBrickTexture`.
 */
function buildFloorTexture(base: Rgb, grout: Rgb): TextureBitmap {
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

/**
 * Metal walkway grating — `tech`'s floor. `base` is the bar metal and
 * `accent` the dark void seen through the holes, which is the inverse of
 * every other floor generator here (where `base` is the surface and `accent`
 * the recessed grout); that inversion is the point, since a grating reads as
 * "mostly hole" and gives `tech` a floor that is unmistakable underfoot.
 */
function buildGratingTexture(base: Rgb, hole: Rgb): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(hole);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const pitch = TEXTURE_SIZE / 4;
  const barW = 5;
  for (let i = 0; i < 4; i++) {
    const at = i * pitch;
    ctx.fillStyle = rgb(shade(base, (Math.random() - 0.5) * 10));
    ctx.fillRect(at, 0, barW, TEXTURE_SIZE);
    ctx.fillStyle = rgb(shade(base, -18 + (Math.random() - 0.5) * 10));
    ctx.fillRect(0, at, TEXTURE_SIZE, barW);
  }

  // Top highlight on the vertical bars only — enough to imply the bars sit
  // above the holes without turning the whole thing into a bright plate.
  ctx.fillStyle = rgb(shade(base, 40));
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(i * pitch, 0, 1, TEXTURE_SIZE);
  }
  return bitmapFromCanvas(canvas, ctx);
}

/**
 * Poured concrete slab — `rust`'s floor. Speckle plus two seams, no tiling
 * grid at all, so it contrasts with the regular 4x4 of `buildFloorTexture`.
 */
function buildConcreteTexture(base: Rgb, seam: Rgb): TextureBitmap {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const specks = 420;
  for (let i = 0; i < specks; i++) {
    const x = Math.floor(Math.random() * TEXTURE_SIZE);
    const y = Math.floor(Math.random() * TEXTURE_SIZE);
    ctx.fillStyle = rgb(shade(base, (Math.random() - 0.5) * 26));
    ctx.fillRect(x, y, 1 + Math.floor(Math.random() * 2), 1);
  }

  ctx.strokeStyle = rgb(seam);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, TEXTURE_SIZE / 2);
  ctx.lineTo(TEXTURE_SIZE, TEXTURE_SIZE / 2);
  ctx.moveTo(TEXTURE_SIZE / 2, 0);
  ctx.lineTo(TEXTURE_SIZE / 2, TEXTURE_SIZE);
  ctx.stroke();
  return bitmapFromCanvas(canvas, ctx);
}

/**
 * Two-leaf door with a center seam and handles — deliberately reads as an
 * openable door on its own, since texturing removes the old flat `DOOR_RGB`
 * fill that used to be the only "this is a door" signal. Shared by every
 * styleset; only `base` changes (see `STYLE_PALETTES`).
 */
function buildDoorTexture(base: Rgb): TextureBitmap {
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

function buildWall(spec: StylePalette["wall"]): TextureBitmap {
  switch (spec.pattern) {
    case "brick":
      return buildBrickTexture(spec.base, spec.accent);
    case "panel":
      return buildPanelTexture(spec.base, spec.accent);
    case "blockwork":
      return buildBlockworkTexture(spec.base, spec.accent);
  }
}

function buildFloor(spec: StylePalette["floor"]): TextureBitmap {
  switch (spec.pattern) {
    case "flagstone":
      return buildFloorTexture(spec.base, spec.accent);
    case "grating":
      return buildGratingTexture(spec.base, spec.accent);
    case "concrete":
      return buildConcreteTexture(spec.base, spec.accent);
  }
}

function buildDefaultStyleTextures(id: StyleSetId): StyleTextures {
  const palette = STYLE_PALETTES[id];
  return {
    wall: buildWall(palette.wall),
    floor: buildFloor(palette.floor),
    door: buildDoorTexture(palette.door),
  };
}

function buildDefaultSignalTextures(): SignalTextures {
  return {
    loreWall: buildPanelTexture(LORE_BASE, LORE_SEAM),
    hazardFloor: buildFloorTexture(HAZARD_FLOOR_BASE, HAZARD_FLOOR_GROUT),
    teleporterFloor: buildFloorTexture(TELEPORTER_FLOOR_BASE, TELEPORTER_FLOOR_GROUT),
    spikeSafeFloor: buildFloorTexture(SPIKE_SAFE_FLOOR_BASE, SPIKE_SAFE_FLOOR_GROUT),
    spikeActiveFloor: buildFloorTexture(SPIKE_ACTIVE_FLOOR_BASE, SPIKE_ACTIVE_FLOOR_GROUT),
  };
}

/** Assembles one `LevelStyle` per id. `signals` is passed in rather than
 * rebuilt per styleset so all five share the exact same bitmap objects — the
 * cheapest possible expression of "these never vary". */
function buildStyles(
  structural: (id: StyleSetId) => StyleTextures,
  signals: SignalTextures,
): Record<StyleSetId, LevelStyle> {
  const styles = {} as Record<StyleSetId, LevelStyle>;
  for (const id of STYLE_SET_IDS) {
    const palette = STYLE_PALETTES[id];
    styles[id] = {
      id,
      textures: { ...structural(id), ...signals },
      ceiling: palette.ceiling,
      automapWall: palette.automapWall,
    };
  }
  return styles;
}

/**
 * Turns a `src/wad/`-composited texture into a renderer-ready `TextureBitmap`
 * at its native size (see `TEXTURE_SIZE`'s doc comment). `src/wad/` leaves
 * pixels no patch covered fully transparent (`alpha === 0`) — filled in here
 * with the styleset's flat base color, fully opaque, so the renderer's hot
 * path stays alpha-free and always draws fully opaque strips, exactly like the
 * procedural defaults. Mutates `pixels.rgba` in place (it's a fresh buffer
 * from `loadWadTextures` — which re-composites per styleset precisely so no
 * two callers ever share one).
 */
function bitmapFromWadPixels(pixels: WadTexturePixels, holeFill: Rgb): TextureBitmap {
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

/** `slot`'s WAD texture if it resolved, otherwise the procedural default that
 * was already built for this slot. Never all-or-nothing: one missing name
 * costs exactly one slot. */
function slotOrDefault(slot: WadSlot, holeFill: Rgb, fallback: TextureBitmap): TextureBitmap {
  return slot.texture ? bitmapFromWadPixels(slot.texture, holeFill) : fallback;
}

/** Which allowlisted name (if any) matched each of one styleset's structural
 * slots. `null` means that slot is on its procedural default. */
export interface WadStyleSummary {
  wall: string | null;
  floor: string | null;
  door: string | null;
}

/** Everything `loadFromWad` needs to report back to the UI: which name (if
 * any) matched each slot, or a fatal parse error. Never includes the actual
 * bitmaps — `main.ts` only needs to phrase a status string from this. */
export interface WadLoadSummary {
  ok: boolean;
  error: string | null;
  styles: Record<StyleSetId, WadStyleSummary>;
  signals: Record<keyof SignalTextures, string | null>;
  /** How many of `totalSlots` came from the WAD rather than a default. */
  matchedSlots: number;
  totalSlots: number;
}

/** 3 structural slots per styleset, plus the 5 shared gameplay-signal slots. */
export const TOTAL_WAD_SLOTS = STYLE_SET_IDS.length * 3 + 5;

/**
 * Owns the `LevelStyle` table the raycaster renders with. Starts out on the
 * procedural defaults; `loadFromWad` swaps in WAD-sourced textures per slot,
 * falling back to that slot's default individually if no allowlisted name
 * matched (or its data turned out corrupt) — never an all-or-nothing swap,
 * and never leaves a style with a missing slot.
 */
export class TextureManager {
  private readonly defaults: Record<StyleSetId, LevelStyle>;
  private active: Record<StyleSetId, LevelStyle>;

  constructor() {
    this.defaults = buildStyles(buildDefaultStyleTextures, buildDefaultSignalTextures());
    this.active = this.defaults;
  }

  /** Always fully populated — the raycaster never needs to null-check a slot. */
  getStyle(id: StyleSetId): LevelStyle {
    return this.active[id];
  }

  /** Parses `bytes` as a DOOM WAD and swaps in whichever slots it has a
   * matching allowlisted texture/flat for (see `src/wad/textureAllowlist.ts`).
   * A fatal parse failure leaves the active styles untouched. Session-only:
   * not persisted, matching the existing "Select BGM Folder" precedent — a
   * fresh page load always starts back on the procedural defaults. */
  loadFromWad(bytes: ArrayBuffer): WadLoadSummary {
    const result = loadWadTextures(bytes);
    const summary = emptySummary(result.error);
    if (!result.ok) return summary;

    const defaultSignals = this.defaults.stone.textures;
    const signals: SignalTextures = {
      loreWall: slotOrDefault(result.signals.loreWall, LORE_BASE, defaultSignals.loreWall),
      hazardFloor: slotOrDefault(result.signals.hazardFloor, HAZARD_FLOOR_BASE, defaultSignals.hazardFloor),
      teleporterFloor: slotOrDefault(
        result.signals.teleporterFloor,
        TELEPORTER_FLOOR_BASE,
        defaultSignals.teleporterFloor,
      ),
      spikeSafeFloor: slotOrDefault(result.signals.spikeSafeFloor, SPIKE_SAFE_FLOOR_BASE, defaultSignals.spikeSafeFloor),
      spikeActiveFloor: slotOrDefault(
        result.signals.spikeActiveFloor,
        SPIKE_ACTIVE_FLOOR_BASE,
        defaultSignals.spikeActiveFloor,
      ),
    };

    this.active = buildStyles((id) => {
      const palette = STYLE_PALETTES[id];
      const slots = result.styles[id];
      const fallback = this.defaults[id].textures;
      return {
        wall: slotOrDefault(slots.wall, palette.wall.base, fallback.wall),
        floor: slotOrDefault(slots.floor, palette.floor.base, fallback.floor),
        door: slotOrDefault(slots.door, palette.door, fallback.door),
      };
    }, signals);

    for (const id of STYLE_SET_IDS) {
      const slots = result.styles[id];
      summary.styles[id] = { wall: slots.wall.name, floor: slots.floor.name, door: slots.door.name };
    }
    summary.signals = {
      loreWall: result.signals.loreWall.name,
      hazardFloor: result.signals.hazardFloor.name,
      teleporterFloor: result.signals.teleporterFloor.name,
      spikeSafeFloor: result.signals.spikeSafeFloor.name,
      spikeActiveFloor: result.signals.spikeActiveFloor.name,
    };
    summary.matchedSlots = countMatched(summary);
    return summary;
  }
}

function emptySummary(error: string | null): WadLoadSummary {
  const styles = {} as Record<StyleSetId, WadStyleSummary>;
  for (const id of STYLE_SET_IDS) styles[id] = { wall: null, floor: null, door: null };
  return {
    ok: error === null,
    error,
    styles,
    signals: {
      loreWall: null,
      hazardFloor: null,
      teleporterFloor: null,
      spikeSafeFloor: null,
      spikeActiveFloor: null,
    },
    matchedSlots: 0,
    totalSlots: TOTAL_WAD_SLOTS,
  };
}

function countMatched(summary: WadLoadSummary): number {
  let matched = 0;
  for (const id of STYLE_SET_IDS) {
    const style = summary.styles[id];
    if (style.wall) matched++;
    if (style.floor) matched++;
    if (style.door) matched++;
  }
  for (const name of Object.values(summary.signals)) if (name) matched++;
  return matched;
}

export const textures = new TextureManager();

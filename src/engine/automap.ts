// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * The automap: a togglable 2D overlay of the level, revealing only the tiles
 * the player has already explored (fog of war). Pure Canvas 2D, drawn as a
 * late-stage overlay each frame — the sim keeps running while this is up
 * (movement, combat, hazards all continue, Diablo-style), it's not a pause
 * screen. The view is a fixed-cell-size viewport centered on and panning with
 * the player (clamped to the map's bounds), not a shrink-to-fit of the whole
 * grid — that kept large maps illegible and always letterboxed the (always
 * square) grid inside the landscape canvas.
 */
import {
  BRANCH_DOOR_TILE,
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
  type LootDrop,
} from "../map/types";
import { gateIdAt } from "../map/gates";
import { activeSpikeTileKeys } from "./traps";
import type { Player } from "./player";
import { drawRotatedGlyph, outlineRect, type Glyph } from "./pathSprites";
import type { TeammateMapMarker } from "./sprites";
import { HUD_HEIGHT } from "./hud";
import { withOverlayScale } from "./overlayScale";

/** Fixed tile size in *design* pixels — independent of map size, so large maps
 * stay just as readable as small ones (the old fit-to-box math shrank as low
 * as ~2px/tile on big levels). Zoomed well out relative to a "1:1" 10px/tile
 * read, so a given viewport shows a wide swath of the map at once.
 *
 * **Design pixels, so the automap covers the same *tiles* at every preset, not
 * the same device pixels.** Before the overlay layer scaled, Sharp showed four
 * times the map area of Classic — `(1280 - 24) / 3` tiles across versus
 * `(640 - 24) / 3` — because the tiles stayed 3 device px while the canvas
 * doubled. That is the behaviour that changed: a preset now decides how sharp
 * the automap is, not how much of the level it shows. The camera clamp means
 * most campaign maps still fit either way. */
const CELL_PX = 3;
/** Margin kept clear on the left/right/top/bottom of the viewport. */
const MARGIN = 12;

/** Structural/navigational tiles render in muted greyscale, Diablo-style, so
 * the map doesn't visually fight the live world still rendering around it.
 * Only danger/goal tiles keep a distinct accent color (see below). */
const WALL_COLOR = "#c8c8ce";
/** Explored, still-locked doors — a cooler mid-grey, distinguishable from
 * plain wall by tone alone. */
/** Gate tones on the automap, indexed by `Gate.colorIndex` — desaturated
 * relative to the minimap's, because the automap is otherwise greyscale and
 * reserves accents for danger and goals. A gate *is* a goal signal: it tells
 * you which key to go and find. By value, not shared import, as with every
 * other colour here. */
const GATE_COLORS = ["#b4685f", "#5f7fb4", "#5fa878", "#8f68b4"];
/** Explored, unopened Switchboard branch doors — a warm tone against the
 * key-locked door's cool one, so "needs a key" and "just push it" read apart
 * at a glance even on the desaturated automap. */
const BRANCH_DOOR_COLOR = "#b39a72";
/** Explored goto/label teleporter pads — brightest of the structural tones so
 * they still stand out for navigation despite being desaturated. */
const TELEPORTER_COLOR = "#e8eaf0";
/** Lore terminal walls — a mid grey, distinct in tone from wall/door/teleporter. */
const LORE_COLOR = "#b4b8ba";
/** Faint wash marking explored open floor. */
const FLOOR_COLOR = "rgba(200,200,210,0.08)";

/** Spike trap: dull metal when safe, hot red when active — kept as a danger
 * accent (unchanged from before the greyscale restyle). */
const SPIKE_SAFE_COLOR = "#8a8a90";
const SPIKE_ACTIVE_COLOR = "#e02818";
/** Hazard (acid) tiles — same hot, non-green accent as the HUD minimap, kept
 * distinct so danger reads at a glance even in an otherwise grey map. */
const HAZARD_COLOR = "#ff9d1f";
/** Discovered, still-live proximity mines — danger accent. */
const MINE_COLOR = "#ff5050";
/** Exit tile, once discovered — goal accent, matching the corner minimap's
 * exit-pulse hue family. */
const EXIT_COLOR = "#41ff6e";
/** Player marker — the one warm, unambiguous color so it never blends into
 * either the grey terrain or the red/orange/green accents. */
const PLAYER_COLOR = "#ffd23f";
/** Multiplayer-only loot-drop marker color — matches `renderMinimap`'s own
 * `LOOT_DROP_COLOR` by value, not by shared import (each renderer keeps its
 * own independently-defined, thematically-matched constants, same as every
 * other color here). A muted gold/amber, distinct from `PLAYER_COLOR`'s
 * brighter gold. */
const LOOT_DROP_COLOR = "#b8860b";
/** Backing tone drawn behind every teammate dot. Not decoration: `PLAYER_COLORS`
 * includes an amber (`#fbbf24`) almost exactly this map's own `PLAYER_COLOR`
 * (`#ffd23f`) and a green (`#4ade80`) near its `EXIT_COLOR`, so the surround is
 * what keeps "a teammate" from reading as "you" or as the exit. */
const TEAMMATE_OUTLINE_COLOR = "rgba(0,5,2,0.85)";
/** One outward sweep of a help ping's ring, in milliseconds, and how far it
 * grows over that sweep. Wall clock like the minimap's, and by value rather
 * than shared import — same convention as every colour in this file. */
const HELP_PING_SWEEP_MS = 900;
const HELP_PING_RING_GROWTH_PX = 16;

/** Solid rock as far as this map is concerned. An unopened `SECRET_WALL_TILE`
 * counts, which is load-bearing rather than incidental: `secretRooms.ts` carves
 * a secret room's *interior* out of that tile too, precisely so no map can leak
 * it. Treating it as wall here means such a room is enclosed entirely in
 * wall-like tiles, none of which faces open space, so `wallFacesOpenSpace`
 * hides the whole room — exactly as fog of war used to, and for a reason that
 * survives fog's removal. */
function isWallLike(tile: number): boolean {
  return tile === 1 || tile === SECRET_WALL_TILE;
}

/**
 * Whether a wall tile borders the carved level, i.e. any of its eight
 * neighbours is something other than rock. Only such walls are drawn — see the
 * comment at the tile loop for why.
 *
 * Cheap and, more importantly, **static**: it reads only `map.grid`, so the
 * whole tile layer is now a pure function of the grid and can be baked once
 * per level rather than recomputed every frame (see `automapTileLayer`). That
 * is the thing fog of war made impossible, and it is why removing fog is what
 * unblocked the cache.
 */
function wallFacesOpenSpace(map: GameMap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= map.height) continue;
    const row = map.grid[ny];
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= map.width) continue;
      if (!isWallLike(row[nx])) return true;
    }
  }
  return false;
}

/**
 * The colour a tile contributes to the *static* layer, or `null` for one that
 * contributes nothing.
 *
 * Spike traps are deliberately absent: their colour is a function of
 * `levelTime`, so they are the one tile type that cannot be baked and are
 * drawn live over the top in both paths.
 */
function staticTileColor(map: GameMap, x: number, y: number, tile: number): string | null {
  if (isWallLike(tile)) {
    // An unopened secret wall is indistinguishable from a plain wall here on
    // purpose — see `isWallLike`. Rock that faces nothing is not drawn at all.
    return wallFacesOpenSpace(map, x, y) ? WALL_COLOR : null;
  }
  if (tile === LORE_TILE) return LORE_COLOR;
  if (tile === DOOR_TILE) return GATE_COLORS[map.gates[gateIdAt(map, x, y)]?.colorIndex ?? 1];
  // Its own colour, not the key-locked door's: the whole point of the second
  // door type is that a player can tell at a glance which one needs a key they
  // may not have yet.
  if (tile === BRANCH_DOOR_TILE) return BRANCH_DOOR_COLOR;
  if (tile === TELEPORTER_TILE) return TELEPORTER_COLOR;
  if (tile === SPIKE_TRAP_TILE) return null; // live only
  if (tile === HAZARD_TILE) return HAZARD_COLOR;
  return FLOOR_COLOR;
}

/**
 * Cached static tile layer for the automap — perf finding **P4**, which was
 * parked because it *"needs a `visited` revision counter, since fog-of-war
 * grows continuously"*. Removing fog is what made the layer static and the
 * cache possible: it is now a pure function of the grid.
 *
 * Same module-scope single-slot shape as `raycaster.ts`'s `minimapWallLayer`
 * (finding F1). Keyed on map identity plus `gridVersion`, which is bumped
 * whenever the grid itself mutates — a door opening, a secret wall being
 * pushed through.
 *
 * The whole map is baked, not just the viewport, so panning costs nothing and
 * a rotated blit has source pixels in every direction.
 */
let automapTileLayer: {
  source: GameMap;
  gridVersion: number;
  /** Device pixels per design pixel the layer was baked at — part of the key,
   * because a layer baked for Classic and blitted at Sharp is a pixel-doubled
   * 3px grid, which is the blur this whole change exists to remove. */
  scale: number;
  canvas: HTMLCanvasElement;
} | null = null;

/** The cached layer, or `null` when there is no DOM to bake into — which is
 * the case in the unit suite (vitest runs `node`, not `jsdom`, for this
 * module), so the caller falls back to drawing tiles live. That fallback is
 * not dead code kept for tidiness; it is the path every automap test takes. */
function automapTileCanvas(map: GameMap, gridVersion: number, scale: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (
    automapTileLayer &&
    automapTileLayer.source === map &&
    automapTileLayer.gridVersion === gridVersion &&
    automapTileLayer.scale === scale
  ) {
    return automapTileLayer.canvas;
  }
  const canvas = document.createElement("canvas");
  // The floor matters: a zero-sized canvas throws `InvalidStateError` on the
  // first draw rather than returning null, so it would surface as a crash in
  // the renderer rather than as a fallback to live tiles.
  canvas.width = Math.max(1, Math.ceil(map.width * CELL_PX * scale));
  canvas.height = Math.max(1, Math.ceil(map.height * CELL_PX * scale));
  const layerCtx = canvas.getContext("2d");
  if (!layerCtx) return null;
  // The scale is passed in rather than read off the target context, because by
  // the time this is called the caller may have rotated it (facing-up automap)
  // and `contextScale` would be reading a rotated basis for a baker that has
  // nothing to do with the rotation.
  layerCtx.scale(scale, scale);
  for (let y = 0; y < map.height; y++) {
    const row = map.grid[y];
    for (let x = 0; x < map.width; x++) {
      const color = staticTileColor(map, x, y, row[x]);
      if (color === null) continue;
      layerCtx.fillStyle = color;
      layerCtx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  automapTileLayer = { source: map, gridVersion, scale, canvas };
  return canvas;
}

/**
 * Draw the automap as a translucent viewport overlay filling the available
 * area (margin + bottom HUD strip reserved), so most of the live game stays
 * dimly visible through it. Shows explored tiles in a fixed-size grid that
 * pans to keep the player roughly centered (clamped so it never scrolls past
 * the map's edges — same idea as Diablo's map).
 *
 * **No fog of war.** The whole carved level is drawn from the moment it loads,
 * matching the corner minimap, which never had fog. What is *not* drawn is the
 * untouched rock the generator never carved (see `wallFacesOpenSpace`) — the
 * job `map.visited` was incidentally doing here, and the only one of its jobs
 * this panel still needs.
 */
export function drawAutomap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  player: Player,
  levelTime = 0,
  /** Multiplayer-only (`multiplayer-game-state-spec.md` §5) — always `[]` for
   * single-player, so an always-empty array is indistinguishable from this
   * parameter not existing at all. Gated by the caller
   * (`engine.ts`'s `isMultiplayerSession()` check), not here. */
  lootDrops: readonly LootDrop[] = [],
  /** Every other living player, with their marker colour and whether they are
   * calling for help — see `renderMinimap`'s own parameter. `[]` for
   * single-player, so an omitted argument changes nothing. */
  teammates: readonly TeammateMapMarker[] = [],
  /** Bumped by the engine whenever `map.grid` itself mutates (a door opening, a
   * secret wall pushed through) — the cache key for the baked tile layer.
   * Defaults to 0 so callers that don't have one still render correctly; they
   * simply share a single cache slot per map. */
  gridVersion = 0,
  /** Rotate the map so the player's facing is always "up", rather than drawing
   * it north-up. A user setting (`codeenstein-automap-rotate`), so both are
   * live code paths. */
  rotateToFacing = false,
): void {
  withOverlayScale(ctx, (width, height, scale) => {
    const vx0 = MARGIN;
    const vy0 = MARGIN;
    const viewW = Math.max(1, width - MARGIN * 2);
    const viewH = Math.max(1, height - HUD_HEIGHT - MARGIN * 2);
    const viewTilesW = viewW / CELL_PX;
    const viewTilesH = viewH / CELL_PX;

    // Camera top-left corner, in fractional tile units.
    //
    // North-up: centered on the player by default, clamped per-axis to the map's
    // bounds — but centered on that axis instead when the map is smaller than the
    // viewport there, since the clamp range would otherwise be invalid (negative).
    //
    // Facing-up: centered *exactly* on the player, with no clamp. A rotated
    // viewport's corners sweep past the map's bounds no matter where the camera
    // sits, so a clamp would buy nothing and would make the player's marker drift
    // off the pivot the whole map turns around. Nothing spills visibly, because
    // the rock outside the level is not drawn (see `wallFacesOpenSpace`).
    const camX = rotateToFacing
      ? player.posX
      : map.width <= viewTilesW
        ? (map.width - viewTilesW) / 2
        : Math.max(0, Math.min(player.posX - viewTilesW / 2, map.width - viewTilesW));
    const camY = rotateToFacing
      ? player.posY
      : map.height <= viewTilesH
        ? (map.height - viewTilesH) / 2
        : Math.max(0, Math.min(player.posY - viewTilesH / 2, map.height - viewTilesH));

    // Drawing origin. North-up draws straight into the viewport; facing-up draws
    // around (0,0) because the context is translated to the viewport's centre and
    // rotated first, so the player — the camera's exact centre — lands on the
    // pivot.
    const ox = rotateToFacing ? 0 : vx0;
    const oy = rotateToFacing ? 0 : vy0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vx0, vy0, viewW, viewH);
    ctx.clip();

    // Translucent panel behind the map, Diablo-style — the live 3D scene stays
    // clearly visible through it rather than being mostly hidden.
    ctx.fillStyle = "rgba(0,5,2,0.35)";
    ctx.fillRect(vx0, vy0, viewW, viewH);

    // Everything below is drawn in map space. Facing-up pivots that space about
    // the viewport's centre; the clip and the panel above stay in screen space,
    // so the viewport itself remains a rectangle.
    //
    // `-π/2 - facing` is what puts the facing direction on screen-up: canvas
    // rotate() is clockwise-positive because +Y is down (the same convention
    // `drawCompass` documents), and screen-up is -Y. Note the player marker needs
    // no special case at all — drawn at its real facing angle inside this frame,
    // it comes out pointing up, since `facing + (-π/2 - facing)` is `-π/2`.
    if (rotateToFacing) {
      ctx.translate(vx0 + viewW / 2, vy0 + viewH / 2);
      ctx.rotate(-Math.PI / 2 - Math.atan2(player.dirY, player.dirX));
      // A nearest-neighbour rotation of 3px cells aliases badly; opt this one
      // blit in and restore, the way `drawDisc` does.
      ctx.imageSmoothingEnabled = true;
    }

    const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);

    // Only the tile range that can actually be visible in the viewport.
    // The tile range that can actually be visible. Rotated, the viewport's
    // corners reach further than its own width and height — up to half its
    // diagonal in every direction from the pivot — so the axis-aligned bounds
    // would clip the map short on the diagonals as the player turns.
    const reachTiles = Math.hypot(viewW, viewH) / 2 / CELL_PX + 1;
    const tileX0 = Math.max(0, Math.floor(rotateToFacing ? camX - reachTiles : camX));
    const tileY0 = Math.max(0, Math.floor(rotateToFacing ? camY - reachTiles : camY));
    const tileX1 = Math.min(map.width, Math.ceil(rotateToFacing ? camX + reachTiles : camX + viewTilesW));
    const tileY1 = Math.min(map.height, Math.ceil(rotateToFacing ? camY + reachTiles : camY + viewTilesH));

    // One blit for the whole static layer where a DOM exists to bake into,
    // otherwise the same tiles drawn live. See `automapTileCanvas`.
    const layer = automapTileCanvas(map, gridVersion, scale);
    if (layer) {
      // The viewport clip above already bounds this, so the whole layer can be
      // drawn at a camera offset rather than sliced with source-rect arithmetic
      // — which also keeps negative `camX`/`camY` (a map smaller than the
      // viewport, so the camera centres instead of clamping) from needing a
      // special case.
      ctx.drawImage(layer, ox - camX * CELL_PX, oy - camY * CELL_PX, layer.width / scale, layer.height / scale);
      // Spike traps are the one tile type that cannot be baked — their colour
      // rides `levelTime`. Walked from `map.spikeTraps` rather than by scanning
      // the grid, since that list is exactly the tiles that need them.
      for (const trap of map.spikeTraps) {
        if (trap.x < tileX0 - 1 || trap.x > tileX1 || trap.y < tileY0 - 1 || trap.y > tileY1) continue;
        ctx.fillStyle = activeSpikes.has(`${trap.x},${trap.y}`) ? SPIKE_ACTIVE_COLOR : SPIKE_SAFE_COLOR;
        ctx.fillRect(ox + (trap.x - camX) * CELL_PX, oy + (trap.y - camY) * CELL_PX, CELL_PX, CELL_PX);
      }
    } else {
      for (let y = tileY0; y < tileY1; y++) {
        const tileRow = map.grid[y];
        for (let x = tileX0; x < tileX1; x++) {
          const tile = tileRow[x];
          const color =
            tile === SPIKE_TRAP_TILE
              ? activeSpikes.has(`${x},${y}`)
                ? SPIKE_ACTIVE_COLOR
                : SPIKE_SAFE_COLOR
              : staticTileColor(map, x, y, tile);
          if (color === null) continue;
          ctx.fillStyle = color;
          ctx.fillRect(ox + (x - camX) * CELL_PX, oy + (y - camY) * CELL_PX, CELL_PX, CELL_PX);
        }
      }
    }

    // Discovered, still-live proximity mines.
    ctx.fillStyle = MINE_COLOR;
    for (const mine of map.mines) {
      if (!mine.alive || !mine.visible) continue;
      if (mine.x < tileX0 - 1 || mine.x > tileX1 || mine.y < tileY0 - 1 || mine.y > tileY1) continue;
      const mx = ox + (mine.x - camX) * CELL_PX - CELL_PX / 2;
      const my = oy + (mine.y - camY) * CELL_PX - CELL_PX / 2;
      ctx.fillRect(mx, my, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
    }

    // Multiplayer-only loot drops (ammo/weapon/health/key drops on the ground
    // — e.g. left behind by a disconnected player), and the one thing here still
    // gated on `map.visited`.
    //
    // That gate used to be justified as "the same rule this renderer already
    // applies to literally everything else". It is now the *exception* rather
    // than the rule, and it survives on its own merits: a drop marks where a
    // teammate dropped out, so an ungated one broadcasts their exact position
    // the instant it happens, in a room nobody has entered. That is a coop
    // privacy rule (`multiplayer-game-state-spec.md` §5), not a discovery one,
    // which is why it outlived the fog it used to hide behind. `[]` for
    // single-player, so this loop is a no-op there.
    ctx.fillStyle = LOOT_DROP_COLOR;
    for (const drop of lootDrops) {
      if (!map.visited[Math.floor(drop.y)]?.[Math.floor(drop.x)]) continue;
      if (drop.x < tileX0 - 1 || drop.x > tileX1 || drop.y < tileY0 - 1 || drop.y > tileY1) continue;
      const dx = ox + (drop.x - camX) * CELL_PX - CELL_PX / 2;
      const dy = oy + (drop.y - camY) * CELL_PX - CELL_PX / 2;
      ctx.fillRect(dx, dy, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
    }

    // Exit tile. Drawn unconditionally now that the terrain is: the corner
    // minimap has always shown the exit from the moment the level loads
    // (`renderMinimap`'s own exit block has no gate at all), so keeping a
    // discovery gate on this one panel made the *bigger, deliberately opened*
    // map the one that told you less.
    {
      ctx.fillStyle = EXIT_COLOR;
      const ex = ox + (map.exit.x - camX) * CELL_PX;
      const ey = oy + (map.exit.y - camY) * CELL_PX;
      ctx.fillRect(ex, ey, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
    }

    // Teammates, in their own per-player colour. Ungated — which was a
    // deliberate exception when the terrain was fogged, and is simply the norm
    // now that it isn't. The distinction that still matters is with the loot
    // drops above: a drop is level content and leaks a room, a teammate is a
    // person and leaks only themselves, to people already on their team.
    // `[]` in single-player, so this loop is a no-op there.
    for (const mate of teammates) {
      const mx = ox + (mate.x - camX) * CELL_PX;
      const my = oy + (mate.y - camY) * CELL_PX;
      const dot = Math.max(4, CELL_PX + 1);
      ctx.fillStyle = TEAMMATE_OUTLINE_COLOR;
      ctx.fillRect(mx - dot / 2 - 1, my - dot / 2 - 1, dot + 2, dot + 2);
      ctx.fillStyle = mate.color;
      ctx.fillRect(mx - dot / 2, my - dot / 2, dot, dot);
    }

    // The sonar ring for anyone currently calling for help. The viewport is
    // already clipped above, so unlike the minimap's this needs no clip of its
    // own. `outlineRect` (four `fillRect`s), never `strokeRect` — this renderer
    // is covered by `renderCost.test.ts` too.
    const now = performance.now();
    const helpPulse = 0.5 + 0.5 * Math.sin(now / 150);
    const helpSweep = (now % HELP_PING_SWEEP_MS) / HELP_PING_SWEEP_MS;
    ctx.lineWidth = 1;
    for (const mate of teammates) {
      if (!mate.helpPing) continue;
      const cx = ox + (mate.x - camX) * CELL_PX;
      const cy = oy + (mate.y - camY) * CELL_PX;
      const base = Math.max(4, CELL_PX + 1) * (1 + 0.3 * helpPulse);
      ctx.fillStyle = mate.color;
      ctx.fillRect(cx - base / 2, cy - base / 2, base, base);
      const ring = base + 2 + helpSweep * HELP_PING_RING_GROWTH_PX;
      ctx.strokeStyle = mate.color;
      ctx.globalAlpha = 0.7 * (1 - helpSweep);
      outlineRect(ctx, cx - ring / 2, cy - ring / 2, ring, ring);
      ctx.globalAlpha = 1;
    }

    drawPlayerMarker(ctx, player, ox, oy, camX, camY, CELL_PX);

    if (rotateToFacing) ctx.imageSmoothingEnabled = false;
    ctx.restore();
  });
}

/** Solid triangle at the player's exact position, pointing along their
 * facing — camera-relative, so it stays near the viewport's center while the
 * camera is actively panning, sliding toward an edge only near the map's
 * actual boundary. */
function drawPlayerMarker(
  ctx: CanvasRenderingContext2D,
  player: Player,
  vx0: number,
  vy0: number,
  camX: number,
  camY: number,
  cell: number,
): void {
  const px = vx0 + (player.posX - camX) * cell;
  const py = vy0 + (player.posY - camY) * cell;
  const angle = Math.atan2(player.dirY, player.dirX);
  drawRotatedGlyph(ctx, playerMarkerGlyph(Math.max(6, cell * 1.6)), angle, px, py);
}

/** Player-marker glyphs by rendered size — see `raycaster.ts`'s own
 * `minimapMarkerGlyph` for the shared reasoning; `CELL_PX` is fixed here, so
 * in practice this memo holds exactly one entry. */
const playerMarkerGlyphs = new Map<number, Glyph>();

function playerMarkerGlyph(size: number): Glyph {
  const cached = playerMarkerGlyphs.get(size);
  if (cached) return cached;
  const back = size * 0.7;
  const glyph: Glyph = {
    width: size * 2 + 4,
    height: size * 2 + 4,
    anchorX: size + 2,
    anchorY: size + 2,
    draw: (g, ox, oy) => {
      g.fillStyle = PLAYER_COLOR;
      g.beginPath();
      g.moveTo(ox + size, oy);
      g.lineTo(ox + Math.cos(2.5) * back, oy + Math.sin(2.5) * back);
      g.lineTo(ox + Math.cos(-2.5) * back, oy + Math.sin(-2.5) * back);
      g.closePath();
      g.fill();
    },
  };
  playerMarkerGlyphs.set(size, glyph);
  return glyph;
}

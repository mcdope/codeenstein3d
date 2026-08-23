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

/** Fixed tile size in canvas pixels — independent of map size, so large maps
 * stay just as readable as small ones (the old fit-to-box math shrank as low
 * as ~2px/tile on big levels). Zoomed well out relative to a "1:1" 10px/tile
 * read, so a given viewport shows a wide swath of the map at once. */
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
): void {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  const vx0 = MARGIN;
  const vy0 = MARGIN;
  const viewW = Math.max(1, width - MARGIN * 2);
  const viewH = Math.max(1, height - HUD_HEIGHT - MARGIN * 2);
  const viewTilesW = viewW / CELL_PX;
  const viewTilesH = viewH / CELL_PX;

  // Camera top-left corner, in fractional tile units: centered on the player
  // by default, clamped per-axis to the map's bounds — but centered on that
  // axis instead when the map is smaller than the viewport there, since the
  // clamp range would otherwise be invalid (negative).
  const camX =
    map.width <= viewTilesW
      ? (map.width - viewTilesW) / 2
      : Math.max(0, Math.min(player.posX - viewTilesW / 2, map.width - viewTilesW));
  const camY =
    map.height <= viewTilesH
      ? (map.height - viewTilesH) / 2
      : Math.max(0, Math.min(player.posY - viewTilesH / 2, map.height - viewTilesH));

  ctx.save();
  ctx.beginPath();
  ctx.rect(vx0, vy0, viewW, viewH);
  ctx.clip();

  // Translucent panel behind the map, Diablo-style — the live 3D scene stays
  // clearly visible through it rather than being mostly hidden.
  ctx.fillStyle = "rgba(0,5,2,0.35)";
  ctx.fillRect(vx0, vy0, viewW, viewH);

  const activeSpikes = activeSpikeTileKeys(map.spikeTraps, levelTime);

  // Only the tile range that can actually be visible in the viewport.
  const tileX0 = Math.max(0, Math.floor(camX));
  const tileY0 = Math.max(0, Math.floor(camY));
  const tileX1 = Math.min(map.width, Math.ceil(camX + viewTilesW));
  const tileY1 = Math.min(map.height, Math.ceil(camY + viewTilesH));

  for (let y = tileY0; y < tileY1; y++) {
    const tileRow = map.grid[y];
    for (let x = tileX0; x < tileX1; x++) {
      const tile = tileRow[x];
      // The carved-level mask that replaced fog of war. `MapGenerator`
      // allocates a solid grid and carves the level out of it, so the great
      // majority of wall tiles are untouched rock that no player will ever
      // stand near — and `map.visited` used to hide them as a side effect of
      // hiding everything unexplored. Painting them now would fill the whole
      // viewport with `WALL_COLOR` and destroy the point of a *translucent*
      // overlay (see `debugRevealMap`'s own doc comment, which calls the
      // result "a screenshot that is mostly a grey field, and one no amount of
      // real play could ever produce").
      //
      // So a wall is drawn only where it actually faces the level. That is the
      // same rule `debugRevealMap` hand-rolls — open tiles plus the walls
      // immediately around them — derived from the grid instead of from a
      // reveal radius, which makes it static and therefore bakeable.
      if (isWallLike(tile) && !wallFacesOpenSpace(map, x, y)) continue;
      const px = vx0 + (x - camX) * CELL_PX;
      const py = vy0 + (y - camY) * CELL_PX;
      if (tile === 1 || tile === SECRET_WALL_TILE) {
        // An unopened secret wall is indistinguishable from a plain wall
        // here on purpose — the automap must not spoil its location before
        // the player actually finds/opens it. The one intended discovery
        // hint is the much subtler in-view tint (`secretWallTint` in
        // raycaster.ts); once opened, the tile becomes plain floor (0) and
        // falls through to the ordinary floor branch below like any other
        // explored room.
        ctx.fillStyle = WALL_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === LORE_TILE) {
        ctx.fillStyle = LORE_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === DOOR_TILE) {
        ctx.fillStyle = GATE_COLORS[map.gates[gateIdAt(map, x, y)]?.colorIndex ?? 1];
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === BRANCH_DOOR_TILE) {
        // Its own colour, not the key-locked door's: the whole point of the
        // second door type is that a player can tell at a glance which one
        // needs a key they may not have yet.
        ctx.fillStyle = BRANCH_DOOR_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === TELEPORTER_TILE) {
        ctx.fillStyle = TELEPORTER_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === SPIKE_TRAP_TILE) {
        ctx.fillStyle = activeSpikes.has(`${x},${y}`) ? SPIKE_ACTIVE_COLOR : SPIKE_SAFE_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else if (tile === HAZARD_TILE) {
        ctx.fillStyle = HAZARD_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      } else {
        ctx.fillStyle = FLOOR_COLOR;
        ctx.fillRect(px, py, CELL_PX, CELL_PX);
      }
    }
  }

  // Discovered, still-live proximity mines.
  ctx.fillStyle = MINE_COLOR;
  for (const mine of map.mines) {
    if (!mine.alive || !mine.visible) continue;
    if (mine.x < tileX0 - 1 || mine.x > tileX1 || mine.y < tileY0 - 1 || mine.y > tileY1) continue;
    const mx = vx0 + (mine.x - camX) * CELL_PX - CELL_PX / 2;
    const my = vy0 + (mine.y - camY) * CELL_PX - CELL_PX / 2;
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
    const dx = vx0 + (drop.x - camX) * CELL_PX - CELL_PX / 2;
    const dy = vy0 + (drop.y - camY) * CELL_PX - CELL_PX / 2;
    ctx.fillRect(dx, dy, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
  }

  // Exit tile. Drawn unconditionally now that the terrain is: the corner
  // minimap has always shown the exit from the moment the level loads
  // (`renderMinimap`'s own exit block has no gate at all), so keeping a
  // discovery gate on this one panel made the *bigger, deliberately opened*
  // map the one that told you less.
  {
    ctx.fillStyle = EXIT_COLOR;
    const ex = vx0 + (map.exit.x - camX) * CELL_PX;
    const ey = vy0 + (map.exit.y - camY) * CELL_PX;
    ctx.fillRect(ex, ey, Math.max(3, CELL_PX), Math.max(3, CELL_PX));
  }

  // Teammates, in their own per-player colour. Ungated — which was a
  // deliberate exception when the terrain was fogged, and is simply the norm
  // now that it isn't. The distinction that still matters is with the loot
  // drops above: a drop is level content and leaks a room, a teammate is a
  // person and leaks only themselves, to people already on their team.
  // `[]` in single-player, so this loop is a no-op there.
  for (const mate of teammates) {
    const mx = vx0 + (mate.x - camX) * CELL_PX;
    const my = vy0 + (mate.y - camY) * CELL_PX;
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
    const cx = vx0 + (mate.x - camX) * CELL_PX;
    const cy = vy0 + (mate.y - camY) * CELL_PX;
    const base = Math.max(4, CELL_PX + 1) * (1 + 0.3 * helpPulse);
    ctx.fillStyle = mate.color;
    ctx.fillRect(cx - base / 2, cy - base / 2, base, base);
    const ring = base + 2 + helpSweep * HELP_PING_RING_GROWTH_PX;
    ctx.strokeStyle = mate.color;
    ctx.globalAlpha = 0.7 * (1 - helpSweep);
    outlineRect(ctx, cx - ring / 2, cy - ring / 2, ring, ring);
    ctx.globalAlpha = 1;
  }

  drawPlayerMarker(ctx, player, vx0, vy0, camX, camY, CELL_PX);

  ctx.restore();
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

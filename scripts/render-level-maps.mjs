// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Renders every `demo-campaign/` level's floor plan to a PNG and prints a
 * layout-metrics table, headlessly (no browser, no DOM — see
 * `scripts/lib/loadEngineModules.mjs`).
 *
 * Layout quality is a *visual* property first and a numeric one second: "the
 * corridors are too long and the breakup rooms all look the same" is obvious
 * the moment you see seventeen floor plans side by side, and invisible in any
 * single-level assertion. `verify-demo-campaign.mjs` already checks that every
 * map *feature* shows up somewhere; nothing checked how the result reads as a
 * place. This is that missing half — a repeatable before/after for any change
 * to `src/map/generation/`, rather than a one-off eyeball.
 *
 * The metrics are picked to be exactly the ones that move when room placement
 * or corridor topology changes:
 *
 * - `legMean/legMax` — manhattan distance between consecutive room centers.
 *   This is the *cause* of long corridors, since `connectRooms` carves between
 *   those two points and nothing bounds their separation.
 * - `maxRun` — longest unbroken straight corridor run, the thing
 *   `breakUpLongCorridors` exists to keep under `MAX_CORRIDOR_STRAIGHT_LENGTH`.
 * - `feat` + the footprint histogram — how many corridor features got injected
 *   and how much they repeat.
 * - `floor/bbox` — how densely the level fills the space it spans, as opposed
 *   to `floor/grid`, which mostly measures leftover border rock.
 * - `loopIdx` — grouped room doorways / 2 - (rooms - 1). Zero for a pure tree;
 *   positive once rooms have more than one way in.
 *
 * PNG is written by hand (zlib + CRC32, ~40 lines below) rather than through a
 * canvas shim or an image dependency: the output is a flat palette of solid
 * tiles, which is the one case where a raw encoder is genuinely simpler than
 * the alternatives.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadEngineModules, REPO_ROOT } from "./lib/loadEngineModules.mjs";

const CAMPAIGN_DIR = path.join(REPO_ROOT, "demo-campaign");
const OUT_DIR = path.join(REPO_ROOT, "level_maps");
/** Pixels per map tile in the rendered PNG. 4 keeps a 160-tile map readable
 * at 640px without needing a separate scaling step. */
const TILE_PX = 4;

/** Same directories-first/alphabetical-case-insensitive order the real game
 * uses (`compareNodes`, `src/fs/workspace.ts`), mirrored from
 * `verify-demo-campaign.mjs`. */
function campaignOrder(filenames) {
  return [...filenames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// --- PNG encoding ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode raw RGB rows (`width * height * 3`) as a truecolor PNG. */
function encodePng(rgb, width, height) {
  // PNG scanlines are each prefixed with a filter byte; filter 0 (none) is
  // fine here — the image is large flat color runs, which deflate handles.
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- rendering ------------------------------------------------------------

/** Tile palette. Room / corridor / corridor-feature floor are all grid value
 * `0` — they're told apart by which rect a tile falls inside, which is the
 * whole point of the picture. */
const PALETTE = {
  rock: [22, 22, 28],
  room: [70, 110, 190],
  feature: [225, 140, 45],
  corridor: [200, 200, 205],
  hazard: [90, 200, 80],
  door: [235, 90, 90],
  branchDoor: [235, 150, 90],
  teleporter: [90, 200, 235],
  spikeTrap: [190, 60, 60],
  secretWall: [140, 60, 200],
  lore: [230, 220, 120],
  spawn: [60, 230, 90],
  exit: [255, 240, 60],
};

const TILE_PALETTE_KEY = {
  2: "hazard",
  3: "door",
  4: "teleporter",
  5: "spikeTrap",
  6: "secretWall",
  7: "lore",
  8: "branchDoor",
};

/** Set of `"x,y"` keys covered by `rects`. */
function rectTileKeys(rects) {
  const keys = new Set();
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) keys.add(`${x},${y}`);
    }
  }
  return keys;
}

function renderLevelPng(map, roomKeys, featureKeys) {
  const width = map.width * TILE_PX;
  const height = map.height * TILE_PX;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.grid[y][x];
      let color;
      if (x === map.spawn.x && y === map.spawn.y) color = PALETTE.spawn;
      else if (x === map.exit.x && y === map.exit.y) color = PALETTE.exit;
      else if (tile === 1) color = PALETTE.rock;
      else if (TILE_PALETTE_KEY[tile]) color = PALETTE[TILE_PALETTE_KEY[tile]];
      else if (featureKeys.has(`${x},${y}`)) color = PALETTE.feature;
      else if (roomKeys.has(`${x},${y}`)) color = PALETTE.room;
      else color = PALETTE.corridor;

      for (let dy = 0; dy < TILE_PX; dy++) {
        for (let dx = 0; dx < TILE_PX; dx++) {
          const offset = ((y * TILE_PX + dy) * width + (x * TILE_PX + dx)) * 3;
          rgb[offset] = color[0];
          rgb[offset + 1] = color[1];
          rgb[offset + 2] = color[2];
        }
      }
    }
  }
  return encodePng(rgb, width, height);
}

// --- metrics --------------------------------------------------------------

/**
 * Longest unbroken straight run of *plain corridor* floor — floor that belongs
 * to no room and no corridor feature. Deliberately the same definition
 * `findStraightRuns` uses in `breakup.ts`, so this number is directly
 * comparable to `MAX_CORRIDOR_STRAIGHT_LENGTH`.
 */
function maxStraightRun(map, roomKeys, featureKeys) {
  const isCorridor = (x, y) =>
    map.grid[y][x] === 0 && !roomKeys.has(`${x},${y}`) && !featureKeys.has(`${x},${y}`);
  let longest = 0;
  const scan = (outer, inner, at) => {
    for (let a = 0; a < outer; a++) {
      let run = 0;
      for (let b = 0; b < inner; b++) {
        if (at(a, b)) {
          run++;
          if (run > longest) longest = run;
        } else {
          run = 0;
        }
      }
    }
  };
  scan(map.height, map.width, (y, x) => isCorridor(x, y));
  scan(map.width, map.height, (x, y) => isCorridor(x, y));
  return longest;
}

/**
 * Distinct doorways on a room's perimeter: contiguous runs of open floor just
 * outside the room that lead into it, each run counted once however many tiles
 * wide it is. Same "a doorway is one gate, however many tiles wide" rule
 * `doorwayTiles` (`geometry.ts`) applies to keys — without it a 3-wide
 * corridor mouth would read as three separate ways in and the loop index would
 * be nonsense.
 */
function roomDoorways(room, map) {
  const open = (x, y) => map.grid[y]?.[x] !== undefined && map.grid[y][x] !== 1;
  let doorways = 0;
  const scanSide = (length, outsideAt, insideAt) => {
    let inRun = false;
    for (let i = 0; i < length; i++) {
      const [ox, oy] = outsideAt(i);
      const [ix, iy] = insideAt(i);
      const isMouth = open(ox, oy) && open(ix, iy);
      if (isMouth && !inRun) doorways++;
      inRun = isMouth;
    }
  };
  scanSide(room.w, (i) => [room.x + i, room.y - 1], (i) => [room.x + i, room.y]);
  scanSide(room.w, (i) => [room.x + i, room.y + room.h], (i) => [room.x + i, room.y + room.h - 1]);
  scanSide(room.h, (i) => [room.x - 1, room.y + i], (i) => [room.x, room.y + i]);
  scanSide(room.h, (i) => [room.x + room.w, room.y + i], (i) => [room.x + room.w - 1, room.y + i]);
  return doorways;
}

function levelMetrics(map, roomKeys, featureKeys) {
  const legs = [];
  for (let i = 1; i < map.rooms.length; i++) {
    const a = map.rooms[i - 1].center;
    const b = map.rooms[i].center;
    legs.push(Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
  }
  legs.sort((a, b) => a - b);

  let floor = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.grid[y][x] === 1) continue;
      floor++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const bbox = floor > 0 ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
  const doorways = map.rooms.reduce((sum, room) => sum + roomDoorways(room, map), 0);

  return {
    size: map.width,
    rooms: map.rooms.length,
    features: map.breakupRooms.length,
    legMean: legs.length > 0 ? Math.round(legs.reduce((s, v) => s + v, 0) / legs.length) : 0,
    legMax: legs.at(-1) ?? 0,
    legsOver20: legs.filter((l) => l > 20).length,
    maxRun: maxStraightRun(map, roomKeys, featureKeys),
    floorPctGrid: Math.round((floor / (map.width * map.height)) * 100),
    floorPctBbox: bbox > 0 ? Math.round((floor / bbox) * 100) : 0,
    // A pure tree over N rooms has N-1 edges, so 2(N-1) doorways. Anything
    // above that is a second way into some room: a loop or a junction.
    loopIdx: Math.round(doorways / 2 - Math.max(0, map.rooms.length - 1)),
    doors: map.doors.length,
    keys: map.keys.length,
  };
}

// --- main -----------------------------------------------------------------

const { parseFile, extensionOf, MapGenerator, UNLOCKABLE_WEAPONS } = await loadEngineModules();
const generator = new MapGenerator();

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const filenames = campaignOrder(
  fs.readdirSync(CAMPAIGN_DIR).filter((f) => fs.statSync(path.join(CAMPAIGN_DIR, f)).isFile()),
);

const rows = [];
const footprints = new Map();

for (const filename of filenames) {
  const source = fs.readFileSync(path.join(CAMPAIGN_DIR, filename), "utf8");
  const parsed = await parseFile(filename, source);
  if (!parsed) {
    console.error(`[skip] ${filename}: did not parse (no adapter matched, or the adapter threw)`);
    continue;
  }
  const map = generator.generate(parsed, {
    bonusLevel: extensionOf(filename) === "h",
    hasRocketLauncher: false,
    missingWeaponIndices: UNLOCKABLE_WEAPONS,
  });

  const roomKeys = rectTileKeys(map.rooms);
  const featureKeys = rectTileKeys(map.breakupRooms);
  fs.writeFileSync(path.join(OUT_DIR, `${filename}.png`), renderLevelPng(map, roomKeys, featureKeys));
  for (const r of map.breakupRooms) {
    const shape = `${r.w}x${r.h}`;
    footprints.set(shape, (footprints.get(shape) ?? 0) + 1);
  }
  // `entities` next to `rooms` is the regression signal for anything that
  // tightens placement: an entity whose room never fits is silently dropped,
  // taking its enemies, doors and lore anchor with it.
  rows.push({ file: filename, entities: parsed.entities.length, ...levelMetrics(map, roomKeys, featureKeys) });
}

const COLUMNS = [
  ["file", 28, (r) => r.file],
  ["size", 5, (r) => r.size],
  ["rooms", 6, (r) => `${r.rooms}/${r.entities}`],
  ["feat", 5, (r) => r.features],
  ["legMean", 8, (r) => r.legMean],
  ["legMax", 7, (r) => r.legMax],
  [">20", 4, (r) => r.legsOver20],
  ["maxRun", 7, (r) => r.maxRun],
  ["fl/grid", 8, (r) => `${r.floorPctGrid}%`],
  ["fl/bbox", 8, (r) => `${r.floorPctBbox}%`],
  ["loopIdx", 8, (r) => r.loopIdx],
  ["doors", 6, (r) => r.doors],
  ["keys", 5, (r) => r.keys],
];

console.log(COLUMNS.map(([label, width]) => String(label).padEnd(width)).join(""));
for (const row of rows) {
  console.log(COLUMNS.map(([, width, read]) => String(read(row)).padEnd(width)).join(""));
}

const mean = (read) => Math.round(rows.reduce((s, r) => s + read(r), 0) / Math.max(1, rows.length));
console.log(
  `\nacross ${rows.length} levels: legMean=${mean((r) => r.legMean)}  ` +
    `legMax=${Math.max(...rows.map((r) => r.legMax))}  ` +
    `maxRun=${Math.max(...rows.map((r) => r.maxRun))}  ` +
    `features=${rows.reduce((s, r) => s + r.features, 0)}  ` +
    `floor/bbox=${mean((r) => r.floorPctBbox)}%  ` +
    `loopIdx=${mean((r) => r.loopIdx)}`,
);

const sortedFootprints = [...footprints.entries()].sort((a, b) => b[1] - a[1]);
const featureTotal = sortedFootprints.reduce((s, [, n]) => s + n, 0);
console.log(
  `corridor-feature footprints (${featureTotal} total): ` +
    sortedFootprints.map(([shape, n]) => `${shape}:${n}`).join("  "),
);

fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), `${JSON.stringify({ rows, footprints: sortedFootprints }, null, 2)}\n`);
console.log(`\nwrote ${rows.length} PNGs + metrics.json to ${path.relative(REPO_ROOT, OUT_DIR)}/`);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-constructs small synthetic WAD `ArrayBuffer`s for `verify-wad-parser.mjs`
 * — no real IWAD is bundled with this repo (copyright), so every fixture used
 * for testing `src/wad/` is built here, byte by byte, from the format spec.
 *
 * The default fixture's `TESTWALL`/`TESTFLOOR` texture/flat are deliberately
 * named after real allowlist entries (`textureAllowlist.ts`) so the same
 * fixture exercises both the low-level parse functions directly *and*
 * `loadWadTextures`'s end-to-end allowlist-matching path.
 */

function writeName(buf, offset, name, maxLen) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < name.length ? name.charCodeAt(i) : 0;
  }
}

function buildPlaypal(entries) {
  const buf = new Uint8Array(256 * 3);
  for (const [index, [r, g, b]] of entries) {
    buf[index * 3] = r;
    buf[index * 3 + 1] = g;
    buf[index * 3 + 2] = b;
  }
  return buf;
}

function buildPnames(names) {
  const buf = new Uint8Array(4 + names.length * 8);
  new DataView(buf.buffer).setInt32(0, names.length, true);
  names.forEach((n, i) => writeName(buf, 4 + i * 8, n, 8));
  return buf;
}

/** `columns`: one entry per column, each a list of `{ topDelta, pixels }`
 * posts — an empty list means that column has zero posts (a deliberate
 * "hole", used to test that an earlier-composited patch shows through). */
function buildPatch(width, height, columns) {
  const headerSize = 8;
  const columnOfsSize = width * 4;
  const columnBlocks = [];
  const columnOffsets = [];
  let cursor = headerSize + columnOfsSize;

  for (const posts of columns) {
    columnOffsets.push(cursor);
    const bytes = [];
    for (const post of posts) {
      bytes.push(post.topDelta & 0xff, post.pixels.length & 0xff, 0, ...post.pixels, 0);
    }
    bytes.push(0xff); // terminator
    columnBlocks.push(Uint8Array.from(bytes));
    cursor += bytes.length;
  }

  const buf = new Uint8Array(cursor);
  const view = new DataView(buf.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, 0, true); // leftoffset, unused
  view.setInt16(6, 0, true); // topoffset, unused
  columnOffsets.forEach((ofs, x) => view.setInt32(headerSize + x * 4, ofs, true));

  let offset = headerSize + columnOfsSize;
  for (const block of columnBlocks) {
    buf.set(block, offset);
    offset += block.length;
  }
  return buf;
}

/** `defs`: `[{ name, width, height, patches: [{ originX, originY, patchIndex }] }]`. */
function buildTextureLump(defs) {
  const headerSize = 4 + defs.length * 4;
  const texBlocks = [];
  const offsets = [];
  let cursor = headerSize;

  for (const def of defs) {
    offsets.push(cursor);
    const size = 22 + def.patches.length * 10;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    writeName(buf, 0, def.name, 8);
    view.setInt32(8, 0, true); // masked, unused
    view.setInt16(12, def.width, true);
    view.setInt16(14, def.height, true);
    view.setInt32(16, 0, true); // columndirectory, obsolete/unused
    view.setInt16(20, def.patches.length, true);
    def.patches.forEach((p, i) => {
      const po = 22 + i * 10;
      view.setInt16(po, p.originX, true);
      view.setInt16(po + 2, p.originY, true);
      view.setInt16(po + 4, p.patchIndex, true);
      view.setInt16(po + 6, 0, true); // stepdir, unused
      view.setInt16(po + 8, 0, true); // colormap, unused
    });
    texBlocks.push(buf);
    cursor += size;
  }

  const out = new Uint8Array(cursor);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, defs.length, true);
  offsets.forEach((ofs, i) => outView.setInt32(4 + i * 4, ofs, true));
  let off = headerSize;
  for (const block of texBlocks) {
    out.set(block, off);
    off += block.length;
  }
  return out;
}

function buildFlat(paletteIndex) {
  return new Uint8Array(64 * 64).fill(paletteIndex);
}

function assembleWad(lumps, magic) {
  const headerSize = 12;
  const positions = [];
  let cursor = headerSize;
  for (const lump of lumps) {
    positions.push(cursor);
    cursor += lump.bytes.length;
  }
  const dirOffset = cursor;
  const out = new Uint8Array(dirOffset + lumps.length * 16);
  const view = new DataView(out.buffer);
  writeName(out, 0, magic, 4);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, dirOffset, true);

  lumps.forEach((lump, i) => {
    out.set(lump.bytes, positions[i]);
    const entry = dirOffset + i * 16;
    view.setInt32(entry, positions[i], true);
    view.setInt32(entry + 4, lump.bytes.length, true);
    writeName(out, entry + 8, lump.name, 8);
  });
  return out.buffer;
}

/**
 * Palette entries used by every fixture below: index 0 is unused/background,
 * 1/2 are the two composited-texture test colors, 3 is the flat's color.
 */
export const PALETTE_ENTRIES = {
  patchA: [10, 20, 30],
  patchB: [40, 50, 60],
  flat: [80, 90, 100],
};

/**
 * Builds `TESTWALL` (6×4) from two overlapping patches: `PATCH1` (4×4, fully
 * opaque, `patchA` color) at origin (0,0), then `PATCH2` (2×4) at the same
 * origin — its column 0 is opaque `patchB` color (overwrites `PATCH1`'s),
 * its column 1 has zero posts (a hole, so `PATCH1`'s original color shows
 * through). Columns 4-5 are never covered by either patch, so they must
 * come back fully transparent (`alpha === 0`).
 */
export function buildTestWad(opts = {}) {
  const {
    includePlaypal = true,
    includeTextures = true,
    includeFlats = true,
    textureName = "STARTAN3", // real WALL_TEXTURE_ALLOWLIST entry
    doorTextureName = "BIGDOOR2", // real DOOR_TEXTURE_ALLOWLIST entry; pass null to omit
    loreWallTextureName = "COMPUTE2", // real LORE_WALL_TEXTURE_ALLOWLIST entry; pass null to omit
    flatName = "FLOOR4_8", // real FLOOR_TEXTURE_ALLOWLIST entry
    bonusFloorName = null, // real BONUS_FLOOR_TEXTURE_ALLOWLIST entry; pass a name to enable
    hazardFloorName = "NUKAGE3", // real HAZARD_FLOOR_TEXTURE_ALLOWLIST entry; pass null to omit
    teleporterFloorName = "GATE1", // real TELEPORTER_FLOOR_TEXTURE_ALLOWLIST entry; pass null to omit
    spikeSafeFloorName = "FLOOR7_1", // real SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST entry; pass null to omit
    spikeActiveFloorName = "BLOOD1", // real SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST entry; pass null to omit
    texture2Name = null, // when set, adds a second TEXTURE2 lump (real Doom2 IWADs ship both); pass a name to enable
    magic = "IWAD",
    truncate = false,
  } = opts;

  const lumps = [];

  if (includePlaypal) {
    lumps.push({
      name: "PLAYPAL",
      bytes: buildPlaypal([
        [1, PALETTE_ENTRIES.patchA],
        [2, PALETTE_ENTRIES.patchB],
        [3, PALETTE_ENTRIES.flat],
      ]),
    });
  }

  if (includeTextures) {
    const patch1Columns = Array.from({ length: 4 }, () => [{ topDelta: 0, pixels: [1, 1, 1, 1] }]);
    const patch2Columns = [[{ topDelta: 0, pixels: [2, 2, 2, 2] }], []]; // column 1: deliberate hole

    lumps.push({ name: "PNAMES", bytes: buildPnames(["PATCH1", "PATCH2"]) });
    lumps.push({ name: "PATCH1", bytes: buildPatch(4, 4, patch1Columns) });
    lumps.push({ name: "PATCH2", bytes: buildPatch(2, 4, patch2Columns) });

    const patches = [
      { originX: 0, originY: 0, patchIndex: 0 },
      { originX: 0, originY: 0, patchIndex: 1 },
    ];
    const textureDefs = [{ name: textureName, width: 6, height: 4, patches }];
    if (doorTextureName) textureDefs.push({ name: doorTextureName, width: 6, height: 4, patches });
    if (loreWallTextureName) textureDefs.push({ name: loreWallTextureName, width: 6, height: 4, patches });

    lumps.push({ name: "TEXTURE1", bytes: buildTextureLump(textureDefs) });

    if (texture2Name) {
      lumps.push({
        name: "TEXTURE2",
        bytes: buildTextureLump([{ name: texture2Name, width: 6, height: 4, patches }]),
      });
    }
  }

  if (includeFlats) {
    lumps.push({ name: "F_START", bytes: new Uint8Array(0) });
    lumps.push({ name: flatName, bytes: buildFlat(3) });
    if (bonusFloorName) lumps.push({ name: bonusFloorName, bytes: buildFlat(3) });
    if (hazardFloorName) lumps.push({ name: hazardFloorName, bytes: buildFlat(3) });
    if (teleporterFloorName) lumps.push({ name: teleporterFloorName, bytes: buildFlat(3) });
    if (spikeSafeFloorName) lumps.push({ name: spikeSafeFloorName, bytes: buildFlat(3) });
    if (spikeActiveFloorName) lumps.push({ name: spikeActiveFloorName, bytes: buildFlat(3) });
    lumps.push({ name: "NOTAFLAT", bytes: new Uint8Array(100) }); // wrong size — must be skipped
    lumps.push({ name: "F_END", bytes: new Uint8Array(0) });
  }

  let bytes = assembleWad(lumps, magic);
  if (truncate) bytes = bytes.slice(0, 16);
  return bytes;
}

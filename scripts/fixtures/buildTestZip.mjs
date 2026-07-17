// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-constructs a small synthetic ZIP `Buffer` for `verify-zip-reader.mjs`
 * — real ZIP layout (local file header + data per entry, then a central
 * directory, then an End Of Central Directory record), built field-by-field
 * from the format spec so every entry's compression method and position is
 * exactly under test control. Same rationale as `buildTestWad.mjs`: no real
 * third-party archive is bundled with this repo for testing.
 */
import { deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** `entries`: `[{ name, data: Buffer, method: "stored" | "deflate" }]`. */
export function buildTestZip(entries, { corruptEocd = false } = {}) {
  const localParts = [];
  const centralEntries = [];
  let cursor = 0;

  for (const { name, data, method } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = method === "deflate" ? deflateRawSync(data) : data;
    const compressionMethod = method === "deflate" ? 8 : 0;

    const localHeaderOffset = cursor;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(compressionMethod, 8);
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    localParts.push(header, nameBuf, compressed);
    cursor += header.length + nameBuf.length + compressed.length;

    centralEntries.push({
      name: nameBuf,
      compressionMethod,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      localHeaderOffset,
    });
  }

  const centralParts = [];
  for (const e of centralEntries) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(e.compressionMethod, 10);
    entry.writeUInt16LE(0, 12); // mod time
    entry.writeUInt16LE(0, 14); // mod date
    entry.writeUInt32LE(0, 16); // crc32
    entry.writeUInt32LE(e.compressedSize, 20);
    entry.writeUInt32LE(e.uncompressedSize, 24);
    entry.writeUInt16LE(e.name.length, 28);
    entry.writeUInt16LE(0, 30); // extra length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number start
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(e.localHeaderOffset, 42);
    centralParts.push(entry, e.name);
  }

  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(corruptEocd ? 0xdeadbeef : EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(centralEntries.length, 8); // entries on this disk
  eocd.writeUInt16LE(centralEntries.length, 10); // total entries
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localData, centralData, eocd]);
}

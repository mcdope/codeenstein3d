// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-rolled ZIP reader for `scripts/fetch-online-wads.mjs`, Node-only. Same
 * convention as `src/wad/wadFile.ts`: raw buffer reads at explicit offsets,
 * little-endian throughout (ZIP's own byte order), throw on fatal/malformed
 * input. See `doc/dev/decisions.md`'s "Dependency Minimalism" section — the
 * same reasoning that justified hand-rolling the WAD parser (small, stable
 * binary format; avoid pulling in an npm package for a one-shot dev tool)
 * applies here.
 *
 * Deliberately narrow: only STORED and DEFLATE entries, no zip64, no
 * multi-disk archives, no encryption — none of this project's source zips
 * use any of those (confirmed directly with `unzip -l` against each one).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

/** Scans backward from the end of the buffer for the End Of Central
 * Directory record — it's the only ZIP structure with a fixed trailing
 * position (allowing for a variable-length comment after it). */
function findEndOfCentralDirectory(buf) {
  const maxScan = Math.min(buf.length, EOCD_MIN_SIZE + MAX_COMMENT_LENGTH);
  for (let offset = buf.length - EOCD_MIN_SIZE; offset >= buf.length - maxScan; offset--) {
    if (offset < 0) break;
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return {
        centralDirectoryOffset: buf.readUInt32LE(offset + 16),
        centralDirectoryEntryCount: buf.readUInt16LE(offset + 10),
      };
    }
  }
  throw new Error("Not a ZIP file (End Of Central Directory record not found)");
}

/** Parses every central directory entry into `{ name, localHeaderOffset,
 * compressedSize, compressionMethod }`. */
function parseCentralDirectory(buf, eocd) {
  const entries = [];
  let offset = eocd.centralDirectoryOffset;
  for (let i = 0; i < eocd.centralDirectoryEntryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Malformed ZIP central directory entry ${i} at offset ${offset}`);
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({ name, localHeaderOffset, compressedSize, compressionMethod });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads one entry's raw (still-compressed) data by following its local
 * file header, which carries the actual variable-length name/extra-field
 * sizes for that copy (they can differ in length from the central directory's). */
function readLocalFileData(buf, entry) {
  const offset = entry.localHeaderOffset;
  if (buf.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Malformed ZIP local file header for "${entry.name}"`);
  }
  const nameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  return buf.subarray(dataStart, dataStart + entry.compressedSize);
}

/** Decompresses one entry to a `Buffer`. `compressionMethod` 0 = STORED
 * (passthrough), 8 = DEFLATE; anything else throws. */
function extractEntry(buf, entry) {
  const raw = readLocalFileData(buf, entry);
  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for "${entry.name}"`);
}

/** Extracts a single named entry from a ZIP `Buffer`. Throws if the entry
 * isn't present or the archive is malformed/unsupported. */
export function extractFileFromZip(zipBuf, entryPath) {
  const eocd = findEndOfCentralDirectory(zipBuf);
  const entries = parseCentralDirectory(zipBuf, eocd);
  const entry = entries.find((e) => e.name === entryPath);
  if (!entry) {
    throw new Error(`"${entryPath}" not found in ZIP (entries: ${entries.map((e) => e.name).join(", ")})`);
  }
  return extractEntry(zipBuf, entry);
}

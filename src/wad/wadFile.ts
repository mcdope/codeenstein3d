// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * DOOM WAD container format: a 12-byte header (magic + lump count + lump
 * directory offset) followed by a flat directory of fixed-size lump entries.
 * Every multi-byte field in the WAD format is little-endian — `DataView`
 * defaults to big-endian, so every read here passes `littleEndian: true`
 * explicitly.
 */

export interface WadHeader {
  isPwad: boolean;
  numLumps: number;
  infoTableOfs: number;
}

export interface LumpEntry {
  filePos: number;
  size: number;
  name: string;
}

/** Reads up to `maxLen` bytes as ASCII, stopping at the first NUL (WAD names
 * are NUL-padded, not necessarily NUL-terminated at exactly `maxLen`), and
 * uppercases the result — real WAD names are always uppercase, but comparing
 * against the hardcoded allowlists defensively rather than assuming it. */
export function readPaddedName(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const byte = view.getUint8(offset + i);
    if (byte === 0) break;
    s += String.fromCharCode(byte);
  }
  return s.toUpperCase();
}

export function parseWadHeader(view: DataView): WadHeader {
  const magic = readPaddedName(view, 0, 4);
  if (magic !== "IWAD" && magic !== "PWAD") {
    throw new Error(`Not a WAD file (expected "IWAD"/"PWAD" magic, got "${magic}")`);
  }
  return {
    isPwad: magic === "PWAD",
    numLumps: view.getInt32(4, true),
    infoTableOfs: view.getInt32(8, true),
  };
}

/** Each lump directory entry is 16 bytes: `int32 filepos`, `int32 size`,
 * `char[8] name`. */
export function parseLumpDirectory(view: DataView, header: WadHeader): LumpEntry[] {
  const lumps: LumpEntry[] = [];
  for (let i = 0; i < header.numLumps; i++) {
    const offset = header.infoTableOfs + i * 16;
    lumps.push({
      filePos: view.getInt32(offset, true),
      size: view.getInt32(offset + 4, true),
      name: readPaddedName(view, offset + 8, 8),
    });
  }
  return lumps;
}

/** First lump matching `name` (case-insensitive via `readPaddedName`'s own
 * uppercasing — pass an already-uppercase `name`). */
export function findLump(lumps: LumpEntry[], name: string): LumpEntry | undefined {
  return lumps.find((l) => l.name === name);
}

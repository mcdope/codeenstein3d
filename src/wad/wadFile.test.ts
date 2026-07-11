// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { findLump, parseLumpDirectory, parseWadHeader, readPaddedName, type LumpEntry } from "./wadFile";

function nameBuffer(name: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < name.length && i < len; i++) buf[i] = name.charCodeAt(i);
  return buf;
}

describe("readPaddedName", () => {
  it("reads an exact-length name with no padding", () => {
    const buf = nameBuffer("PLAYPAL", 8);
    expect(readPaddedName(new DataView(buf.buffer), 0, 8)).toBe("PLAYPAL");
  });

  it("stops at the first NUL byte", () => {
    const buf = nameBuffer("F1", 8);
    expect(readPaddedName(new DataView(buf.buffer), 0, 8)).toBe("F1");
  });

  it("uppercases lowercase names", () => {
    const buf = nameBuffer("startan3", 8);
    expect(readPaddedName(new DataView(buf.buffer), 0, 8)).toBe("STARTAN3");
  });

  it("respects an offset into a larger buffer", () => {
    const buf = new Uint8Array(16);
    buf.set(nameBuffer("TEXTURE1", 8), 8);
    expect(readPaddedName(new DataView(buf.buffer), 8, 8)).toBe("TEXTURE1");
  });
});

describe("parseWadHeader", () => {
  function headerBuffer(magic: string, numLumps: number, infoTableOfs: number): DataView {
    const buf = new Uint8Array(12);
    buf.set(nameBuffer(magic, 4), 0);
    const view = new DataView(buf.buffer);
    view.setInt32(4, numLumps, true);
    view.setInt32(8, infoTableOfs, true);
    return view;
  }

  it("accepts IWAD magic", () => {
    const header = parseWadHeader(headerBuffer("IWAD", 3, 12));
    expect(header).toEqual({ isPwad: false, numLumps: 3, infoTableOfs: 12 });
  });

  it("accepts PWAD magic", () => {
    const header = parseWadHeader(headerBuffer("PWAD", 1, 12));
    expect(header.isPwad).toBe(true);
  });

  it("throws on an invalid magic", () => {
    expect(() => parseWadHeader(headerBuffer("JUNK", 0, 12))).toThrow(/Not a WAD file/);
  });
});

describe("parseLumpDirectory", () => {
  it("reads every entry's position, size, and name", () => {
    const dirOffset = 0;
    const buf = new Uint8Array(32);
    const view = new DataView(buf.buffer);
    view.setInt32(0, 100, true);
    view.setInt32(4, 4096, true);
    buf.set(nameBuffer("F_START", 8), 8);
    view.setInt32(16, 200, true);
    view.setInt32(20, 64, true);
    buf.set(nameBuffer("PNAMES", 8), 24);

    const lumps = parseLumpDirectory(view, { isPwad: false, numLumps: 2, infoTableOfs: dirOffset });
    expect(lumps).toEqual([
      { filePos: 100, size: 4096, name: "F_START" },
      { filePos: 200, size: 64, name: "PNAMES" },
    ]);
  });

  it("returns an empty array for zero lumps", () => {
    const view = new DataView(new ArrayBuffer(0));
    expect(parseLumpDirectory(view, { isPwad: false, numLumps: 0, infoTableOfs: 0 })).toEqual([]);
  });
});

describe("findLump", () => {
  const lumps: LumpEntry[] = [
    { filePos: 0, size: 10, name: "PLAYPAL" },
    { filePos: 10, size: 20, name: "PNAMES" },
  ];

  it("returns the first lump matching the name", () => {
    expect(findLump(lumps, "PNAMES")).toEqual({ filePos: 10, size: 20, name: "PNAMES" });
  });

  it("returns undefined when no lump matches", () => {
    expect(findLump(lumps, "MISSING")).toBeUndefined();
  });
});

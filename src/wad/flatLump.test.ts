// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { findFlat, parseFlat } from "./flatLump";
import type { Palette } from "./playpal";
import type { LumpEntry } from "./wadFile";

const FLAT_BYTES = 64 * 64;

function lump(name: string, filePos: number, size: number): LumpEntry {
  return { name, filePos, size };
}

describe("findFlat", () => {
  it("finds a standard-size flat between F_START/F_END markers", () => {
    const lumps = [lump("F_START", 0, 0), lump("FLOOR4_8", 0, FLAT_BYTES), lump("F_END", 0, 0)];
    expect(findFlat(lumps, "FLOOR4_8")).toBe(lumps[1]);
  });

  it("also accepts the F1_START/F1_END marker pair", () => {
    const lumps = [lump("F1_START", 0, 0), lump("NUKAGE3", 0, FLAT_BYTES), lump("F1_END", 0, 0)];
    expect(findFlat(lumps, "NUKAGE3")).toBe(lumps[1]);
  });

  it("returns null when there is no marker pair at all", () => {
    const lumps = [lump("FLOOR4_8", 0, FLAT_BYTES)];
    expect(findFlat(lumps, "FLOOR4_8")).toBeNull();
  });

  it("returns null when the name isn't found inside the marker range", () => {
    const lumps = [lump("F_START", 0, 0), lump("OTHER", 0, FLAT_BYTES), lump("F_END", 0, 0)];
    expect(findFlat(lumps, "FLOOR4_8")).toBeNull();
  });

  it("returns null when the matching lump has the wrong size (unsupported variant)", () => {
    const lumps = [lump("F_START", 0, 0), lump("NOTAFLAT", 0, 100), lump("F_END", 0, 0)];
    expect(findFlat(lumps, "NOTAFLAT")).toBeNull();
  });

  it("returns null when start/end markers are out of order (end before start)", () => {
    const lumps = [lump("F_END", 0, 0), lump("FLOOR4_8", 0, FLAT_BYTES), lump("F_START", 0, 0)];
    expect(findFlat(lumps, "FLOOR4_8")).toBeNull();
  });
});

describe("parseFlat", () => {
  it("converts every palette-index byte into an opaque RGBA pixel", () => {
    const buf = new Uint8Array(FLAT_BYTES).fill(3);
    const palette: Palette = new Array(256).fill([0, 0, 0]);
    palette[3] = [80, 90, 100];

    const flat = parseFlat(new DataView(buf.buffer), { filePos: 0, size: FLAT_BYTES, name: "FLOOR4_8" }, palette);

    expect(flat.width).toBe(64);
    expect(flat.height).toBe(64);
    expect(flat.rgba.slice(0, 4)).toEqual(Uint8ClampedArray.from([80, 90, 100, 255]));
    expect(flat.rgba.slice(-4)).toEqual(Uint8ClampedArray.from([80, 90, 100, 255]));
  });

  it("falls back to black for an out-of-range palette index", () => {
    const buf = new Uint8Array(FLAT_BYTES).fill(5);
    const flat = parseFlat(new DataView(buf.buffer), { filePos: 0, size: FLAT_BYTES, name: "X" }, []);
    expect(flat.rgba.slice(0, 4)).toEqual(Uint8ClampedArray.from([0, 0, 0, 255]));
  });

  it("respects a nonzero lump filePos", () => {
    const buf = new Uint8Array(8 + FLAT_BYTES).fill(0);
    buf.fill(3, 8);
    const palette: Palette = new Array(256).fill([0, 0, 0]);
    palette[3] = [1, 2, 3];
    const flat = parseFlat(new DataView(buf.buffer), { filePos: 8, size: FLAT_BYTES, name: "X" }, palette);
    expect(flat.rgba.slice(0, 4)).toEqual(Uint8ClampedArray.from([1, 2, 3, 255]));
  });
});

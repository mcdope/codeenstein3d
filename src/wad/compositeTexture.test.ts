// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { buildTestWad, PALETTE_ENTRIES } from "../../scripts/fixtures/buildTestWad.mjs";
import { compositeTexture } from "./compositeTexture";
import type { Palette } from "./playpal";
import { parsePnames } from "./pnames";
import { parseTextureLump, type TextureDef } from "./textureLump";
import { findLump, parseLumpDirectory, parseWadHeader } from "./wadFile";

function loadFixtureParts() {
  const bytes = buildTestWad();
  const view = new DataView(bytes);
  const header = parseWadHeader(view);
  const lumps = parseLumpDirectory(view, header);
  const pnames = parsePnames(view, findLump(lumps, "PNAMES")!);
  const defs = parseTextureLump(view, findLump(lumps, "TEXTURE1")!);
  const palette: Palette = new Array(256).fill([0, 0, 0]);
  palette[1] = PALETTE_ENTRIES.patchA;
  palette[2] = PALETTE_ENTRIES.patchB;
  return { view, lumps, pnames, defs, palette };
}

describe("compositeTexture", () => {
  it("paints the fixture's two overlapping patches, later patch winning where opaque", () => {
    const { view, lumps, pnames, defs, palette } = loadFixtureParts();
    const def = defs.get("STARTAN3")!;
    const result = compositeTexture(def, pnames, (n) => findLump(lumps, n), view, palette);

    expect(result.width).toBe(6);
    expect(result.height).toBe(4);
    // Column 0: PATCH2 (opaque, patchB color) painted over PATCH1.
    expect(pixelAt(result, 0, 0)).toEqual([...PALETTE_ENTRIES.patchB, 255]);
    // Column 1: PATCH2 has a hole here, so PATCH1's original color shows through.
    expect(pixelAt(result, 1, 0)).toEqual([...PALETTE_ENTRIES.patchA, 255]);
    // Columns 4-5: never covered by either patch — fully transparent.
    expect(pixelAt(result, 4, 0)[3]).toBe(0);
    expect(pixelAt(result, 5, 0)[3]).toBe(0);
  });

  it("skips a patch placement whose patchIndex has no pnames entry", () => {
    const { view, lumps, palette } = loadFixtureParts();
    const def: TextureDef = { name: "X", width: 4, height: 4, patches: [{ originX: 0, originY: 0, patchIndex: 99 }] };
    const result = compositeTexture(def, ["PATCH1"], (n) => findLump(lumps, n), view, palette);
    expect(result.rgba.every((b) => b === 0)).toBe(true);
  });

  it("skips a patch placement whose named lump isn't found", () => {
    const { view, lumps, palette } = loadFixtureParts();
    const def: TextureDef = { name: "X", width: 4, height: 4, patches: [{ originX: 0, originY: 0, patchIndex: 0 }] };
    const result = compositeTexture(def, ["MISSING"], (n) => findLump(lumps, n), view, palette);
    expect(result.rgba.every((b) => b === 0)).toBe(true);
  });

  it("clips pixels that would land outside the texture's bounds", () => {
    const { view, lumps, pnames, palette } = loadFixtureParts();
    // Origin far enough right/down that the whole 4x4 patch falls outside a 2x2 texture.
    const def: TextureDef = { name: "X", width: 2, height: 2, patches: [{ originX: 10, originY: 10, patchIndex: 0 }] };
    const result = compositeTexture(def, pnames, (n) => findLump(lumps, n), view, palette);
    expect(result.rgba.every((b) => b === 0)).toBe(true);
  });

  it("falls back to black when a pixel's palette index is out of range", () => {
    const { view, lumps, palette } = loadFixtureParts();
    // PATCH1's pixels are all palette index 1; give a palette with no entry there.
    const emptyPalette: Palette = [];
    const def: TextureDef = { name: "X", width: 4, height: 4, patches: [{ originX: 0, originY: 0, patchIndex: 0 }] };
    const result = compositeTexture(def, ["PATCH1"], (n) => findLump(lumps, n), view, emptyPalette);
    expect(pixelAt(result, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("returns a fully transparent buffer for a texture with zero patches", () => {
    const { view, lumps, pnames, palette } = loadFixtureParts();
    const def: TextureDef = { name: "X", width: 2, height: 2, patches: [] };
    const result = compositeTexture(def, pnames, (n) => findLump(lumps, n), view, palette);
    expect(result.rgba.every((b) => b === 0)).toBe(true);
  });
});

function pixelAt(tex: { width: number; rgba: Uint8ClampedArray }, x: number, y: number): number[] {
  const i = (y * tex.width + x) * 4;
  return [tex.rgba[i], tex.rgba[i + 1], tex.rgba[i + 2], tex.rgba[i + 3]];
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { parseTextureLump } from "./textureLump";

function nameBuffer(name: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < name.length && i < len; i++) buf[i] = name.charCodeAt(i);
  return buf;
}

interface TexDefInput {
  name: string;
  width: number;
  height: number;
  patches: { originX: number; originY: number; patchIndex: number }[];
}

function buildTextureLumpBuffer(defs: TexDefInput[]): Uint8Array {
  const headerSize = 4 + defs.length * 4;
  const blocks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = headerSize;

  for (const def of defs) {
    offsets.push(cursor);
    const size = 22 + def.patches.length * 10;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    buf.set(nameBuffer(def.name, 8), 0);
    view.setInt16(12, def.width, true);
    view.setInt16(14, def.height, true);
    view.setInt16(20, def.patches.length, true);
    def.patches.forEach((p, i) => {
      const po = 22 + i * 10;
      view.setInt16(po, p.originX, true);
      view.setInt16(po + 2, p.originY, true);
      view.setInt16(po + 4, p.patchIndex, true);
    });
    blocks.push(buf);
    cursor += size;
  }

  const out = new Uint8Array(cursor);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, defs.length, true);
  offsets.forEach((ofs, i) => outView.setInt32(4 + i * 4, ofs, true));
  let off = headerSize;
  for (const block of blocks) {
    out.set(block, off);
    off += block.length;
  }
  return out;
}

describe("parseTextureLump", () => {
  it("reads every texture definition keyed by name", () => {
    const buf = buildTextureLumpBuffer([
      { name: "STARTAN3", width: 64, height: 128, patches: [{ originX: 0, originY: 0, patchIndex: 0 }] },
      {
        name: "BIGDOOR2",
        width: 128,
        height: 128,
        patches: [
          { originX: 0, originY: 0, patchIndex: 1 },
          { originX: 64, originY: 0, patchIndex: 2 },
        ],
      },
    ]);
    const defs = parseTextureLump(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "TEXTURE1" });

    expect(defs.size).toBe(2);
    expect(defs.get("STARTAN3")).toEqual({
      name: "STARTAN3",
      width: 64,
      height: 128,
      patches: [{ originX: 0, originY: 0, patchIndex: 0 }],
    });
    expect(defs.get("BIGDOOR2")?.patches).toHaveLength(2);
  });

  it("returns an empty map for zero textures", () => {
    const buf = buildTextureLumpBuffer([]);
    const defs = parseTextureLump(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "TEXTURE1" });
    expect(defs.size).toBe(0);
  });

  it("handles a texture definition with zero patches", () => {
    const buf = buildTextureLumpBuffer([{ name: "EMPTY", width: 8, height: 8, patches: [] }]);
    const defs = parseTextureLump(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "TEXTURE1" });
    expect(defs.get("EMPTY")?.patches).toEqual([]);
  });

  it("respects a nonzero lump filePos", () => {
    const inner = buildTextureLumpBuffer([{ name: "WALL1", width: 4, height: 4, patches: [] }]);
    const buf = new Uint8Array(8 + inner.length);
    buf.set(inner, 8);
    const defs = parseTextureLump(new DataView(buf.buffer), { filePos: 8, size: inner.length, name: "TEXTURE1" });
    expect(defs.has("WALL1")).toBe(true);
  });
});

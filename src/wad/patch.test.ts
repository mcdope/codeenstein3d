// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { parsePatch, type Post } from "./patch";

/** Builds a patch lump byte buffer per the `mappatch_t` format `parsePatch`
 * expects. `columns`: one post list per column (empty = zero posts, i.e. a
 * fully transparent column). */
function buildPatchBuffer(width: number, height: number, columns: Post[][]): Uint8Array {
  const headerSize = 8;
  const columnOfsSize = width * 4;
  const blocks: number[][] = [];
  const offsets: number[] = [];
  let cursor = headerSize + columnOfsSize;

  for (const posts of columns) {
    offsets.push(cursor);
    const bytes: number[] = [];
    for (const post of posts) {
      bytes.push(post.topDelta, post.pixels.length, 0, ...post.pixels, 0);
    }
    bytes.push(0xff);
    blocks.push(bytes);
    cursor += bytes.length;
  }

  const buf = new Uint8Array(cursor);
  const view = new DataView(buf.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  offsets.forEach((ofs, x) => view.setInt32(headerSize + x * 4, ofs, true));

  let offset = headerSize + columnOfsSize;
  for (const block of blocks) {
    buf.set(block, offset);
    offset += block.length;
  }
  return buf;
}

describe("parsePatch", () => {
  it("reads width/height and one post per column", () => {
    const buf = buildPatchBuffer(2, 4, [
      [{ topDelta: 0, pixels: [1, 2, 3, 4] }],
      [{ topDelta: 1, pixels: [5, 6] }],
    ]);
    const patch = parsePatch(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "PATCH1" });

    expect(patch.width).toBe(2);
    expect(patch.height).toBe(4);
    expect(patch.columns).toEqual([
      [{ topDelta: 0, pixels: [1, 2, 3, 4] }],
      [{ topDelta: 1, pixels: [5, 6] }],
    ]);
  });

  it("reads multiple posts within a single column", () => {
    const buf = buildPatchBuffer(1, 8, [
      [
        { topDelta: 0, pixels: [1, 1] },
        { topDelta: 4, pixels: [2, 2, 2] },
      ],
    ]);
    const patch = parsePatch(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "PATCH1" });
    expect(patch.columns[0]).toHaveLength(2);
    expect(patch.columns[0][1]).toEqual({ topDelta: 4, pixels: [2, 2, 2] });
  });

  it("treats a column with zero posts as a hole (empty post list)", () => {
    const buf = buildPatchBuffer(1, 4, [[]]);
    const patch = parsePatch(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "PATCH1" });
    expect(patch.columns[0]).toEqual([]);
  });

  it("respects a nonzero lump filePos", () => {
    const inner = buildPatchBuffer(1, 2, [[{ topDelta: 0, pixels: [9] }]]);
    const buf = new Uint8Array(4 + inner.length);
    buf.set(inner, 4);
    const patch = parsePatch(new DataView(buf.buffer), { filePos: 4, size: inner.length, name: "PATCH1" });
    expect(patch.columns[0]).toEqual([{ topDelta: 0, pixels: [9] }]);
  });
});

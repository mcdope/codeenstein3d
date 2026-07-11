// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { parsePnames } from "./pnames";

function nameBuffer(name: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < name.length && i < len; i++) buf[i] = name.charCodeAt(i);
  return buf;
}

describe("parsePnames", () => {
  it("reads numpatches then that many 8-byte names", () => {
    const buf = new Uint8Array(4 + 2 * 8);
    new DataView(buf.buffer).setInt32(0, 2, true);
    buf.set(nameBuffer("PATCH1", 8), 4);
    buf.set(nameBuffer("PATCH2", 8), 12);

    expect(parsePnames(new DataView(buf.buffer), { filePos: 0, size: buf.length, name: "PNAMES" })).toEqual([
      "PATCH1",
      "PATCH2",
    ]);
  });

  it("returns an empty array when numpatches is zero", () => {
    const buf = new Uint8Array(4);
    expect(parsePnames(new DataView(buf.buffer), { filePos: 0, size: 4, name: "PNAMES" })).toEqual([]);
  });

  it("respects a nonzero lump filePos", () => {
    const buf = new Uint8Array(4 + 4 + 8);
    new DataView(buf.buffer).setInt32(4, 1, true);
    buf.set(nameBuffer("WALL1", 8), 8);
    expect(parsePnames(new DataView(buf.buffer), { filePos: 4, size: 12, name: "PNAMES" })).toEqual(["WALL1"]);
  });
});

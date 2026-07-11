// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { parsePlaypal } from "./playpal";

describe("parsePlaypal", () => {
  it("reads 256 RGB triples starting at the lump's filePos", () => {
    const buf = new Uint8Array(4 + 256 * 3);
    // 4 bytes of leading junk to prove filePos offsetting is respected.
    buf[4] = 10;
    buf[5] = 20;
    buf[6] = 30;
    buf[4 + 255 * 3] = 250;
    buf[4 + 255 * 3 + 1] = 251;
    buf[4 + 255 * 3 + 2] = 252;

    const palette = parsePlaypal(new DataView(buf.buffer), { filePos: 4, size: 768, name: "PLAYPAL" });

    expect(palette).toHaveLength(256);
    expect(palette[0]).toEqual([10, 20, 30]);
    expect(palette[255]).toEqual([250, 251, 252]);
  });
});

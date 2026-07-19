// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { FIXED_DT, INPUT_DELAY_TICKS, MAP_CHUNK_SIZE_BYTES, TICK_RATE_HZ } from "./netcodeConstants";

describe("netcode constants", () => {
  it("FIXED_DT is the exact reciprocal of TICK_RATE_HZ", () => {
    expect(FIXED_DT * TICK_RATE_HZ).toBe(1);
  });

  it("has a positive, reasonable input delay in ticks", () => {
    expect(INPUT_DELAY_TICKS).toBeGreaterThan(0);
  });

  it("chunk size stays comfortably under the ~64 KiB practical message-size floor", () => {
    expect(MAP_CHUNK_SIZE_BYTES).toBeLessThan(64 * 1024);
    expect(MAP_CHUNK_SIZE_BYTES).toBeGreaterThan(0);
  });
});

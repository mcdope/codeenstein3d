// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  CORRECTION_SMOOTH_MS,
  FIXED_DT,
  INPUT_DELAY_TICKS,
  MAP_CHUNK_SIZE_BYTES,
  RECONCILE_INTERVAL_TICKS,
  SNAP_THRESHOLD_TILES,
  TICK_RATE_HZ,
} from "./netcodeConstants";

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

  it("reconciles roughly once per second at TICK_RATE_HZ", () => {
    expect(RECONCILE_INTERVAL_TICKS / TICK_RATE_HZ).toBe(1);
  });

  it("has a positive correction-smoothing window", () => {
    expect(CORRECTION_SMOOTH_MS).toBeGreaterThan(0);
  });

  it("has a positive, sub-tile snap threshold", () => {
    expect(SNAP_THRESHOLD_TILES).toBeGreaterThan(0);
    expect(SNAP_THRESHOLD_TILES).toBeLessThan(1);
  });
});

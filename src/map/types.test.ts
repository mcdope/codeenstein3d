// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
} from "./types";

describe("tile value constants", () => {
  it("are the documented distinct values", () => {
    expect(HAZARD_TILE).toBe(2);
    expect(DOOR_TILE).toBe(3);
    expect(TELEPORTER_TILE).toBe(4);
    expect(SPIKE_TRAP_TILE).toBe(5);
    expect(SECRET_WALL_TILE).toBe(6);
    expect(LORE_TILE).toBe(7);
  });

  it("are all mutually distinct", () => {
    const values = [HAZARD_TILE, DOOR_TILE, TELEPORTER_TILE, SPIKE_TRAP_TILE, SECRET_WALL_TILE, LORE_TILE];
    expect(new Set(values).size).toBe(values.length);
  });
});

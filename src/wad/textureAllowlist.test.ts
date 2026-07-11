// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  BONUS_FLOOR_TEXTURE_ALLOWLIST,
  BONUS_WALL_TEXTURE_ALLOWLIST,
  DOOR_TEXTURE_ALLOWLIST,
  FLOOR_TEXTURE_ALLOWLIST,
  HAZARD_FLOOR_TEXTURE_ALLOWLIST,
  LORE_WALL_TEXTURE_ALLOWLIST,
  SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST,
  TELEPORTER_FLOOR_TEXTURE_ALLOWLIST,
  WALL_TEXTURE_ALLOWLIST,
} from "./textureAllowlist";

const ALL_ALLOWLISTS = {
  WALL_TEXTURE_ALLOWLIST,
  BONUS_WALL_TEXTURE_ALLOWLIST,
  DOOR_TEXTURE_ALLOWLIST,
  FLOOR_TEXTURE_ALLOWLIST,
  BONUS_FLOOR_TEXTURE_ALLOWLIST,
  LORE_WALL_TEXTURE_ALLOWLIST,
  HAZARD_FLOOR_TEXTURE_ALLOWLIST,
  TELEPORTER_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST,
};

describe("texture allowlists", () => {
  it.each(Object.entries(ALL_ALLOWLISTS))("%s is a nonempty list of uppercase 1-8 char names", (_key, list) => {
    expect(list.length).toBeGreaterThan(0);
    for (const name of list) {
      expect(name).toBe(name.toUpperCase());
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(8);
    }
  });

  it.each(Object.entries(ALL_ALLOWLISTS))("%s has no duplicate names", (_key, list) => {
    expect(new Set(list).size).toBe(list.length);
  });
});

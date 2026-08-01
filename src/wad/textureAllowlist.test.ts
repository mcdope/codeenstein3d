// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { STYLE_SET_IDS, type StyleSetId } from "../map/types";
import {
  HAZARD_FLOOR_TEXTURE_ALLOWLIST,
  LORE_WALL_TEXTURE_ALLOWLIST,
  SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST,
  STYLE_WAD_ALLOWLISTS,
  TELEPORTER_FLOOR_TEXTURE_ALLOWLIST,
} from "./textureAllowlist";

const SIGNAL_ALLOWLISTS = {
  LORE_WALL_TEXTURE_ALLOWLIST,
  HAZARD_FLOOR_TEXTURE_ALLOWLIST,
  TELEPORTER_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_SAFE_FLOOR_TEXTURE_ALLOWLIST,
  SPIKE_ACTIVE_FLOOR_TEXTURE_ALLOWLIST,
};

/** Every per-styleset structural list, flattened to `["stone.wall", [...]]`
 * pairs so the shared name-shape assertions below cover them identically to
 * the signal lists. */
const STYLE_ALLOWLISTS: [string, readonly string[]][] = STYLE_SET_IDS.flatMap((id) =>
  (["wall", "floor", "door"] as const).map(
    (slot) => [`${id}.${slot}`, STYLE_WAD_ALLOWLISTS[id][slot]] as [string, readonly string[]],
  ),
);

const ALL_ALLOWLISTS: [string, readonly string[]][] = [...Object.entries(SIGNAL_ALLOWLISTS), ...STYLE_ALLOWLISTS];

describe("texture allowlists", () => {
  it.each(ALL_ALLOWLISTS)("%s is a nonempty list of uppercase 1-8 char names", (_key, list) => {
    expect(list.length).toBeGreaterThan(0);
    for (const name of list) {
      expect(name).toBe(name.toUpperCase());
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(8);
    }
  });

  it.each(ALL_ALLOWLISTS)("%s has no duplicate names", (_key, list) => {
    expect(new Set(list).size).toBe(list.length);
  });

  it("covers every styleset", () => {
    expect(Object.keys(STYLE_WAD_ALLOWLISTS).sort()).toEqual([...STYLE_SET_IDS].sort());
  });

  // The whole point of grouping by styleset is that a WAD-textured session has
  // the same level-to-level variety the procedural defaults do. Two stylesets
  // whose first-choice wall is the same name would silently collapse to one
  // look on every WAD that has it.
  it("gives each styleset a distinct first-choice wall", () => {
    const firstChoices = STYLE_SET_IDS.map((id: StyleSetId) => STYLE_WAD_ALLOWLISTS[id].wall[0]);
    expect(new Set(firstChoices).size).toBe(firstChoices.length);
  });

  it("gives each styleset a distinct first-choice floor", () => {
    const firstChoices = STYLE_SET_IDS.map((id: StyleSetId) => STYLE_WAD_ALLOWLISTS[id].floor[0]);
    expect(new Set(firstChoices).size).toBe(firstChoices.length);
  });
});

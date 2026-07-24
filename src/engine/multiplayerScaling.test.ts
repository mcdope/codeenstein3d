// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { eliteScalingFor } from "./multiplayerScaling";

describe("eliteScalingFor", () => {
  it("returns the identity multiplier for a single player", () => {
    expect(eliteScalingFor(1)).toEqual({ hp: 1, damage: 1 });
  });

  it("scales up per extra player beyond the first", () => {
    expect(eliteScalingFor(2)).toEqual({ hp: 1.5, damage: 1.25 });
    expect(eliteScalingFor(3)).toEqual({ hp: 2, damage: 1.5 });
  });

  it("clamps 0 or negative counts to the identity multiplier, never dividing scale below 1x", () => {
    expect(eliteScalingFor(0)).toEqual({ hp: 1, damage: 1 });
    expect(eliteScalingFor(-1)).toEqual({ hp: 1, damage: 1 });
  });
});

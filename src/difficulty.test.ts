// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFICULTY, DIFFICULTY_MULTIPLIERS } from "./difficulty";

describe("DIFFICULTY_MULTIPLIERS", () => {
  it("scales easy down and hard up for hp/damage, inverted for ammoDropRate", () => {
    // easy.damage (0.85) doesn't mirror easy.hp (0.7) the way hard's pair
    // does — see DIFFICULTY_MULTIPLIERS' doc comment for why.
    expect(DIFFICULTY_MULTIPLIERS.easy).toEqual({ hp: 0.7, damage: 0.85, ammoDropRate: 1.3 });
    expect(DIFFICULTY_MULTIPLIERS.normal).toEqual({ hp: 1, damage: 1, ammoDropRate: 1 });
    expect(DIFFICULTY_MULTIPLIERS.hard).toEqual({ hp: 1.5, damage: 1.5, ammoDropRate: 0.7 });
  });

  it("has an entry for every DifficultyLevel", () => {
    expect(Object.keys(DIFFICULTY_MULTIPLIERS).sort()).toEqual(["easy", "hard", "normal"]);
  });
});

describe("DEFAULT_DIFFICULTY", () => {
  it("is normal", () => {
    expect(DEFAULT_DIFFICULTY).toBe("normal");
  });
});

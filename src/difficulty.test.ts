// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { DEFAULT_DIFFICULTY, DIFFICULTY_MULTIPLIERS, ROLLBACKS_BY_DIFFICULTY } from "./difficulty";

describe("DIFFICULTY_MULTIPLIERS", () => {
  it("scales easy down and hard up for hp/damage, inverted for ammoDropRate", () => {
    // easy.damage (0.85) doesn't mirror easy.hp (0.7) the way hard's pair
    // does — see DIFFICULTY_MULTIPLIERS' doc comment for why.
    expect(DIFFICULTY_MULTIPLIERS.easy).toEqual({ hp: 0.7, damage: 0.85, ammoDropRate: 1.3, enemyAimSpreadDeg: 10 });
    expect(DIFFICULTY_MULTIPLIERS.normal).toEqual({ hp: 1, damage: 1, ammoDropRate: 1, enemyAimSpreadDeg: 4 });
    expect(DIFFICULTY_MULTIPLIERS.hard).toEqual({ hp: 1.5, damage: 1.5, ammoDropRate: 0.7, enemyAimSpreadDeg: 0 });
  });

  it("has an entry for every DifficultyLevel", () => {
    expect(Object.keys(DIFFICULTY_MULTIPLIERS).sort()).toEqual(["easy", "hard", "normal"]);
  });
});

describe("ROLLBACKS_BY_DIFFICULTY", () => {
  it("grants 2/1/0 rollbacks on easy/normal/hard", () => {
    expect(ROLLBACKS_BY_DIFFICULTY).toEqual({ easy: 2, normal: 1, hard: 0 });
  });

  it("has an entry for every DifficultyLevel", () => {
    // Same guard as DIFFICULTY_MULTIPLIERS' — a new difficulty tier that
    // reaches the settings dropdown without a rollback count would hand that
    // tier `undefined` rollbacks, which reads as 0 at every comparison site.
    expect(Object.keys(ROLLBACKS_BY_DIFFICULTY).sort()).toEqual(["easy", "hard", "normal"]);
  });

  it("is more forgiving the easier the difficulty, matching every other axis", () => {
    // The stated design property, not a restatement of the values above: the
    // counts compound with the HP/damage/loot curve rather than offsetting it.
    // Reversing a pair would still pass the toEqual if someone "fixed" both.
    expect(ROLLBACKS_BY_DIFFICULTY.easy).toBeGreaterThan(ROLLBACKS_BY_DIFFICULTY.normal);
    expect(ROLLBACKS_BY_DIFFICULTY.normal).toBeGreaterThan(ROLLBACKS_BY_DIFFICULTY.hard);
  });

  it("gives hard none at all, so death stays final there", () => {
    // Not an empty slot waiting to be filled: Hard is the one tier where the
    // Kernel Panic screen keeps its original single button. Pinned because a
    // well-meaning "every difficulty should get at least one" would undo a
    // deliberate design statement.
    expect(ROLLBACKS_BY_DIFFICULTY.hard).toBe(0);
  });

  it("never goes negative, which would read as a rollback the UI can't show", () => {
    for (const count of Object.values(ROLLBACKS_BY_DIFFICULTY)) expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe("DEFAULT_DIFFICULTY", () => {
  it("is normal", () => {
    expect(DEFAULT_DIFFICULTY).toBe("normal");
  });
});

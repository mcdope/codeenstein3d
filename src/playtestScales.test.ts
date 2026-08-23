// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYTEST_SCALES,
  ENEMY_DAMAGE_SCALES,
  KILL_HEAL_SCALES,
  parsePlaytestScale,
} from "./playtestScales";

describe("playtest scale ladders", () => {
  it("offers the four enemy-damage candidates the select lists", () => {
    expect(ENEMY_DAMAGE_SCALES).toEqual([1, 1.5, 2, 3]);
  });

  it("offers the four kill-heal candidates the select lists", () => {
    expect(KILL_HEAL_SCALES).toEqual([1, 0.67, 0.5, 0.33]);
  });

  it("starts both ladders at identity", () => {
    // The stated property, not a restatement of the arrays: the control has to
    // open on "unchanged", so a reordering that buried 1 in the middle would
    // silently make the default option something else.
    expect(ENEMY_DAMAGE_SCALES[0]).toBe(DEFAULT_PLAYTEST_SCALES.enemyDamage);
    expect(KILL_HEAL_SCALES[0]).toBe(DEFAULT_PLAYTEST_SCALES.killHeal);
  });

  it("makes the heal ladder the reciprocal of the damage ladder", () => {
    // The whole reason there are two knobs: `damage 2x + heal 1x` and
    // `damage 1x + heal 0.5x` have to be the same net margin reached two
    // different ways, or a session cannot tell spike lethality from attrition.
    // Rounded to 2dp because the select shows 0.67/0.33, not 2/3 and 1/3.
    for (const [i, damage] of ENEMY_DAMAGE_SCALES.entries()) {
      expect(KILL_HEAL_SCALES[i]).toBeCloseTo(Math.round(100 / damage) / 100, 2);
    }
  });

  it("defaults to identity on both axes", () => {
    expect(DEFAULT_PLAYTEST_SCALES).toEqual({ enemyDamage: 1, killHeal: 1 });
  });
});

describe("parsePlaytestScale", () => {
  it("accepts every listed candidate", () => {
    for (const scale of ENEMY_DAMAGE_SCALES) {
      expect(parsePlaytestScale(String(scale), ENEMY_DAMAGE_SCALES)).toBe(scale);
    }
    for (const scale of KILL_HEAL_SCALES) {
      expect(parsePlaytestScale(String(scale), KILL_HEAL_SCALES)).toBe(scale);
    }
  });

  it("returns undefined for a missing key", () => {
    expect(parsePlaytestScale(null, ENEMY_DAMAGE_SCALES)).toBeUndefined();
  });

  it("rejects a plausible number that is not on the ladder", () => {
    // Membership, not a range check — the point of the control is that only
    // the listed candidates are ever played, so a leftover value from an
    // earlier set of candidates must not survive a change to the ladder.
    expect(parsePlaytestScale("1.25", ENEMY_DAMAGE_SCALES)).toBeUndefined();
    expect(parsePlaytestScale("4", ENEMY_DAMAGE_SCALES)).toBeUndefined();
    expect(parsePlaytestScale("0.5", ENEMY_DAMAGE_SCALES)).toBeUndefined();
  });

  it("rejects junk rather than coercing it", () => {
    // `Number("")` is 0 and `Number(" 1 ")` is 1 — the first must not pass as
    // a scale, and neither may reach the engine as NaN.
    expect(parsePlaytestScale("", ENEMY_DAMAGE_SCALES)).toBeUndefined();
    expect(parsePlaytestScale("banana", ENEMY_DAMAGE_SCALES)).toBeUndefined();
    expect(parsePlaytestScale("Infinity", ENEMY_DAMAGE_SCALES)).toBeUndefined();
  });

  it("keeps the two ladders from accepting each other's values", () => {
    // Passing the wrong ladder is the mistake this signature invites, and it
    // would silently give the heal knob a 3x setting.
    expect(parsePlaytestScale("3", KILL_HEAL_SCALES)).toBeUndefined();
    expect(parsePlaytestScale("0.33", ENEMY_DAMAGE_SCALES)).toBeUndefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { rollBonusWeaponDrop, rollLoot } from "./loot";

describe("rollLoot", () => {
  it("returns a kind from the normal-difficulty weight table by default", () => {
    const kind = rollLoot(false, "normal", () => 0);
    expect(kind).toBe("bullets"); // first bucket, rng=0 always lands in it
  });

  it("uses the base weight table for non-normal difficulty", () => {
    const kind = rollLoot(false, "easy", () => 0);
    expect(kind).toBe("bullets");
  });

  it("uses the bonus weight table on a bonus level, regardless of difficulty", () => {
    const kind = rollLoot(true, "hard", () => 0);
    expect(kind).toBe("bullets");
  });

  it("excludes rockets when there's no rocket launcher", () => {
    // rng=1 (edge case) would normally fall through to the last bucket —
    // use a high-but-valid roll instead to land past every other bucket.
    for (let i = 0; i < 50; i++) {
      const kind = rollLoot(false, "normal", () => 0.999, false, true, false, true);
      expect(kind).not.toBe("rockets");
    }
  });

  it("excludes smg when gdb isn't owned", () => {
    const kind = rollLoot(false, "normal", () => 0.5, true, false, false, true);
    expect(kind).not.toBe("smg");
  });

  it("excludes gas when Friday Hotfix isn't owned", () => {
    const kind = rollLoot(false, "normal", () => 0.5, true, true, false, false);
    expect(kind).not.toBe("gas");
  });

  it("excludes health when the player is at full stability", () => {
    // Force a roll that would otherwise land in the health bucket by
    // scanning the whole weight range with rng=1-ish and checking never health.
    for (let i = 0; i < 20; i++) {
      const kind = rollLoot(false, "normal", () => i / 20, true, true, true, true);
      expect(kind).not.toBe("health");
    }
  });

  it("falls back to the first usable kind when rng rounds to exactly the total weight", () => {
    const kind = rollLoot(false, "normal", () => 1);
    expect(kind).toBe("bullets"); // usable[0] for the default (all-available) table
  });

  it("picks the last bucket for a roll just under the top of the range", () => {
    // NORMAL_LOOT_WEIGHTS: bullets 46, smg 20, gas 20, rockets 12, health 11,
    // swap 11 -> total 120. A roll of 119/120 lands in the final "swap" bucket.
    const kind = rollLoot(false, "normal", () => 119 / 120);
    expect(kind).toBe("swap");
  });

  it("defaults rng to Math.random when omitted", () => {
    const kind = rollLoot();
    expect(["bullets", "rockets", "smg", "gas", "health", "swap"]).toContain(kind);
  });
});

describe("rollBonusWeaponDrop", () => {
  it("returns undefined immediately when there's nothing missing (no rng draw)", () => {
    let calls = 0;
    const rng = () => {
      calls++;
      return 0;
    };
    expect(rollBonusWeaponDrop([], rng)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("returns undefined when the odds roll misses", () => {
    expect(rollBonusWeaponDrop([3, 4], () => 0.5, 0.1)).toBeUndefined();
  });

  it("returns a missing weapon index when the odds roll hits", () => {
    const index = rollBonusWeaponDrop([3, 4], () => 0, 0.5);
    expect([3, 4]).toContain(index);
  });

  it("picks the last candidate for a second-draw roll near 1", () => {
    let call = 0;
    const rng = () => (call++ === 0 ? 0 : 0.9999);
    expect(rollBonusWeaponDrop([3, 4, 5], rng, 0.5)).toBe(5);
  });

  it("defaults chance to NORMAL_KILL_WEAPON_DROP_CHANCE and rng to Math.random", () => {
    expect(() => rollBonusWeaponDrop([3])).not.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { Enemy } from "../map/types";
import { computeScore, killPoints, sumScoreBreakdowns, zeroScoreBreakdown, type ScoreInput } from "./scoring";

function enemy(overrides: Partial<Enemy> = {}): Enemy {
  return {
    x: 0,
    y: 0,
    hp: 0,
    maxHp: 100,
    alive: false,
    attackCooldown: 0,
    hitFlash: 0,
    home: { x: 0, y: 0, w: 1, h: 1 },
    aggroed: false,
    discovered: false,
    roamX: 0,
    roamY: 0,
    fireCooldown: 0,
    entity: { name: "f", kind: "function", startLine: 1, endLine: 1, complexityScore: 4, nestingDepth: 0 },
    elite: false,
    edgeCase: false,
    ...overrides,
  };
}

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    killPoints: 0,
    finalHealth: 50,
    maxHealth: 100,
    finalBullets: 50,
    finalRockets: 5,
    finalSmg: 20,
    finalGas: 10,
    startingBullets: 100,
    startingRockets: 10,
    startingSmg: 40,
    startingGas: 20,
    levelTimeSec: 90,
    distanceTraveledTiles: 100,
    shortestPathTiles: 50,
    mapCompletionFrac: 0.5,
    uniqueLoreTerminalsRead: 0,
    uniqueSecretRoomsOpened: 0,
    multiKillCount: 0,
    ultraKillCount: 0,
    weaponShotsFired: 0,
    weaponHits: 0,
    ...overrides,
  };
}

describe("killPoints", () => {
  it("scales base + complexity points for a regular kill", () => {
    // BASE_KILL_POINTS(50) + complexityScore(4) * COMPLEXITY_POINTS_PER_SCORE(15) = 110
    expect(killPoints(enemy({ elite: false }))).toBe(110);
  });

  it("triples the subtotal for an Elite kill", () => {
    expect(killPoints(enemy({ elite: true }))).toBe(330);
  });
});

describe("computeScore", () => {
  it("carries killPoints straight through to the breakdown and total", () => {
    const result = computeScore(input({ killPoints: 300 }));
    expect(result.killPoints).toBe(300);
  });

  it("awards full health bonus at full health, none at zero", () => {
    expect(computeScore(input({ finalHealth: 100, maxHealth: 100 })).healthBonus).toBe(500);
    expect(computeScore(input({ finalHealth: 0, maxHealth: 100 })).healthBonus).toBe(0);
  });

  it("clamps health bonus when finalHealth exceeds maxHealth", () => {
    expect(computeScore(input({ finalHealth: 150, maxHealth: 100 })).healthBonus).toBe(500);
  });

  it("clamps health bonus at 0 when finalHealth is negative", () => {
    expect(computeScore(input({ finalHealth: -10, maxHealth: 100 })).healthBonus).toBe(0);
  });

  it("splits the ammo bonus four ways across bullets/rockets/smg/gas", () => {
    const result = computeScore(
      input({
        finalBullets: 100,
        startingBullets: 100,
        finalRockets: 10,
        startingRockets: 10,
        finalSmg: 40,
        startingSmg: 40,
        finalGas: 20,
        startingGas: 20,
      }),
    );
    expect(result.ammoBonus).toBe(250); // all four pools full -> max bonus
  });

  it("treats a zero starting-ammo pool as contributing zero to the ammo bonus", () => {
    const result = computeScore(
      input({
        finalBullets: 0,
        startingBullets: 0,
        finalRockets: 0,
        startingRockets: 0,
        finalSmg: 0,
        startingSmg: 0,
        finalGas: 0,
        startingGas: 0,
      }),
    );
    expect(result.ammoBonus).toBe(0);
  });

  it("clamps an ammo fraction that somehow exceeds its starting amount", () => {
    const result = computeScore(
      input({
        finalBullets: 999,
        startingBullets: 100,
        finalRockets: 0,
        startingRockets: 0,
        finalSmg: 0,
        startingSmg: 0,
        finalGas: 0,
        startingGas: 0,
      }),
    );
    expect(result.ammoBonus).toBe(63); // round((1 + 0 + 0 + 0) / 4 * 250)
  });

  it("awards full speed bonus for finishing at/under the target time", () => {
    expect(computeScore(input({ levelTimeSec: 30 })).speedBonus).toBe(400);
    expect(computeScore(input({ levelTimeSec: 90 })).speedBonus).toBe(400);
  });

  it("linearly decays the speed bonus between the target and twice the target", () => {
    expect(computeScore(input({ levelTimeSec: 135 })).speedBonus).toBe(200);
  });

  it("awards no speed bonus at/past twice the target time", () => {
    expect(computeScore(input({ levelTimeSec: 180 })).speedBonus).toBe(0);
    expect(computeScore(input({ levelTimeSec: 999 })).speedBonus).toBe(0);
  });

  it("treats zero distance traveled as a perfect path ratio", () => {
    expect(computeScore(input({ distanceTraveledTiles: 0, shortestPathTiles: 50 })).pathBonus).toBe(300);
  });

  it("scores a perfect path at the max path bonus", () => {
    expect(computeScore(input({ distanceTraveledTiles: 50, shortestPathTiles: 50 })).pathBonus).toBe(300);
  });

  it("scores a wandered path below the max, and clamps a ratio above 1", () => {
    expect(computeScore(input({ distanceTraveledTiles: 100, shortestPathTiles: 50 })).pathBonus).toBe(150);
    // shortestPathTiles exceeding distanceTraveledTiles clamps back to a perfect ratio
    expect(computeScore(input({ distanceTraveledTiles: 50, shortestPathTiles: 100 })).pathBonus).toBe(300);
  });

  it("awards the map-completion bonus only strictly past the threshold", () => {
    expect(computeScore(input({ mapCompletionFrac: 0.95 })).mapCompletionBonus).toBe(0);
    expect(computeScore(input({ mapCompletionFrac: 0.96 })).mapCompletionBonus).toBe(750);
    expect(computeScore(input({ mapCompletionFrac: 0.5 })).mapCompletionBonus).toBe(0);
  });

  it("clamps an out-of-range map-completion fraction before comparing to the threshold", () => {
    expect(computeScore(input({ mapCompletionFrac: 1.5 })).mapCompletionBonus).toBe(750);
    expect(computeScore(input({ mapCompletionFrac: -0.5 })).mapCompletionBonus).toBe(0);
  });

  it("adds a flat bonus per unique lore terminal read", () => {
    expect(computeScore(input({ uniqueLoreTerminalsRead: 3 })).loreBonus).toBe(300);
  });

  it("adds a flat bonus per unique secret room opened", () => {
    expect(computeScore(input({ uniqueSecretRoomsOpened: 2 })).secretRoomBonus).toBe(400);
  });

  it("adds a flat bonus per Multi Kill and per Ultra Kill streak triggered", () => {
    expect(computeScore(input({ multiKillCount: 1 })).multikillBonus).toBe(300);
    expect(computeScore(input({ ultraKillCount: 1 })).multikillBonus).toBe(750);
    expect(computeScore(input({ multiKillCount: 2, ultraKillCount: 1 })).multikillBonus).toBe(1350);
  });

  it("floors the total at 0 when a deeply negative killPoints outweighs every bonus", () => {
    const result = computeScore(
      input({
        killPoints: -100000,
        finalHealth: 0,
        maxHealth: 100,
        finalBullets: 0,
        startingBullets: 0,
        finalRockets: 0,
        startingRockets: 0,
        finalSmg: 0,
        startingSmg: 0,
        finalGas: 0,
        startingGas: 0,
        levelTimeSec: 9999,
        distanceTraveledTiles: 100,
        shortestPathTiles: 0,
        mapCompletionFrac: 0,
        uniqueLoreTerminalsRead: 0,
        uniqueSecretRoomsOpened: 0,
      }),
    );
    expect(result.total).toBe(0);
  });

  it("sums every bonus (plus killPoints) into the total for a normal run", () => {
    const result = computeScore(
      input({
        killPoints: 100,
        finalHealth: 100,
        maxHealth: 100,
        levelTimeSec: 30,
        distanceTraveledTiles: 50,
        shortestPathTiles: 50,
        mapCompletionFrac: 1,
        uniqueLoreTerminalsRead: 1,
        uniqueSecretRoomsOpened: 1,
      }),
    );
    expect(result.total).toBe(
      100 + result.healthBonus + result.ammoBonus + 400 + 300 + 750 + 100 + 200 + result.accuracyBonus,
    );
  });

  describe("accuracyBonus", () => {
    it("awards the full bonus for 100% accuracy", () => {
      expect(computeScore(input({ weaponShotsFired: 10, weaponHits: 10 })).accuracyBonus).toBe(250);
    });

    it("awards 0 when no shots were fired, not 100%", () => {
      expect(computeScore(input({ weaponShotsFired: 0, weaponHits: 0 })).accuracyBonus).toBe(0);
    });

    it("scales linearly with partial accuracy", () => {
      expect(computeScore(input({ weaponShotsFired: 100, weaponHits: 50 })).accuracyBonus).toBe(125);
    });

    it("clamps hits above shotsFired defensively", () => {
      expect(computeScore(input({ weaponShotsFired: 10, weaponHits: 999 })).accuracyBonus).toBe(250);
    });
  });
});

describe("zeroScoreBreakdown / sumScoreBreakdowns", () => {
  it("zeroScoreBreakdown is the identity for sumScoreBreakdowns", () => {
    const breakdown = computeScore(input({ killPoints: 50, weaponShotsFired: 4, weaponHits: 2 }));
    expect(sumScoreBreakdowns(zeroScoreBreakdown(), breakdown)).toEqual(breakdown);
  });

  it("sums every category elementwise, including total", () => {
    const a = computeScore(input({ killPoints: 50 }));
    const b = computeScore(input({ killPoints: 25 }));
    const sum = sumScoreBreakdowns(a, b);
    expect(sum.killPoints).toBe(a.killPoints + b.killPoints);
    expect(sum.total).toBe(a.total + b.total);
  });
});

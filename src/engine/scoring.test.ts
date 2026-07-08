import { describe, it, expect } from "vitest";
import { killPoints, computeScore, type ScoreInput } from "./scoring";
import type { Enemy } from "../../map/types";

describe("scoring", () => {
  describe("killPoints", () => {
    it("calculates points for a basic non-elite enemy", () => {
      const enemy = { elite: false, entity: { complexityScore: 2 } } as Enemy;
      expect(killPoints(enemy)).toBe(80);
    });
    it("calculates points for an elite enemy", () => {
      const enemy = { elite: true, entity: { complexityScore: 2 } } as Enemy;
      expect(killPoints(enemy)).toBe(240);
    });
    it("calculates points for a basic non-elite enemy with 0 complexity", () => {
      const enemy = { elite: false, entity: { complexityScore: 0 } } as Enemy;
      expect(killPoints(enemy)).toBe(50);
    });
  });

  describe("computeScore", () => {
    const baseInput: ScoreInput = {
      killPoints: 0, finalHealth: 100, maxHealth: 100, finalBullets: 50, finalRockets: 10,
      startingBullets: 50, startingRockets: 10, levelTimeSec: 45, distanceTraveledTiles: 100,
      shortestPathTiles: 100, mapCompletionFrac: 1.0, uniqueLoreTerminalsRead: 2
    };
    it("calculates a perfect score", () => {
      const score = computeScore(baseInput);
      expect(score).toEqual({ killPoints: 0, healthBonus: 500, ammoBonus: 250, speedBonus: 400, pathBonus: 300, mapCompletionBonus: 750, loreBonus: 200, total: 2400 });
    });
    it("handles zero starting ammo", () => {
      const input = { ...baseInput, startingBullets: 0, startingRockets: 0 };
      const score = computeScore(input);
      expect(score.ammoBonus).toBe(0);
    });
    it("handles negative or > 1 values for clamping", () => {
      const input = { ...baseInput, finalHealth: 150, maxHealth: 100, finalBullets: 60, finalRockets: 15, startingBullets: 50, startingRockets: 10, mapCompletionFrac: 1.5, shortestPathTiles: 150, distanceTraveledTiles: 100 };
      const score = computeScore(input);
      expect(score.healthBonus).toBe(500);
      expect(score.ammoBonus).toBe(250);
      expect(score.mapCompletionBonus).toBe(750);
      expect(score.pathBonus).toBe(300);
    });
    it("handles 0 values for clamping", () => {
      const input = { ...baseInput, finalHealth: -10, finalBullets: -5, finalRockets: -2, mapCompletionFrac: -0.5 };
      const score = computeScore(input);
      expect(score.healthBonus).toBe(0);
      expect(score.ammoBonus).toBe(0);
      expect(score.mapCompletionBonus).toBe(0);
    });
    it("handles distanceTraveledTiles === 0", () => {
      const input = { ...baseInput, distanceTraveledTiles: 0 };
      const score = computeScore(input);
      expect(score.pathBonus).toBe(300);
    });
    it("handles time over target, decaying to 0", () => {
      expect(computeScore({ ...baseInput, levelTimeSec: 135 }).speedBonus).toBe(200);
      expect(computeScore({ ...baseInput, levelTimeSec: 180 }).speedBonus).toBe(0);
      expect(computeScore({ ...baseInput, levelTimeSec: 200 }).speedBonus).toBe(0);
    });
    it("handles negative total points", () => {
      const input = { ...baseInput, killPoints: -5000, mapCompletionFrac: 0 };
      const score = computeScore(input);
      expect(score.total).toBe(0);
    });
    it("handles exact map completion threshold", () => {
      const input = { ...baseInput, mapCompletionFrac: 0.95 };
      const score = computeScore(input);
      expect(score.mapCompletionBonus).toBe(0);
    });
  });
});
// @ts-nocheck
import { describe, it, expect } from "vitest";
import { isSpikeActive, activeSpikeTileKeys, spikeDamage, detonateMine, updateMines } from "./traps";
import type { SpikeTrap, Mine } from "../map/types";
import type { Player } from "./player";

describe("traps", () => {
  describe("isSpikeActive", () => {
    it("should correctly identify active spikes based on levelTime", () => {
      const trap: SpikeTrap = { x: 1, y: 1, phase: 0, period: 2 };
      expect(isSpikeActive(trap, 0)).toBe(false);
      expect(isSpikeActive(trap, 0.5)).toBe(false);
      expect(isSpikeActive(trap, 1)).toBe(true);
      expect(isSpikeActive(trap, 1.5)).toBe(true);
      expect(isSpikeActive(trap, 2)).toBe(false);
    });

    it("should account for trap phase", () => {
      const trap: SpikeTrap = { x: 1, y: 1, phase: 1, period: 2 };
      expect(isSpikeActive(trap, 0)).toBe(true);
      expect(isSpikeActive(trap, 1)).toBe(false);
    });
  });

  describe("activeSpikeTileKeys", () => {
    it("should return keys for active spikes only", () => {
      const traps: SpikeTrap[] = [
        { x: 1, y: 1, phase: 0, period: 2 },
        { x: 2, y: 3, phase: 1, period: 2 },
      ];
      const keysAt0 = activeSpikeTileKeys(traps, 0);
      expect(keysAt0.size).toBe(1);
      expect(keysAt0.has("2,3")).toBe(true);
      const keysAt1 = activeSpikeTileKeys(traps, 1);
      expect(keysAt1.size).toBe(1);
      expect(keysAt1.has("1,1")).toBe(true);
    });
  });

  describe("spikeDamage", () => {
    it("should deal damage when player is on an active spike trap", () => {
      const traps: SpikeTrap[] = [{ x: 5, y: 5, phase: 0, period: 2 }];
      // Use decimal coordinates to ensure Math.floor resolves properly
      const player = { posX: 5.5, posY: 5.5 } as Player;
      const damage = spikeDamage(traps, player, 1, 0.5);
      expect(damage).toBe(10); // SPIKE_DPS(20) * 0.5
    });

    it("should not deal damage when player is on an inactive spike trap", () => {
      const traps: SpikeTrap[] = [{ x: 5, y: 5, phase: 0, period: 2 }];
      const player = { posX: 5.5, posY: 5.5 } as Player;
      const damage = spikeDamage(traps, player, 0, 0.5);
      expect(damage).toBe(0);
    });

    it("should not deal damage when player is not on any trap", () => {
      const traps: SpikeTrap[] = [{ x: 5, y: 5, phase: 0, period: 2 }];
      const player = { posX: 2, posY: 2 } as Player;
      const damage = spikeDamage(traps, player, 1, 0.5);
      expect(damage).toBe(0);
    });
  });

  describe("detonateMine", () => {
    it("should deal max damage when at point blank", () => {
      const mine = { x: 5, y: 5, alive: true } as Mine;
      const player = { posX: 5, posY: 5 } as Player;
      const damage = detonateMine(mine, player);
      expect(damage).toBe(32); // MINE_MAX_DAMAGE
      expect(mine.alive).toBe(false);
    });

    it("should deal no damage when outside blast radius", () => {
      const mine = { x: 5, y: 5, alive: true } as Mine;
      // 2.4 is MINE_BLAST_RADIUS
      const player = { posX: 5 + 2.4, posY: 5 } as Player;
      const damage = detonateMine(mine, player);
      expect(damage).toBe(0);
      expect(mine.alive).toBe(false);
    });

    it("should deal falloff damage", () => {
      const mine = { x: 5, y: 5, alive: true } as Mine;
      const player = { posX: 5 + 1.2, posY: 5 } as Player;
      const damage = detonateMine(mine, player);
      // Half radius = 1 - 0.5 = 0.5 falloff = 16 damage
      expect(damage).toBeCloseTo(16);
    });

    it("should deal minimum falloff damage at edges", () => {
      const mine = { x: 5, y: 5, alive: true } as Mine;
      const player = { posX: 5 + 2.3, posY: 5 } as Player;
      const damage = detonateMine(mine, player);
      expect(damage).toBe(32 * 0.35); // 11.2 (MINE_DAMAGE_FALLOFF_FLOOR)
    });
  });

  describe("updateMines", () => {
    it("should ignore dead mines", () => {
      const mines = [{ x: 5, y: 5, alive: false, closeTimer: 0, visible: false }] as Mine[];
      const player = { posX: 5, posY: 5 } as Player;
      const damage = updateMines(mines, player, 1);
      expect(damage).toBe(0);
    });

    it("should make mine visible when within sight radius", () => {
      // MINE_SIGHT_RADIUS is 4.5
      const mines = [{ x: 5, y: 5, alive: true, closeTimer: 0, visible: false }] as Mine[];
      const player = { posX: 5 + 4.0, posY: 5 } as Player;
      updateMines(mines, player, 1);
      expect(mines[0].visible).toBe(true);
    });

    it("should not make mine visible when outside sight radius", () => {
      const mines = [{ x: 5, y: 5, alive: true, closeTimer: 0, visible: false }] as Mine[];
      const player = { posX: 5 + 5.0, posY: 5 } as Player;
      updateMines(mines, player, 1);
      expect(mines[0].visible).toBe(false);
    });

    it("should reset fuse timer when outside fuse radius", () => {
      // MINE_FUSE_RADIUS is 1.8
      const mines = [{ x: 5, y: 5, alive: true, closeTimer: 0.5, visible: false }] as Mine[];
      const player = { posX: 5 + 2.0, posY: 5 } as Player;
      updateMines(mines, player, 1);
      expect(mines[0].closeTimer).toBe(0);
    });

    it("should increment fuse timer but not detonate if below fuse seconds", () => {
      // MINE_FUSE_SECONDS is 0.9
      const mines = [{ x: 5, y: 5, alive: true, closeTimer: 0.5, visible: false }] as Mine[];
      const player = { posX: 5 + 1.0, posY: 5 } as Player;
      const damage = updateMines(mines, player, 0.3);
      expect(mines[0].closeTimer).toBe(0.8);
      expect(damage).toBe(0);
      expect(mines[0].alive).toBe(true);
    });

    it("should detonate when fuse timer exceeds fuse seconds", () => {
      const mines = [{ x: 5, y: 5, alive: true, closeTimer: 0.5, visible: false }] as Mine[];
      const player = { posX: 5 + 1.0, posY: 5 } as Player;
      const damage = updateMines(mines, player, 0.5); // closeTimer bumps up to 1.0 >= 0.9
      expect(mines[0].closeTimer).toBe(1.0);
      expect(mines[0].alive).toBe(false);
      expect(damage).toBeGreaterThan(0);
    });
  });
});

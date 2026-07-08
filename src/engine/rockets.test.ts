// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  spawnRocket,
  updateRockets,
  rocketDamageAt,
  collectRocketBillboards,
  ROCKET_BLAST_RADIUS,
} from "./rockets";
import type { Rocket, RocketExplosion } from "./rockets";
import type { GameMap, Enemy } from "../map/types";
import type { Player } from "./player";

// Mock sprites module to control projectPoint output predictably
vi.mock("./sprites", () => ({
  projectPoint: vi.fn((player, x, y, width, height, radius) => {
    // We'll use rocket's x as depth, y as screenX, and arbitrarily map left/right
    return {
      depth: x,
      screenX: y,
      left: 10,
      right: 20, 
    };
  }),
}));

// Provide a mock isWall that respects the GameMap's grid
vi.mock("./player", () => ({
  isWall: vi.fn((map, cx, cy) => {
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true;
    return map.grid[cy][cx] === 1;
  }),
}));

describe("rockets", () => {
  describe("spawnRocket", () => {
    it("spawns a rocket with correct offset and velocity", () => {
      const list: Rocket[] = [];
      spawnRocket(list, 10, 20, 1, 0, 50);
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        x: 10.4,
        y: 20,
        vx: 9, // ROCKET_SPEED is 9
        vy: 0,
        damage: 50,
      });
    });
  });

  describe("updateRockets", () => {
    let map: GameMap;

    beforeEach(() => {
      // 10x10 empty map
      map = {
        width: 10,
        height: 10,
        grid: Array.from({ length: 10 }, () => Array(10).fill(0)),
      } as unknown as GameMap;
    });

    it("handles an empty list", () => {
      expect(updateRockets([], [], map, 1)).toEqual([]);
    });

    it("moves rockets and does not explode if no hit", () => {
      const list: Rocket[] = [{ x: 5, y: 5, vx: 2, vy: 0, damage: 10 }];
      const explosions = updateRockets(list, [], map, 1);
      expect(explosions).toHaveLength(0);
      expect(list[0].x).toBe(7);
      expect(list[0].y).toBe(5);
    });

    it("explodes when hitting an enemy (distance < 0.4 and alive)", () => {
      const list: Rocket[] = [{ x: 5, y: 5, vx: 2, vy: 0, damage: 10 }];
      const enemies: Enemy[] = [
        { alive: true, x: 7.2, y: 5 } as Enemy, // 7.2 - 7.0 = 0.2 < 0.4
      ];
      const explosions = updateRockets(list, enemies, map, 1);
      
      expect(list).toHaveLength(0);
      expect(explosions).toHaveLength(1);
      expect(explosions[0]).toEqual({ x: 7, y: 5, damage: 10 });
    });

    it("does not explode on a dead enemy even if distance < 0.4", () => {
      const list: Rocket[] = [{ x: 5, y: 5, vx: 2, vy: 0, damage: 10 }];
      const enemies: Enemy[] = [
        { alive: false, x: 7.2, y: 5 } as Enemy,
      ];
      const explosions = updateRockets(list, enemies, map, 1);
      
      expect(list).toHaveLength(1);
      expect(explosions).toHaveLength(0);
    });

    it("does not explode if alive enemy is too far", () => {
      const list: Rocket[] = [{ x: 5, y: 5, vx: 2, vy: 0, damage: 10 }];
      const enemies: Enemy[] = [
        { alive: true, x: 7.5, y: 5 } as Enemy, // 7.5 - 7.0 = 0.5 >= 0.4
      ];
      const explosions = updateRockets(list, enemies, map, 1);
      
      expect(list).toHaveLength(1);
      expect(explosions).toHaveLength(0);
    });

    it("explodes when hitting a wall", () => {
      map.grid[5][7] = 1; // wall at x=7, y=5
      const list: Rocket[] = [{ x: 5, y: 5, vx: 2, vy: 0, damage: 10 }];
      const explosions = updateRockets(list, [], map, 1);
      
      expect(list).toHaveLength(0);
      expect(explosions).toHaveLength(1);
      expect(explosions[0]).toEqual({ x: 7, y: 5, damage: 10 });
    });
  });

  describe("rocketDamageAt", () => {
    it("returns 0 outside or exactly at ROCKET_BLAST_RADIUS", () => {
      const expl: RocketExplosion = { x: 0, y: 0, damage: 100 };
      expect(rocketDamageAt(expl, 2.6, 0)).toBe(0); // exactly at radius
      expect(rocketDamageAt(expl, 3, 0)).toBe(0); // outside
    });

    it("returns linear damage falloff", () => {
      const expl: RocketExplosion = { x: 0, y: 0, damage: 100 };
      // 1.3 is half of 2.6, so falloff is 0.5
      expect(rocketDamageAt(expl, 1.3, 0)).toBeCloseTo(50);
    });

    it("clamps falloff to ROCKET_DAMAGE_FALLOFF_FLOOR (0.3)", () => {
      const expl: RocketExplosion = { x: 0, y: 0, damage: 100 };
      // 2.5 is very close to 2.6, so 1 - (2.5/2.6) ≈ 0.038 < 0.3
      expect(rocketDamageAt(expl, 2.5, 0)).toBeCloseTo(30);
    });
  });

  describe("collectRocketBillboards & clamp", () => {
    let mockCtx: any;
    
    beforeEach(() => {
      mockCtx = {
        canvas: { width: 800, height: 600 },
        fillStyle: "",
        fillRect: vi.fn(),
      };
    });

    it("filters out rockets with depth <= 0.1", () => {
      const player = {} as Player;
      const list: Rocket[] = [
        { x: 0.1, y: 50, vx: 0, vy: 0, damage: 10 },
        { x: -5, y: 50, vx: 0, vy: 0, damage: 10 },
      ];
      const zBuffer = new Float64Array(800).fill(100);
      
      const jobs = collectRocketBillboards(mockCtx, player, list, zBuffer);
      expect(jobs).toHaveLength(0);
    });

    it("early returns draw if depth >= zBuffer[col]", () => {
      const player = {} as Player;
      // Mock configured so x maps to depth, y maps to screenX
      const list: Rocket[] = [{ x: 5, y: 50, vx: 0, vy: 0, damage: 10 }];
      const zBuffer = new Float64Array(800).fill(100);
      zBuffer[50] = 2; // wall is at depth 2 (closer than rocket at 5)
      
      const jobs = collectRocketBillboards(mockCtx, player, list, zBuffer);
      expect(jobs).toHaveLength(1);
      
      jobs[0].draw();
      expect(mockCtx.fillRect).not.toHaveBeenCalled();
    });

    it("draws and exercises clamp: value < min, value > max, min <= value <= max", () => {
      const player = {} as Player;
      // We will place 3 rockets to cover the 3 clamp branches:
      // screenX = -10 (clamp to 0)
      // screenX = 1000 (clamp to 799)
      // screenX = 50 (clamp to 50)
      const list: Rocket[] = [
        { x: 2, y: -10, vx: 0, vy: 0, damage: 10 },
        { x: 2, y: 1000, vx: 0, vy: 0, damage: 10 },
        { x: 2, y: 50, vx: 0, vy: 0, damage: 10 },
      ];
      const zBuffer = new Float64Array(800).fill(100);
      
      const jobs = collectRocketBillboards(mockCtx, player, list, zBuffer);
      expect(jobs).toHaveLength(3);
      
      // Execute draw for all to hit the branches of clamp
      jobs[0].draw();
      jobs[1].draw();
      jobs[2].draw();
      
      // Each visible draw calls fillRect 3 times
      expect(mockCtx.fillRect).toHaveBeenCalledTimes(9);
    });

    it("covers Math.max(3, ...) for size calculation", async () => {
      const player = {} as Player;
      
      // Dynamically override projectPoint exclusively for this test to control left/right outputs
      const { projectPoint } = await import("./sprites");
      const projectMock = projectPoint as any;
      projectMock.mockReturnValueOnce({
        depth: 2,
        screenX: 50,
        left: 0,
        right: 4, // (4 - 0) * 0.5 = 2 < 3, so size becomes 3
      });
      projectMock.mockReturnValueOnce({
        depth: 2,
        screenX: 50,
        left: 0,
        right: 20, // (20 - 0) * 0.5 = 10 > 3, so size becomes 10
      });

      const list: Rocket[] = [
        { x: 2, y: 50, vx: 0, vy: 0, damage: 10 },
        { x: 2, y: 50, vx: 0, vy: 0, damage: 10 }
      ];
      const zBuffer = new Float64Array(800).fill(100);
      
      const jobs = collectRocketBillboards(mockCtx, player, list, zBuffer);
      expect(jobs).toHaveLength(2);
      
      jobs[0].draw();
      jobs[1].draw();
      
      expect(mockCtx.fillRect).toHaveBeenCalledTimes(6);
    });
  });
});

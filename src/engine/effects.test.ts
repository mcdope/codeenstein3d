// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  drawDamageFlash,
  makeBulletTrace,
  drawBulletTraces,
  spawnExplosion,
  updateExplosions,
  renderExplosions,
  tickBulletTraces,
  spawnBlood,
  updateBlood,
  renderBlood,
  DAMAGE_FLASH_FRAMES,
  BULLET_TRACE_FRAMES,
  HIT_FLASH_FRAMES,
  GORE_MULTIPLIERS,
  EXTREME_GORE_ENABLED,
  DEFAULT_GORE_LEVEL,
} from "./effects";
import type { Player } from "./player";
import { projectPoint } from "./sprites";

vi.mock("./sprites", () => ({
  projectPoint: vi.fn(),
}));

function createMockCtx() {
  return {
    canvas: { width: 800, height: 600 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

const dummyPlayer: Player = {
  x: 0,
  y: 0,
  dirX: 1,
  dirY: 0,
  planeX: 0,
  planeY: 0.66,
  moveSpeed: 5,
  rotSpeed: 3,
  health: 100,
  maxHealth: 100,
  armor: 0,
  weapons: [],
  currentWeapon: 0,
  ammo: [],
  score: 0,
  dead: false,
};

describe("effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should export correct constants", () => {
      expect(DAMAGE_FLASH_FRAMES).toBe(12);
      expect(BULLET_TRACE_FRAMES).toBe(4);
      expect(HIT_FLASH_FRAMES).toBe(5);
      expect(EXTREME_GORE_ENABLED).toBe(false);
      expect(DEFAULT_GORE_LEVEL).toBe("normal");
      expect(GORE_MULTIPLIERS.none).toEqual({ count: 0, size: 1, stainDuration: 1 });
      expect(GORE_MULTIPLIERS.extreme).toEqual({ count: 10, size: 10, stainDuration: 10 });
    });
  });

  describe("drawDamageFlash", () => {
    it("should not draw if intensity <= 0", () => {
      const ctx = createMockCtx();
      drawDamageFlash(ctx, 0);
      drawDamageFlash(ctx, -1);
      expect(ctx.fillRect).not.toHaveBeenCalled();
    });

    it("should draw a red overlay based on intensity", () => {
      const ctx = createMockCtx();
      drawDamageFlash(ctx, 1);
      expect(ctx.fillStyle).toBe("rgba(255,0,0,0.400)");
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });
  });

  describe("makeBulletTrace", () => {
    it("should return a properly initialized trace", () => {
      const trace = makeBulletTrace(800, 600, 100, 200, "#ff0000");
      expect(trace).toEqual({
        x1: 400,
        y1: 600,
        x2: 100,
        y2: 200,
        frames: BULLET_TRACE_FRAMES,
        color: "#ff0000",
      });
    });
  });

  describe("drawBulletTraces", () => {
    it("should draw traces with computed alpha and colors", () => {
      const ctx = createMockCtx();
      const traces = [
        { x1: 400, y1: 600, x2: 100, y2: 200, frames: BULLET_TRACE_FRAMES, color: "#ff8800" },
        { x1: 400, y1: 600, x2: 200, y2: 300, frames: 0, color: "#00ff00" },
        { x1: 400, y1: 600, x2: 300, y2: 400, frames: -1, color: "#0000ff" },
      ];

      drawBulletTraces(ctx, traces);

      expect(ctx.lineCap).toBe("round");
      expect(ctx.lineWidth).toBe(1);

      expect(ctx.beginPath).toHaveBeenCalledTimes(3);
      expect(ctx.moveTo).toHaveBeenCalledTimes(3);
      expect(ctx.lineTo).toHaveBeenCalledTimes(3);
      expect(ctx.stroke).toHaveBeenCalledTimes(3);
    });
  });

  describe("tickBulletTraces", () => {
    it("should age and remove expired traces", () => {
      const traces = [
        { x1: 0, y1: 0, x2: 1, y2: 1, frames: 2, color: "#000" },
        { x1: 0, y1: 0, x2: 1, y2: 1, frames: 1, color: "#000" },
        { x1: 0, y1: 0, x2: 1, y2: 1, frames: 0, color: "#000" },
      ];

      tickBulletTraces(traces);

      expect(traces.length).toBe(1);
      expect(traces[0].frames).toBe(1);
    });
  });

  describe("spawnExplosion", () => {
    it("should add an explosion to the list", () => {
      const list = [];
      spawnExplosion(list, 5, 5, 2.5);
      expect(list.length).toBe(1);
      expect(list[0]).toEqual(expect.objectContaining({
        x: 5,
        y: 5,
        radius: 2.5,
        life: 0.35,
        maxLife: 0.35,
      }));
    });
  });

  describe("updateExplosions", () => {
    it("should update explosion life and remove dead ones", () => {
      const list = [
        { x: 0, y: 0, radius: 1, life: 0.5, maxLife: 1 },
        { x: 0, y: 0, radius: 1, life: 0.1, maxLife: 1 },
      ];

      updateExplosions(list, 0.2);

      expect(list.length).toBe(1);
      expect(list[0].life).toBeCloseTo(0.3);
    });
  });

  describe("renderExplosions", () => {
    it("should correctly render explosions handling depth and clamping", () => {
      const ctx = createMockCtx();
      const list = [
        { x: 1, y: 1, radius: 2, life: 0.175, maxLife: 0.35 },
        { x: 2, y: 2, radius: 2, life: 0.1, maxLife: 0.35 },
        { x: 3, y: 3, radius: 2, life: 0.1, maxLife: 0.35 },
        { x: 4, y: 4, radius: 2, life: 0.1, maxLife: 0.35 },
        { x: 5, y: 5, radius: 2, life: 0.1, maxLife: 0.35 },
      ];
      
      const zBuffer = new Float64Array(800);
      zBuffer.fill(10);

      vi.mocked(projectPoint)
        .mockReturnValueOnce({ depth: 5, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 15, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 0.05, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 5, screenX: -50, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 5, screenX: 1000, top: 100, bottom: 500 });

      renderExplosions(ctx, dummyPlayer, list, zBuffer);

      expect(projectPoint).toHaveBeenCalledTimes(5);
      expect(ctx.beginPath).toHaveBeenCalledTimes(6);
      expect(ctx.arc).toHaveBeenCalledTimes(6);
      expect(ctx.fill).toHaveBeenCalledTimes(6);
    });
  });

  describe("spawnBlood", () => {
    it("should spawn correct number of particles with randomized properties", () => {
      const list = [];
      spawnBlood(list, 10, 10, 5);
      expect(list.length).toBe(5);
      expect(list[0]).toEqual(expect.objectContaining({
        x: 10,
        y: 10,
        settled: false,
      }));
      expect(typeof list[0].vx).toBe("number");
      expect(typeof list[0].vy).toBe("number");
      expect(typeof list[0].vz).toBe("number");
      expect(typeof list[0].life).toBe("number");
      expect(typeof list[0].z).toBe("number");
    });
  });

  describe("updateBlood", () => {
    it("should update flying particles and handle settling", () => {
      const list = [
        { x: 0, y: 0, z: 2, vx: 1, vy: 1, vz: 5, life: 1, settled: false },
        { x: 0, y: 0, z: 0.1, vx: 10, vy: 10, vz: -1, life: 1, settled: false },
        { x: 0, y: 0, z: 0, vx: 1, vy: 1, vz: 0, life: 0.1, settled: true },
      ];

      updateBlood(list, 0.2, 2);

      expect(list.length).toBe(2);

      expect(list[0].vz).toBeCloseTo(3.8);
      expect(list[0].z).toBeCloseTo(2.76);
      expect(list[0].settled).toBe(false);

      expect(list[1].z).toBe(0);
      expect(list[1].vz).toBe(0);
      expect(list[1].vx).toBeCloseTo(4);
      expect(list[1].settled).toBe(true);
      expect(list[1].life).toBeCloseTo(3 - 0.2);
    });

    it("should not reset life again if already settled", () => {
      const list = [
        { x: 0, y: 0, z: 0, vx: 1, vy: 1, vz: 0, life: 5, settled: true },
      ];
      updateBlood(list, 0.2, 2);
      expect(list[0].life).toBeCloseTo(4.8);
      expect(list[0].settled).toBe(true);
    });
  });

  describe("renderBlood", () => {
    it("should correctly render blood particles handling depth and size", () => {
      const ctx = createMockCtx();
      const list = [
        { x: 1, y: 1, z: 1, vx: 0, vy: 0, vz: 0, life: 1, settled: false },
        { x: 2, y: 2, z: 1, vx: 0, vy: 0, vz: 0, life: 1, settled: false },
        { x: 3, y: 3, z: 1, vx: 0, vy: 0, vz: 0, life: 1, settled: false },
        { x: 4, y: 4, z: 1, vx: 0, vy: 0, vz: 0, life: 1, settled: false },
        { x: 5, y: 5, z: 1, vx: 0, vy: 0, vz: 0, life: 1, settled: false },
      ];

      const zBuffer = new Float64Array(800);
      zBuffer.fill(10);

      vi.mocked(projectPoint)
        .mockReturnValueOnce({ depth: 5, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 0.1, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 15, screenX: 400, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 5, screenX: -100, top: 100, bottom: 500 })
        .mockReturnValueOnce({ depth: 5, screenX: 400, top: 100, bottom: 101 });

      renderBlood(ctx, dummyPlayer, list, zBuffer, 1);

      expect(projectPoint).toHaveBeenCalledTimes(5);
      expect(ctx.fillRect).toHaveBeenCalledTimes(3);
      expect(ctx.fillStyle).toBe("#c81e1e");
    });
  });
});

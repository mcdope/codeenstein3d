// @ts-nocheck
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderScene, renderMinimap, FOG_FAR } from './raycaster';
import {
  DOOR_TILE,
  HAZARD_TILE,
  LORE_TILE,
  SECRET_WALL_TILE,
  SPIKE_TRAP_TILE,
  TELEPORTER_TILE,
  type GameMap,
} from '../map/types';
import type { Player } from './player';

describe('raycaster', () => {
  let ctx: any;
  let canvas: any;
  let player: Player;
  let zBuffer: Float64Array;

  beforeEach(() => {
    canvas = {
      width: 320,
      height: 240,
    };
    ctx = {
      canvas,
      createImageData: vi.fn().mockReturnValue({
        width: 320,
        height: 240,
        data: new Uint8ClampedArray(320 * 240 * 4),
      }),
      putImageData: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
      save: vi.fn(),
      restore: vi.fn(),
      strokeRect: vi.fn(),
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
    };
    player = {
      posX: 1.5,
      posY: 1.5,
      dirX: 1,
      dirY: 0,
      planeX: 0,
      planeY: 0.66,
      radius: 0.2,
      moveSpeed: 0.1,
      rotSpeed: 0.05,
    } as any;
    zBuffer = new Float64Array(320);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMap(overrides: Partial<GameMap> = {}): GameMap {
    return {
      width: 5,
      height: 5,
      grid: [
        [1, 1, 1, 1, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 1, 1, 1, 1],
      ],
      bonusLevel: false,
      hazards: [],
      teleporters: [],
      spikeTraps: [],
      loreTerminals: [],
      doors: [],
      mines: [],
      keys: [],
      exit: { x: 1, y: 1 },
      enemies: [],
      ...overrides,
    };
  }

  describe('renderScene', () => {
    it('renders a scene without floor-cast', () => {
      const map = createMap();
      renderScene(ctx, map, player, zBuffer, 0, 0);
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('renders a scene with hazards triggering floor-cast', () => {
      const map = createMap({
        hazards: [{ x: 1, y: 1 }],
      });
      renderScene(ctx, map, player, zBuffer, 0, 0);
      expect(ctx.createImageData).toHaveBeenCalledWith(320, 240);
      expect(ctx.putImageData).toHaveBeenCalled();
    });

    it('re-creates floor image if size changes', () => {
      const map = createMap({ hazards: [{x: 1, y: 1}] });
      renderScene(ctx, map, player, zBuffer, 0, 0);
      
      canvas.width = 640;
      canvas.height = 480;
      ctx.createImageData.mockReturnValue({
        width: 640,
        height: 480,
        data: new Uint8ClampedArray(640 * 480 * 4),
      });
      renderScene(ctx, map, player, zBuffer, 0, 0);
      expect(ctx.createImageData).toHaveBeenCalledWith(640, 480);
    });

    it('renders a bonus level scene', () => {
      const map = createMap({ bonusLevel: true, teleporters: [{x: 1, y: 1}] });
      renderScene(ctx, map, player, zBuffer, 0, 0);
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('handles ray hitting wall, doors, lore, secret walls and out of bounds', () => {
      const map = createMap({
        grid: [
          [1, DOOR_TILE, LORE_TILE, SECRET_WALL_TILE, 1],
          [1, 0, 0, 0, 1],
          [1, 0, 0, 0, 1],
          [1, 0, 0, 0, 1],
          [1, 1, 1, 1, 1],
        ],
      });
      // Look north
      player.posX = 1.5; player.posY = 1.5; player.dirX = 0; player.dirY = -1; player.planeX = 0.66; player.planeY = 0;
      renderScene(ctx, map, player, zBuffer, 0, 0);

      // Look south (hit out of bounds eventually)
      player.posX = 1.5; player.posY = 3.5; player.dirX = 0; player.dirY = 1;
      renderScene(ctx, map, player, zBuffer, 0, 0);
    });

    it('handles zero direction vector (guard loop termination)', () => {
      const map = createMap();
      player.posX = 1.5; player.posY = 1.5; player.dirX = 0; player.dirY = 0; player.planeX = 0; player.planeY = 0;
      renderScene(ctx, map, player, zBuffer, 0, 0);
      expect(zBuffer[0]).toBeNaN();
    });

    it('handles floor casting and teleporter/spike/hazard tiles', () => {
      const map = createMap({
        spikeTraps: [{ x: 1, y: 1 }, { x: 1, y: 2 }],
        teleporters: [{ x: 1, y: 3 }],
        hazards: [{ x: 2, y: 1 }],
        grid: [
          [1, 1, 1, 1, 1],
          [1, SPIKE_TRAP_TILE, HAZARD_TILE, 0, 1],
          [1, SPIKE_TRAP_TILE, 0, 0, 1],
          [1, TELEPORTER_TILE, 0, 0, 1],
          [1, 1, 1, 1, 1],
        ],
      });
      // Look south to see floor
      player.posX = 1.5; player.posY = 1.5; player.dirX = 0; player.dirY = 1; player.planeX = 0.66; player.planeY = 0;
      renderScene(ctx, map, player, zBuffer, 0, 0); // Spikes hit the normal block
      renderScene(ctx, map, player, zBuffer, 0, 10000); // Trigger spikes hit the active block depending on levelTime
    });

    it('tests fog shading thresholds', () => {
      const bigMap = createMap({
        width: 20, height: 2,
        grid: [
          Array(20).fill(1),
          Array(20).fill(1)
        ]
      });
      for(let i=1; i<19; i++) {
        bigMap.grid[1][i] = 0;
      }
      player.posX = 1.5; player.posY = 1.5; player.dirX = 1; player.dirY = 0; player.planeX = 0; player.planeY = 0.66;
      renderScene(ctx, bigMap, player, zBuffer, 0, 0);
    });
  });

  describe('renderMinimap', () => {
    it('renders everything', () => {
      const map = createMap({
        loreTerminals: [{ x: 1, y: 1 }],
        hazards: [{ x: 1, y: 1 }],
        doors: [{ x: 1, y: 1 }, { x: 1, y: 2 }],
        spikeTraps: [{ x: 1, y: 1 }],
        mines: [
          { x: 1, y: 1, alive: true, visible: true },
          { x: 1, y: 2, alive: false, visible: true },
          { x: 1, y: 3, alive: true, visible: false },
        ],
        teleporters: [{ x: 1, y: 1 }],
        keys: [
          { x: 1, y: 1, collected: false },
          { x: 1, y: 2, collected: true }
        ],
        exit: { x: 1, y: 1 },
        enemies: [
          { x: 1, y: 1, alive: true, discovered: true, entity: { kind: 0 } as any },
          { x: 1, y: 2, alive: false, discovered: true, entity: { kind: 0 } as any },
          { x: 1, y: 3, alive: true, discovered: false, entity: { kind: 0 } as any },
        ],
        grid: [
          [1, 1, 1, 1, 1],
          [1, DOOR_TILE, SECRET_WALL_TILE, 1, 1],
          [1, 0, 1, 1, 1], // Testing open door
          [1, LORE_TILE, 1, 1, 1],
          [1, 1, 1, 1, 1],
        ]
      });
      const rect = renderMinimap(ctx, map, player, 0, 140);
      expect(rect).toBeDefined();
    });

    it('renders bonus level map', () => {
      const map = createMap({
        bonusLevel: true,
        grid: [
          [1, 1, 1, 1, 1],
          [1, SECRET_WALL_TILE, 0, 0, 1],
          [1, 0, 0, 0, 1],
          [1, 0, 0, 0, 1],
          [1, 1, 1, 1, 1],
        ]
      });
      renderMinimap(ctx, map, player, 0, 140);
      expect(ctx.fillRect).toHaveBeenCalled();
    });
  });
});

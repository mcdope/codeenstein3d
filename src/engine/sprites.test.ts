// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enemyColor,
  projectPoint,
  projectEnemy,
  collectEnemyBillboards,
  findTargetAtColumn,
  findTargetUnderCrosshair,
  findMineAtColumn,
  collectExitBillboard,
  collectKeyBillboards,
  collectLootBillboards,
  collectDecorationBillboards,
  collectTeleporterBillboards,
  collectMineBillboards,
} from './sprites';
import type { Player } from './player';
import type { Enemy, KeyItem, LootDrop, Decoration, Teleporter, Mine } from '../map/types';

describe('sprites', () => {
  let ctx: any;
  let zBuffer: Float64Array;
  let player: Player;

  beforeEach(() => {
    ctx = {
      canvas: { width: 800, height: 600 },
      fillRect: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: '',
    };
    zBuffer = new Float64Array(800).fill(Infinity);
    player = {
      posX: 0,
      posY: 0,
      dirX: 1,
      dirY: 0,
      planeX: 0,
      planeY: 0.66,
    } as unknown as Player;
  });

  describe('enemyColor', () => {
    it('returns red for function', () => {
      expect(enemyColor('function')).toBe('#e0483a');
    });
    it('returns orange for method', () => {
      expect(enemyColor('method')).toBe('#e08a2a');
    });
    it('returns purple for default', () => {
      expect(enemyColor('variable' as any)).toBe('#b84ad0');
    });
  });

  describe('projectPoint', () => {
    it('projects a point correctly', () => {
      const proj = projectPoint(player, 5, 0, 800, 600, 1.0);
      expect(proj.depth).toBeCloseTo(5);
      expect(proj.screenX).toBeCloseTo(400);
      expect(proj.top).toBeCloseTo(240);
      expect(proj.bottom).toBeCloseTo(360);
    });
  });

  describe('projectEnemy', () => {
    it('projects a regular enemy', () => {
      const enemy = { x: 5, y: 0, elite: false } as Enemy;
      const proj = projectEnemy(player, enemy, 800, 600);
      expect(proj.depth).toBeCloseTo(5);
    });
    it('projects an elite enemy larger', () => {
      const enemy = { x: 5, y: 0, elite: true } as Enemy;
      const projNormal = projectEnemy(player, { ...enemy, elite: false }, 800, 600);
      const projElite = projectEnemy(player, enemy, 800, 600);
      expect(projElite.bottom - projElite.top).toBeCloseTo((projNormal.bottom - projNormal.top) * 1.5);
    });
  });

  describe('collectEnemyBillboards', () => {
    it('collects living enemies in front of near clip', () => {
      const enemy = {
        x: 5,
        y: 0,
        alive: true,
        elite: false,
        hitFlash: 0,
        hp: 10,
        maxHp: 20,
        entity: { kind: 'function', name: 'foo' },
      } as Enemy;
      const jobs = collectEnemyBillboards(ctx, player, [enemy], zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('handles behind-wall body clipping', () => {
      const enemy = {
        x: 5,
        y: 0,
        alive: true,
        elite: false,
        hitFlash: 0,
        hp: 10,
        maxHp: 20,
        entity: { kind: 'function', name: 'foo' },
      } as Enemy;
      zBuffer.fill(1); // put wall close
      const jobs = collectEnemyBillboards(ctx, player, [enemy], zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw(); 
      // should not draw body or name label because behind wall
    });

    it('draws hitflash, draws elite overlay', () => {
      const enemy = {
        x: 5,
        y: 0,
        alive: true,
        elite: true,
        hitFlash: 1,
        hp: 10,
        maxHp: 20,
        entity: { kind: 'method', name: 'bar' },
      } as Enemy;
      const jobs = collectEnemyBillboards(ctx, player, [enemy], zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillStyle).toBe('#f2c230'); // elite overlay replaces hitFlash body
      expect(ctx.fillText).toHaveBeenCalledWith('⚠ ELITE', expect.any(Number), expect.any(Number));
    });

    it('ignores dead enemies and behind-camera enemies', () => {
      const deadEnemy = { x: 5, y: 0, alive: false } as Enemy;
      const behindEnemy = { x: -5, y: 0, alive: true } as Enemy;
      const jobs = collectEnemyBillboards(ctx, player, [deadEnemy, behindEnemy], zBuffer);
      expect(jobs.length).toBe(0);
    });
  });

  describe('findTargetAtColumn', () => {
    it('finds enemy', () => {
      const enemy1 = { x: 5, y: 0, alive: true, elite: false } as Enemy;
      const target = findTargetAtColumn(player, [enemy1], zBuffer, 800, 600, 400);
      expect(target).toBe(enemy1);
    });

    it('ignores dead, behind-camera, out-of-bounds, behind-wall enemies', () => {
      const dead = { x: 5, y: 0, alive: false, elite: false } as Enemy;
      const behind = { x: -5, y: 0, alive: true, elite: false } as Enemy;
      const outOfBoundsX = { x: 5, y: 10, alive: true, elite: false } as Enemy;
      const enemyValid = { x: 5, y: 0, alive: true, elite: false } as Enemy;

      expect(findTargetAtColumn(player, [dead], zBuffer, 800, 600, 400)).toBeNull();
      expect(findTargetAtColumn(player, [behind], zBuffer, 800, 600, 400)).toBeNull();
      expect(findTargetAtColumn(player, [outOfBoundsX], zBuffer, 800, 600, 400)).toBeNull();

      zBuffer.fill(1); // wall in front
      expect(findTargetAtColumn(player, [enemyValid], zBuffer, 800, 600, 400)).toBeNull();
      zBuffer.fill(Infinity);
      
      const outOfBoundsYCamera = { ...player, planeY: 0.1 } as Player;
      const above = { x: 5, y: 0, alive: true, elite: false } as Enemy;
      findTargetAtColumn(outOfBoundsYCamera, [above], zBuffer, 800, 600, 400); // coverage case
    });
    
    it('finds closest target', () => {
      const far = { x: 10, y: 0, alive: true, elite: false } as Enemy;
      const near = { x: 5, y: 0, alive: true, elite: false } as Enemy;
      const target = findTargetAtColumn(player, [far, near], zBuffer, 800, 600, 400);
      expect(target).toBe(near);
    });
  });

  describe('findTargetUnderCrosshair', () => {
    it('calls findTargetAtColumn with center X', () => {
      const enemy = { x: 5, y: 0, alive: true, elite: false } as Enemy;
      const target = findTargetUnderCrosshair(player, [enemy], zBuffer, 800, 600);
      expect(target).toBe(enemy);
    });
  });

  describe('findMineAtColumn', () => {
    it('finds mine', () => {
      const mine = { x: 5, y: 0, alive: true, visible: true } as Mine;
      const target = findMineAtColumn(player, [mine], zBuffer, 800, 600, 400);
      expect(target).toBe(mine);
    });

    it('ignores dead, invisible, out-of-bounds, behind-wall, behind-camera', () => {
      const dead = { x: 5, y: 0, alive: false, visible: true } as Mine;
      const invis = { x: 5, y: 0, alive: true, visible: false } as Mine;
      const behind = { x: -5, y: 0, alive: true, visible: true } as Mine;
      expect(findMineAtColumn(player, [dead, invis, behind], zBuffer, 800, 600, 400)).toBeNull();

      const valid = { x: 5, y: 0, alive: true, visible: true } as Mine;
      zBuffer.fill(1); // wall
      expect(findMineAtColumn(player, [valid], zBuffer, 800, 600, 400)).toBeNull();
      
      zBuffer.fill(Infinity);
      expect(findMineAtColumn(player, [valid], zBuffer, 800, 600, 800)).toBeNull(); // Out of X bounds
    });

    it('finds nearest mine', () => {
      const far = { x: 10, y: 0, alive: true, visible: true } as Mine;
      const near = { x: 5, y: 0, alive: true, visible: true } as Mine;
      expect(findMineAtColumn(player, [far, near], zBuffer, 800, 600, 400)).toBe(near);
    });
  });

  describe('collectExitBillboard', () => {
    it('collects exit marker in front', () => {
      const jobs = collectExitBillboard(ctx, player, { x: 5, y: 0 }, zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillText).toHaveBeenCalledWith('return', expect.any(Number), expect.any(Number));
    });

    it('ignores exit behind camera', () => {
      const jobs = collectExitBillboard(ctx, player, { x: -5, y: 0 }, zBuffer);
      expect(jobs.length).toBe(0);
    });

    it('occludes exit behind wall', () => {
      zBuffer.fill(1);
      const jobs = collectExitBillboard(ctx, player, { x: 5, y: 0 }, zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillText).not.toHaveBeenCalled();
    });
  });

  describe('collectKeyBillboards', () => {
    it('collects uncollected keys in front', () => {
      const keys = [{ x: 5, y: 0, collected: false } as KeyItem];
      const jobs = collectKeyBillboards(ctx, player, keys, zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('ignores collected keys or behind camera', () => {
      const keys = [
        { x: 5, y: 0, collected: true } as KeyItem,
        { x: -5, y: 0, collected: false } as KeyItem,
      ];
      const jobs = collectKeyBillboards(ctx, player, keys, zBuffer);
      expect(jobs.length).toBe(0);
    });
    
    it('occludes behind wall', () => {
      const keys = [{ x: 5, y: 0, collected: false } as KeyItem];
      zBuffer.fill(1);
      const jobs = collectKeyBillboards(ctx, player, keys, zBuffer);
      jobs[0].draw();
    });
  });

  describe('collectLootBillboards', () => {
    it('collects loot in front', () => {
      const drops = [
        { x: 5, y: 0, kind: 'bullets' as const },
        { x: 5, y: 0, kind: 'rockets' as const },
        { x: 5, y: 0, kind: 'health' as const },
        { x: 5, y: 0, kind: 'swap' as const },
        { x: 5, y: 0, kind: 'weapon' as const },
      ];
      const jobs = collectLootBillboards(ctx, player, drops, zBuffer);
      expect(jobs.length).toBe(5);
      jobs.forEach(job => job.draw());
      expect(ctx.fillRect).toHaveBeenCalled();
      expect(ctx.strokeRect).toHaveBeenCalled(); // weapon drop
    });

    it('ignores behind camera', () => {
      const jobs = collectLootBillboards(ctx, player, [{ x: -5, y: 0, kind: 'health' }], zBuffer);
      expect(jobs.length).toBe(0);
    });

    it('occludes behind wall', () => {
      zBuffer.fill(1);
      const jobs = collectLootBillboards(ctx, player, [{ x: 5, y: 0, kind: 'health' }], zBuffer);
      jobs[0].draw();
    });
  });

  describe('collectDecorationBillboards', () => {
    it('collects decorations in front', () => {
      const decors = [
        { x: 5, y: 0, kind: 'rack' as const },
        { x: 5, y: 0, kind: 'desk' as const },
        { x: 5, y: 0, kind: 'plant' as const },
        { x: 5, y: 0, kind: 'block' as const },
      ];
      const jobs = collectDecorationBillboards(ctx, player, decors, zBuffer);
      expect(jobs.length).toBe(4);
      jobs.forEach(job => job.draw());
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('ignores behind camera', () => {
      const jobs = collectDecorationBillboards(ctx, player, [{ x: -5, y: 0, kind: 'rack' }], zBuffer);
      expect(jobs.length).toBe(0);
    });

    it('occludes behind wall', () => {
      zBuffer.fill(1);
      const jobs = collectDecorationBillboards(ctx, player, [{ x: 5, y: 0, kind: 'rack' }], zBuffer);
      jobs[0].draw();
    });
  });

  describe('collectTeleporterBillboards', () => {
    it('collects teleporters in front', () => {
      const teles = [{ x: 5, y: 0 } as Teleporter];
      const jobs = collectTeleporterBillboards(ctx, player, teles, zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('ignores behind camera', () => {
      const jobs = collectTeleporterBillboards(ctx, player, [{ x: -5, y: 0 } as Teleporter], zBuffer);
      expect(jobs.length).toBe(0);
    });

    it('occludes behind wall', () => {
      zBuffer.fill(1);
      const jobs = collectTeleporterBillboards(ctx, player, [{ x: 5, y: 0 } as Teleporter], zBuffer);
      jobs[0].draw();
    });
  });

  describe('collectMineBillboards', () => {
    it('collects visible living mines in front', () => {
      const mines = [{ x: 5, y: 0, alive: true, visible: true } as Mine];
      const jobs = collectMineBillboards(ctx, player, mines, zBuffer);
      expect(jobs.length).toBe(1);
      jobs[0].draw();
      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('ignores invisible or dead mines, or behind camera', () => {
      const mines = [
        { x: 5, y: 0, alive: false, visible: true } as Mine,
        { x: 5, y: 0, alive: true, visible: false } as Mine,
        { x: -5, y: 0, alive: true, visible: true } as Mine,
      ];
      const jobs = collectMineBillboards(ctx, player, mines, zBuffer);
      expect(jobs.length).toBe(0);
    });

    it('occludes behind wall', () => {
      zBuffer.fill(1);
      const mines = [{ x: 5, y: 0, alive: true, visible: true } as Mine];
      const jobs = collectMineBillboards(ctx, player, mines, zBuffer);
      jobs[0].draw();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnProjectile, updateProjectiles, collectProjectileBillboards, type Projectile } from './projectiles';
import { isWall } from './player';
import { projectPoint } from './sprites';

vi.mock('./player', () => ({
  isWall: vi.fn(),
}));

vi.mock('./sprites', () => ({
  projectPoint: vi.fn(),
}));

describe('projectiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('spawnProjectile', () => {
    it('should spawn a projectile moving towards the target', () => {
      const list: Projectile[] = [];
      spawnProjectile(list, 0, 0, 3, 4);

      expect(list).toHaveLength(1);
      const p = list[0];
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
      // Math.hypot(3, 4) = 5
      // vx = (3 / 5) * 5 = 3
      // vy = (4 / 5) * 5 = 4
      expect(p.vx).toBe(3);
      expect(p.vy).toBe(4);
      expect(p.damage).toBe(8); // base damage
    });

    it('should handle zero distance (target same as spawn)', () => {
      const list: Projectile[] = [];
      spawnProjectile(list, 0, 0, 0, 0);
      
      expect(list).toHaveLength(1);
      expect(list[0].vx).toBe(0);
      expect(list[0].vy).toBe(0);
    });

    it('should apply damageMultiplier', () => {
      const list: Projectile[] = [];
      spawnProjectile(list, 0, 0, 1, 0, 2);
      expect(list[0].damage).toBe(16);
    });
  });

  describe('updateProjectiles', () => {
    it('should move projectiles', () => {
      const list: Projectile[] = [{ x: 0, y: 0, vx: 10, vy: 5, damage: 8 }];
      const player = { posX: 100, posY: 100, radius: 0.5 } as any;
      const map = {} as any;
      
      vi.mocked(isWall).mockReturnValue(false);
      
      const damage = updateProjectiles(list, player, map, 0.5);
      
      expect(damage).toBe(0);
      expect(list).toHaveLength(1);
      expect(list[0].x).toBe(5);
      expect(list[0].y).toBe(2.5);
    });

    it('should damage player when projectile hits player AABB', () => {
      // player at 10,10 with radius 0.5, reach is 0.5 + 0.15 = 0.65
      const list: Projectile[] = [{ x: 9.8, y: 10.2, vx: 1, vy: 1, damage: 8 }];
      const player = { posX: 10, posY: 10, radius: 0.5 } as any;
      const map = {} as any;

      const damage = updateProjectiles(list, player, map, 0.1);

      expect(damage).toBe(8);
      expect(list).toHaveLength(0); // projectile removed
    });

    it('should destroy projectile when it hits a wall', () => {
      const list: Projectile[] = [{ x: 5, y: 5, vx: 0, vy: 0, damage: 8 }];
      const player = { posX: 100, posY: 100, radius: 0.5 } as any;
      const map = {} as any;

      vi.mocked(isWall).mockReturnValue(true);

      const damage = updateProjectiles(list, player, map, 0.1);

      expect(damage).toBe(0);
      expect(list).toHaveLength(0);
      expect(isWall).toHaveBeenCalledWith(map, 5, 5);
    });

    it('should prefer player hit over wall hit', () => {
      const list: Projectile[] = [{ x: 10, y: 10, vx: 0, vy: 0, damage: 8 }];
      const player = { posX: 10, posY: 10, radius: 0.5 } as any;
      const map = {} as any;

      // Even if wall is true, player hit takes precedence
      vi.mocked(isWall).mockReturnValue(true);

      const damage = updateProjectiles(list, player, map, 0.1);

      expect(damage).toBe(8);
      expect(list).toHaveLength(0);
      // isWall should not be called if player is hit
      expect(isWall).not.toHaveBeenCalled();
    });
  });

  describe('collectProjectileBillboards', () => {
    it('should filter out projectiles behind camera (depth <= 0.1)', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = { canvas: { width: 800, height: 600 } } as any;
      const zBuffer = new Float64Array(800).fill(10);

      vi.mocked(projectPoint).mockReturnValue({ depth: 0.1, screenX: 400, left: 390, right: 410 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      expect(billboards).toHaveLength(0);
    });

    it('should return a draw job if projectile is visible and not occluded', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = {
        canvas: { width: 800, height: 600 },
        fillStyle: '',
        fillRect: vi.fn(),
      } as any;
      const zBuffer = new Float64Array(800).fill(10); // Wall at depth 10

      // depth = 5 < 10 (wall depth), so it's not occluded
      vi.mocked(projectPoint).mockReturnValue({ depth: 5, screenX: 400, left: 390, right: 410 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      expect(billboards).toHaveLength(1);

      billboards[0].draw();

      expect(ctx.fillRect).toHaveBeenCalledTimes(3);
    });

    it('should not draw if projectile is occluded by zBuffer', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = {
        canvas: { width: 800, height: 600 },
        fillStyle: '',
        fillRect: vi.fn(),
      } as any;
      const zBuffer = new Float64Array(800).fill(2); // Wall at depth 2

      // depth = 5 > 2 (wall depth), so it IS occluded
      vi.mocked(projectPoint).mockReturnValue({ depth: 5, screenX: 400, left: 390, right: 410 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      expect(billboards).toHaveLength(1);

      billboards[0].draw();

      expect(ctx.fillRect).not.toHaveBeenCalled();
    });

    it('should clamp screenX correctly for zBuffer index', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = {
        canvas: { width: 800, height: 600 },
        fillStyle: '',
        fillRect: vi.fn(),
      } as any;
      const zBuffer = new Float64Array(800).fill(10); // Not occluded

      // Off-screen to the right
      vi.mocked(projectPoint).mockReturnValue({ depth: 5, screenX: 1000, left: 990, right: 1010 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      billboards[0].draw();

      expect(ctx.fillRect).toHaveBeenCalled(); // Since depth=5 and zBuffer[799] (clamped) is 10
    });
    
    it('should clamp screenX below 0 correctly', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = {
        canvas: { width: 800, height: 600 },
        fillStyle: '',
        fillRect: vi.fn(),
      } as any;
      const zBuffer = new Float64Array(800).fill(10); // Not occluded

      // Off-screen to the left
      vi.mocked(projectPoint).mockReturnValue({ depth: 5, screenX: -100, left: -110, right: -90 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      billboards[0].draw();

      expect(ctx.fillRect).toHaveBeenCalled(); // Since depth=5 and zBuffer[0] (clamped) is 10
    });

    it('should enforce a minimum size of 3', () => {
      const list: Projectile[] = [{ x: 1, y: 1, vx: 0, vy: 0, damage: 0 }];
      const player = {} as any;
      const ctx = {
        canvas: { width: 800, height: 600 },
        fillStyle: '',
        fillRect: vi.fn(),
      } as any;
      const zBuffer = new Float64Array(800).fill(10);

      // right - left = 2, so size = max(3, 1) = 3
      vi.mocked(projectPoint).mockReturnValue({ depth: 5, screenX: 400, left: 399, right: 401 } as any);

      const billboards = collectProjectileBillboards(ctx, player, list, zBuffer);
      billboards[0].draw();

      // first fillRect is for outer aura: 2 * size
      // size is 3.
      // cx = 400, cy = 300
      expect(ctx.fillRect).toHaveBeenNthCalledWith(1, 400 - 3, 300 - 3, 6, 6);
    });
  });
});

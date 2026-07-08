// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateEnemies } from './enemyAi';
import type { GameMap, Enemy } from '../map/types';
import type { Player } from './player';
import type { Projectile } from './projectiles';
import * as projectiles from './projectiles';

vi.mock('./projectiles', () => ({
  spawnProjectile: vi.fn(),
}));

describe('enemyAi', () => {
  let map: GameMap;
  let player: Player;
  let projectilesList: Projectile[];
  let enemyTemplate: Enemy;

  beforeEach(() => {
    vi.clearAllMocks();

    map = {
      width: 20,
      height: 20,
      grid: Array(20).fill(0).map(() => Array(20).fill(0)), // 0 = floor
      spawn: { x: 1, y: 1 },
      doors: [], items: [], secrets: [], lore: [], hazards: []
    } as unknown as GameMap;

    for (let i = 0; i < 20; i++) {
      map.grid[0][i] = 1; map.grid[19][i] = 1;
      map.grid[i][0] = 1; map.grid[i][19] = 1;
    }

    player = {
      posX: 5.5, posY: 5.5,
      dirX: 1, dirY: 0,
      planeX: 0, planeY: 0.66,
      noClip: false, radius: 0.2,
      rotate: vi.fn(), moveForward: vi.fn(), strafe: vi.fn()
    } as unknown as Player;

    projectilesList = [];

    enemyTemplate = {
      alive: true, x: 10.5, y: 10.5,
      roamX: 10.5, roamY: 10.5,
      home: { x: 2, y: 2, w: 16, h: 16 },
      aggroed: false, attackCooldown: 0, fireCooldown: 0,
      elite: false, hp: 100, maxHp: 100, damageFlashTimer: 0
    };
  });

  const getRng = (val = 0.5) => () => val;

  describe('updateEnemies', () => {
    it('skips dead enemies and sums up damage for alive ones', () => {
      const dead = { ...enemyTemplate, alive: false };
      const alive = { ...enemyTemplate, aggroed: true, x: 5.5, y: 5.8, attackCooldown: 0 };
      const damage = updateEnemies([dead, alive], player, map, 0.1, projectilesList, getRng());
      expect(damage).toBe(10);
    });
  });

  describe('cooldown reduction', () => {
    it('decreases cooldowns but clamps them at 0', () => {
      const e = { ...enemyTemplate, attackCooldown: 0.05, fireCooldown: 0.05, x: 100, y: 100 };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(e.attackCooldown).toBe(0);
      expect(e.fireCooldown).toBe(0);
    });
  });

  describe('aggro logic', () => {
    it('aggroes when in radius (7.5 tiles) and clear line of sight', () => {
      const e = { ...enemyTemplate, x: 5.5, y: 10.5 }; // dist = 5
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(e.aggroed).toBe(true);
    });

    it('does not aggro if line of sight is blocked by a wall', () => {
      map.grid[8][5] = 1;
      const e = { ...enemyTemplate, x: 5.5, y: 10.5 };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(e.aggroed).toBe(false);
    });

    it('does not aggro if out of radius', () => {
      const e = { ...enemyTemplate, x: 5.5, y: 15.5 }; // dist = 10 > 7.5
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(e.aggroed).toBe(false);
    });

    it('remains aggroed if it was previously aggroed', () => {
      map.grid[8][5] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 15.5 };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(e.aggroed).toBe(true);
    });
  });

  describe('roam state', () => {
    beforeEach(() => {
      player.posX = -10.5;
      player.posY = -10.5;
    });

    it('picks a new target when arriving at current target', () => {
      const e = { ...enemyTemplate, x: 10.5, y: 10.5, roamX: 10.6, roamY: 10.6, home: { x: 2, y: 2, w: 2, h: 2 } };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng(0.1));
      expect(e.roamX).toBe(2.5);
      expect(e.roamY).toBe(2.5);
    });

    it('handles rooms with w/h <= 1 cleanly', () => {
      const e = { ...enemyTemplate, roamX: 10.5, roamY: 10.5, home: { x: 2, y: 2, w: 0, h: 0 } };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng(0.9));
      expect(e.roamX).toBe(2.5);
      expect(e.roamY).toBe(2.5);
    });

    it('moves toward the roam target without leaving home limits', () => {
      const e = { ...enemyTemplate, x: 10.5, y: 10.5, roamX: 15.5, roamY: 15.5 };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).toBeGreaterThan(10.5);
      expect(e.y).toBeGreaterThan(10.5);
    });

    it('picks a new roam target if it hits a bounding wall while walking', () => {
      map.grid[10][11] = 1; // Wall to the right
      const e = { ...enemyTemplate, x: 10.5, y: 10.5, roamX: 15.5, roamY: 10.5 };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.roamX).not.toBe(15.5);
    });

    it('respects home boundaries', () => {
      const e = { ...enemyTemplate, x: 2.5, y: 2.5, roamX: 0.5, roamY: 0.5, home: { x: 2, y: 2, w: 5, h: 5 } };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.roamX).not.toBe(0.5);
    });
  });

  describe('chase state: melee', () => {
    it('bites the player if in ATTACK_RADIUS and cooldown is 0', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 5.8, attackCooldown: 0 };
      const dmg = updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(dmg).toBe(10);
      expect(e.attackCooldown).toBe(0.8);
    });

    it('elite bite applies a multiplier', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 5.8, attackCooldown: 0, elite: true };
      const dmg = updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(dmg).toBe(20);
    });

    it('waits if in ATTACK_RADIUS but cooldown is > 0', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 5.8, attackCooldown: 0.5 };
      const dmg = updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(dmg).toBe(0);
      expect(e.attackCooldown).toBeCloseTo(0.4);
    });
  });

  describe('chase state: ranged', () => {
    it('shoots a projectile if within RANGED_RANGE, cooldown 0, with LOS', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 10.5, fireCooldown: 0 };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng(0.5));
      expect(projectiles.spawnProjectile).toHaveBeenCalledWith(projectilesList, 5.5, 10.5, 5.5, 5.5, 1);
      expect(e.fireCooldown).toBe(1.9); // FIRE_COOLDOWN_MIN (1.2) + 0.5 * (2.6 - 1.2)
    });

    it('elite shots deal multiplied damage', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 10.5, fireCooldown: 0, elite: true };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng(0.5));
      expect(projectiles.spawnProjectile).toHaveBeenCalledWith(projectilesList, 5.5, 10.5, 5.5, 5.5, 2);
    });

    it('does not shoot if line of sight is blocked', () => {
      map.grid[8][5] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 10.5, fireCooldown: 0 };
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(projectiles.spawnProjectile).not.toHaveBeenCalled();
    });

    it('does not shoot if out of range', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 15.5, fireCooldown: 0 }; // dist = 10 > 8
      updateEnemies([e], player, map, 0.1, projectilesList, getRng());
      expect(projectiles.spawnProjectile).not.toHaveBeenCalled();
    });
  });

  describe('chase state: movement & navigation', () => {
    it('moves directly toward the player if no waypoint needed', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 5.9, y: 5.9, fireCooldown: 10 };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).toBeLessThan(5.9);
      expect(e.y).toBeLessThan(5.9);
    });

    it('navigates around walls using the BFS distance field', () => {
      map.grid[5][6] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 8.5, y: 5.5, fireCooldown: 10 };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.y).not.toBe(5.5);
    });

    it('falls back to straight chasing if player is out of PATH_MARGIN reach', () => {
      const e = { ...enemyTemplate, aggroed: true, x: 16.5, y: 5.5, fireCooldown: 10 }; // Dist = 11
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).toBeLessThan(16.5);
    });

    it('falls back to straight chasing if player is trapped inside a solid wall', () => {
      player.posX = 1.5; player.posY = 1.5;
      map.grid[1][1] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 4.5, y: 1.5, fireCooldown: 10 };
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).toBeLessThan(4.5);
    });

    it('slides around wall obstacles utilizing STEER_OFFSETS', () => {
      map.grid[6][5] = 1; map.grid[6][4] = 1; map.grid[6][6] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 5.5, y: 7.5, fireCooldown: 10 };
      player.posX = 5.5; player.posY = -10.5; // Simulate extremely far player
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).not.toBe(5.5);
    });

    it('does not move if completely boxed in', () => {
      map.grid[11][10] = 1; map.grid[9][10] = 1; map.grid[10][11] = 1; map.grid[10][9] = 1;
      const e = { ...enemyTemplate, aggroed: true, x: 10.5, y: 10.5, fireCooldown: 10 };
      player.posX = 10.5; player.posY = -5.5; 
      updateEnemies([e], player, map, 1.0, projectilesList, getRng());
      expect(e.x).toBe(10.5);
      expect(e.y).toBe(10.5);
    });
  });
});

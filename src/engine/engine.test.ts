// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaycasterEngine } from './engine';
import { GameMap, Enemy, Projectile, Mine, Decoration } from '../map/types';

vi.mock('./audio', () => ({
  audio: new Proxy({}, { get: () => vi.fn() })
}));
vi.mock('./hud', () => new Proxy({}, { get: () => vi.fn() }));
vi.mock('./raycaster', () => new Proxy({}, { get: () => vi.fn() }));
vi.mock('./automap', () => new Proxy({}, { get: () => vi.fn() }));
vi.mock('./viewmodel', () => new Proxy({}, { get: () => vi.fn() }));
vi.mock('./effects', () => ({
  ...vi.importActual('./effects'),
  drawBulletTraces: vi.fn(), drawDamageFlash: vi.fn(),
  renderBlood: vi.fn(), renderExplosions: vi.fn(), spawnBlood: vi.fn(),
  spawnExplosion: vi.fn(), tickBulletTraces: vi.fn(), updateBlood: vi.fn(), updateExplosions: vi.fn()
}));
vi.mock('./enemyAi', () => ({ updateEnemies: vi.fn(() => 0) }));
vi.mock('./projectiles', () => ({ collectProjectileBillboards: vi.fn(() => []), updateProjectiles: vi.fn(() => 0) }));
vi.mock('./rockets', () => ({ collectRocketBillboards: vi.fn(() => []), rocketDamageAt: vi.fn(() => 0), spawnRocket: vi.fn(), updateRockets: vi.fn(() => []), ROCKET_BLAST_RADIUS: 2 }));
vi.mock('./traps', () => ({ detonateMine: vi.fn(() => 0), spikeDamage: vi.fn(() => 0), updateMines: vi.fn(() => 0) }));
vi.mock('./scoring', () => ({ computeScore: vi.fn(() => ({ total: 100 })), killPoints: vi.fn(() => 10) }));
vi.mock('./sprites', () => new Proxy({}, { get: () => vi.fn(() => []) }));
vi.mock('../prng', () => ({ mulberry32: () => () => 0.5, randomSeed: () => 123 }));

describe('RaycasterEngine Fuzzer', () => {
  it('fuzzes all methods', () => {
    const canvas = { width: 800, height: 600, getContext: () => ({ canvas: { width: 800, height: 600 } }) } as any;
    const map = {
      width: 10, height: 10, grid: Array(10).fill(Array(10).fill(0)),
      visited: Array(10).fill(Array(10).fill(false)),
      decorations: [], teleporters: [{ x: 1, y: 1, targetX: 2, targetY: 2, label: 'a' }], mines: [], keys: [{ x: 0, y: 0, collected: false }],
      ammoPickups: [{ x: 0, y: 0, collected: false, amount: 10, kind: 'bullets' }], exit: { x: 5, y: 5 }, enemies: [{ alive: true, x: 0, y: 0, hp: 10, maxHp: 10, entity: { name: 'Bug' }, home: { x: 0, y: 0, w: 10, h: 10 } }],
      loreTerminals: [{ x: 0, y: 0, text: 'Hello' }], spikeTraps: [], bonusLevel: false, shortestPathTiles: 10
    } as unknown as GameMap;

    let cheats = ['IDDQD', 'IDCLIP', 'IDKFA'];
    const input = {
      attach: vi.fn(), detach: vi.fn(), pollGamepad: vi.fn(),
      consumeFpsToggle: vi.fn().mockReturnValue(true),
      consumeCheat: vi.fn(() => cheats.pop() || null),
      consumeClick: vi.fn().mockReturnValue(true),
      consumeBlur: vi.fn().mockReturnValue(true),
      consumeEscape: vi.fn().mockReturnValue(true),
      consumeMapToggle: vi.fn().mockReturnValue(true),
      consumeInteract: vi.fn().mockReturnValue(true),
      consumeWeaponRequest: vi.fn().mockReturnValue(0),
      consumeWheelSteps: vi.fn().mockReturnValue(1),
      consumeMelee: vi.fn().mockReturnValue(true),
      isDown: vi.fn().mockReturnValue(true),
      gamepadForward: vi.fn().mockReturnValue(1),
      gamepadStrafe: vi.fn().mockReturnValue(1),
      gamepadTurn: vi.fn().mockReturnValue(1),
      consumeMouseDX: vi.fn().mockReturnValue(1),
      consumeFire: vi.fn().mockReturnValue(true),
      isFireHeld: vi.fn().mockReturnValue(true),
      captureSnapshot: vi.fn().mockReturnValue({}),
    };
    const engine = new RaycasterEngine(canvas, map, {}, undefined, undefined, undefined, 123, input);
    engine.start();
    
    // Fuzz many frames
    for (let i = 0; i < 100; i++) {
      engine.advance(0.16);
    }
    engine.stop();
    expect(engine).toBeDefined();
  });
});
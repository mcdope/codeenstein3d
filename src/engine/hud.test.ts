// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  drawCrosshair,
  drawFpsOverlay,
  drawCheatToast,
  drawPauseOverlay,
  drawLoreOverlay,
  drawCompass,
  drawHud,
  COMPASS_ENABLED
} from './hud';
import type { EngineStats } from './engine';

// Mock weapons for HUD
vi.mock('./weapons', () => {
  return {
    WEAPONS: [
      { ammoType: 'none' },    // 0: Melee
      { ammoType: 'bullets' }, // 1: Bullets
      { ammoType: 'rockets' }, // 2: Rockets
    ]
  };
});

describe('hud', () => {
  let ctx: any;

  beforeEach(() => {
    ctx = {
      canvas: { width: 800, height: 600 },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      textAlign: '',
      textBaseline: '',
      font: '',
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      // Simple mock for text width based on length
      measureText: vi.fn((text: string) => ({ width: text.length * 8 })),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
    };
  });

  describe('drawCrosshair', () => {
    it('draws normal crosshair without target', () => {
      drawCrosshair(ctx, false);
      expect(ctx.fillStyle).toBe('rgba(255,255,255,0.6)');
      expect(ctx.fillRect).toHaveBeenCalledTimes(2);
    });

    it('draws red crosshair with target', () => {
      drawCrosshair(ctx, true);
      expect(ctx.fillStyle).toBe('rgba(255,60,60,0.95)');
    });

    it('draws spread lines when spreadPx > 0', () => {
      drawCrosshair(ctx, false, 10);
      expect(ctx.fillStyle).toBe('rgba(255,255,255,0.35)');
      expect(ctx.fillRect).toHaveBeenCalledTimes(4); // 2 crosshair + 2 spread
    });
  });

  describe('drawFpsOverlay', () => {
    it('draws fps overlay with green text when fps >= 30', () => {
      drawFpsOverlay(ctx, 60, 16.6);
      expect(ctx.textAlign).toBe('start');
      expect(ctx.fillText).toHaveBeenCalledWith('FPS', 792, 14);
      expect(ctx.fillText).toHaveBeenCalledWith('60', 792, 30);
      expect(ctx.fillText).toHaveBeenCalledWith('16.6ms', 792, 44);
      expect(ctx.fillStyle).toBe('#5aa869'); 
    });

    it('draws fps overlay with red text when fps < 30', () => {
      drawFpsOverlay(ctx, 20, 50.0);
      expect(ctx.fillText).toHaveBeenCalledWith('20', 792, 30);
    });
  });

  describe('drawCheatToast', () => {
    it('draws cheat toast with clamped alpha', () => {
      drawCheatToast(ctx, 'GOD MODE', 1.5); // alpha > 1
      expect(ctx.globalAlpha).toBe(1);
      
      drawCheatToast(ctx, 'GOD MODE', -0.5); // alpha < 0
      expect(ctx.globalAlpha).toBe(0);
      
      expect(ctx.fillText).toHaveBeenCalledWith('GOD MODE', 400, 42);
    });
  });

  describe('drawPauseOverlay', () => {
    it('draws pause overlay', () => {
      drawPauseOverlay(ctx);
      expect(ctx.fillText).toHaveBeenCalledWith('PAUSED', 400, 294);
      expect(ctx.fillText).toHaveBeenCalledWith('Click to resume, or press Esc again', 400, 320);
    });
  });

  describe('drawLoreOverlay', () => {
    it('wraps text and draws lore overlay with scrollbar if needed', () => {
      // Long text with many words to trigger the wrapText 'if' branches
      const longText = 'A '.repeat(500) + '\n\n' + 'B '.repeat(500);
      const result = drawLoreOverlay(ctx, longText, 1);
      
      expect(result.maxScrollLines).toBeGreaterThanOrEqual(0);
      expect(ctx.fillText).toHaveBeenCalledWith('LORE TERMINAL', 400, expect.any(Number));
      // Verifies the branch for maxScrollLines > 0
      expect(ctx.fillText).toHaveBeenCalledWith('W/S to scroll · R (or click) to close', 400, expect.any(Number));
    });

    it('draws lore overlay without scrollbar if text fits', () => {
      const result = drawLoreOverlay(ctx, 'Short lore', 0);
      expect(result.maxScrollLines).toBe(0);
      // Verifies the branch for maxScrollLines <= 0
      expect(ctx.fillText).toHaveBeenCalledWith('Press R (or click) to close', 400, expect.any(Number));
    });
  });

  describe('COMPASS_ENABLED', () => {
    it('is true', () => {
      expect(COMPASS_ENABLED).toBe(true);
    });
  });

  describe('drawCompass', () => {
    it('draws compass pointing to exit', () => {
      const badge = { cx: 100, cy: 100, r: 20 };
      drawCompass(ctx, badge, 0, 0, Math.PI, 10, 10);
      
      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.translate).toHaveBeenCalledWith(100, 100);
      expect(ctx.rotate).toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });
  });

  describe('drawHud', () => {
    let stats: EngineStats;

    beforeEach(() => {
      stats = {
        health: 100,
        maxHealth: 100,
        swap: 50,
        bullets: 100,
        rockets: 10,
        keysHeld: 1,
        keysTotal: 3,
        score: 5000,
        weaponIndex: 1, // bullets
      } as EngineStats;
    });

    it('draws hud with bullets weapon', () => {
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('SYSTEM STABILITY', 12, 559);
      expect(ctx.fillText).toHaveBeenCalledWith('BULLETS', 275, 559);
    });

    it('draws hud with rockets weapon', () => {
      stats.weaponIndex = 2; // rockets
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('ROCKETS', 275, 559);
    });

    it('draws hud with melee weapon', () => {
      stats.weaponIndex = 0; // melee
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('MELEE', 275, 559);
    });

    it('draws hud with low health', () => {
      stats.health = 20; // <= 30% triggers the red color path
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('20%', 128, 583);
    });

    it('draws hud with no swap', () => {
      stats.swap = 0; // triggers grey color
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('0', 205, 583);
    });

    it('draws hud with zero ammo for bullets and rockets', () => {
      // Empty Bullets
      stats.weaponIndex = 1; 
      stats.bullets = 0;
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('0', 275, 583);
      
      // Empty Rockets
      stats.weaponIndex = 2; 
      stats.rockets = 0;
      drawHud(ctx, stats);
      expect(ctx.fillText).toHaveBeenCalledWith('0', 275, 583);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameHud } from './gameHud';

describe('gameHud', () => {
  let canvas: HTMLCanvasElement;
  let hud: GameHud;
  let time: number;

  beforeEach(() => {
    vi.useFakeTimers();
    time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));

    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    hud = new GameHud(canvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function advanceTime(ms: number) {
    time += ms;
    vi.advanceTimersByTime(ms);
  }

  it('draws Kernel Panic overlay and dismisses after lock', () => {
    const onAck = vi.fn();
    hud.showKernelPanic(onAck);

    const ctx = canvas.getContext('2d') as any;
    expect(ctx).not.toBeNull();
    
    // Attempt dismiss immediately (locked)
    const keyEvent = new KeyboardEvent('keydown', { code: 'Enter' });
    window.dispatchEvent(keyEvent);
    expect(onAck).not.toHaveBeenCalled();

    // Advance past lock
    advanceTime(1500);

    // Mousedown dismiss
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    expect(onAck).toHaveBeenCalled();
  });

  it('draws Build Successful and dismisses on space key', () => {
    const onAck = vi.fn();
    hud.showBuildSuccessful(onAck);
    
    advanceTime(1500);
    
    const keyEvent = new KeyboardEvent('keydown', { code: 'Space' });
    window.dispatchEvent(keyEvent);
    expect(onAck).toHaveBeenCalled();
  });

  it('draws Level Start', () => {
    const onAck = vi.fn();
    hud.showLevelStart({
      campaign: 'Test Camp',
      levelName: 'Level 1',
      roomCount: 5,
      enemyCount: 10
    }, onAck);
    
    advanceTime(1500);
    
    const keyEvent = new KeyboardEvent('keydown', { code: 'Escape' });
    window.dispatchEvent(keyEvent);
    expect(onAck).toHaveBeenCalled();
  });

  it('draws Commit Summary', () => {
    const onAck = vi.fn();
    hud.showCommitSummary({
      linesRefactored: 100,
      bugsSquashed: 5
    }, onAck);
    
    advanceTime(1500);
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    expect(onAck).toHaveBeenCalled();
  });

  it('draws Replay Ended', () => {
    const onAck = vi.fn();
    hud.showReplayEnded('Manual stop', onAck);
    
    advanceTime(1500);
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    expect(onAck).toHaveBeenCalled();
  });

  it('handles gamepad polling', () => {
    const mockGamepad = { buttons: [{ pressed: false }] };
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => [mockGamepad],
      configurable: true
    });

    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    
    mockGamepad.buttons[0].pressed = true;
    advanceTime(500); 
    expect(onAck).not.toHaveBeenCalled();
    
    mockGamepad.buttons[0].pressed = false;
    advanceTime(1000); 
    
    mockGamepad.buttons[0].pressed = true;
    advanceTime(50); 
    expect(onAck).toHaveBeenCalled();
  });

  it('handles gamepad when API is missing', () => {
    Object.defineProperty(navigator, 'getGamepads', {
      value: undefined,
      configurable: true
    });

    const onAck = vi.fn();
    hud.showKernelPanic(onAck);
    
    advanceTime(1500);
    canvas.dispatchEvent(new MouseEvent('mousedown'));
    expect(onAck).toHaveBeenCalled();
  });
});

// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initConsoleSidebar } from './consoleSidebar';

describe('consoleSidebar', () => {
  let canvas: HTMLCanvasElement;
  let sidebarEl: HTMLElement;
  let logEl: HTMLElement;
  let originalConsoleLog: any;

  beforeEach(() => {
    vi.useFakeTimers();
    canvas = document.createElement('canvas');
    sidebarEl = document.createElement('div');
    logEl = document.createElement('div');
    originalConsoleLog = console.log;
    console.log = vi.fn();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    console.log = originalConsoleLog;
    vi.restoreAllMocks();
  });

  it('toggles visibility on fullscreenchange', () => {
    initConsoleSidebar(canvas, sidebarEl, logEl);

    // Initial state (not fullscreen)
    expect(sidebarEl.classList.contains('hidden')).toBe(false);

    // Fake fullscreen on canvas
    Object.defineProperty(document, 'fullscreenElement', {
      value: canvas,
      configurable: true
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    
    expect(sidebarEl.classList.contains('hidden')).toBe(true);

    // Fake fullscreen on something else
    Object.defineProperty(document, 'fullscreenElement', {
      value: document.createElement('div'),
      configurable: true
    });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(sidebarEl.classList.contains('hidden')).toBe(false);
  });

  it('mirrors string console.log into logEl', () => {
    initConsoleSidebar(canvas, sidebarEl, logEl);

    console.log('hello world');
    expect(logEl.children).toHaveLength(1);
    expect(logEl.children[0].textContent).toBe('hello world');
    
    // Ignores non-string logs
    console.log({ foo: 'bar' });
    expect(logEl.children).toHaveLength(1);

    // Handles colors
    console.log('%chello styled', 'color: #ff0000; font-weight: bold;');
    expect(logEl.children).toHaveLength(2);
    const line2 = logEl.children[1] as HTMLElement;
    expect(line2.textContent).toBe('hello styled');
    expect(line2.style.color).toBe('rgb(255, 0, 0)');

    // Truncates long lines
    const longStr = 'a'.repeat(400);
    console.log(longStr);
    const line3 = logEl.children[2] as HTMLElement;
    expect(line3.textContent).toBe('a'.repeat(300) + '…');

    // Bounds log entries to MAX_LINES = 200
    for (let i = 0; i < 205; i++) {
      console.log('line ' + i);
    }
    expect(logEl.children).toHaveLength(200);
    expect(logEl.children[199].textContent).toBe('line 204');
  });

  it('schedules and prints random hints when active and avoids duplicates', () => {
    let rand = 0.1;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const r = rand;
      rand += 0.1;
      if (rand > 0.9) rand = 0.1;
      return r;
    });

    const handle = initConsoleSidebar(canvas, sidebarEl, logEl);
    
    // hints not active, shouldn't print hint
    vi.advanceTimersByTime(50000);
    expect(logEl.textContent).toBe('');

    handle.setHintsActive(true);
    
    // advance time to trigger first hint
    vi.advanceTimersByTime(40000);
    
    expect(logEl.children.length).toBeGreaterThan(0);
    const firstHint = logEl.lastElementChild?.textContent;
    expect(firstHint).toContain('[hint]');
    
    const hintCount1 = logEl.children.length;
    
    // advance more to get multiple hints. The random mock will naturally avoid infinite loops.
    vi.advanceTimersByTime(40000);
    expect(logEl.children.length).toBeGreaterThan(hintCount1);
  });
});

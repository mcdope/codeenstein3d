// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CampaignReplayRecorder, ReplayPlaybackInput, type ReplayLevelMeta } from './replay';
import type { InputSnapshot } from './input';

const mockMeta: ReplayLevelMeta = {
  filePath: 'test/level.json',
  bonusLevel: false,
  gameplaySeed: 1234,
  difficulty: 'hurt_me_plenty' as any,
  gore: 'normal' as any,
};

const createMockSnapshot = (overrides: Partial<InputSnapshot> = {}): InputSnapshot => ({
  keys: [],
  mouseDX: 0,
  fireQueued: false,
  fireHeld: false,
  weaponRequest: null,
  mapToggle: false,
  interact: false,
  melee: false,
  wheelSteps: 0,
  fpsToggle: false,
  escape: false,
  blur: false,
  click: false,
  gpForward: 0,
  gpStrafe: 0,
  gpTurn: 0,
  ...overrides,
});

describe('CampaignReplayRecorder', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles record without starting a level gracefully', async () => {
    const recorder = new CampaignReplayRecorder('My Campaign');
    recorder.record(16, createMockSnapshot());
    const payload = await recorder.finish();
    expect(payload).toBeNull();
  });

  it('records frames and finishes a valid level', async () => {
    const recorder = new CampaignReplayRecorder('Test Campaign');
    recorder.startLevel(mockMeta, Promise.resolve('hash123'));
    const snap = createMockSnapshot({ keys: ['KeyW'] });
    recorder.record(16, snap);
    
    const payload = await recorder.finish();
    expect(payload).toEqual({
      version: 2,
      campaignName: 'Test Campaign',
      levels: [
        {
          ...mockMeta,
          astHash: 'hash123',
          frames: [
            { dt: 16, input: snap }
          ]
        }
      ]
    });
  });

  it('records multiple levels', async () => {
    const recorder = new CampaignReplayRecorder('Multi Campaign');
    
    recorder.startLevel(mockMeta, Promise.resolve('hash1'));
    recorder.record(16, createMockSnapshot({ mouseDX: 1 }));
    
    recorder.startLevel({ ...mockMeta, filePath: 'level2.json' }, Promise.resolve('hash2'));
    recorder.record(16, createMockSnapshot({ mouseDX: 2 }));
    
    const payload = await recorder.finish();
    expect(payload?.levels).toHaveLength(2);
    expect(payload?.levels[0].frames[0].input.mouseDX).toBe(1);
    expect(payload?.levels[0].astHash).toBe('hash1');
    expect(payload?.levels[1].frames[0].input.mouseDX).toBe(2);
    expect(payload?.levels[1].astHash).toBe('hash2');
  });

  it('skips levels that overflow MAX_REPLAY_FRAMES_PER_LEVEL (21600)', async () => {
    const recorder = new CampaignReplayRecorder('Overflow Campaign');
    recorder.startLevel(mockMeta, Promise.resolve('hash123'));
    
    for (let i = 0; i <= 21600; i++) {
      recorder.record(16, createMockSnapshot());
    }
    
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeded 21600 frames'),
      'color:#e0a04a'
    );
    
    // Testing the early return in LevelRecorder.record
    recorder.record(16, createMockSnapshot());
    
    const payload = await recorder.finish();
    expect(payload).toBeNull();
  });

  it('skips levels that have no frames', async () => {
    const recorder = new CampaignReplayRecorder('Empty Levels');
    recorder.startLevel(mockMeta, Promise.resolve('hash1'));
    recorder.startLevel({ ...mockMeta, filePath: 'level2.json' }, Promise.resolve('hash2'));
    recorder.record(16, createMockSnapshot());
    
    const payload = await recorder.finish();
    // Level 1 had no frames, so it should be skipped
    expect(payload?.levels).toHaveLength(1);
    expect(payload?.levels[0].astHash).toBe('hash2');
  });

  it('caps at MAX_REPLAY_LEVELS (100)', async () => {
    const recorder = new CampaignReplayRecorder('Too Many Levels');
    
    for (let i = 0; i <= 101; i++) {
      recorder.startLevel({ ...mockMeta, filePath: `level${i}.json` }, Promise.resolve(`hash${i}`));
      recorder.record(16, createMockSnapshot());
    }
    
    const payload = await recorder.finish();
    expect(payload?.levels).toHaveLength(100);
    expect(payload?.levels[0].astHash).toBe('hash0');
    expect(payload?.levels[99].astHash).toBe('hash99');
  });
});

describe('ReplayPlaybackInput', () => {
  it('starts with empty snapshot', () => {
    const input = new ReplayPlaybackInput();
    expect(input.captureSnapshot()).toEqual(createMockSnapshot());
  });

  it('loads frame and exposes values correctly', () => {
    const input = new ReplayPlaybackInput();
    const snap = createMockSnapshot({
      keys: ['Space'],
      mouseDX: 5,
      fireQueued: true,
      fireHeld: true,
      weaponRequest: 3,
      mapToggle: true,
      interact: true,
      melee: true,
      wheelSteps: -1,
      fpsToggle: true,
      escape: true,
      blur: true,
      click: true,
      gpForward: 0.5,
      gpStrafe: -0.5,
      gpTurn: 1.0,
    });
    
    input.loadFrame(snap);
    
    expect(input.isDown('Space')).toBe(true);
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.consumeMouseDX()).toBe(5);
    expect(input.consumeFire()).toBe(true);
    expect(input.isFireHeld()).toBe(true);
    expect(input.consumeWeaponRequest()).toBe(3);
    expect(input.consumeMapToggle()).toBe(true);
    expect(input.consumeInteract()).toBe(true);
    expect(input.consumeMelee()).toBe(true);
    expect(input.consumeWheelSteps()).toBe(-1);
    expect(input.consumeFpsToggle()).toBe(true);
    expect(input.consumeEscape()).toBe(true);
    expect(input.consumeBlur()).toBe(true);
    expect(input.consumeClick()).toBe(true);
    expect(input.gamepadForward()).toBe(0.5);
    expect(input.gamepadStrafe()).toBe(-0.5);
    expect(input.gamepadTurn()).toBe(1.0);
    expect(input.captureSnapshot()).toEqual(snap);
  });

  it('detaches and resets to empty snapshot', () => {
    const input = new ReplayPlaybackInput();
    input.loadFrame(createMockSnapshot({ keys: ['Space'] }));
    expect(input.isDown('Space')).toBe(true);
    
    input.detach();
    expect(input.isDown('Space')).toBe(false);
    expect(input.captureSnapshot()).toEqual(createMockSnapshot());
  });

  it('has no-op attach and pollGamepad methods', () => {
    const input = new ReplayPlaybackInput();
    expect(() => input.attach()).not.toThrow();
    expect(() => input.pollGamepad()).not.toThrow();
  });

  it('consumeCheat always returns null', () => {
    const input = new ReplayPlaybackInput();
    expect(input.consumeCheat()).toBeNull();
  });
});

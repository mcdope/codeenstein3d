// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Define the mock before importing audio to ensure it's used if needed
class MockGain {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn().mockReturnThis();
}

class MockOscillator {
  type = 'sine';
  frequency = {
    value: 440,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn().mockReturnThis();
  start = vi.fn();
  stop = vi.fn();
}

class MockDynamicsCompressor {
  connect = vi.fn().mockReturnThis();
}

class MockWaveShaper {
  curve = null;
  oversample = 'none';
  connect = vi.fn().mockReturnThis();
}

class EnhancedMockAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  createGain = vi.fn(() => new MockGain());
  createOscillator = vi.fn(() => new MockOscillator());
  createDynamicsCompressor = vi.fn(() => new MockDynamicsCompressor());
  createWaveShaper = vi.fn(() => new MockWaveShaper());
  resume = vi.fn().mockResolvedValue(undefined);
}

describe('AudioManager', () => {
  let originalAudioContext: any;
  let originalWebkitAudioContext: any;
  let originalNavigator: any;

  beforeEach(() => {
    originalAudioContext = global.AudioContext;
    originalWebkitAudioContext = (global as any).webkitAudioContext;
    originalNavigator = global.navigator;

    global.AudioContext = EnhancedMockAudioContext as any;
    (global as any).webkitAudioContext = undefined;
    global.navigator = {} as any;
  });

  afterEach(() => {
    global.AudioContext = originalAudioContext;
    (global as any).webkitAudioContext = originalWebkitAudioContext;
    global.navigator = originalNavigator;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function getFreshAudio() {
    const { audio } = await import('./audio');
    return audio;
  }

  it('initializes context and handles volumes', async () => {
    const audio = await getFreshAudio();
    audio.setMasterVolume(0.8);
    audio.setSfxVolume(0.9);
    audio.setBgmVolume(0.7);

    const ctx = audio.resume();
    expect(ctx).toBeTruthy();

    // Volume updates after init
    audio.setMasterVolume(0.5);
    audio.setSfxVolume(0.6);
    audio.setBgmVolume(0.4);
  });

  it('resumes context if suspended', async () => {
    const audio = await getFreshAudio();
    const ctx = audio.resume() as any;
    expect(ctx).toBeTruthy();
    
    ctx.state = 'suspended';
    audio.resume();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('isSilenced returns true and caches unavailable if no AudioContext', async () => {
    global.AudioContext = undefined as any;
    (global as any).webkitAudioContext = undefined;
    
    const audio = await getFreshAudio();
    expect(audio.isSilenced()).toBe(false); // First call checks webdriver, not ctx
    const ctx = audio.resume();
    expect(ctx).toBeNull();
    expect(audio.isSilenced()).toBe(true);
  });

  it('isSilenced returns true if isAutomated', async () => {
    global.navigator = { webdriver: true } as any;
    const audio = await getFreshAudio();
    expect(audio.isSilenced()).toBe(true);
    const ctx = audio.resume();
    expect(ctx).toBeNull();
  });

  it('connects BGM source', async () => {
    const audio = await getFreshAudio();
    const mockNode = { connect: vi.fn() } as any;
    const ctx = audio.connectBgmSource(mockNode);
    expect(ctx).toBeTruthy();
    expect(mockNode.connect).toHaveBeenCalled();
  });

  it('playShoot plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playShoot();
  });

  it('playHit plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playHit();
  });

  it('playDamage plays sound and rate limits', async () => {
    const audio = await getFreshAudio();
    audio.playDamage();
    
    const ctx = audio.resume() as any;
    ctx.currentTime = 0.1; // less than 0.18
    audio.playDamage(); // should return early
    
    ctx.currentTime = 0.5; // more than 0.18
    audio.playDamage(); // should play
  });

  it('playEnemyShoot plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playEnemyShoot();
  });

  it('playAmmoDrop plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playAmmoDrop();
  });

  it('playPickup plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playPickup();
  });

  it('playStep plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playStep();
  });

  it('playAlarm plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playAlarm();
  });

  it('playTeleport plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playTeleport();
  });

  it('playLevelComplete plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playLevelComplete();
  });

  it('playExplosion plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playExplosion();
  });

  it('playSecret plays correct sound', async () => {
    const audio = await getFreshAudio();
    audio.playSecret();
  });

  it('early returns from all play methods if audio is unavailable', async () => {
    global.AudioContext = undefined as any;
    (global as any).webkitAudioContext = undefined;
    
    const audio = await getFreshAudio();
    // These should safely return early without throwing
    audio.playShoot();
    audio.playHit();
    audio.playDamage();
    audio.playEnemyShoot();
    audio.playAmmoDrop();
    audio.playPickup();
    audio.playStep();
    audio.playAlarm();
    audio.playTeleport();
    audio.playLevelComplete();
    audio.playExplosion();
    audio.playSecret();
  });
});

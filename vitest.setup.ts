import { vi } from 'vitest';
global.jest = vi as any;
import 'jest-canvas-mock';

// Mock Web Audio API
class MockAudioContext {
  destination = {};
  createGain() { return { gain: { value: 1 }, connect: vi.fn().mockImplementation((dest) => dest) }; }
  createOscillator() { return { type: 'sine', frequency: { value: 440 }, connect: vi.fn().mockImplementation((dest) => dest), start: vi.fn(), stop: vi.fn() }; }
  createBuffer() { return {}; }
  createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, connect: vi.fn().mockImplementation((dest) => dest), start: vi.fn(), stop: vi.fn(), onended: null }; }
  createBiquadFilter() { return { type: 'lowpass', frequency: { value: 1000 }, connect: vi.fn().mockImplementation((dest) => dest) }; }
  createDynamicsCompressor() { return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, reduction: 0, attack: { value: 0 }, release: { value: 0 }, connect: vi.fn().mockImplementation((dest) => dest) }; }
  createMediaElementSource() { return { connect: vi.fn().mockImplementation((dest) => dest), mediaElement: {} }; }
  suspend() { return Promise.resolve(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

global.AudioContext = MockAudioContext as any;
global.window.AudioContext = MockAudioContext as any;

// Mock showDirectoryPicker
global.window.showDirectoryPicker = vi.fn().mockResolvedValue({
  kind: 'directory',
  name: 'mock-dir',
  values: () => [],
});

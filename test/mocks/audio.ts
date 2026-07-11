// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Hand-rolled Web Audio API test double, covering exactly the surface
 * `src/engine/audio.ts`/`src/engine/bgm.ts` call (confirmed via grep):
 * oscillator/gain/biquad-filter/buffer-source/dynamics-compressor/wave-shaper/
 * media-element-source nodes, each with `connect`/`disconnect`/`start`/`stop`
 * as `vi.fn()`s and `AudioParam`-shaped fields (`value` +
 * `setValueAtTime`/`linearRampToValueAtTime`/`exponentialRampToValueAtTime`).
 *
 * `audio.ts` already has a graceful "no AudioContext global" no-op path (see
 * its `audioContextCtor()`) — tests exercise both branches: the default
 * (no global stubbed) covers the no-op path, and
 * `vi.stubGlobal("AudioContext", MockAudioContext)` covers real synthesis.
 */
import { vi } from "vitest";

function mockAudioParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

function mockAudioNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function mockSourceNode() {
  return {
    ...mockAudioNode(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export class MockAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  state: AudioContextState = "running";
  destination = mockAudioNode();

  resume = vi.fn(async () => {
    this.state = "running";
  });

  createOscillator = vi.fn(() => ({
    ...mockSourceNode(),
    type: "sine" as OscillatorType,
    frequency: mockAudioParam(440),
  }));

  createGain = vi.fn(() => ({
    ...mockAudioNode(),
    gain: mockAudioParam(1),
  }));

  createBiquadFilter = vi.fn(() => ({
    ...mockAudioNode(),
    type: "lowpass" as BiquadFilterType,
    frequency: mockAudioParam(350),
    Q: mockAudioParam(1),
    gain: mockAudioParam(0),
  }));

  createBuffer = vi.fn((numberOfChannels: number, length: number, sampleRate: number) => ({
    numberOfChannels,
    length,
    sampleRate,
    getChannelData: vi.fn(() => new Float32Array(length)),
  }));

  createBufferSource = vi.fn(() => ({
    ...mockSourceNode(),
    buffer: null as unknown,
    loop: false,
  }));

  createDynamicsCompressor = vi.fn(() => ({
    ...mockAudioNode(),
    threshold: mockAudioParam(-24),
    knee: mockAudioParam(30),
    ratio: mockAudioParam(12),
    attack: mockAudioParam(0.003),
    release: mockAudioParam(0.25),
  }));

  createWaveShaper = vi.fn(() => ({
    ...mockAudioNode(),
    curve: null as Float32Array | null,
    oversample: "none" as OverSampleType,
  }));

  createMediaElementSource = vi.fn((_element: HTMLMediaElement) => mockAudioNode());
}

/** Registers `MockAudioContext` as the global `AudioContext`; returns a
 * restore function. */
export function stubAudioContext(): () => void {
  vi.stubGlobal("AudioContext", MockAudioContext);
  return () => vi.unstubAllGlobals();
}

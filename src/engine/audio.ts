// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Procedural retro audio, synthesized entirely with the Web Audio API — no
 * `<audio>` tags and no external sound files. Every effect is built from
 * oscillators, a noise buffer, gain envelopes, and a distortion curve.
 *
 * `audio` is a lazily-initialized singleton: the `AudioContext` is created on
 * the first sound (so we respect the browser autoplay policy, which only lets
 * audio start after a user gesture — firing, entering a level, etc.) and every
 * play call resumes it if the browser suspended it. When no `AudioContext` is
 * available (e.g. a non-browser test runner) every method is a safe no-op —
 * likewise when the page is running under browser automation (see
 * `isSilenced`), so unit/functional tests and Claude-driven verification runs
 * never make actual noise even in a real (or headless) Chromium.
 *
 * Every procedural effect routes through an SFX bus, and a custom BGM track
 * (see `src/engine/bgm.ts`) routes through a separate BGM bus — both feed a
 * shared master gain and a compressor, so several simultaneous hits (a
 * shotgun blast, say) can't clip, and the Master/SFX/BGM sidebar sliders can
 * balance the two independently (see `setMasterVolume`/`setSfxVolume`/
 * `setBgmVolume`).
 */

/** Grab whatever AudioContext constructor the environment exposes, if any. */
type AudioContextCtor = new () => AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** True when the page is running under browser automation — Playwright,
 * Puppeteer, and Selenium all set `navigator.webdriver` on the browser they
 * control, so this needs no cooperation from the harness/caller. */
function isAutomated(): boolean {
  const nav = (globalThis as unknown as { navigator?: { webdriver?: boolean } }).navigator;
  return nav?.webdriver === true;
}

/** Default gain values for the three user-facing volume sliders (see
 * `setMasterVolume`/`setSfxVolume`/`setBgmVolume`), applied at context
 * creation before any saved preference (see main.ts) overrides them. BGM
 * defaults quieter than SFX so a freshly-picked custom track doesn't drown
 * out the game's own sound effects before the player ever touches a slider. */
const DEFAULT_MASTER_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;
const DEFAULT_BGM_VOLUME = 0.5;

class AudioManager {
  private ctx: AudioContext | null = null;
  /** Final bus before the compressor/destination — both `sfx` and `bgm`
   * route through this, so the Master slider scales everything at once. */
  private master: GainNode | null = null;
  /** Bus every procedural sound effect (`playShoot`, `playHit`, …) connects
   * to, independent of `bgm` — see `setSfxVolume`. */
  private sfx: GainNode | null = null;
  /** Bus a custom BGM source connects to via `connectBgmSource` — kept
   * separate from `sfx` so the two volumes can be balanced independently
   * (custom music doesn't overpower in-game sound effects, or vice versa). */
  private bgm: GainNode | null = null;
  private distortion: WaveShaperNode | null = null;
  /** Cached white-noise buffer backing `playRocketExplosion`'s crack transient — built once since its content (raw random samples) never needs to vary between explosions. */
  private explosionNoise: AudioBuffer | null = null;
  private unavailable = false;
  /** Timestamp of the last damage sound, to rate-limit continuous hazards. */
  private lastDamageAt = -Infinity;

  /** Pending volumes (0-1), applied to their gain node immediately if the
   * context already exists, or at creation time otherwise — see `resume()`
   * and the three `setXVolume` methods below. */
  private masterVolume = DEFAULT_MASTER_VOLUME;
  private sfxVolume = DEFAULT_SFX_VOLUME;
  private bgmVolume = DEFAULT_BGM_VOLUME;

  /**
   * Ensure the context exists and is running; returns it, or `null` when audio
   * is unavailable. Safe to call from a user-gesture handler to warm it up.
   */
  resume(): AudioContext | null {
    if (this.isSilenced()) return null;
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) {
        this.unavailable = true;
        return null;
      }
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.masterVolume;
      const sfx = ctx.createGain();
      sfx.gain.value = this.sfxVolume;
      const bgm = ctx.createGain();
      bgm.gain.value = this.bgmVolume;
      sfx.connect(master);
      bgm.connect(master);
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.sfx = sfx;
      this.bgm = bgm;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** True if playback is suppressed — no `AudioContext` exists, or the page
   * is running under browser automation (see `isAutomated`), so automated or
   * Claude-driven runs stay silent. Also used by `bgm.ts` to gate its raw
   * `<audio>` element playback, which doesn't go through `resume()`'s guard. */
  isSilenced(): boolean {
    if (this.unavailable) return true;
    if (isAutomated()) {
      this.unavailable = true;
      return true;
    }
    return false;
  }

  /** Overall volume (0-1), scaling both SFX and BGM. */
  setMasterVolume(volume: number): void {
    this.masterVolume = clamp01(volume);
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  /** Volume (0-1) of every procedural sound effect. */
  setSfxVolume(volume: number): void {
    this.sfxVolume = clamp01(volume);
    if (this.sfx) this.sfx.gain.value = this.sfxVolume;
  }

  /** Volume (0-1) of custom BGM played through `connectBgmSource`. */
  setBgmVolume(volume: number): void {
    this.bgmVolume = clamp01(volume);
    if (this.bgm) this.bgm.gain.value = this.bgmVolume;
  }

  /** Warm up the context (if needed) and route `node` (e.g. a custom BGM
   * player's `MediaElementAudioSourceNode`) into the BGM bus. Returns the
   * live `AudioContext` so the caller can build/connect further nodes of its
   * own against it, or `null` if audio is unavailable. */
  connectBgmSource(node: AudioNode): AudioContext | null {
    const ctx = this.resume();
    if (ctx && this.bgm) node.connect(this.bgm);
    return ctx;
  }

  /** Retro blaster: a square wave sweeping rapidly down from a high pitch. */
  playShoot(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);
    const gain = envelope(ctx, 0.5, 0.005, 0.14);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Enemy hit: a low, brief triangle-wave "thud". */
  playHit(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.11);
    const gain = envelope(ctx, 0.55, 0.004, 0.13);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  /**
   * Player took damage: a harsh, distorted sawtooth "system error" beep.
   * Rate-limited so continuous damage (standing in acid) buzzes rather than
   * machine-guns the effect.
   */
  playDamage(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    if (t - this.lastDamageAt < 0.18) return;
    this.lastDamageAt = t;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.linearRampToValueAtTime(150, t + 0.2);
    const gain = envelope(ctx, 0.5, 0.003, 0.22);
    osc.connect(this.distortionNode(ctx)).connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.24);
  }

  /** Enemy ranged shot: a buzzy descending sawtooth "zap", distinct from ours. */
  playEnemyShoot(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.14);
    const gain = envelope(ctx, 0.26, 0.004, 0.15);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  /** Ammo drop: a soft, low "plop" when a defeated enemy sheds a heap pickup. */
  playAmmoDrop(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(250, t + 0.09);
    const gain = envelope(ctx, 0.22, 0.004, 0.1);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /** Ammo pickup: a bright rising square-wave "power-up" blip. */
  playPickup(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(990, t + 0.08);
    const gain = envelope(ctx, 0.32, 0.004, 0.12);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Footstep: a very quiet, slightly pitch-varied low thump for each stride. */
  playStep(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const base = 95 + Math.random() * 30;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.05);
    const gain = envelope(ctx, 0.07, 0.003, 0.05);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  /** Low-health alarm: a short, high-pitched warning pip (one per beat). */
  playAlarm(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(1245, t);
    const gain = envelope(ctx, 0.28, 0.004, 0.12);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Goto teleporter warp: a quick sci-fi sweep, up then settling back down. */
  playTeleport(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(1100, t + 0.09);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.18);
    const gain = envelope(ctx, 0.35, 0.005, 0.2);
    osc.connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  /** Level cleared, advancing to the next file: a short rising arpeggio. */
  playLevelComplete(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const start = t + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.3, 0.004, 0.12);
      osc.connect(gain).connect(sfx);
      osc.start(start);
      osc.stop(start + 0.14);
    });
  }

  /** Proximity mine detonation (or one shot to disarm one): a low, distorted
   * booming thud — smaller and duller than a rocket's own boom, see
   * `playRocketExplosion`. */
  playExplosion(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.35);
    const gain = envelope(ctx, 0.65, 0.005, 0.4);
    osc.connect(this.distortionNode(ctx)).connect(gain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  /**
   * A rocket detonating: a bigger, punchier boom than the mine's own thud
   * (`playExplosion`) — a deep sub-bass sweep for the body of the blast, plus
   * a short filtered white-noise "crack" transient layered on top so the
   * initial impact reads as sharp, not just a rumble.
   */
  playRocketExplosion(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(75, t);
    osc.frequency.exponentialRampToValueAtTime(22, t + 0.5);
    const oscGain = envelope(ctx, 0.85, 0.004, 0.55);
    osc.connect(this.distortionNode(ctx)).connect(oscGain).connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.6);

    const noise = ctx.createBufferSource();
    noise.buffer = this.explosionNoiseBuffer(ctx);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(2200, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const noiseGain = envelope(ctx, 0.5, 0.002, 0.28);
    noise.connect(noiseFilter).connect(noiseGain).connect(this.sfx);
    noise.start(t);
    noise.stop(t + 0.32);
  }

  /** Shared white-noise buffer for `playRocketExplosion`'s crack transient (built once). */
  private explosionNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.explosionNoise) {
      const length = Math.floor(ctx.sampleRate * 0.35);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.explosionNoise = buffer;
    }
    return this.explosionNoise;
  }

  /** Secret wall opened, or a lore terminal read: a bright, mysterious rising
   * chime — distinct from the level-complete arpeggio and the pickup blip. */
  playSecret(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;
    const notes = [880, 1108.73, 1318.51]; // A5, C#6, E6
    notes.forEach((freq, i) => {
      const start = t + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.25, 0.006, 0.16);
      osc.connect(gain).connect(sfx);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  }

  /** Shared distortion shaper for the damage voice (built once). */
  private distortionNode(ctx: AudioContext): WaveShaperNode {
    if (!this.distortion) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = distortionCurve(60);
      shaper.oversample = "2x";
      this.distortion = shaper;
    }
    return this.distortion;
  }
}

/**
 * A gain node with a quick attack-then-decay envelope: ramps up to `peak` over
 * `attack` seconds, then exponentially back to silence by `attack + decay`.
 * Exponential ramps need a non-zero floor, hence the tiny 0.0001 anchors.
 */
function envelope(ctx: AudioContext, peak: number, attack: number, decay: number): GainNode {
  const t = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return gain;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Classic waveshaper distortion curve; higher `amount` = harsher clipping. */
function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/** Process-wide procedural audio singleton. */
export const audio = new AudioManager();

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
 * available (e.g. a non-browser test runner) every method is a safe no-op.
 *
 * All voices route through a shared master gain and a compressor so several
 * simultaneous hits (a shotgun blast, say) can't clip.
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

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private distortion: WaveShaperNode | null = null;
  private unavailable = false;
  /** Timestamp of the last damage sound, to rate-limit continuous hazards. */
  private lastDamageAt = -Infinity;

  /**
   * Ensure the context exists and is running; returns it, or `null` when audio
   * is unavailable. Safe to call from a user-gesture handler to warm it up.
   */
  resume(): AudioContext | null {
    if (this.unavailable) return null;
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) {
        this.unavailable = true;
        return null;
      }
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Retro blaster: a square wave sweeping rapidly down from a high pitch. */
  playShoot(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);
    const gain = envelope(ctx, 0.5, 0.005, 0.14);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Enemy hit: a low, brief triangle-wave "thud". */
  playHit(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.11);
    const gain = envelope(ctx, 0.55, 0.004, 0.13);
    osc.connect(gain).connect(this.master);
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
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    if (t - this.lastDamageAt < 0.18) return;
    this.lastDamageAt = t;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.linearRampToValueAtTime(150, t + 0.2);
    const gain = envelope(ctx, 0.5, 0.003, 0.22);
    osc.connect(this.distortionNode(ctx)).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.24);
  }

  /** Enemy ranged shot: a buzzy descending sawtooth "zap", distinct from ours. */
  playEnemyShoot(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.14);
    const gain = envelope(ctx, 0.26, 0.004, 0.15);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  /** Ammo drop: a soft, low "plop" when a defeated enemy sheds a heap pickup. */
  playAmmoDrop(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(250, t + 0.09);
    const gain = envelope(ctx, 0.22, 0.004, 0.1);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /** Ammo pickup: a bright rising square-wave "power-up" blip. */
  playPickup(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(990, t + 0.08);
    const gain = envelope(ctx, 0.32, 0.004, 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Footstep: a very quiet, slightly pitch-varied low thump for each stride. */
  playStep(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const base = 95 + Math.random() * 30;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.7, t + 0.05);
    const gain = envelope(ctx, 0.07, 0.003, 0.05);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  /** Low-health alarm: a short, high-pitched warning pip (one per beat). */
  playAlarm(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(1245, t);
    const gain = envelope(ctx, 0.28, 0.004, 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Goto teleporter warp: a quick sci-fi sweep, up then settling back down. */
  playTeleport(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(1100, t + 0.09);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.18);
    const gain = envelope(ctx, 0.35, 0.005, 0.2);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  /** Level cleared, advancing to the next file: a short rising arpeggio. */
  playLevelComplete(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const master = this.master;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const start = t + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.3, 0.004, 0.12);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + 0.14);
    });
  }

  /** Proximity mine detonation: a low, distorted booming thud. */
  playExplosion(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.35);
    const gain = envelope(ctx, 0.65, 0.005, 0.4);
    osc.connect(this.distortionNode(ctx)).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  /** Secret wall opened, or a lore terminal read: a bright, mysterious rising
   * chime — distinct from the level-complete arpeggio and the pickup blip. */
  playSecret(): void {
    const ctx = this.resume();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const master = this.master;
    const notes = [880, 1108.73, 1318.51]; // A5, C#6, E6
    notes.forEach((freq, i) => {
      const start = t + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.25, 0.006, 0.16);
      osc.connect(gain).connect(master);
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

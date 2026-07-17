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
 *
 * `playShoot(kind)` dispatches on a weapon's `WeaponViewKind` (the same tag
 * that already picks its viewmodel silhouette — see `weapons.ts`) to give
 * every weapon its own fire sound instead of one shared blip: a snappy tone
 * for the pistol, a noise-layered boom for the shotgun, a cheap flyweight
 * tick for gdb's full-auto burst, a rising launch whoosh for ghidra (distinct
 * from `playRocketExplosion`'s impact boom), a continuously-blended hiss for
 * Friday Hotfix's jet, an airy whoosh for the knife, and a revving buzz for
 * Toolchain. The three full-auto voices (gdb/Friday Hotfix/Toolchain) add a
 * small `Math.random()` pitch jitter per shot so a rapid burst doesn't sound
 * like an identical clone-stamped loop — cosmetic randomness only, per
 * `doc/dev/architecture.md`'s Determinism section (SFX pitch must never draw
 * from the seeded replay PRNG).
 */

import type { WeaponViewKind } from "./weapons";

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
  /** Cached distortion curve samples — see `distortionNode` for why the
   * `WaveShaperNode` itself is deliberately *not* cached here. */
  private distortionCurveCache: Float32Array<ArrayBuffer> | null = null;
  /** White-noise buffers backing every noise-based transient (rocket-blast
   * crack, shotgun blast, rocket launch chuff, flamethrower hiss, knife
   * whoosh), cached by duration (ms) since raw random samples never need to
   * vary between plays of the same length. */
  private noiseBuffers = new Map<number, AudioBuffer>();
  private unavailable = false;
  /** Timestamp of the last damage sound, to rate-limit continuous hazards. */
  private lastDamageAt = -Infinity;
  /** Total `playShoot` calls this session — a cheap proxy for total
   * oscillator/gain-node churn, read only by the `?perfDebug=1` profiler (see
   * `perfDebug.ts`) to rule out (or confirm) Web-Audio node buildup as a
   * source of the unreproduced magento2/"nightmare" shooting-framedrop
   * report. The increment itself is free enough to leave unconditional
   * rather than threading a debug flag through every call site. */
  private shotCount = 0;

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

  /** Diagnostics only — see `shotCount`'s doc comment. */
  getShotCount(): number {
    return this.shotCount;
  }

  /** Diagnostics only — the live `AudioContext.state` ("suspended" is the
   * common real-world surprise: a browser can silently re-suspend a context
   * that lost the page's audio focus, at which point every `playShoot` still
   * runs its full oscillator/envelope setup but never actually resumes
   * playback, see `resume()` above), or `"none"` before any sound has ever
   * played. */
  getContextState(): string {
    return this.ctx?.state ?? "none";
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

  /** Weapon fire, dispatched by `kind` (a weapon's `viewKind`, reused as its
   * sound identity — see this file's header comment) so each weapon has its
   * own distinct voice instead of one shared blip. */
  playShoot(kind: WeaponViewKind): void {
    this.shotCount += 1;
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const sfx = this.sfx;
    switch (kind) {
      case "pistol":
        return this.playPistolShot(ctx, sfx);
      case "shotgun":
        return this.playShotgunBlast(ctx, sfx);
      case "mp":
        return this.playSmgShot(ctx, sfx);
      case "rocket":
        return this.playRocketLaunch(ctx, sfx);
      case "flamethrower":
        return this.playFlameJet(ctx, sfx);
      case "knife":
        return this.playKnifeSwing(ctx, sfx);
      case "chainsaw":
        return this.playChainsawSwing(ctx, sfx);
    }
  }

  /** echo pistol: a square wave sweeping rapidly down from a high pitch — the
   * baseline "retro blaster" snap every other weapon's voice is built to
   * sound distinct from. */
  private playPistolShot(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);
    const gain = envelope(ctx, 0.5, 0.005, 0.14);
    osc.connect(gain).connect(sfx);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  /** Regex Shotgun: a heavier, distorted low thump plus a short filtered
   * noise burst layered on top, so it reads as a broadband blast rather than
   * the pistol's clean tone. */
  private playShotgunBlast(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.16);
    const oscGain = envelope(ctx, 0.7, 0.003, 0.18);
    osc.connect(this.distortionNode(ctx)).connect(oscGain).connect(sfx);
    osc.start(t);
    osc.stop(t + 0.2);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.12);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(3500, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(600, t + 0.1);
    const noiseGain = envelope(ctx, 0.4, 0.002, 0.09);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.11);
  }

  /** gdb: a short, cheap, low-pitched tick — fires up to ~11x/sec, so this
   * stays deliberately lightweight, with a small cosmetic pitch jitter per
   * shot so a sustained burst doesn't sound like a clone-stamped loop.
   * Tuned down from an initial higher-pitched draft per playtest feedback. */
  private playSmgShot(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    const jitter = 1 + (Math.random() * 2 - 1) * 0.06;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(340 * jitter, t);
    osc.frequency.exponentialRampToValueAtTime(160 * jitter, t + 0.04);
    const gain = envelope(ctx, 0.32, 0.002, 0.045);
    osc.connect(gain).connect(sfx);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** ghidra: the *launch*, distinct from `playRocketExplosion`'s impact boom
   * — a rising sweep plus a short noise "chuff" for the ignition puff,
   * instead of every other weapon's falling pitch. */
  private playRocketLaunch(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.22);
    const oscGain = envelope(ctx, 0.5, 0.02, 0.2);
    osc.connect(oscGain).connect(sfx);
    osc.start(t);
    osc.stop(t + 0.24);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.15);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(900, t);
    noiseFilter.Q.value = 0.7;
    const noiseGain = envelope(ctx, 0.35, 0.01, 0.13);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.15);
  }

  /** Friday Hotfix: re-triggered every 0.1s while held, so a low rumble plus
   * a filtered noise hiss are tuned with a soft attack and a cosmetic jitter
   * per call, so consecutive triggers blend into a continuous jet roar
   * instead of popping as discrete blips. */
  private playFlameJet(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    const jitter = 1 + (Math.random() * 2 - 1) * 0.15;

    const rumble = ctx.createOscillator();
    rumble.type = "sawtooth";
    rumble.frequency.setValueAtTime(70 * jitter, t);
    const rumbleGain = envelope(ctx, 0.22, 0.02, 0.09);
    rumble.connect(rumbleGain).connect(sfx);
    rumble.start(t);
    rumble.stop(t + 0.12);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.12);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(1500 * jitter, t);
    noiseFilter.Q.value = 0.6;
    const noiseGain = envelope(ctx, 0.4, 0.02, 0.09);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.12);
  }

  /** SIGKILL Knife: a fast, airy noise "whoosh" — no gunshot character at
   * all, and no low-end boom, since a stab isn't an explosion. */
  private playKnifeSwing(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.1);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(2600, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(900, t + 0.08);
    noiseFilter.Q.value = 1.2;
    const noiseGain = envelope(ctx, 0.3, 0.002, 0.07);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.09);
  }

  /** Toolchain: a gritty, distorted revving buzz with a quick up-then-down
   * pitch wobble (rather than every other weapon's plain downward sweep) so
   * repeated auto-fire triggers read as a sustained motor, not a discrete
   * blip each time. */
  private playChainsawSwing(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    const jitter = 1 + (Math.random() * 2 - 1) * 0.08;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90 * jitter, t);
    osc.frequency.linearRampToValueAtTime(130 * jitter, t + 0.05);
    osc.frequency.linearRampToValueAtTime(85 * jitter, t + 0.14);
    const gain = envelope(ctx, 0.55, 0.004, 0.14);
    osc.connect(this.distortionNode(ctx)).connect(gain).connect(sfx);
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
    noise.buffer = this.noiseBuffer(ctx, 0.35);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(2200, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const noiseGain = envelope(ctx, 0.5, 0.002, 0.28);
    noise.connect(noiseFilter).connect(noiseGain).connect(this.sfx);
    noise.start(t);
    noise.stop(t + 0.32);
  }

  /** Cached-by-duration white-noise buffer backing every noise-based
   * transient (rocket-blast crack, shotgun blast, rocket launch chuff,
   * flamethrower hiss, knife whoosh) — built once per distinct length since
   * raw random samples never need to vary between plays. */
  private noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const key = Math.round(seconds * 1000);
    let buffer = this.noiseBuffers.get(key);
    if (!buffer) {
      const length = Math.floor(ctx.sampleRate * seconds);
      buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffers.set(key, buffer);
    }
    return buffer;
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

  /** "Multi Kill" streak bonus (3 kills within a few seconds of each other —
   * see `RaycasterEngine.registerKillForStreak`): a bright, triumphant
   * rising arpeggio — smaller and shorter than `playUltraKill`'s own bigger
   * version, same "smaller vs. bigger" relationship as `playExplosion`/
   * `playRocketExplosion`. */
  playMultiKill(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;
    const notes = [659.25, 830.61, 987.77]; // E5, G#5, B5
    notes.forEach((freq, i) => {
      const start = t + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.35, 0.004, 0.14);
      osc.connect(gain).connect(sfx);
      osc.start(start);
      osc.stop(start + 0.16);
    });
  }

  /** "Ultra Kill" streak bonus (6 kills within a few seconds) — a bigger,
   * more dramatic version of `playMultiKill`: two more notes, a wider pitch
   * spread, longer per-note duration, plus a short filtered noise "sizzle"
   * layered under the arpeggio for extra punch (the same "bigger" treatment
   * `playRocketExplosion` gets over `playExplosion`). */
  playUltraKill(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;
    const notes = [659.25, 830.61, 987.77, 1174.66, 1318.51]; // E5, G#5, B5, D6, E6
    notes.forEach((freq, i) => {
      const start = t + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.5, 0.004, 0.2);
      osc.connect(gain).connect(sfx);
      osc.start(start);
      osc.stop(start + 0.22);
    });

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.15);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(1800, t);
    const noiseGain = envelope(ctx, 0.3, 0.002, 0.1);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.12);
  }

  /** A fresh distortion shaper per call — deliberately *not* a single cached
   * node reused across calls. `connect()` chaining (`osc.connect(shaper).connect(gain)`
   * at every call site) means a shared node would accumulate one permanent
   * `shaper → gain` edge per call, and since the shaper is referenced forever
   * by `this`, every one of those `gain` nodes (and everything upstream of
   * them) would be kept alive forever too — an unbounded Web Audio node leak
   * that crashed the tab within seconds of holding Toolchain's auto-fire
   * trigger. Only the expensive-to-generate curve samples are worth caching;
   * the node itself is as cheap as the `createOscillator`/`createGain` calls
   * already made fresh per shot everywhere else in this file. */
  private distortionNode(ctx: AudioContext): WaveShaperNode {
    if (!this.distortionCurveCache) {
      this.distortionCurveCache = distortionCurve(60);
    }
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.distortionCurveCache;
    shaper.oversample = "2x";
    return shaper;
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

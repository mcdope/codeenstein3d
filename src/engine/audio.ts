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
 * for the pistol, a noise-layered boom for the shotgun (with its pump-action
 * rack cycling in behind it), a cheap flyweight
 * tick for gdb's full-auto burst, a rising launch whoosh for ghidra (distinct
 * from `playRocketExplosion`'s impact boom), a continuously-blended hiss for
 * Friday Hotfix's jet, and an airy whoosh for the knife. The full-auto voices
 * (gdb/Friday Hotfix/Toolchain) add a small `Math.random()` pitch jitter per
 * shot so a rapid burst doesn't sound like an identical clone-stamped loop —
 * cosmetic randomness only, per `doc/dev/architecture.md`'s Determinism
 * section (SFX pitch must never draw from the seeded replay PRNG).
 *
 * **Toolchain is the one exception to "every sound is a bounded one-shot".**
 * It is the only *held* weapon, so it runs a real sustained motor —
 * `startChainsaw`/`revChainsaw`/`stopChainsaw`, driven by the engine's melee
 * path rather than scheduled entirely from here. `playShoot("chainsaw")`
 * therefore revs the running loop instead of synthesizing a fresh voice.
 *
 * `playReload(kind)` dispatches the same way, over the four weapons that
 * actually have a magazine, giving each a short scheduled sequence of
 * mechanical clacks (see `playClack`) instead of one shared click.
 */

import type { WeaponViewKind } from "./weapons";
import { clamp01 } from "../mathUtil";
import { isAutomated } from "../automation";

/** Grab whatever AudioContext constructor the environment exposes, if any. */
type AudioContextCtor = new () => AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}


/** Default gain values for the three user-facing volume sliders (see
 * `setMasterVolume`/`setSfxVolume`/`setBgmVolume`), applied at context
 * creation before any saved preference (see main.ts) overrides them. BGM
 * defaults quieter than SFX so a freshly-picked custom track doesn't drown
 * out the game's own sound effects before the player ever touches a slider. */
const DEFAULT_MASTER_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;
const DEFAULT_BGM_VOLUME = 0.5;

/**
 * The Toolchain motor — see `AudioManager.startChainsaw`.
 *
 * Both pitches sit in the same 50-350Hz mechanical register the `Clack` bodies
 * use, and the loaded pitch is close to where the old one-shot's peak was
 * (130Hz), so the weapon's voice is recognisably the same tool — it just no
 * longer stops between bites. The chug rates are what carry the two-stroke
 * character: slow and loping at idle, faster under load, the way a real saw
 * climbs when it bites into something.
 */
const CHAINSAW_IDLE_HZ = 55;
const CHAINSAW_LOAD_HZ = 130;
const CHAINSAW_IDLE_CHUG_HZ = 14;
const CHAINSAW_LOAD_CHUG_HZ = 23;
/** Quieter than a gunshot's 0.5-0.7 peak: this one is *sustained*, and a drone
 * at gunshot level would sit on top of every other cue for as long as the key
 * is held. */
const CHAINSAW_PEAK = 0.32;
/** Spin-down after the key is released — long enough to read as a motor
 * coasting rather than a switch being flipped. */
const CHAINSAW_RELEASE_SEC = 0.18;

/**
 * One scheduled mechanical "clack" — a struck-object body under a narrow
 * bandpassed noise click. See `AudioManager.playClack` for the recipe and
 * `playShotgunPump` for the argument behind it. All times are in seconds.
 */
interface Clack {
  /** Offset from the start of the sequence this clack belongs to. */
  at: number;
  /** Body pitch, swept `from` down to `to` — both in the 50-350Hz register
   * this project's mechanical sounds live in, never a bright chirp. */
  from: number;
  to: number;
  /** Body gain peak, kept well under the weapon's own shot so a sequence
   * reads as the mechanism working, not as more shots. */
  peak: number;
  /** Centre frequency of the bandpassed noise click over the body. */
  noiseHz: number;
  noisePeak: number;
  /** Optional shaping — heavier parts sweep further and ring longer. */
  sweep?: number;
  bodyDecay?: number;
  noiseDecay?: number;
  /** Bandpass Q; lower widens the click from a dry knock towards a scrape. */
  q?: number;
}

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
  /**
   * The running chainsaw motor, or `null` when it is not running.
   *
   * **The only sustained voice in this file.** Everything else here is a
   * bounded one-shot that schedules its own `stop()` and is never referenced
   * again — see this module's header. Toolchain needs the exception because it
   * is the one weapon that is *held*: firing a 0.16s blip once per 0.35s bite
   * left ~0.19s of silence between buzzes, which reads as a stuttering tool
   * rather than a running motor.
   *
   * Every node is retained so `stopChainsaw` can `disconnect()` all of them.
   * That is not tidiness — see `distortionNode`'s comment for the unbounded
   * node leak that crashed the tab the last time something held this trigger.
   * A single shaper for the lifetime of one loop is fine; a shaper that
   * outlives its loop, still wired to a dead gain, is the bug.
   */
  private chainsaw: {
    osc: OscillatorNode;
    detune: OscillatorNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    chug: GainNode;
    shaper: WaveShaperNode;
    gain: GainNode;
  } | null = null;
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
      // The only kind that does not synthesize a fresh voice per shot: the
      // motor is already running (see `startChainsaw`), so a bite leans on it
      // instead of layering another blip over the top.
      case "chainsaw":
        return this.revChainsaw();
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
   * the pistol's clean tone — followed by the pump cycling (see
   * `playShotgunPump`). */
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

    // Just as the noise tail (t+0.11) and the body (t+0.2) die away.
    this.playShotgunPump(ctx, sfx, t + 0.18);
  }

  /**
   * Regex Shotgun, the pump: a two-part "cha-CHUNK" — the rack hauled back,
   * then slammed forward again — filling the gap the weapon's 0.85s
   * pump-action `fireIntervalSec` (see `weapons.ts`) leaves after the blast.
   * Without it that cooldown reads as a dropped click; with it, as the gun
   * cycling. Everything is silent by ~0.42s after the shot, leaving ~0.43s of
   * "loaded and waiting" before the next one.
   *
   * It's scheduled from in here rather than exposed as its own `playShoot`
   * kind or triggered from `engine.ts`, for three reasons. This file's design
   * is "`viewKind` IS the sound identity" (see the header comment), and the
   * pump is part of the shotgun's voice, not a separate game event. Scheduling
   * off `ctx.currentTime` is sample-accurate, where an engine-driven trigger
   * would land on a frame boundary and audibly jitter at low FPS. And it
   * inherits `fire()`'s existing local/remote shooter gating for free.
   *
   * `triangle` bodies, since a square reads as a tone and a triangle as a
   * struck object, under a narrow bandpassed noise clack — a lowpass leaves
   * hiss, while 260-340Hz at Q 7 is a dry mechanical knock. Peaks stay at
   * 0.20-0.24 against the blast's 0.7 so it reads as mechanism, not as a
   * second shot.
   */
  private playShotgunPump(ctx: AudioContext, sfx: GainNode, at: number): void {
    // Rack back, then slam forward — the slam is the heavier, lower of the two.
    this.playClacks(ctx, sfx, at, [
      { at: 0, from: 110, to: 60, peak: 0.2, noiseHz: 340, noisePeak: 0.11 },
      { at: 0.16, from: 85, to: 48, peak: 0.24, noiseHz: 260, noisePeak: 0.13 },
    ]);
  }

  /**
   * One mechanical clack, scheduled at the absolute context time `start`: a
   * `triangle` body (a struck object, where a square would read as a tone)
   * swept downward, under a narrow bandpassed noise click (a lowpass would
   * leave hiss instead of a dry knock). The shared recipe behind
   * `playShotgunPump` and every `playReload` sequence — see the pump's doc
   * comment above for why these are scheduled off `ctx.currentTime` with
   * explicit offsets rather than triggered per frame from the engine.
   */
  private playClack(ctx: AudioContext, sfx: GainNode, start: number, clack: Clack): void {
    const sweep = clack.sweep ?? 0.04;
    const bodyDecay = clack.bodyDecay ?? 0.05;
    const noiseDecay = clack.noiseDecay ?? 0.03;

    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(clack.from, start);
    body.frequency.exponentialRampToValueAtTime(clack.to, start + sweep);
    const bodyGain = envelope(ctx, clack.peak, 0.001, bodyDecay, start);
    body.connect(bodyGain).connect(sfx);
    body.start(start);
    body.stop(start + bodyDecay + 0.03);

    // The same cached 0.12s buffer the shotgun blast already allocates,
    // windowed down to a click by the envelope and the early `stop`.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.12);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(clack.noiseHz, start);
    noiseFilter.Q.value = clack.q ?? 7;
    const noiseGain = envelope(ctx, clack.noisePeak, 0.001, noiseDecay, start);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(start);
    noise.stop(start + noiseDecay + 0.02);
  }

  /** A whole sequence of `playClack`s, each at its own `at` offset from `from`. */
  private playClacks(ctx: AudioContext, sfx: GainNode, from: number, clacks: Clack[]): void {
    for (const clack of clacks) this.playClack(ctx, sfx, from + clack.at, clack);
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

  /**
   * Start the Toolchain motor, if it is not already running.
   *
   * A two-stroke chainsaw is a low, dirty drone that is *amplitude*-modulated
   * by its own firing cycle — the chug is the reason it reads as a chainsaw
   * and not as a buzzing wasp, so it is the LFO here rather than the pitch
   * that does the characterising work. The build is:
   *
   * - two `sawtooth` oscillators an octave apart and slightly detuned, so the
   *   drone beats against itself instead of sitting dead still
   * - through the file's usual `distortionCurve(60)` shaper, the "gritty"
   *   idiom shared with the shotgun, explosions and the damage grunt
   * - into a gain whose level is swung by a ~14Hz sine — the chug
   * - into a master gain, ramped rather than enveloped
   *
   * `envelope()` is deliberately not used: it hard-schedules an exponential
   * decay to silence, which is exactly what a sustained voice must not do.
   *
   * Idempotent, so the engine can call it every frame the key is held.
   */
  startChainsaw(): void {
    if (this.chainsaw) return;
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(CHAINSAW_IDLE_HZ, t);
    const detune = ctx.createOscillator();
    detune.type = "sawtooth";
    detune.frequency.setValueAtTime(CHAINSAW_IDLE_HZ * 2.02, t);

    // The chug: a gain that never fully closes, so the motor keeps turning
    // over between strokes rather than cutting in and out.
    const chug = ctx.createGain();
    chug.gain.setValueAtTime(0.65, t);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(CHAINSAW_IDLE_CHUG_HZ, t);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.setValueAtTime(0.35, t);
    lfo.connect(lfoDepth).connect(chug.gain);

    const shaper = this.distortionNode(ctx);
    const gain = ctx.createGain();
    // Ramp in rather than snapping on, so starting the saw isn't a click.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(CHAINSAW_PEAK, t + 0.06);

    osc.connect(shaper);
    detune.connect(shaper);
    shaper.connect(chug).connect(gain).connect(this.sfx);
    osc.start(t);
    detune.start(t);
    lfo.start(t);
    this.chainsaw = { osc, detune, lfo, lfoDepth, chug, shaper, gain };
  }

  /**
   * Lean on the motor for one bite — pitch and chug rate both climb, then
   * settle back to idle.
   *
   * Called once per `fireIntervalSec` from the engine's melee path, so the
   * damage cadence still drives the sound even though the drone underneath it
   * is continuous. A no-op when the motor is not running, which is what makes
   * the `playShoot("chainsaw")` call site safe on the frame the key goes down.
   */
  revChainsaw(): void {
    const saw = this.chainsaw;
    if (!saw || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Cosmetic only, so `Math.random` rather than the seeded PRNG — see
    // architecture.md. Keeps consecutive bites from sounding clone-stamped.
    const jitter = 1 + (Math.random() * 2 - 1) * 0.06;
    for (const [node, base] of [
      [saw.osc, CHAINSAW_LOAD_HZ],
      [saw.detune, CHAINSAW_LOAD_HZ * 2.02],
    ] as const) {
      node.frequency.cancelScheduledValues(t);
      node.frequency.setValueAtTime(node.frequency.value, t);
      node.frequency.linearRampToValueAtTime(base * jitter, t + 0.05);
      node.frequency.linearRampToValueAtTime((base === CHAINSAW_LOAD_HZ ? CHAINSAW_IDLE_HZ : CHAINSAW_IDLE_HZ * 2.02) * jitter, t + 0.3);
    }
    saw.lfo.frequency.cancelScheduledValues(t);
    saw.lfo.frequency.setValueAtTime(saw.lfo.frequency.value, t);
    saw.lfo.frequency.linearRampToValueAtTime(CHAINSAW_LOAD_CHUG_HZ, t + 0.05);
    saw.lfo.frequency.linearRampToValueAtTime(CHAINSAW_IDLE_CHUG_HZ, t + 0.3);
  }

  /**
   * Stop the motor and tear its graph down. Idempotent.
   *
   * **Every retained node is disconnected**, the shaper included. Leaving a
   * shaper wired to a dead gain is the exact shape of the leak recorded in
   * `distortionNode` — one that took seconds of held auto-fire to kill a tab.
   * The oscillators are stopped slightly after the fade so the tail is audible
   * rather than clipped into a click.
   */
  stopChainsaw(): void {
    const saw = this.chainsaw;
    if (!saw || !this.ctx) {
      this.chainsaw = null;
      return;
    }
    this.chainsaw = null;
    const t = this.ctx.currentTime;
    saw.gain.gain.cancelScheduledValues(t);
    saw.gain.gain.setValueAtTime(saw.gain.gain.value, t);
    saw.gain.gain.linearRampToValueAtTime(0.0001, t + CHAINSAW_RELEASE_SEC);
    const end = t + CHAINSAW_RELEASE_SEC + 0.02;
    saw.osc.stop(end);
    saw.detune.stop(end);
    saw.lfo.stop(end);
    saw.osc.onended = () => {
      saw.osc.disconnect();
      saw.detune.disconnect();
      saw.lfo.disconnect();
      saw.lfoDepth.disconnect();
      saw.chug.disconnect();
      saw.shaper.disconnect();
      saw.gain.disconnect();
    };
  }

  /**
   * Weapon reload, dispatched by `kind` exactly like `playShoot` — the same
   * "`viewKind` IS the sound identity" rule (see this file's header comment),
   * so each reloadable weapon's mechanism sounds like its own hardware rather
   * than one shared click.
   *
   * Each voice is a short sequence of clacks scheduled off `ctx.currentTime`
   * (see `playClack`), laid out to roughly span that weapon's reload duration
   * — so the reload reads as the gun being worked rather than as a single
   * blip followed by dead air — and finishing a little early, leaving a beat
   * of "loaded and waiting" the way `playShotgunPump` does.
   *
   * Friday Hotfix, SIGKILL Knife and Toolchain have no magazine to swap, so
   * they never reload and deliberately have no voice here. Like `playShoot`,
   * there's no `default` case: a newly added `WeaponViewKind` has to be
   * listed here (even if only to fall through silently) or this fails to
   * compile, rather than shipping a silent reload nobody notices.
   */
  playReload(kind: WeaponViewKind): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const sfx = this.sfx;
    switch (kind) {
      case "pistol":
        return this.playPistolReload(ctx, sfx);
      case "shotgun":
        return this.playShotgunReload(ctx, sfx);
      case "mp":
        return this.playSmgReload(ctx, sfx);
      case "rocket":
        return this.playRocketReload(ctx, sfx);
      case "flamethrower":
      case "knife":
      case "chainsaw":
        return; // no magazine — see the doc comment above
    }
  }

  /** echo pistol, reloading (~1.1s): magazine out, magazine in, slide
   * release — three light, quick clicks, the highest and shortest of the four
   * reload voices since it's the smallest mechanism. Peaks 0.14-0.19 against
   * the pistol shot's 0.5. */
  private playPistolReload(ctx: AudioContext, sfx: GainNode): void {
    this.playClacks(ctx, sfx, ctx.currentTime, [
      // Magazine catch pressed, empty mag drops free.
      { at: 0, from: 190, to: 105, peak: 0.22, noiseHz: 420, noisePeak: 0.14 },
      // Fresh magazine seated — the heaviest of the three.
      { at: 0.36, from: 150, to: 80, peak: 0.3, noiseHz: 340, noisePeak: 0.18 },
      // Slide released: the crispest, shortest click of the three.
      {
        at: 0.82,
        from: 220,
        to: 120,
        peak: 0.27,
        noiseHz: 560,
        noisePeak: 0.19,
        sweep: 0.03,
        bodyDecay: 0.04,
        noiseDecay: 0.025,
      },
    ]);
  }

  /** Regex Shotgun, reloading (~1.2s): two shells shoved into the tube — long,
   * soft, low, wide-Q shoves rather than snaps — then the pump racking closed.
   * The rack reuses `playShotgunPump` outright: it's the same physical action
   * the shot already cycles, and duplicating it would let the two drift. */
  private playShotgunReload(ctx: AudioContext, sfx: GainNode): void {
    const t = ctx.currentTime;
    // Wide-Q and long-decayed: a shell being shoved home, not a snap.
    const shell = { noisePeak: 0.16, bodyDecay: 0.07, q: 4 };
    this.playClacks(ctx, sfx, t, [
      { ...shell, at: 0, from: 95, to: 58, peak: 0.26, noiseHz: 300 },
      { ...shell, at: 0.28, from: 90, to: 54, peak: 0.27, noiseHz: 280 },
    ]);
    // Racked closed once both shells are in; silent again by ~0.9s.
    this.playShotgunPump(ctx, sfx, t + 0.66);
  }

  /** gdb, reloading (~2.0s): a much heavier box magazine — five low clunks
   * spread over the full cycle (catch, mag out, fresh mag seated hard, bolt
   * back, bolt released) instead of the pistol's three light clicks, all of
   * them longer-ringing and lower. */
  private playSmgReload(ctx: AudioContext, sfx: GainNode): void {
    this.playClacks(ctx, sfx, ctx.currentTime, [
      { at: 0, from: 130, to: 70, peak: 0.24, noiseHz: 260, noisePeak: 0.14, bodyDecay: 0.07 },
      { at: 0.45, from: 110, to: 58, peak: 0.21, noiseHz: 220, noisePeak: 0.13, bodyDecay: 0.07 },
      // Seated hard — the heaviest hit of the sequence.
      {
        at: 0.95,
        from: 95,
        to: 50,
        peak: 0.32,
        noiseHz: 190,
        noisePeak: 0.19,
        sweep: 0.05,
        bodyDecay: 0.09,
      },
      // Bolt hauled back, then let go: the tight pair that ends the cycle.
      { at: 1.45, from: 150, to: 85, peak: 0.26, noiseHz: 340, noisePeak: 0.18 },
      { at: 1.68, from: 105, to: 55, peak: 0.35, noiseHz: 240, noisePeak: 0.21, bodyDecay: 0.06 },
    ]);
  }

  /** ghidra, reloading (~1.6s): the slowest and heaviest of the four — the
   * breech swung open, a long low thunk as the rocket slides down the tube,
   * then a crisp latch snapping shut, high and short against the two thunks
   * so the sequence has an audible "sealed" beat at the end. */
  private playRocketReload(ctx: AudioContext, sfx: GainNode): void {
    this.playClacks(ctx, sfx, ctx.currentTime, [
      {
        at: 0,
        from: 90,
        to: 48,
        peak: 0.29,
        noiseHz: 200,
        noisePeak: 0.16,
        sweep: 0.06,
        bodyDecay: 0.1,
        noiseDecay: 0.05,
        q: 3,
      },
      // The rocket bottoming out in the tube: the lowest, longest hit in here.
      {
        at: 0.55,
        from: 70,
        to: 40,
        peak: 0.35,
        noiseHz: 160,
        noisePeak: 0.18,
        sweep: 0.08,
        bodyDecay: 0.14,
        noiseDecay: 0.06,
        q: 3,
      },
      // Latch: short, dry and well above everything before it.
      {
        at: 1.25,
        from: 200,
        to: 110,
        peak: 0.27,
        noiseHz: 380,
        noisePeak: 0.21,
        sweep: 0.03,
        bodyDecay: 0.04,
        noiseDecay: 0.025,
        q: 9,
      },
    ]);
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

  /**
   * Walked into a key-locked door with no key: a blunt, low "denied" thunk —
   * the door refusing to move. Deliberately mechanical rather than a UI
   * buzzer, and pitched right down in the 110->62Hz register so it can't be
   * confused with `playAlarm`'s 1245Hz pip or with `playKeyPing` immediately
   * after it. `triangle` body for the same reason `playShotgunPump` uses one:
   * a square reads as a tone, a triangle as a struck object.
   *
   * Both layers are scheduled here, in one call, rather than triggered
   * separately — the latch tick then stays sample-accurate against the body
   * instead of landing on a frame boundary, exactly as `playShotgunPump`
   * argues for its own clacks. This is the first half of the denial-then-ping
   * pair; see `RaycasterEngine.cueLockedDoorHint` for the ordering.
   */
  playLockedDoor(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;

    const body = ctx.createOscillator();
    body.type = "triangle";
    body.frequency.setValueAtTime(110, t);
    body.frequency.exponentialRampToValueAtTime(62, t + 0.06);
    const bodyGain = envelope(ctx, 0.3, 0.002, 0.16, t);
    body.connect(bodyGain).connect(this.sfx);
    body.start(t);
    body.stop(t + 0.2);

    // The latch failing to throw, a hair after the door stops dead. Narrow
    // bandpass rather than a lowpass, same as the pump's clacks: 300Hz at Q 7
    // is a dry mechanical knock, where a lowpass leaves audible hiss.
    const latch = ctx.createBufferSource();
    latch.buffer = this.noiseBuffer(ctx, 0.12);
    const latchFilter = ctx.createBiquadFilter();
    latchFilter.type = "bandpass";
    latchFilter.frequency.setValueAtTime(300, t + 0.02);
    latchFilter.Q.value = 7;
    const latchGain = envelope(ctx, 0.12, 0.001, 0.04, t + 0.02);
    latch.connect(latchFilter).connect(latchGain).connect(this.sfx);
    latch.start(t + 0.02);
    latch.stop(t + 0.08);
  }

  /**
   * The key-locator sonar that follows `playLockedDoor` — a soft two-note
   * rising sine figure marking the nearest reachable key on the minimap.
   * Deliberately the opposite register to the denial below it, so the pair
   * reads as question and answer rather than as one muddled event. Quieter
   * than `playAlarm`'s pip (0.16 against 0.28) because it repeats every
   * ~0.7s for several seconds and must not nag.
   */
  playKeyPing(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;
    const notes = [659.25, 880]; // E5, A5
    notes.forEach((freq, i) => {
      const start = t + i * 0.06;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      const gain = envelope(ctx, 0.16, 0.004, 0.1, start);
      osc.connect(gain).connect(sfx);
      osc.start(start);
      osc.stop(start + 0.12);
    });
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

  /**
   * An "Acid Overflow" room starting to flood under the player (see
   * `src/engine/acidOverflow.ts`): a low, sinking drone with a wet
   * bandpass-filtered hiss over it — deliberately the darkest cue in here.
   *
   * Everything else in this file is an *event* the player caused (a shot, a
   * pickup, a kill), so they're short, bright and high. This one is something
   * happening *to* them that they may not have looked at yet, so it goes the
   * other way: low, slow, and long enough to register as "that's bad" rather
   * than as a confirmation blip.
   */
  playAcidOverflow(): void {
    const ctx = this.resume();
    if (!ctx || !this.sfx) return;
    const t = ctx.currentTime;
    const sfx = this.sfx;

    // Sinking drone — the "something just gave way" half.
    const drone = ctx.createOscillator();
    drone.type = "triangle";
    drone.frequency.setValueAtTime(150, t);
    drone.frequency.exponentialRampToValueAtTime(70, t + 0.55);
    const droneGain = envelope(ctx, 0.3, 0.03, 0.55);
    drone.connect(droneGain).connect(sfx);
    drone.start(t);
    drone.stop(t + 0.6);

    // Wet hiss — the "and it's spreading" half. Bandpassed low and swept
    // downward so it reads as bubbling rather than as a steam/air whoosh.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(ctx, 0.6);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(620, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(240, t + 0.5);
    noiseFilter.Q.value = 1.4;
    const noiseGain = envelope(ctx, 0.16, 0.05, 0.5);
    noise.connect(noiseFilter).connect(noiseGain).connect(sfx);
    noise.start(t);
    noise.stop(t + 0.6);
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
 *
 * Both ramps anchor to `startAt`, which defaults to "now" but can be pushed
 * into the future so a delayed transient (see `playShotgunPump`) still gets
 * its full attack rather than opening mid-decay.
 */
function envelope(
  ctx: AudioContext,
  peak: number,
  attack: number,
  decay: number,
  startAt = ctx.currentTime,
): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + attack + decay);
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

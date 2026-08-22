// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAudioContext } from "../../test/mocks/audio";
import type { WeaponViewKind } from "./weapons";

let audio: (typeof import("./audio"))["audio"];

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  ({ audio } = await import("./audio"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioManager.resume() — constructor selection & availability", () => {
  it("returns null and never builds a graph when no AudioContext constructor exists at all", () => {
    expect(audio.resume()).toBeNull();
  });

  it("falls back to webkitAudioContext when the standard AudioContext is absent", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", MockAudioContext);
    const ctx = audio.resume();
    expect(ctx).toBeInstanceOf(MockAudioContext);
  });

  it("prefers the standard AudioContext when both constructors exist", () => {
    class OtherCtx extends MockAudioContext {}
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("webkitAudioContext", OtherCtx);
    const ctx = audio.resume();
    expect(ctx).toBeInstanceOf(MockAudioContext);
    expect(ctx).not.toBeInstanceOf(OtherCtx);
  });

  it("builds the sfx/bgm/master graph on first call and reuses it on later calls", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    expect(ctx.createGain).toHaveBeenCalledTimes(3); // master, sfx, bgm
    expect(ctx.createDynamicsCompressor).toHaveBeenCalledTimes(1);

    const master = ctx.createGain.mock.results[0].value;
    const sfx = ctx.createGain.mock.results[1].value;
    const bgm = ctx.createGain.mock.results[2].value;
    expect(sfx.connect).toHaveBeenCalledWith(master);
    expect(bgm.connect).toHaveBeenCalledWith(master);

    const second = audio.resume();
    expect(second).toBe(ctx); // same instance
    expect(ctx.createGain).toHaveBeenCalledTimes(3); // not rebuilt
  });

  it("resumes a suspended context but leaves an already-running one alone", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.resume();
    expect(ctx.resume).not.toHaveBeenCalled(); // still "running"

    ctx.state = "suspended";
    audio.resume();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });
});

describe("AudioManager.isSilenced() — browser-automation gating", () => {
  it("is silenced when navigator.webdriver is true, even with a real AudioContext available", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", { webdriver: true });
    expect(audio.resume()).toBeNull();
    expect(audio.isSilenced()).toBe(true);
  });

  it("stays silenced (sticky) once tripped, even if navigator.webdriver later reads false", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", { webdriver: true });
    expect(audio.resume()).toBeNull();

    vi.stubGlobal("navigator", { webdriver: false });
    expect(audio.resume()).toBeNull();
  });

  it("is not silenced when navigator has no webdriver flag", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", {});
    expect(audio.resume()).not.toBeNull();
  });

  it("handles a missing navigator global without throwing", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", undefined);
    expect(audio.resume()).not.toBeNull();
  });
});

describe("AudioManager volume controls", () => {
  it("queues a pending volume before the context exists, applied once it's created", () => {
    audio.setMasterVolume(0.3);
    audio.setSfxVolume(0.7);
    audio.setBgmVolume(0.1);
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    expect(ctx.createGain.mock.results[0].value.gain.value).toBe(0.3);
    expect(ctx.createGain.mock.results[1].value.gain.value).toBe(0.7);
    expect(ctx.createGain.mock.results[2].value.gain.value).toBe(0.1);
  });

  it("applies a volume change immediately once the context already exists", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.setMasterVolume(0.9);
    audio.setSfxVolume(0.2);
    audio.setBgmVolume(0.4);
    expect(ctx.createGain.mock.results[0].value.gain.value).toBe(0.9);
    expect(ctx.createGain.mock.results[1].value.gain.value).toBe(0.2);
    expect(ctx.createGain.mock.results[2].value.gain.value).toBe(0.4);
  });

  it("clamps volumes to the 0-1 range", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.setMasterVolume(-5);
    expect(ctx.createGain.mock.results[0].value.gain.value).toBe(0);
    audio.setMasterVolume(5);
    expect(ctx.createGain.mock.results[0].value.gain.value).toBe(1);
  });
});

describe("AudioManager.connectBgmSource()", () => {
  it("returns null and doesn't connect when audio is unavailable", () => {
    const node = { connect: vi.fn() } as unknown as AudioNode;
    expect(audio.connectBgmSource(node)).toBeNull();
    expect(node.connect).not.toHaveBeenCalled();
  });

  it("connects the node into the bgm bus and returns the live context", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const node = { connect: vi.fn() } as unknown as AudioNode;
    const ctx = audio.connectBgmSource(node) as unknown as MockAudioContext;
    expect(ctx).toBeInstanceOf(MockAudioContext);
    const bgm = ctx.createGain.mock.results[2].value;
    expect(node.connect).toHaveBeenCalledWith(bgm);
  });
});

describe("AudioManager.playShoot() dispatch", () => {
  it("does nothing when audio is unavailable", () => {
    expect(() => audio.playShoot("pistol")).not.toThrow();
  });

  // `oscType` is the *first* oscillator's — the weapon's own body — so the
  // shotgun's two trailing pump clacks (see below) don't disturb it.
  const cases: Array<{ kind: WeaponViewKind; noiseSources: number; oscType: OscillatorType }> = [
    { kind: "pistol", noiseSources: 0, oscType: "square" },
    { kind: "shotgun", noiseSources: 3, oscType: "sawtooth" }, // blast + two pump clacks
    { kind: "mp", noiseSources: 0, oscType: "square" },
    { kind: "rocket", noiseSources: 1, oscType: "sawtooth" },
    { kind: "flamethrower", noiseSources: 1, oscType: "sawtooth" },
    // "chainsaw" is deliberately absent: it is the one kind that synthesizes
    // no per-shot voice at all. Toolchain runs a sustained motor instead, so
    // `playShoot` only revs it — covered by the loop tests below.
  ];

  for (const { kind, noiseSources, oscType } of cases) {
    it(`plays a distinct voice for "${kind}"`, () => {
      vi.stubGlobal("AudioContext", MockAudioContext);
      const ctx = audio.resume() as unknown as MockAudioContext;
      audio.playShoot(kind);
      expect(ctx.createOscillator).toHaveBeenCalled();
      expect(ctx.createOscillator.mock.results[0].value.type).toBe(oscType);
      expect(ctx.createBufferSource).toHaveBeenCalledTimes(noiseSources);
    });
  }

  // Toolchain's motor — the only sustained voice in `audio.ts`, and therefore
  // the only one that can leak. Everything else schedules its own stop and is
  // never referenced again.
  it("runs the chainsaw as a sustained motor rather than a per-shot blip", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.startChainsaw();

    // One engine body plus the chug LFO, and no one-shot stop scheduled at
    // start time — a sustained source deliberately breaks the "always
    // bounded" invariant every other voice in the file follows.
    const oscs = ctx.createOscillator.mock.results.map((r) => r.value);
    expect(oscs).toHaveLength(2);
    const [body, lfo] = oscs;
    for (const osc of oscs) {
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).not.toHaveBeenCalled();
    }

    // The three properties that separate a chainsaw from a synth patch. An
    // early version had none of them and a playtest called it "scifi techno";
    // each line here is one of those mistakes, pinned so it cannot come back.

    // 1. It is mostly *noise* — the chain rattle — not oscillators. Without a
    //    looping noise source this is a synth bass by construction.
    const noise = ctx.createBufferSource.mock.results[0].value;
    expect(noise.loop).toBe(true);
    expect(noise.start).toHaveBeenCalled();
    const [rattle, cut] = ctx.createBiquadFilter.mock.results.map((r) => r.value);
    expect(rattle.type).toBe("bandpass");
    // Wide, not resonant: a high Q here rings like a filter sweep.
    expect(rattle.Q.value).toBeLessThan(2);

    // 1b. The body is mixed *under* the rattle and the sub-bass is trimmed.
    //     At unity the oscillator buries the noise and the whole thing reads
    //     as a bass note with a rattle behind it — reported as "a bit much
    //     bass" before this existed.
    const gains = ctx.createGain.mock.results.map((r) => r.value);
    const bodyMix = gains.find((g) => g.gain.setValueAtTime.mock.calls.some(([v]) => v > 0 && v < 0.5));
    expect(bodyMix).toBeDefined();
    expect(cut.type).toBe("highpass");
    expect(cut.frequency.setValueAtTime.mock.calls[0][0]).toBeGreaterThan(60);

    // 2. The chug LFO is a sawtooth, not a sine. Smooth sinusoidal amplitude
    //    modulation is a tremolo pedal; combustion is a sharp kick that
    //    decays, and that asymmetry is the engine character.
    expect(body.type).toBe("sawtooth");
    expect(lfo.type).toBe("sawtooth");

    // 3. The body sits off a musical pitch. The first version used 55Hz (A1)
    //    with a second oscillator an octave above it, which spelled a chord.
    const A1 = 55;
    expect(body.frequency.setValueAtTime).toHaveBeenCalled();
    const bodyHz = body.frequency.setValueAtTime.mock.calls[0][0];
    expect(Math.abs(bodyHz - A1)).toBeGreaterThan(4);
    // ...and still inside the 50-350Hz mechanical register the rest of the
    // file's machinery lives in (see the `Clack` bodies).
    expect(bodyHz).toBeGreaterThan(40);
    expect(bodyHz).toBeLessThan(350);
  });

  it("only starts one chainsaw motor however often it is asked", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.startChainsaw();
    const afterFirst = ctx.createOscillator.mock.calls.length;
    audio.startChainsaw();
    audio.startChainsaw();
    // Idempotent on purpose: the engine calls this every frame the key is held.
    expect(ctx.createOscillator.mock.calls.length).toBe(afterFirst);
  });

  it("disconnects every chainsaw node once the motor has spun down", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.startChainsaw();
    const oscs = ctx.createOscillator.mock.results.map((r) => r.value);
    const shaper = ctx.createWaveShaper.mock.results[0].value;
    audio.stopChainsaw();

    for (const osc of oscs) expect(osc.stop).toHaveBeenCalled();
    // The teardown is deferred to `onended` so the fade-out is audible rather
    // than clipped. Firing it by hand is the only way to reach the teardown
    // without a real audio clock.
    expect(oscs[0].onended).toBeTypeOf("function");
    oscs[0].onended();
    // The shaper especially: a `WaveShaperNode` left wired to a dead gain is
    // precisely the unbounded node leak that once crashed the tab within
    // seconds of holding this weapon's trigger. See `distortionNode`.
    expect(shaper.disconnect).toHaveBeenCalled();
    for (const osc of oscs) expect(osc.disconnect).toHaveBeenCalled();
  });

  it("revs the running motor on a bite instead of layering a new voice", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.startChainsaw();
    const [osc, lfo] = ctx.createOscillator.mock.results.map((r) => r.value);
    const rattle = ctx.createBiquadFilter.mock.results[0].value;
    const before = ctx.createOscillator.mock.calls.length;

    audio.playShoot("chainsaw");

    // No new oscillator: a bite leans on the drone that is already running.
    // This is the one `playShoot` kind that synthesizes nothing.
    expect(ctx.createOscillator.mock.calls.length).toBe(before);
    // All three climb together — engine note, firing rate, and the brightness
    // of the rattle. Ramping the pitch alone would read as a pitch-bend
    // effect rather than as a chain catching on something.
    expect(osc.frequency.linearRampToValueAtTime).toHaveBeenCalled();
    expect(lfo.frequency.linearRampToValueAtTime).toHaveBeenCalled();
    expect(rattle.frequency.linearRampToValueAtTime).toHaveBeenCalled();
  });

  it("ignores a bite when the motor is not running", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    // Reachable for real: `fire()` can land on the same frame the key goes
    // down, before the per-frame sync has started the motor.
    expect(() => audio.playShoot("chainsaw")).not.toThrow();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it("stops the chainsaw safely when it was never started", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    audio.resume();
    expect(() => audio.stopChainsaw()).not.toThrow();
  });

  it("makes the chainsaw motor a no-op under browser automation", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", { webdriver: true });
    audio.startChainsaw();
    expect(audio.getContextState()).toBe("none");
    expect(() => audio.stopChainsaw()).not.toThrow();
  });

  it("the shotgun's blast is followed by two low pump clacks", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playShoot("shotgun");

    // The blast body first, then the rack-back and the slam-forward.
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    const [blast, rack, slam] = ctx.createOscillator.mock.results.map((r) => r.value);
    expect(blast.type).toBe("sawtooth");
    expect(rack.type).toBe("triangle"); // a struck object, not a tone
    expect(slam.type).toBe("triangle");

    // Scheduled into the gap the 0.85s pump-action cooldown leaves behind,
    // starting once the blast's own tail has died away.
    expect(rack.start.mock.calls[0][0]).toBeCloseTo(0.18);
    expect(slam.start.mock.calls[0][0]).toBeCloseTo(0.34);

    // Mechanism, not a second shot: both sit below the blast's 150Hz body.
    const blastHz = blast.frequency.setValueAtTime.mock.calls[0][0];
    expect(rack.frequency.setValueAtTime.mock.calls[0][0]).toBeLessThan(blastHz);
    expect(slam.frequency.setValueAtTime.mock.calls[0][0]).toBeLessThan(blastHz);

    // Dry bandpassed clacks, unlike the blast's hissier lowpassed tail.
    const filters = ctx.createBiquadFilter.mock.results.map((r) => r.value.type);
    expect(filters).toEqual(["lowpass", "bandpass", "bandpass"]);
  });

  it('plays a noise-only "knife" whoosh, with no oscillator at all', () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playShoot("knife");
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });
});

describe("AudioManager.playReload() dispatch", () => {
  it("does nothing when audio is unavailable", () => {
    expect(() => audio.playReload("pistol")).not.toThrow();
  });

  // One clack = one triangle body + one bandpassed noise click, so the two
  // counts always match; the shotgun's total includes `playShotgunPump`'s
  // two, reused rather than duplicated for the final rack.
  const cases: Array<{ kind: WeaponViewKind; clacks: number }> = [
    { kind: "pistol", clacks: 3 }, // mag out, mag in, slide release
    { kind: "shotgun", clacks: 4 }, // two shells + the pump's rack and slam
    { kind: "mp", clacks: 5 }, // catch, mag out, mag in, bolt back, bolt release
    { kind: "rocket", clacks: 3 }, // breech, tube thunk, latch
  ];

  for (const { kind, clacks } of cases) {
    it(`plays a ${clacks}-clack mechanical sequence for "${kind}"`, () => {
      vi.stubGlobal("AudioContext", MockAudioContext);
      const ctx = audio.resume() as unknown as MockAudioContext;
      audio.playReload(kind);
      expect(ctx.createOscillator).toHaveBeenCalledTimes(clacks);
      expect(ctx.createBufferSource).toHaveBeenCalledTimes(clacks);

      const bodies = ctx.createOscillator.mock.results.map((r) => r.value);
      // Struck objects, not tones — and every noise layer a dry bandpassed
      // knock rather than the hiss a lowpass would leave.
      expect(bodies.every((o: { type: string }) => o.type === "triangle")).toBe(true);
      const filters = ctx.createBiquadFilter.mock.results.map((r) => r.value.type);
      expect(filters).toEqual(Array(clacks).fill("bandpass"));
    });

    it(`schedules "${kind}"'s clacks in order off ctx.currentTime, each with a stop`, () => {
      vi.stubGlobal("AudioContext", MockAudioContext);
      const ctx = audio.resume() as unknown as MockAudioContext;
      ctx.currentTime = 2; // not zero, so a missing `+ t` would show up
      audio.playReload(kind);

      const sources = [
        ...ctx.createOscillator.mock.results,
        ...ctx.createBufferSource.mock.results,
      ].map((r) => r.value);

      for (const src of sources) {
        const start = src.start.mock.calls[0][0];
        expect(start).toBeGreaterThanOrEqual(2); // absolute, not an offset
        expect(src.stop.mock.calls[0][0]).toBeGreaterThan(start); // never open-ended
      }

      // A sequence of separate hits, not one long tone: the bodies step
      // forward in time and the last one lands within the weapon's reload.
      const starts: number[] = ctx.createOscillator.mock.results.map(
        (r) => r.value.start.mock.calls[0][0],
      );
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(starts[starts.length - 1]).toBeGreaterThan(starts[0] + 0.5);
    });
  }

  it("keeps every reload body in the low mechanical register (50-350Hz)", () => {
    // The house rule this file's mechanical voices follow — see
    // `playShotgunPump`'s doc comment. A bright chirp here would read as a
    // UI beep rather than as hardware being worked.
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    for (const kind of ["pistol", "shotgun", "mp", "rocket"] as const) audio.playReload(kind);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(15); // 3+4+5+3 — the loop below bites

    for (const { value: osc } of ctx.createOscillator.mock.results) {
      const [from] = osc.frequency.setValueAtTime.mock.calls.at(-1) ?? [];
      const [to] = osc.frequency.exponentialRampToValueAtTime.mock.calls.at(-1) ?? [];
      expect(from).toBeLessThanOrEqual(350); // the register ceiling
      expect(to).toBeLessThan(from); // sinks, like every struck thing in here
      expect(to).toBeGreaterThanOrEqual(35); // but still a body, not sub-bass
    }
  });

  it("gives every reload voice, not just the pistol's, an audible peak", () => {
    // The pistol bound below is the one that was re-argued, but all four
    // voices were mixed down together and all four were inaudible under
    // gunfire — so guard all four against drifting back down.
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    for (const kind of ["pistol", "shotgun", "mp", "rocket"] as const) {
      ctx.createGain.mockClear();
      audio.playReload(kind);
      const peaks = ctx.createGain.mock.results.map(
        (r) => r.value.gain.exponentialRampToValueAtTime.mock.calls[0][0] as number,
      );
      expect(Math.max(...peaks)).toBeGreaterThan(0.2);
    }
  });

  // The bound here used to be `shotPeak * 0.5`, chosen so a reload "reads as
  // mechanism". It did — and it also meant the reload was inaudible under
  // gunfire, which is the whole reason a player reported never noticing one.
  // Re-argued rather than merely renumbered: a reload must still be plainly
  // quieter than a shot (it is not an event you aim), but it has to survive
  // being mixed against one, so the ceiling is now 0.8 rather than 0.5.
  it("keeps the pistol's reload below its own shot, while still audible over one", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playShoot("pistol");
    // `envelope()`'s first exponential ramp is the peak it opens up to.
    const peakOf = (g: { exponentialRampToValueAtTime: { mock: { calls: number[][] } } }): number =>
      g.exponentialRampToValueAtTime.mock.calls[0][0];
    const shotPeak = peakOf(ctx.createGain.mock.results.at(-1)?.value.gain);

    ctx.createGain.mockClear();
    audio.playReload("pistol");
    const peaks = ctx.createGain.mock.results.map((r) => peakOf(r.value.gain));
    expect(Math.max(...peaks)).toBeLessThan(shotPeak * 0.8);
    expect(Math.max(...peaks)).toBeGreaterThan(shotPeak * 0.4); // and not back to inaudible
  });

  it("is a no-op for the magazine-less weapons", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    for (const kind of ["flamethrower", "knife", "chainsaw"] as const) {
      expect(() => audio.playReload(kind)).not.toThrow();
    }
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });

  it("stays silent under browser automation", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", { webdriver: true });
    expect(audio.isSilenced()).toBe(true);
    expect(() => audio.playReload("mp")).not.toThrow();
    expect(audio.getContextState()).toBe("none"); // no context was ever built
  });

  it("does not count as a shot", () => {
    // `getShotCount` is the perf profiler's shot proxy (see its doc comment);
    // reloads must not inflate it.
    vi.stubGlobal("AudioContext", MockAudioContext);
    audio.resume();
    audio.playReload("shotgun");
    expect(audio.getShotCount()).toBe(0);
  });

  it("reuses the cached 0.12s noise buffer every clack shares", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playReload("mp"); // five clacks, one buffer
    audio.playReload("rocket");
    audio.playShoot("shotgun"); // the same 0.12s key
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);
  });
});

describe("AudioManager diagnostics (getShotCount/getContextState)", () => {
  it("counts every playShoot call, even when audio is unavailable", () => {
    expect(audio.getShotCount()).toBe(0);
    audio.playShoot("pistol");
    audio.playShoot("shotgun");
    expect(audio.getShotCount()).toBe(2);
  });

  it('reports "none" before any sound has ever played, then the live AudioContext state', () => {
    expect(audio.getContextState()).toBe("none");
    vi.stubGlobal("AudioContext", MockAudioContext);
    audio.playShoot("pistol");
    expect(audio.getContextState()).toBe("running");
  });
});

describe("AudioManager simple one-shot effects", () => {
  const effects: Array<[string, () => void]> = [
    ["playHit", () => audio.playHit()],
    ["playDamage", () => audio.playDamage()],
    ["playEnemyShoot", () => audio.playEnemyShoot()],
    ["playAmmoDrop", () => audio.playAmmoDrop()],
    ["playPickup", () => audio.playPickup()],
    ["playStep", () => audio.playStep()],
    ["playAlarm", () => audio.playAlarm()],
    ["playLockedDoor", () => audio.playLockedDoor()],
    ["playKeyPing", () => audio.playKeyPing()],
    ["playTeleport", () => audio.playTeleport()],
    ["playLevelComplete", () => audio.playLevelComplete()],
    ["playExplosion", () => audio.playExplosion()],
    ["playRocketExplosion", () => audio.playRocketExplosion()],
    ["playSecret", () => audio.playSecret()],
    ["playAcidOverflow", () => audio.playAcidOverflow()],
    ["playMultiKill", () => audio.playMultiKill()],
    ["playUltraKill", () => audio.playUltraKill()],
  ];

  it("does nothing for any effect when audio is unavailable", () => {
    for (const [, play] of effects) {
      expect(play).not.toThrow();
    }
  });

  it("plays every effect without throwing once audio is available", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    audio.resume();
    for (const [, play] of effects) {
      expect(play).not.toThrow();
    }
  });

  it("plays a 3-note arpeggio for playLevelComplete and playSecret", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playLevelComplete();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    ctx.createOscillator.mockClear();
    audio.playSecret();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
  });

  it("plays a sinking drone plus a filtered hiss for playAcidOverflow", () => {
    // Deliberately the darkest cue in here: everything else is a short bright
    // blip confirming something the player did, this one warns about something
    // happening to them (see the method's own doc comment).
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playAcidOverflow();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const osc = ctx.createOscillator.mock.results.at(-1)?.value;
    expect(osc.type).toBe("triangle");
    // Sinks rather than rises — the opposite shape to `playPickup`'s blip.
    const [startFreq] = osc.frequency.setValueAtTime.mock.calls.at(-1) ?? [];
    const [endFreq] = osc.frequency.exponentialRampToValueAtTime.mock.calls.at(-1) ?? [];
    expect(endFreq).toBeLessThan(startFreq);
    expect(ctx.createBiquadFilter.mock.results.at(-1)?.value.type).toBe("bandpass");
  });

  it("plays a low sinking thunk plus a bandpassed latch tick for playLockedDoor", () => {
    // A door refusing to move is a mechanical sound, not a UI buzzer: a
    // `triangle` body that sinks, well below `playAlarm`'s 1245Hz pip, with a
    // narrow-bandpassed noise click for the latch.
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playLockedDoor();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const osc = ctx.createOscillator.mock.results.at(-1)?.value;
    expect(osc.type).toBe("triangle");
    const [startFreq] = osc.frequency.setValueAtTime.mock.calls.at(-1) ?? [];
    const [endFreq] = osc.frequency.exponentialRampToValueAtTime.mock.calls.at(-1) ?? [];
    expect(startFreq).toBeLessThan(350); // the "pitch it low" register, not a beep
    expect(endFreq).toBeLessThan(startFreq);
    expect(ctx.createBiquadFilter.mock.results.at(-1)?.value.type).toBe("bandpass");
  });

  it("schedules playLockedDoor's latch tick after its body, off ctx.currentTime", () => {
    // Both layers are scheduled in one call precisely so the tick stays
    // sample-accurate against the thunk instead of landing on a frame
    // boundary — same argument `playShotgunPump` makes for its clacks.
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playLockedDoor();
    const bodyStart = ctx.createOscillator.mock.results.at(-1)?.value.start.mock.calls.at(-1)?.[0];
    const latchStart = ctx.createBufferSource.mock.results.at(-1)?.value.start.mock.calls.at(-1)?.[0];
    expect(latchStart).toBeGreaterThan(bodyStart);
  });

  it("plays a rising two-note sine ping for playKeyPing, clear of the denial's register", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playKeyPing();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    const notes = ctx.createOscillator.mock.results.map((r) => r.value);
    expect(notes.every((o: { type: string }) => o.type === "sine")).toBe(true);
    const freqs = notes.map((o: { frequency: { setValueAtTime: { mock: { calls: number[][] } } } }) =>
      o.frequency.setValueAtTime.mock.calls.at(-1)![0],
    );
    expect(freqs[1]).toBeGreaterThan(freqs[0]); // rises, unlike the denial
    expect(freqs[0]).toBeGreaterThan(350); // and sits well above it
  });

  it("plays a bigger arpeggio plus a noise burst for playUltraKill than playMultiKill", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playMultiKill();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    expect(ctx.createBufferSource).not.toHaveBeenCalled();

    ctx.createOscillator.mockClear();
    audio.playUltraKill();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(5); // two more notes than Multi Kill
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1); // extra noise "sizzle" layer
    expect(ctx.createBiquadFilter.mock.results.at(-1)?.value.type).toBe("bandpass");
  });
});

describe("AudioManager.playDamage() rate limiting", () => {
  it("plays on the first call, suppresses an immediate repeat, then plays again after enough time passes", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;

    audio.playDamage();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);

    audio.playDamage(); // same ctx.currentTime -> rate-limited
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);

    ctx.currentTime = 0.5; // past the 0.18s rate-limit window
    audio.playDamage();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });
});

describe("AudioManager internal caching", () => {
  it("caches the distortion curve across calls that need it", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playExplosion();
    audio.playDamage();
    const firstCurve = ctx.createWaveShaper.mock.results[0].value.curve;
    const secondCurve = ctx.createWaveShaper.mock.results[1].value.curve;
    expect(ctx.createWaveShaper).toHaveBeenCalledTimes(2);
    expect(secondCurve).toBe(firstCurve); // reused, not regenerated
  });

  it("caches noise buffers by duration across calls that share one", () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playShoot("shotgun"); // 0.12s noise buffer
    audio.playShoot("flamethrower"); // also a 0.12s noise buffer -> same cache key
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);
  });
});

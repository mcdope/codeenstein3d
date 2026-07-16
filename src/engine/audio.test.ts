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

  const cases: Array<{ kind: WeaponViewKind; expectNoise: boolean; oscType: OscillatorType }> = [
    { kind: "pistol", expectNoise: false, oscType: "square" },
    { kind: "shotgun", expectNoise: true, oscType: "sawtooth" },
    { kind: "mp", expectNoise: false, oscType: "square" },
    { kind: "rocket", expectNoise: true, oscType: "sawtooth" },
    { kind: "flamethrower", expectNoise: true, oscType: "sawtooth" },
    { kind: "chainsaw", expectNoise: false, oscType: "sawtooth" },
  ];

  for (const { kind, expectNoise, oscType } of cases) {
    it(`plays a distinct voice for "${kind}"`, () => {
      vi.stubGlobal("AudioContext", MockAudioContext);
      const ctx = audio.resume() as unknown as MockAudioContext;
      audio.playShoot(kind);
      expect(ctx.createOscillator).toHaveBeenCalled();
      expect(ctx.createOscillator.mock.results[0].value.type).toBe(oscType);
      expect(ctx.createBufferSource).toHaveBeenCalledTimes(expectNoise ? 1 : 0);
    });
  }

  it('plays a noise-only "knife" whoosh, with no oscillator at all', () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    const ctx = audio.resume() as unknown as MockAudioContext;
    audio.playShoot("knife");
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
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
    ["playTeleport", () => audio.playTeleport()],
    ["playLevelComplete", () => audio.playLevelComplete()],
    ["playExplosion", () => audio.playExplosion()],
    ["playRocketExplosion", () => audio.playRocketExplosion()],
    ["playSecret", () => audio.playSecret()],
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

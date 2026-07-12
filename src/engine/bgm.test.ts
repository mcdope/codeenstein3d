// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDirectoryHandle } from "../../test/mocks/fsAccess";
import { MockAudioContext } from "../../test/mocks/audio";

let bgm: (typeof import("./bgm"))["bgm"];
let audio: (typeof import("./audio"))["audio"];
let urlCounter = 0;

function dir(tree: Record<string, string | Record<string, string>>): FileSystemDirectoryHandle {
  return fakeDirectoryHandle("bgm", tree) as unknown as FileSystemDirectoryHandle;
}

function bgmEl(): HTMLAudioElement {
  return (bgm as unknown as { el: HTMLAudioElement }).el;
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("navigator", {});
  urlCounter = 0;
  URL.createObjectURL = vi.fn(() => `blob:fake-${urlCounter++}`);
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  ({ audio } = await import("./audio"));
  ({ bgm } = await import("./bgm"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BgmPlayer.loadFolder()", () => {
  it("starts at 0 tracks before anything is loaded", () => {
    expect(bgm.trackCount).toBe(0);
  });

  it("filters to only .mp3/.ogg/.wav files, case-insensitively, ignoring other files and subdirectories", async () => {
    const count = await bgm.loadFolder(
      dir({
        "track1.mp3": "a",
        "track2.OGG": "b",
        "notes.txt": "c",
        subdir: { "nested.wav": "d" },
      }),
    );
    expect(count).toBe(2);
    expect(bgm.trackCount).toBe(2);
  });

  it("starts nothing and returns 0 for a folder with no playable files", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    const count = await bgm.loadFolder(dir({ "notes.txt": "c" }));
    expect(count).toBe(0);
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("auto-starts playback of the first (shuffled) track once files are found", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    await bgm.loadFolder(dir({ "a.mp3": "A" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("still plays the raw element even when no AudioContext constructor is available", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    await bgm.loadFolder(dir({ "a.mp3": "A" }));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("does not play or wire a Web Audio graph when isSilenced() is true", async () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", { webdriver: true });
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    await bgm.loadFolder(dir({ "a.mp3": "A" }));
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("does not throw when play() rejects (e.g. the tab lost focus mid-await)", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce(new Error("blocked"));
    await expect(bgm.loadFolder(dir({ "a.mp3": "A" }))).resolves.toBe(1);
  });

  it("wires the MediaElementAudioSourceNode into the bgm bus only once across multiple tracks", async () => {
    vi.stubGlobal("AudioContext", MockAudioContext);
    await bgm.loadFolder(dir({ "a.mp3": "A", "b.mp3": "B" }));
    bgmEl().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => {
      const ctx = audio.resume() as unknown as MockAudioContext;
      expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    });
  });
});

describe("BgmPlayer track-end handling", () => {
  it("wraps the shuffled cursor back to the start once every track has played", async () => {
    // Every track-end re-enters wireAndPlay(), which calls audio.resume() —
    // without a real AudioContext constructor stubbed, the very first call
    // would permanently flip AudioManager's sticky `unavailable` flag and
    // silence every later track (see isSilenced()'s stickiness).
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    await bgm.loadFolder(dir({ "a.mp3": "A", "b.mp3": "B" }));
    expect(playSpy).toHaveBeenCalledTimes(1);

    bgmEl().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2));

    bgmEl().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(3)); // wrapped
  });

  it("is a no-op when the track ends with nothing loaded", () => {
    expect(() => bgmEl().dispatchEvent(new Event("ended"))).not.toThrow();
  });

  it("revokes the previous track's object URL when advancing, but not for the very first track", async () => {
    await bgm.loadFolder(dir({ "a.mp3": "A", "b.mp3": "B" }));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    bgmEl().dispatchEvent(new Event("ended"));
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1));
  });
});

describe("BgmPlayer.stop()", () => {
  it("pauses playback without discarding the loaded playlist", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause");
    await bgm.loadFolder(dir({ "a.mp3": "A" }));
    bgm.stop();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(bgm.trackCount).toBe(1);
  });
});

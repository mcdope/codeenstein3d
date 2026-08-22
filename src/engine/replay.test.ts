// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputSnapshot } from "./input";
import { CampaignReplayRecorder, MAX_REPLAY_FRAMES_PER_LEVEL, ReplayPlaybackInput, type ReplayLevelMeta } from "./replay";

function meta(overrides: Partial<ReplayLevelMeta> = {}): ReplayLevelMeta {
  return {
    filePath: "src/main.c",
    bonusLevel: false,
    gameplaySeed: 42,
    difficulty: "normal",
    gore: "on",
    ...overrides,
  } as ReplayLevelMeta;
}

function snapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    keys: [],
    mouseDX: 0,
    fireQueued: false,
    fireHeld: false,
    weaponRequest: null,
    mapToggle: false,
    interact: false,
  reload: false,
  helpPing: false,
    melee: false,
    meleeHeld: false,
    wheelSteps: 0,
    fpsToggle: false,
    escape: false,
    blur: false,
    pointerUnlock: false,
    click: false,
    gpForward: 0,
    gpStrafe: 0,
    gpTurn: 0,
    ...overrides,
  };
}

describe("CampaignReplayRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when nothing was ever recorded", async () => {
    const rec = new CampaignReplayRecorder("demo");
    expect(await rec.finish()).toBeNull();
  });

  it("records frames for a level and produces a valid payload", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta(), Promise.resolve("hash1"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.record(0.016, snapshot({ fireQueued: true }));
    const payload = await rec.finish();
    expect(payload).not.toBeNull();
    expect(payload!.version).toBe(2);
    expect(payload!.campaignName).toBe("demo");
    expect(payload!.levels).toHaveLength(1);
    expect(payload!.levels[0].astHash).toBe("hash1");
    expect(payload!.levels[0].frames).toHaveLength(2);
  });

  it("record() is a no-op before any startLevel() call", () => {
    const rec = new CampaignReplayRecorder("demo");
    expect(() => rec.record(0.016, snapshot())).not.toThrow();
  });

  it("drops a level that captured zero frames from the final payload", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), Promise.resolve("hashA"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), Promise.resolve("hashB"), Promise.resolve("balance-hash")); // never recorded into
    const payload = await rec.finish();
    expect(payload!.levels).toHaveLength(1);
    expect(payload!.levels[0].filePath).toBe("a.c");
  });

  it("truncates at a gap in the middle instead of silently closing it up", async () => {
    // The shipped `defaultHighscore.ts` carried exactly this: a Casual entry
    // whose replay ran level 9 -> level 11 because level 10 overflowed the
    // frame cap. Filtering made the payload look like a complete run.
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), Promise.resolve("hashA"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), Promise.resolve("hashB"), Promise.resolve("balance-hash")); // never recorded into
    rec.startLevel(meta({ filePath: "c.c" }), Promise.resolve("hashC"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["a.c"]);
  });

  it("truncates at an overflowed middle level, not just an empty one", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), Promise.resolve("hashA"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), Promise.resolve("hashB"), Promise.resolve("balance-hash"));
    // Overflow it the way a genuinely long level does.
    for (let i = 0; i < MAX_REPLAY_FRAMES_PER_LEVEL + 1; i++) rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "c.c" }), Promise.resolve("hashC"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["a.c"]);
  });

  it("reports how far past the cap the offending level ran, so the next cap change is measured", async () => {
    // Without this figure the warning only ever says "over the cap", which is
    // exactly what made the previous cap raise a guess: recording stops at the
    // limit, so nothing knew the true length.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), Promise.resolve("hashA"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), Promise.resolve("hashB"), Promise.resolve("balance-hash"));
    const over = 250;
    for (let i = 0; i < MAX_REPLAY_FRAMES_PER_LEVEL + over; i++) rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "c.c" }), Promise.resolve("hashC"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    await rec.finish();

    const truncation = warnSpy.mock.calls.map(([msg]) => String(msg)).find((m) => m.includes("truncated"));
    expect(truncation).toContain(`${MAX_REPLAY_FRAMES_PER_LEVEL + over - 1} frames`);
    expect(truncation).toContain(`${over - 1} past the cap`);
  });

  it("says nothing about the cap when a level went unrecordable without overflowing", async () => {
    // The other way `finish()` returns null: a level started and never
    // recorded a frame. Reporting "0 past the cap" there would be misleading.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), Promise.resolve("hashA"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), Promise.resolve("hashB"), Promise.resolve("balance-hash"));
    rec.startLevel(meta({ filePath: "c.c" }), Promise.resolve("hashC"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    await rec.finish();

    const truncation = warnSpy.mock.calls.map(([msg]) => String(msg)).find((m) => m.includes("truncated"));
    expect(truncation).toBeDefined();
    expect(truncation).not.toContain("past the cap");
  });

  it("returns null overall when every level ends up empty", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta(), Promise.resolve("hash1"), Promise.resolve("balance-hash"));
    expect(await rec.finish()).toBeNull();
  });

  it("stops recording further levels once MAX_REPLAY_LEVELS is reached", async () => {
    const rec = new CampaignReplayRecorder("demo");
    for (let i = 0; i < 101; i++) {
      rec.startLevel(meta({ filePath: `level${i}.c` }), Promise.resolve(`hash${i}`), Promise.resolve("balance-hash"));
      rec.record(0.016, snapshot());
    }
    const payload = await rec.finish();
    expect(payload!.levels).toHaveLength(100);
    // The 101st startLevel() call was rejected — record() after it is a no-op.
    expect(payload!.levels.every((l) => l.filePath !== "level100.c")).toBe(true);
  });

  it("stops recording a level's frames past MAX_REPLAY_FRAMES_PER_LEVEL and drops that level's replay", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta(), Promise.resolve("hash1"), Promise.resolve("balance-hash"));
    for (let i = 0; i < MAX_REPLAY_FRAMES_PER_LEVEL + 1; i++) rec.record(0.016, snapshot());
    expect(warnSpy).toHaveBeenCalledOnce();
    const payload = await rec.finish();
    expect(payload).toBeNull(); // the only level overflowed -> dropped -> no payload at all
  });

  it("only warns once even if record() keeps being called after overflow", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta(), Promise.resolve("hash1"), Promise.resolve("balance-hash"));
    for (let i = 0; i < MAX_REPLAY_FRAMES_PER_LEVEL + 5; i++) rec.record(0.016, snapshot());
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("preserves multi-level order in the final payload", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "first.c" }), Promise.resolve("h1"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "second.c" }), Promise.resolve("h2"), Promise.resolve("balance-hash"));
    rec.record(0.016, snapshot());
    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["first.c", "second.c"]);
  });
});

describe("ReplayPlaybackInput", () => {
  it("starts at the neutral/idle snapshot before any frame is loaded", () => {
    const input = new ReplayPlaybackInput();
    expect(input.isDown("KeyW")).toBe(false);
    expect(input.consumeMouseDX()).toBe(0);
    expect(input.consumeFire()).toBe(false);
    expect(input.consumeWeaponRequest()).toBeNull();
  });

  it("reflects the loaded frame's state through every consume*/is* method", () => {
    const input = new ReplayPlaybackInput();
    input.loadFrame(
      snapshot({
        keys: ["KeyW"],
        mouseDX: 5,
        fireQueued: true,
        fireHeld: true,
        weaponRequest: 2,
        mapToggle: true,
        interact: true,
        melee: true,
        meleeHeld: true,
        wheelSteps: 1,
        fpsToggle: true,
        escape: true,
        blur: true,
        pointerUnlock: true,
        click: true,
        gpForward: 0.5,
        gpStrafe: -0.5,
        gpTurn: 0.25,
      }),
    );
    expect(input.isDown("KeyW")).toBe(true);
    expect(input.isDown("KeyS")).toBe(false);
    expect(input.consumeMouseDX()).toBe(5);
    expect(input.consumeFire()).toBe(true);
    expect(input.isFireHeld()).toBe(true);
    expect(input.consumeWeaponRequest()).toBe(2);
    expect(input.consumeMapToggle()).toBe(true);
    expect(input.consumeInteract()).toBe(true);
    expect(input.consumeMelee()).toBe(true);
    expect(input.isMeleeHeld()).toBe(true);
    expect(input.consumeWheelSteps()).toBe(1);
    expect(input.consumeFpsToggle()).toBe(true);
    expect(input.consumeEscape()).toBe(true);
    expect(input.consumeBlur()).toBe(true);
    expect(input.consumePointerUnlock()).toBe(true);
    expect(input.consumeClick()).toBe(true);
    expect(input.gamepadForward()).toBe(0.5);
    expect(input.gamepadStrafe()).toBe(-0.5);
    expect(input.gamepadTurn()).toBe(0.25);
  });

  it("always returns null from consumeCheat(), regardless of loaded state", () => {
    const input = new ReplayPlaybackInput();
    input.loadFrame(snapshot());
    expect(input.consumeCheat()).toBeNull();
  });

  it("attach() and pollGamepad() are no-ops", () => {
    const input = new ReplayPlaybackInput();
    input.loadFrame(snapshot({ mouseDX: 3 }));
    expect(() => input.attach()).not.toThrow();
    expect(() => input.pollGamepad()).not.toThrow();
    expect(input.consumeMouseDX()).toBe(3); // unaffected
  });

  it("detach() resets to the neutral/idle snapshot", () => {
    const input = new ReplayPlaybackInput();
    input.loadFrame(snapshot({ mouseDX: 3, fireQueued: true }));
    input.detach();
    expect(input.consumeMouseDX()).toBe(0);
    expect(input.consumeFire()).toBe(false);
  });

  it("captureSnapshot() returns the currently loaded snapshot", () => {
    const input = new ReplayPlaybackInput();
    const s = snapshot({ mouseDX: 7 });
    input.loadFrame(s);
    expect(input.captureSnapshot()).toBe(s);
  });
});

describe("CampaignReplayRecorder.dropCurrentLevel — a rolled-back attempt", () => {
  const H = (): Promise<string> => Promise.resolve("h");

  it("removes the in-progress level so it never reaches the payload", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), H(), H());
    rec.record(0.016, snapshot());
    rec.startLevel(meta({ filePath: "b.c" }), H(), H()); // died here
    rec.record(0.016, snapshot());
    rec.dropCurrentLevel();
    rec.startLevel(meta({ filePath: "b.c" }), H(), H()); // rolled back, played it again
    rec.record(0.016, snapshot());

    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["a.c", "b.c"]);
    // Exactly one b.c, not two: the failed attempt is gone rather than
    // sitting in front of the surviving one, where playback would have
    // stopped at its death and never reached anything after it.
    expect(payload!.levels).toHaveLength(2);
  });

  it("leaves the levels before it untouched and in order", async () => {
    const rec = new CampaignReplayRecorder("demo");
    for (const f of ["a.c", "b.c", "c.c"]) {
      rec.startLevel(meta({ filePath: f }), H(), H());
      rec.record(0.016, snapshot());
    }
    rec.dropCurrentLevel();
    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["a.c", "b.c"]);
  });

  it("is a no-op when nothing is being recorded", async () => {
    const rec = new CampaignReplayRecorder("demo");
    expect(() => rec.dropCurrentLevel()).not.toThrow();
    rec.startLevel(meta({ filePath: "a.c" }), H(), H());
    rec.record(0.016, snapshot());
    rec.dropCurrentLevel();
    // Called twice: the second must not eat the level before it.
    rec.dropCurrentLevel();
    rec.startLevel(meta({ filePath: "a.c" }), H(), H());
    rec.record(0.016, snapshot());
    const payload = await rec.finish();
    expect(payload!.levels.map((l) => l.filePath)).toEqual(["a.c"]);
  });

  it("stops recording into the dropped level", async () => {
    const rec = new CampaignReplayRecorder("demo");
    rec.startLevel(meta({ filePath: "a.c" }), H(), H());
    rec.record(0.016, snapshot());
    rec.dropCurrentLevel();
    expect(() => rec.record(0.016, snapshot())).not.toThrow(); // no live level to record into
    const payload = await rec.finish();
    expect(payload).toBeNull(); // nothing savable was captured at all
  });
});

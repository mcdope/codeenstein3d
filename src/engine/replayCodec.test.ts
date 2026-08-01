// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { HighscoreEntry } from "./highscores";
import { RECORDED_KEYS, type InputSnapshot } from "./input";
import type { ReplayFrame } from "./replay";
import {
  decodeReplayFrames,
  encodeReplayFrames,
  isBinaryBoard,
  packBoardForStorage,
  unpackBoardFromStorage,
} from "./replayCodec";

function emptyInput(): InputSnapshot {
  return {
    keys: [],
    mouseDX: 0,
    fireQueued: false,
    fireHeld: false,
    weaponRequest: null,
    mapToggle: false,
    interact: false,
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
  };
}

function frame(dt: number, overrides: Partial<InputSnapshot> = {}): ReplayFrame {
  return { dt, input: { ...emptyInput(), ...overrides } };
}

function entryWith(levels: { frames: ReplayFrame[] }[]): HighscoreEntry {
  return {
    score: 1234,
    campaignName: "demo-campaign",
    levelName: "main.c",
    levelsCleared: levels.length,
    hash: "abc123",
    achievedAt: 1_700_000_000_000,
    replay: {
      version: 2,
      campaignName: "demo-campaign",
      levels: levels.map((l, i) => ({
        filePath: `stage${i}.c`,
        bonusLevel: false,
        gameplaySeed: 42 + i,
        difficulty: "normal",
        gore: "normal",
        astHash: `ast${i}`,
        balanceHash: `bal${i}`,
        frames: l.frames,
      })),
    },
  };
}

describe("replayCodec — frame encoding", () => {
  it("round-trips an all-defaults frame", () => {
    const frames = [frame(0.016)];
    expect(decodeReplayFrames(encodeReplayFrames(frames))).toEqual(frames);
  });

  it("round-trips every recorded key, individually and all at once", () => {
    const frames = [...RECORDED_KEYS.map((k) => frame(0.016, { keys: [k] })), frame(0.016, { keys: [...RECORDED_KEYS] })];
    expect(decodeReplayFrames(encodeReplayFrames(frames))).toEqual(frames);
  });

  it("round-trips every packed boolean, including all of them set at once", () => {
    const bools = [
      "fireQueued",
      "fireHeld",
      "mapToggle",
      "interact",
      "melee",
      "meleeHeld",
      "fpsToggle",
      "escape",
      "blur",
      "pointerUnlock",
      "click",
    ] as const;
    // The 11th flag is what proves the two-byte boolean field is read back
    // little-endian — a one-byte field would silently drop `click`.
    const frames = [...bools.map((b) => frame(0.016, { [b]: true })), frame(0.016, Object.fromEntries(bools.map((b) => [b, true])))];
    expect(decodeReplayFrames(encodeReplayFrames(frames))).toEqual(frames);
  });

  it("round-trips the extras group and distinguishes weaponRequest 0 from null", () => {
    const frames = [
      frame(0.016, { weaponRequest: 0 }),
      frame(0.016, { weaponRequest: 4 }),
      frame(0.016, { weaponRequest: null }),
      frame(0.016, { mouseDX: -12.5, wheelSteps: -3 }),
      frame(0.016, { gpForward: 0.5, gpStrafe: -0.25, gpTurn: 1 }),
    ];
    const back = decodeReplayFrames(encodeReplayFrames(frames));
    expect(back).toEqual(frames);
    expect(back[0].input.weaponRequest).toBe(0); // not coerced to null
    expect(back[2].input.weaponRequest).toBeNull();
  });

  it("preserves dt bit-exactly, including the rAF jitter that motivated the codec", () => {
    // These are real recorded values. Float32 cannot represent any of them,
    // which is exactly why dt is stored as raw float64 bits — a rounded dt
    // would drift a replayed run away from its own recorded score.
    const jittery = [0.01666666666662786, 0.016666666666686068, 0.016666666666656966, 0.05, 1 / 3];
    const frames = jittery.map((dt) => frame(dt));
    const back = decodeReplayFrames(encodeReplayFrames(frames));
    for (let i = 0; i < jittery.length; i++) expect(back[i].dt).toBe(jittery[i]);
  });

  it("handles an empty frame list", () => {
    expect(decodeReplayFrames(encodeReplayFrames([]))).toEqual([]);
  });

  it("uses a varint frame count, so a block past 127 frames still decodes", () => {
    // 127 is the single-byte varint ceiling — the regression this guards is
    // a length written as one raw byte, which silently truncates beyond it.
    const frames = Array.from({ length: 300 }, (_, i) => frame(0.016, { keys: i % 2 ? ["KeyW"] : [] }));
    expect(decodeReplayFrames(encodeReplayFrames(frames))).toEqual(frames);
  });
});

describe("replayCodec — board container", () => {
  it("round-trips a whole board, frames included", async () => {
    const board = [
      entryWith([{ frames: [frame(0.016, { keys: ["KeyW"] }), frame(0.02, { fireQueued: true })] }, { frames: [frame(0.03)] }]),
      entryWith([{ frames: [frame(0.05, { mouseDX: 3 })] }]),
    ];
    const packed = await packBoardForStorage(board);
    expect(isBinaryBoard(packed)).toBe(true);
    expect(await unpackBoardFromStorage(packed)).toEqual(board);
  });

  it("keeps consecutive level blocks aligned — a short block must not eat the next one's bytes", async () => {
    // Uneven block lengths are the case a fixed-stride reader gets wrong:
    // level 0 is one frame, level 1 is many, level 2 is empty.
    const board = [
      entryWith([
        { frames: [frame(0.016)] },
        { frames: Array.from({ length: 40 }, (_, i) => frame(0.016 + i / 1000, { keys: ["KeyA"] })) },
        { frames: [] },
        { frames: [frame(0.99, { melee: true })] },
      ]),
    ];
    expect(await unpackBoardFromStorage(await packBoardForStorage(board))).toEqual(board);
  });

  it("preserves entry metadata, not just frames", async () => {
    const board = [entryWith([{ frames: [frame(0.016)] }])];
    board[0].source = "demo";
    board[0].codebaseLinesOfCode = 999;
    const back = await unpackBoardFromStorage(await packBoardForStorage(board));
    expect(back[0].score).toBe(1234);
    expect(back[0].hash).toBe("abc123");
    expect(back[0].source).toBe("demo");
    expect(back[0].codebaseLinesOfCode).toBe(999);
    expect(back[0].replay?.levels[0].astHash).toBe("ast0");
  });

  it("handles an entry with no replay at all", async () => {
    const board: HighscoreEntry[] = [
      { score: 7, campaignName: "c", levelName: "l", levelsCleared: 1, hash: "h", achievedAt: 1 },
    ];
    expect(await unpackBoardFromStorage(await packBoardForStorage(board))).toEqual(board);
  });

  it("handles an empty board", async () => {
    expect(await unpackBoardFromStorage(await packBoardForStorage([]))).toEqual([]);
  });

  it("isBinaryBoard rejects the older storage forms", () => {
    expect(isBinaryBoard("gz1:H4sIAAAA")).toBe(false);
    expect(isBinaryBoard("[]")).toBe(false);
    expect(isBinaryBoard("")).toBe(false);
  });

  it("packs a repetitive board far smaller than the JSON it replaces", async () => {
    // The whole point of the codec: 2000 near-identical frames should not
    // cost anything like their JSON footprint.
    const frames = Array.from({ length: 2000 }, (_, i) => frame(0.016666666666 + i * 1e-13, { keys: i % 3 ? ["KeyW"] : [] }));
    const board = [entryWith([{ frames }])];
    const packed = await packBoardForStorage(board);
    expect(packed.length).toBeLessThan(JSON.stringify(board).length / 10);
    expect(await unpackBoardFromStorage(packed)).toEqual(board);
  });
});

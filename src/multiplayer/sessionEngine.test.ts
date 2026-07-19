// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import { InputController } from "../engine/input";
import type { GameMap, Tile } from "../map/types";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID } from "./sessionSetupTypes";
import type { SessionSetupResult } from "./sessionSetupTypes";

let buildSessionEngine: typeof import("./sessionEngine").buildSessionEngine;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ buildSessionEngine } = await import("./sessionEngine"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  createMockCanvasContext(canvas);
  return canvas;
}

function walledRoom(size: number): Tile[][] {
  const g: Tile[][] = Array.from({ length: size }, () => new Array(size).fill(0) as Tile[]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) g[y][x] = 1;
    }
  }
  return g;
}

function fakeMap(overrides: Partial<GameMap> = {}, size = 12): GameMap {
  return {
    width: size,
    height: size,
    grid: walledRoom(size),
    visited: Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]),
    rooms: [],
    breakupRooms: [],
    spawn: { x: 5, y: 5 },
    enemies: [],
    exit: { x: size - 2, y: size - 2 },
    shortestPathTiles: 4,
    hazards: [],
    doors: [],
    keys: [],
    decorations: [],
    teleporters: [],
    spikeTraps: [],
    mines: [],
    ammoPickups: [],
    loreTerminals: [],
    bonusLevel: false,
    secretRoomCount: 0,
    ...overrides,
  };
}

function fakeResult(overrides: Partial<SessionSetupResult> = {}): SessionSetupResult {
  return {
    roster: [GUEST_PLAYER_ID, HOST_PLAYER_ID].sort(),
    assignedId: HOST_PLAYER_ID,
    tickRateHz: 30,
    fixedDt: 1 / 30,
    inputDelayTicks: 3,
    gameplaySeed: 1,
    difficulty: "normal",
    playerCount: 2,
    map: fakeMap(),
    ...overrides,
  };
}

describe("buildSessionEngine", () => {
  it("keys the host's own player 'host' and the other player 'guest'", () => {
    const { engine } = buildSessionEngine({ result: fakeResult(), role: "host", canvas: makeCanvas() });
    const roster = engine.rosterSnapshot();
    expect([...roster.keys()].sort()).toEqual(["guest", "host"]);
  });

  it("keys the guest's own player 'guest' and the other player 'host'", () => {
    const { engine } = buildSessionEngine({ result: fakeResult(), role: "guest", canvas: makeCanvas() });
    const roster = engine.rosterSnapshot();
    expect([...roster.keys()].sort()).toEqual(["guest", "host"]);
  });

  it("assigns spawns from multiplayerSpawns in sorted-roster order, wrapping on shortfall", () => {
    const map = fakeMap({
      multiplayerSpawns: [
        { x: 2, y: 2 },
        { x: 8, y: 8 },
      ],
    });
    const result = fakeResult({ map });
    const { engine } = buildSessionEngine({ result, role: "host", canvas: makeCanvas() });
    // sorted roster is ["guest", "host"] -> guest gets index 0, host gets index 1
    expect(engine.getPlayerPosition("guest")).toEqual({ x: 2.5, y: 2.5 });
    expect(engine.getPlayerPosition("host")).toEqual({ x: 8.5, y: 8.5 });
  });

  it("falls back to map.spawn for both players when multiplayerSpawns is undefined", () => {
    const result = fakeResult({ map: fakeMap({ spawn: { x: 4, y: 4 } }) });
    const { engine } = buildSessionEngine({ result, role: "host", canvas: makeCanvas() });
    expect(engine.getPlayerPosition("guest")).toEqual({ x: 4.5, y: 4.5 });
    expect(engine.getPlayerPosition("host")).toEqual({ x: 4.5, y: 4.5 });
  });

  it("falls back to map.spawn when multiplayerSpawns is an empty array", () => {
    const result = fakeResult({ map: fakeMap({ spawn: { x: 4, y: 4 }, multiplayerSpawns: [] }) });
    const { engine } = buildSessionEngine({ result, role: "guest", canvas: makeCanvas() });
    expect(engine.getPlayerPosition("guest")).toEqual({ x: 4.5, y: 4.5 });
    expect(engine.getPlayerPosition("host")).toEqual({ x: 4.5, y: 4.5 });
  });

  it("returns network input sources both feedable via loadFrame, and attaches the local sampler", () => {
    const attachSpy = vi.spyOn(InputController.prototype, "attach");
    const { myInput, otherInput, localSampler } = buildSessionEngine({ result: fakeResult(), role: "host", canvas: makeCanvas() });
    expect(() => myInput.loadFrame({ ...myInput.captureSnapshot() })).not.toThrow();
    expect(() => otherInput.loadFrame({ ...otherInput.captureSnapshot() })).not.toThrow();
    expect(localSampler).toBeDefined();
    expect(attachSpy).toHaveBeenCalledTimes(1);
  });

  it("still fires onFreezeChange for this peer's own pause (pause suppression isn't this step's job)", () => {
    const { engine, myInput } = buildSessionEngine({ result: fakeResult(), role: "host", canvas: makeCanvas() });
    myInput.loadFrame({ ...myInput.captureSnapshot(), escape: true });
    expect(() => engine.advance(1 / 30)).not.toThrow();
  });

  it("onSessionEnded fires exactly once, after detaching the local sampler, once the engine reaches game over", () => {
    const detachSpy = vi.spyOn(InputController.prototype, "detach");
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // hazard tile at spawn
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const onSessionEnded = vi.fn();
    const { engine } = buildSessionEngine({ result: fakeResult({ map }), role: "host", canvas: makeCanvas(), onSessionEnded });

    for (let i = 0; i < 10 && onSessionEnded.mock.calls.length === 0; i++) engine.advance(1);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(detachSpy).toHaveBeenCalledTimes(1);
    // advancing further (the engine itself is already stopped/over) must not
    // re-fire the session-ended callback a second time.
    engine.advance(1);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });
});

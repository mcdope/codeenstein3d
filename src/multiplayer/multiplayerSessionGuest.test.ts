// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeRTCDataChannel } from "../../test/mocks/webrtc";
import { createMockCanvasContext, stubCanvasGetContext } from "../../test/mocks/canvas";
import type { GameMap, Tile } from "../map/types";
import type { InputSnapshot } from "../engine/input";
import type { TickInput, TickInputBundle } from "./netcodeTypes";
import type { PlayerSnapshot, ReconciliationSnapshotMessage } from "./reconciliationTypes";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID } from "./sessionSetupTypes";
import type { SessionSetupResult } from "./sessionSetupTypes";
import type { MultiplayerChannels } from "./types";

let runMultiplayerSessionAsGuest: typeof import("./multiplayerSessionGuest").runMultiplayerSessionAsGuest;

beforeAll(async () => {
  stubCanvasGetContext(document.createElement("canvas"));
  ({ runMultiplayerSessionAsGuest } = await import("./multiplayerSessionGuest"));
});

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  createMockCanvasContext(canvas);
  return canvas;
}

function linkedChannels(): { host: MultiplayerChannels; guest: MultiplayerChannels } {
  const hostInput = new FakeRTCDataChannel("input");
  const guestInput = new FakeRTCDataChannel("input");
  hostInput.link(guestInput);
  const hostReconciliation = new FakeRTCDataChannel("reconciliation");
  const guestReconciliation = new FakeRTCDataChannel("reconciliation");
  hostReconciliation.link(guestReconciliation);
  return {
    host: { input: hostInput as unknown as RTCDataChannel, reconciliation: hostReconciliation as unknown as RTCDataChannel },
    guest: { input: guestInput as unknown as RTCDataChannel, reconciliation: guestReconciliation as unknown as RTCDataChannel },
  };
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
    assignedId: GUEST_PLAYER_ID,
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

function emptySnapshot(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
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
    ...overrides,
  };
}

function collectMessages(channel: RTCDataChannel): (TickInput | TickInputBundle)[] {
  const messages: (TickInput | TickInputBundle)[] = [];
  channel.addEventListener("message", (event) => {
    messages.push(JSON.parse((event as MessageEvent).data as string));
  });
  return messages;
}

function fakePlayerSnapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    posX: 5.5,
    posY: 5.5,
    dirX: 1,
    dirY: 0,
    planeX: 0,
    planeY: 1,
    health: 100,
    swap: 0,
    ammo: { bullets: 0, rockets: 0, smg: 0, gas: 0 },
    weaponIndex: 0,
    keysHeld: 0,
    ownedWeapons: [0, 1, 2],
    alive: true,
    killScore: 0,
    kills: 0,
    ...overrides,
  };
}

function fakeReconciliationSnapshot(overrides: Partial<ReconciliationSnapshotMessage> = {}): ReconciliationSnapshotMessage {
  return {
    type: "reconciliation-snapshot",
    tick: 0,
    rngState: 0,
    players: { host: fakePlayerSnapshot(), guest: fakePlayerSnapshot() },
    enemies: [],
    mines: [],
    lootDrops: [],
    pickupsCollected: [],
    keysCollected: [],
    gridVersion: 0,
    gridDelta: [],
    ...overrides,
  };
}

describe("runMultiplayerSessionAsGuest", () => {
  it("applies a received bundle to the engine and samples+sends its own delayed input in response", () => {
    const channels = linkedChannels();
    const hostSeenMessages = collectMessages(channels.host.input);
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

    const bundle: TickInputBundle = {
      tick: 5,
      dt: 1 / 30,
      inputs: { host: emptySnapshot(), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    channels.host.input.send(JSON.stringify(bundle));

    expect(handle.getLastAppliedTick()).toBe(5);
    expect(hostSeenMessages).toHaveLength(1);
    expect(hostSeenMessages[0]).toMatchObject({ tick: 8, playerId: "guest" }); // 5 + INPUT_DELAY_TICKS(3)
  });

  it("applies every roster player's input from the bundle, not just its own", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      inputs: { host: emptySnapshot({ fireQueued: true }), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    channels.host.input.send(JSON.stringify(bundle));
    expect(() => handle.getPlayerPosition("host")).not.toThrow();
  });

  it("stop() is idempotent", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("ignores further bundles after teardown", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    handle.stop();

    const bundle: TickInputBundle = {
      tick: 0,
      dt: 1 / 30,
      inputs: { host: emptySnapshot(), guest: emptySnapshot() },
      heldInputFallback: [],
    };
    expect(() => channels.host.input.send(JSON.stringify(bundle))).not.toThrow();
    expect(handle.getLastAppliedTick()).toBeNull();
  });

  it("getPlayerPosition delegates to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 6, y: 7 } }) }));
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 6.5, y: 7.5 });
    expect(handle.getPlayerPosition("nope")).toBeNull();
  });

  it("forwards onSessionEnded once game-over fires, after tearing down its own listener", () => {
    const channels = linkedChannels();
    const size = 12;
    const g = walledRoom(size);
    g[5][5] = 2; // hazard tile at spawn
    const map = fakeMap({ grid: g, hazards: [{ x: 5, y: 5 }] }, size);
    const onSessionEnded = vi.fn();
    runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map }), onSessionEnded);

    const bundle: TickInputBundle = { tick: 0, dt: 1 / 30, inputs: { host: emptySnapshot(), guest: emptySnapshot() }, heldInputFallback: [] };
    // FIXED_DT-paced ticks (1/30s each) — needs many more iterations than a
    // dt=1 advance() loop would to cover the same in-sim elapsed time.
    for (let i = 0; i < 300 && onSessionEnded.mock.calls.length === 0; i++) {
      channels.host.input.send(JSON.stringify({ ...bundle, tick: i }));
    }

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it("applies an incoming ReconciliationSnapshotMessage from the host, correcting its own simulated state", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 });

    const snapshot = fakeReconciliationSnapshot({
      players: {
        host: fakePlayerSnapshot({ posX: 8.5, posY: 8.5 }),
        guest: fakePlayerSnapshot({ posX: 2.5, posY: 3.5 }),
      },
    });
    channels.host.reconciliation.send(JSON.stringify(snapshot));

    expect(handle.getPlayerPosition("guest")).toEqual({ x: 2.5, y: 3.5 });
    expect(handle.getPlayerPosition("host")).toEqual({ x: 8.5, y: 8.5 });
  });

  it("stops applying reconciliation snapshots after teardown", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult({ map: fakeMap({ spawn: { x: 5, y: 5 } }) }));
    handle.stop();

    const snapshot = fakeReconciliationSnapshot({ players: { host: fakePlayerSnapshot(), guest: fakePlayerSnapshot({ posX: 9.5, posY: 9.5 }) } });
    expect(() => channels.host.reconciliation.send(JSON.stringify(snapshot))).not.toThrow();
    expect(handle.getPlayerPosition("guest")).toEqual({ x: 5.5, y: 5.5 }); // unchanged — never applied
  });

  it("getRngState/debugInjectDesync/hasActiveRenderOffset delegate to the underlying engine", () => {
    const channels = linkedChannels();
    const handle = runMultiplayerSessionAsGuest(channels.guest, makeCanvas(), fakeResult());
    const before = handle.getPlayerPosition("guest");
    handle.debugInjectDesync({ kind: "position", deltaTiles: 0.2 });
    expect(handle.getPlayerPosition("guest")).toEqual({ x: before!.x + 0.2, y: before!.y });
    expect(typeof handle.getRngState()).toBe("number");
    expect(handle.hasActiveRenderOffset("guest")).toBe(false);
  });
});
